import path from "node:path";
import { notApplicable, runScript, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, PackageJson, Plugin, RunContext } from "../core/types.js";

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
];

const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
];

const VITEST_CONFIGS = [
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.workspace.ts",
];

async function anyExists(ctx: RunContext, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await ctx.exists(name)) return true;
  }
  return false;
}

async function hasDependency(ctx: RunContext, name: string): Promise<boolean> {
  const pkg: PackageJson | null = await ctx.pkg();
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

/** --fix: formatting only. Real code problems stay failures. */
async function applyFormattingFixes(ctx: RunContext): Promise<void> {
  const prettier = ctx.bin("prettier");
  if (prettier && (await anyExists(ctx, PRETTIER_CONFIGS))) {
    ctx.log("   fix: prettier --write .");
    await ctx.exec(prettier, ["--write", ".", "--log-level", "warn"]);
  }

  const eslint = ctx.bin("eslint");
  if (eslint && (await anyExists(ctx, ESLINT_CONFIGS))) {
    ctx.log("   fix: eslint . --fix");
    await ctx.exec(eslint, [".", "--fix"]);
  }
}

const nodePlugin: Plugin = {
  id: "node",
  label: "Node / TypeScript",

  async detect(ctx) {
    if (await ctx.exists("package.json")) return true;
    if (await ctx.exists("tsconfig.json")) return true;
    return await anyExists(ctx, [...VITEST_CONFIGS, ...ESLINT_CONFIGS]);
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const scripts = await ctx.packageScripts();

    if (ctx.fix) await applyFormattingFixes(ctx);

    // Types: prefer the project's own typecheck script so workspaces stay consistent.
    if (scripts.typecheck) {
      checks.push(await runScript(ctx, "typecheck", ctx.target));
    } else if (await ctx.exists("tsconfig.json")) {
      const tsc = ctx.bin("tsc");
      checks.push(
        tsc
          ? await runStep(ctx, "tsc --noEmit", tsc, ["--noEmit", "-p", "tsconfig.json"])
          : skipped("tsc --noEmit", "typescript is not installed"),
      );
    } else {
      checks.push(notApplicable("tsc --noEmit", "no tsconfig.json"));
    }

    // Lint — ESLint speaks JSON natively, so the findings are an artifact, not just log text.
    const eslint = ctx.bin("eslint");
    if (eslint && (await anyExists(ctx, ESLINT_CONFIGS))) {
      checks.push(
        await runStep(ctx, "eslint", eslint, [
          ".",
          "--format",
          "json",
          "--output-file",
          path.join(artifacts.dir, "eslint.json"),
        ]),
      );
    } else if (!eslint) {
      checks.push(skipped("eslint", "eslint is not installed"));
    } else {
      checks.push(notApplicable("eslint", "no ESLint config"));
    }

    // Tests — Vitest writes JUnit directly into artifacts/node/junit.xml.
    const vitest = ctx.bin("vitest");
    if (vitest) {
      checks.push(
        await runStep(ctx, "vitest run", vitest, [
          "run",
          "--reporter=default",
          "--reporter=junit",
          `--outputFile.junit=${artifacts.junitPath}`,
        ]),
      );
    } else if (scripts.test?.includes("vitest")) {
      checks.push(await runScript(ctx, "test", ctx.target));
    } else if (await hasDependency(ctx, "vitest")) {
      checks.push(skipped("vitest run", "vitest is not installed (run npm install)"));
    } else {
      checks.push(notApplicable("vitest run", "vitest is not configured"));
    }

    return checks;
  },
};

export default nodePlugin;
