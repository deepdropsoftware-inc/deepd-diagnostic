import path from "node:path";
import { runCapturedJson, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin, RunContext } from "../core/types.js";

const MARKERS = [
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Pipfile",
  "tox.ini",
  "poetry.lock",
];

async function pythonFor(ctx: RunContext): Promise<string | null> {
  return (await ctx.which("python3")) ?? (await ctx.which("python")) ?? null;
}

/** pytest via `-m` works with venvs, tox and system pythons alike. */
function isMissingModule(output: string | undefined): boolean {
  return Boolean(output && /No module named|ModuleNotFoundError/.test(output));
}

const pythonPlugin: Plugin = {
  id: "python",
  label: "Python",

  async detect(ctx) {
    for (const marker of MARKERS) {
      if (await ctx.exists(marker)) return true;
    }
    return (await ctx.find(["*.py"], { maxDepth: 2 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const python = await pythonFor(ctx);
    if (!python) {
      return [skipped("python", "no python3/python on PATH")];
    }

    const checks: CheckResult[] = [];

    // Tests — pytest writes JUnit natively.
    const pytest = await runStep(ctx, "pytest", python, [
      "-m",
      "pytest",
      `--junitxml=${artifacts.junitPath}`,
      "-q",
    ]);
    checks.push(
      isMissingModule(pytest.output)
        ? skipped("pytest", "pytest is not installed in this environment")
        : pytest,
    );

    // Lint — ruff emits JSON on stdout (standalone binary first, module form second).
    const ruffBin = await ctx.which("ruff");
    if (ruffBin) {
      checks.push(
        await runCapturedJson(
          ctx,
          "ruff",
          ruffBin,
          ["check", "--output-format", "json", "."],
          artifacts,
          "ruff.json",
        ),
      );
    } else if (await moduleAvailable(ctx, python, "ruff")) {
      checks.push(
        await runCapturedJson(
          ctx,
          "ruff",
          python,
          ["-m", "ruff", "check", "--output-format", "json", "."],
          artifacts,
          "ruff.json",
        ),
      );
    } else {
      checks.push(skipped("ruff", "ruff is not installed"));
    }

    // Types — mypy writes its own JUnit; keep it as a separate suite file.
    const mypyJUnit = path.join(artifacts.dir, "mypy.junit.xml");
    const mypyProbe = await ctx.exec(python, ["-m", "mypy", "--version"], ctx.target);
    if (mypyProbe.code === 0) {
      checks.push(
        await runStep(ctx, "mypy", python, [
          "-m",
          "mypy",
          ".",
          "--junit-xml",
          mypyJUnit,
          "--no-error-summary",
        ]),
      );
    } else {
      checks.push(skipped("mypy", "mypy is not installed"));
    }

    return checks;
  },
};

/** Some images expose a tool only as a module; probe before using `python -m`. */
async function moduleAvailable(
  ctx: RunContext,
  python: string,
  module: string,
): Promise<boolean> {
  const probe = await ctx.exec(python, ["-m", module, "--version"], ctx.target);
  return probe.code === 0;
}

export default pythonPlugin;
