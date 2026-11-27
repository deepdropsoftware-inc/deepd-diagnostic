import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeAggregateJUnit } from "./artifacts.js";
import { reconcileBlockers } from "./blockers.js";
import { pluginDirs, readEngineConfig } from "./config.js";
import { findRepoRoot, resolveCassette } from "./detect.js";
import { exec } from "./exec.js";
import { analyzeExplain, writeExplainArtifact } from "./explain.js";
import { analyzeFlakiness, writeFlakyArtifact } from "./flaky.js";
import { analyzeImpact, writeImpactArtifact } from "./impact.js";
import { findPaths, pathExists, readJson, isFile } from "./fs.js";
import { runPass2 } from "./pass2.js";
import { DEFAULT_PLUGINS_DIR, loadPlugins } from "./registry.js";
import { printReport, writeReport } from "./report.js";
import { runPlugins } from "./runner.js";
import type {
  DiagnosticReport,
  PackageJson,
  Pass2Report,
  PassSummary,
  PluginResult,
  RunContext,
} from "./types.js";
import { ENGINE_NAME, ENGINE_VERSION, REPORT_FILENAME } from "./version.js";

export const PASS1_LABEL = "Syntax & Structure";
export const PASS1_APPROACH =
  "deterministic — plugin/tool execution per file, syntax + lint + tests, writes blockers.json";

export interface DiagnoseOptions {
  cassette?: string;
  fix?: boolean;
  /** Overrides the report location (relative to the target). */
  reportPath?: string;
  /** Run language plugins even when Angel Armor fails. Defaults to config.gate. */
  gate?: boolean;
  /** Run the relational Pass 2. Defaults to config.twoPass (true). */
  twoPass?: boolean;
  /** Run the flaky signal. Defaults to config.flaky.enabled (true). */
  flaky?: boolean;
  /** Run test-impact selection. Defaults to config.impact.enabled (true). */
  impact?: boolean;
  /** Triage failures with --ai-explain (model call needs OPENAI_API_KEY). */
  aiExplain?: boolean;
  cwd?: string;
  quiet?: boolean;
}

export interface DiagnoseOutcome {
  report: DiagnosticReport;
  reportPath: string;
  exitCode: number;
}

function resolveToolBin(name: string, dirs: string[]): string | null {
  const names = process.platform === "win32" ? [`${name}.cmd`, name] : [name];
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, "node_modules", ".bin", candidate);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

function createContext(params: {
  repoRoot: string;
  target: string;
  cassette: string | null;
  fix: boolean;
  quiet: boolean;
  artifactsRoot: string;
  config: RunContext["config"];
}): RunContext {
  const { repoRoot, target, cassette, fix, quiet, artifactsRoot, config } = params;
  const binDirs = [target, repoRoot];

  return {
    repoRoot,
    target,
    relativeTarget: path.relative(repoRoot, target) || ".",
    cassette,
    fix,
    artifactsRoot,
    config,
    log: (line) => {
      if (!quiet) console.log(line);
    },
    exec: (command, args, cwd = target) => exec(command, args, cwd),
    which: async (name) => {
      const finder = process.platform === "win32" ? "where" : "which";
      const result = await exec(finder, [name], target, 15_000);
      const first = result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return result.code === 0 && first ? first : null;
    },
    read: async (relativePath) => {
      try {
        return await readFile(path.join(target, relativePath), "utf8");
      } catch {
        return null;
      }
    },
    exists: (...segments) => pathExists(path.join(target, ...segments)),
    find: (names, options = {}) =>
      findPaths(options.dir ?? target, names, options.maxDepth ?? 3),
    pkg: (dir = target) => readJson<PackageJson>(path.join(dir, "package.json")),
    packageScripts: async (dir = target) =>
      (await readJson<PackageJson>(path.join(dir, "package.json")))?.scripts ?? {},
    bin: (name) => resolveToolBin(name, binDirs),
  };
}

/** `--fix` only installs what is missing; it never rewrites code. */
async function ensureDependencies(ctx: RunContext): Promise<void> {
  const lockfileNames = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
  const hasPackageJson = await pathExists(path.join(ctx.repoRoot, "package.json"));
  if (!hasPackageJson) return;

  const hasModules = await pathExists(path.join(ctx.repoRoot, "node_modules"));
  let hasLockfile = false;
  for (const name of lockfileNames) {
    if (await isFile(path.join(ctx.repoRoot, name))) {
      hasLockfile = true;
      break;
    }
  }

  if (hasModules || !hasLockfile) return;

  ctx.log(`fix: installing dependencies in ${ctx.repoRoot} (node_modules is missing)`);
  const install = await ctx.exec(
    "npm",
    (await pathExists(path.join(ctx.repoRoot, "package-lock.json")))
      ? ["ci", "--no-audit", "--no-fund"]
      : ["install", "--no-audit", "--no-fund"],
    ctx.repoRoot,
  );

  if (install.code !== 0) {
    ctx.log(`fix: npm install failed (exit ${install.code ?? "unknown"}) — continuing with checks`);
  }
}

function summarize(results: PluginResult[], durationMs: number): PassSummary {
  const checks = results.flatMap((result) => result.checks);
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.filter((check) => check.status === "passed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  const blocked = results.filter((result) => result.blocked).length;

  return { ok: failed === 0, passed, failed, skipped, blocked, durationMs };
}

export async function runDiagnose(options: DiagnoseOptions = {}): Promise<DiagnoseOutcome> {
  const startedAt = Date.now();
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const repoRoot = await findRepoRoot(cwd);
  const config = await readEngineConfig(repoRoot);
  const quiet = options.quiet ?? false;
  const artifactsRoot = path.resolve(repoRoot, config.artifactsDir ?? "artifacts");
  const twoPass = options.twoPass ?? config.twoPass ?? true;
  const gate = options.gate ?? config.gate ?? true;

  const target = options.cassette
    ? await resolveCassette(repoRoot, options.cassette, config)
    : repoRoot;

  const ctx = createContext({
    repoRoot,
    target,
    cassette: options.cassette ?? null,
    fix: options.fix ?? false,
    quiet,
    artifactsRoot,
    config,
  });

  if (options.fix) await ensureDependencies(ctx);

  const extraDirs = pluginDirs(config).map((dir) => path.resolve(repoRoot, dir));
  const plugins = await loadPlugins([DEFAULT_PLUGINS_DIR, ...extraDirs]);

  // ---------------- PASS 1: syntax & structure ----------------
  let results = await runPlugins(plugins, ctx, { gate });
  let blockers = await reconcileBlockers({
    repoRoot,
    results,
    blockersFile: config.blockersFile,
    boardFile: config.boardFile,
  });

  // ---------------- PASS 2: logic & debt ----------------
  let pass2: Pass2Report | undefined;

  if (twoPass) {
    const first = await runPass2({ ctx, fix: options.fix ?? false });
    pass2 = first;

    // If Pass 2 built automation, Pass 1 is the proof: rerun, reconcile, re-analyse.
    if (first.fixes.some((fix) => fix.applied)) {
      ctx.log("pass 2: automation applied — verifying with Pass 1");
      results = await runPlugins(plugins, ctx, { gate });
      blockers = await reconcileBlockers({
        repoRoot,
        results,
        blockersFile: config.blockersFile,
        boardFile: config.boardFile,
      });
      pass2 = await runPass2({ ctx, fix: false, previousFixes: first.fixes });
    }
  }

  // ---------------- SIGNALS: flaky detection (reads artifacts, never runs tools) ----------------
  const flakyReport = await analyzeFlakiness({
    ctx,
    enabled: options.flaky ?? config.flaky?.enabled ?? true,
  });
  if (flakyReport.enabled) await writeFlakyArtifact(artifactsRoot, flakyReport);

  // ---------------- SIGNALS: impact selection & failure triage (read-only) ----------------
  const impactReport = await analyzeImpact({
    ctx,
    enabled: options.impact ?? config.impact?.enabled ?? true,
    base: config.impact?.base,
    adapter: config.impact?.adapter,
  });
  if (impactReport.enabled) await writeImpactArtifact(artifactsRoot, impactReport);

  const explainReport = await analyzeExplain({
    enabled: options.aiExplain ?? false,
    results,
    repoRoot,
  });
  if (explainReport.enabled) await writeExplainArtifact(artifactsRoot, explainReport);

  const aggregateJUnit = await writeAggregateJUnit(artifactsRoot, results);
  const durationMs = Date.now() - startedAt;
  const pass1Summary = summarize(results, durationMs);
  const flakyFailures = config.flaky?.failOnFlaky ? flakyReport.flaky.length : 0;
  const failed = pass1Summary.failed + (pass2?.summary.errors ?? 0) + flakyFailures;

  const report: DiagnosticReport = {
    engine: ENGINE_NAME,
    engineVersion: ENGINE_VERSION,
    generatedAt: new Date().toISOString(),
    target: {
      relative: ctx.relativeTarget,
      root: target,
      repoRoot,
      cassette: ctx.cassette,
    },
    artifacts: {
      root: artifactsRoot,
      junit: aggregateJUnit ?? path.join(artifactsRoot, "junit.xml"),
    },
    twoPass,
    summary: { ...pass1Summary, ok: failed === 0, failed, durationMs },
    pass1: {
      label: PASS1_LABEL,
      approach: PASS1_APPROACH,
      summary: pass1Summary,
      plugins: results,
    },
    pass2,
    signals: { flaky: flakyReport, impact: impactReport, explain: explainReport },
    blockers,
    availablePlugins: plugins.map((plugin) => plugin.id),
  };

  const reportPath = path.resolve(
    cwd,
    options.reportPath ?? config.reportPath ?? path.join(repoRoot, REPORT_FILENAME),
  );

  await writeReport(report, reportPath);
  if (!quiet) printReport(report, reportPath);

  return { report, reportPath, exitCode: report.summary.ok ? 0 : 1 };
}
