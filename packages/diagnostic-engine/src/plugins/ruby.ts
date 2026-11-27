import path from "node:path";
import { notApplicable, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin, RunContext } from "../core/types.js";

const RUBY_MARKERS = ["Gemfile", "Gemfile.lock", "Rakefile", ".ruby-version", ".rspec"];

async function hasGem(ctx: RunContext, name: string): Promise<boolean> {
  const lock = (await ctx.read("Gemfile.lock")) ?? "";
  if (lock.includes(name)) return true;
  const gemspecs = await ctx.find(["*.gemspec"], { maxDepth: 2 });
  if (gemspecs.length === 0) return false;
  const spec = await ctx.read(path.relative(ctx.target, gemspecs[0] as string));
  return Boolean(spec?.includes(name));
}

const rubyPlugin: Plugin = {
  id: "ruby",
  label: "Ruby",

  async detect(ctx) {
    for (const marker of RUBY_MARKERS) {
      if (await ctx.exists(marker)) return true;
    }
    return (await ctx.find(["*.gemspec"], { maxDepth: 2 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const bundle = await ctx.which("bundle");
    const runGem = (name: string, args: string[]) =>
      bundle
        ? runStep(ctx, name, bundle, ["exec", ...args])
        : runStep(ctx, name, args[0] as string, args.slice(1));

    // Lint — RuboCop writes native JUnit and JSON.
    if (await hasGem(ctx, "rubocop")) {
      const rubocopJUnit = path.join(artifacts.dir, "rubocop.junit.xml");
      checks.push(
        await runGem("rubocop", [
          "rubocop",
          "--format",
          "junit",
          "--out",
          rubocopJUnit,
          "--format",
          "json",
          "--out",
          path.join(artifacts.dir, "rubocop.json"),
        ]),
      );
    } else {
      checks.push(notApplicable("rubocop", "rubocop is not in the bundle"));
    }

    // Tests — rspec_junit_formatter is the standard JUnit reporter.
    if (await hasGem(ctx, "rspec")) {
      if (await hasGem(ctx, "rspec_junit_formatter")) {
        checks.push(
          await runGem("rspec", [
            "rspec",
            "--format",
            "progress",
            "--format",
            "RspecJunitFormatter",
            "--out",
            artifacts.junitPath,
          ]),
        );
      } else {
        checks.push(skipped("rspec junit", "add rspec_junit_formatter for native JUnit"));
        checks.push(await runGem("rspec", ["rspec"]));
      }
    } else if (await ctx.exists("Rakefile")) {
      checks.push(await runGem("rake test", ["rake", "test"]));
    } else {
      checks.push(notApplicable("rspec", "rspec is not in the bundle"));
    }

    return checks;
  },
};

export default rubyPlugin;
