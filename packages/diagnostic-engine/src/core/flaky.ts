import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJUnitResults, testId, type JUnitCase } from "./junit-parse.js";
import type { CheckStatus, FlakyReport, FlakyTestRecord, RunContext } from "./types.js";

/**
 * Flaky detection without an external process.
 *
 * The engine already writes JUnit per plugin per run, so the missing ingredient is
 * history, not analysis: `flakeguard`/DeFlaky both need repeated executions to
 * compare. We keep the per-test outcomes we already produce (keyed by commit) and
 * score them the same way DeFlaky does: flake score = stable / tracked * 100.
 */
export const DEFAULT_HISTORY_FILE = path.join(".deepdiagnose", "flaky-history.json");
export const DEFAULT_MIN_RUNS = 3;
export const DEFAULT_MAX_RUNS = 50;

interface HistoryRun {
  runAt: string;
  commit: string;
  dirty: boolean;
  tests: Record<string, CheckStatus>;
}

interface History {
  version: number;
  runs: HistoryRun[];
}

async function readHistory(file: string): Promise<History> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<History>;
    if (Array.isArray(parsed.runs)) {
      return {
        version: 1,
        runs: parsed.runs.filter(
          (run): run is HistoryRun =>
            Boolean(run) && typeof run.commit === "string" && typeof run.tests === "object",
        ),
      };
    }
  } catch {
    // No history yet (or corrupt): start clean rather than fail the run.
  }
  return { version: 1, runs: [] };
}

async function gitInfo(ctx: RunContext): Promise<{ commit: string; dirty: boolean }> {
  const rev = await ctx.exec("git", ["rev-parse", "--short", "HEAD"], ctx.repoRoot);
  const status = await ctx.exec("git", ["status", "--porcelain"], ctx.repoRoot);

  return {
    commit: rev.code === 0 ? rev.stdout.trim() || "unknown" : "unknown",
    dirty: status.code === 0 && status.stdout.trim().length > 0,
  };
}

function classify(
  passes: number,
  failures: number,
  runs: number,
  minRuns: number,
): FlakyTestRecord["status"] {
  if (passes > 0 && failures > 0) return runs >= minRuns ? "flaky" : "insufficient-history";
  if (failures > 0) return "stable-failing";
  return runs >= minRuns ? "stable-passing" : "insufficient-history";
}

export interface FlakyParams {
  ctx: RunContext;
  /** `--no-flaky` disables the signal entirely. */
  enabled: boolean;
}

export async function analyzeFlakiness(params: FlakyParams): Promise<FlakyReport> {
  const startedAt = Date.now();
  const { ctx } = params;
  const config = ctx.config.flaky ?? {};
  const minRuns = config.minRuns ?? DEFAULT_MIN_RUNS;
  const maxRuns = config.maxRuns ?? DEFAULT_MAX_RUNS;
  const historyFile = path.resolve(
    ctx.repoRoot,
    config.historyFile ?? DEFAULT_HISTORY_FILE,
  );

  if (!params.enabled) {
    return {
      enabled: false,
      historyFile,
      commit: "unknown",
      dirty: false,
      runsStored: 0,
      testsTracked: 0,
      flakeScore: 100,
      minRuns,
      flaky: [],
      stableFailing: [],
      insufficient: 0,
      durationMs: Date.now() - startedAt,
      note: "disabled with --no-flaky",
    };
  }

  const cases = await readJUnitResults(ctx.artifactsRoot);
  const { commit, dirty } = await gitInfo(ctx);

  if (cases.length === 0) {
    return {
      enabled: true,
      historyFile,
      commit,
      dirty,
      runsStored: (await readHistory(historyFile)).runs.length,
      testsTracked: 0,
      flakeScore: 100,
      minRuns,
      flaky: [],
      stableFailing: [],
      insufficient: 0,
      durationMs: Date.now() - startedAt,
      note: "no JUnit results found — run Pass 1 with a test runner to start the history",
    };
  }

  // Record this run before scoring, so the current outcome is part of the history.
  const history = await readHistory(historyFile);
  const current: Record<string, CheckStatus> = {};
  for (const test of cases) current[testId(test)] = test.status;

  history.runs.push({
    runAt: new Date().toISOString(),
    commit,
    dirty,
    tests: current,
  });
  history.runs = history.runs.slice(-maxRuns);
  history.version = 1;

  await mkdir(path.dirname(historyFile), { recursive: true });
  await writeFile(historyFile, `${JSON.stringify(history, null, 2)}\n`, "utf8");

  // Score every test seen in this run across the stored history.
  const byId = new Map<string, JUnitCase>();
  for (const test of cases) byId.set(testId(test), test);

  const records: FlakyTestRecord[] = [];

  for (const [id, test] of byId) {
    const outcomes = history.runs
      .map((run) => run.tests[id])
      .filter((status): status is CheckStatus => Boolean(status));

    const passes = outcomes.filter((status) => status === "passed").length;
    const failures = outcomes.filter((status) => status === "failed").length;
    const skips = outcomes.filter((status) => status === "skipped").length;

    // Definitive proof: both outcomes at the same commit.
    const mixedByCommit = new Map<string, Set<CheckStatus>>();
    for (const run of history.runs) {
      const status = run.tests[id];
      if (!status) continue;
      const set = mixedByCommit.get(run.commit) ?? new Set<CheckStatus>();
      set.add(status);
      mixedByCommit.set(run.commit, set);
    }
    const sameCommitMixed = [...mixedByCommit.values()].some(
      (statuses) => statuses.has("passed") && statuses.has("failed"),
    );

    const runs = outcomes.length;
    const status = classify(passes, failures, runs, minRuns);

    records.push({
      id,
      plugin: test.plugin,
      name: test.name,
      classname: test.classname,
      runs,
      passes,
      failures,
      skips,
      flakeRate: runs > 0 ? Math.round((Math.min(passes, failures) / runs) * 1000) / 1000 : 0,
      sameCommitMixed,
      status,
      lastStatus: test.status,
      lastSeen: new Date().toISOString(),
    });
  }

  const flaky = records
    .filter((record) => record.status === "flaky")
    .sort((a, b) => b.flakeRate - a.flakeRate || Number(b.sameCommitMixed) - Number(a.sameCommitMixed));
  const stableFailing = records.filter((record) => record.status === "stable-failing");
  const insufficient = records.filter((record) => record.status === "insufficient-history").length;

  // DeFlaky semantics: score consistency, not pass/fail. A test that always fails is
  // stable; only outcome flipping reduces the score. Unseen-enough tests are excluded.
  const evaluated = records.filter((record) => record.status !== "insufficient-history");
  const consistent = evaluated.filter(
    (record) => record.status === "stable-passing" || record.status === "stable-failing",
  ).length;

  return {
    enabled: true,
    historyFile,
    commit,
    dirty,
    runsStored: history.runs.length,
    testsTracked: records.length,
    flakeScore: evaluated.length > 0 ? Math.round((consistent / evaluated.length) * 1000) / 10 : 100,
    minRuns,
    flaky,
    stableFailing,
    insufficient,
    durationMs: Date.now() - startedAt,
    ...(evaluated.length === 0
      ? { note: `history still building — ${records.length} test(s) below ${minRuns} runs` }
      : {}),
  };
}

/** Persist the signal as a standalone artifact next to the JUnit files. */
export async function writeFlakyArtifact(
  artifactsRoot: string,
  report: FlakyReport,
): Promise<string> {
  const dir = path.join(artifactsRoot, "flaky");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "report.json");
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
}
