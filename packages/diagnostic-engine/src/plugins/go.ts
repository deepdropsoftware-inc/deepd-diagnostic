import path from "node:path";
import { runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin } from "../core/types.js";

/**
 * Go toolchain. Native JUnit comes from gotestsum (tests) and golangci-lint (lint);
 * go build/vet have no machine format, so the engine synthesizes their suites.
 */
const goPlugin: Plugin = {
  id: "go",
  label: "Go",

  async detect(ctx) {
    if (await ctx.exists("go.mod")) return true;
    if (await ctx.exists("go.work")) return true;
    return (await ctx.find(["*.go"], { maxDepth: 1 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const go = await ctx.which("go");
    if (!go) {
      return [skipped("go toolchain", "go is not installed")];
    }

    const checks: CheckResult[] = [];

    checks.push(await runStep(ctx, "go build", go, ["build", "./..."]));
    checks.push(await runStep(ctx, "go vet", go, ["vet", "./..."]));

    // Lint — golangci-lint v2 moved the output flags; detect the major version.
    const golangci = await ctx.which("golangci-lint");
    if (golangci) {
      const version = await ctx.exec(golangci, ["--version"], ctx.target);
      const major = Number(/v(\d+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? 1);
      const lintJUnit = path.join(artifacts.dir, "golangci.junit.xml");
      const lintJson = path.join(artifacts.dir, "golangci.json");

      const args =
        major >= 2
          ? [
              "run",
              `--output.junit-xml.path=${lintJUnit}`,
              `--output.json.path=${lintJson}`,
              "./...",
            ]
          : ["run", `--out-format=junit-xml:${lintJUnit},json:${lintJson}`, "./..."];

      checks.push(await runStep(ctx, "golangci-lint", golangci, args));
    } else {
      checks.push(skipped("golangci-lint", "golangci-lint is not installed"));
    }

    // Tests — gotestsum gives a native JUnit report; go test is the fallback.
    const gotestsum = await ctx.which("gotestsum");
    if (gotestsum) {
      checks.push(
        await runStep(ctx, "gotestsum", gotestsum, [
          "--junitfile",
          artifacts.junitPath,
          "--format",
          "testname",
          "./...",
        ]),
      );
    } else {
      checks.push(await runStep(ctx, "go test", go, ["test", "./..."]));
    }

    return checks;
  },
};

export default goPlugin;
