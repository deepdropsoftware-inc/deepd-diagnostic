import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findPaths } from "./fs.js";
import {
  emptyResolutionStats,
  isAliasSpecifier,
  loadTsProjects,
  projectForFile,
  resolveSpecifier,
  type ResolutionStats,
  type TsProject,
} from "./module-resolution.js";
import { extractImports } from "./pass2-analysis.js";
import type { ImpactAdapterId, ImpactReport, RunContext } from "./types.js";

/**
 * Test impact selection: which tests can the working-tree diff even reach?
 *
 * Two adapters, one contract:
 *   - `@mizchi/test-impact` (optional, installed by the project): static TS/JS
 *     resolver + per-test V8 coverage, `--format json`.
 *   - the Pass 2 import graph: invert the import edges we already parse and walk
 *     from the changed files up to the tests that import them. Resolution is
 *     shared with Pass 2 (module-resolution.ts), so NodeNext `.js` specifiers,
 *     tsconfig `paths` aliases and `extends` chains behave the same in both.
 *
 * Nothing here executes a test suite. Selection is a signal; running the selected
 * tests stays with the project's own runner.
 */

const SCRIPT_PATTERNS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const MAX_FILES = 2_000;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIR = /(?:^|\/)(?:__tests__|tests?)\//;

function normalize(relativePath: string): string {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function isTestFile(relativePath: string): boolean {
  return TEST_FILE.test(relativePath) || TEST_DIR.test(relativePath);
}

/** Build output, caches and our own artifacts are not source changes. */
const IGNORED_DIRS =
  /(?:^|\/)(?:node_modules|artifacts|\.deepdiagnose|dist|build|out|coverage|target|\.git)\//;
const IGNORED_FILES = new Set(["diagnostic-report.json", "blockers.json", "UNRESOLVED.md"]);

function isRelevant(relativePath: string): boolean {
  const rel = normalize(relativePath);
  if (IGNORED_FILES.has(rel)) return false;
  return !IGNORED_DIRS.test(rel);
}

/* ------------------------------------------------------------- path aliases */

// The resolver and its alias loader live in module-resolution.ts so Pass 2 and
// impact cannot drift apart again. Re-exported here for existing callers/tests.
export { loadAliases } from "./module-resolution.js";
export type { AliasConfig } from "./module-resolution.js";

/* ------------------------------------------------------------- graph adapter */

/**
 * Walk the inverted import graph from every changed file up to the tests that
 * reach it. Exported so the alias behaviour is testable without a full engine run.
 */
export async function selectFromGraph(params: {
  target: string;
  changed: string[];
  files: string[];
  /** Optional counters so a partial selection is visible in the report. */
  stats?: ResolutionStats;
}): Promise<string[]> {
  const { target, changed, files } = params;
  const projects = await loadTsProjects(target);
  const projectByFile = new Map<string, TsProject | undefined>();
  const importers = new Map<string, Set<string>>();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const project = projectForFile(projects, file);
    projectByFile.set(file, project);

    for (const ref of extractImports(text)) {
      const resolution = await resolveSpecifier({
        fromFile: file,
        spec: ref.spec,
        project,
        root: target,
      });

      if (!resolution.path) {
        if (params.stats) {
          if (resolution.reason === "ambiguous") params.stats.ambiguous += 1;
          else if (resolution.reason === "bare") {
            // A bare package specifier is expected; one that looks like an alias is a gap.
            if (isAliasSpecifier(ref.spec, project)) params.stats.unresolved += 1;
            else params.stats.bare += 1;
          } else params.stats.unresolved += 1;
        }
        continue;
      }

      const bucket = importers.get(resolution.path) ?? new Set<string>();
      bucket.add(file);
      importers.set(resolution.path, bucket);
    }
  }

  const selected = new Set<string>();
  const queue = [...changed];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const relative = normalize(path.relative(target, current));
    if (!relative.startsWith("..") && isTestFile(relative)) selected.add(relative);

    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }

  return [...selected].sort();
}

/* ------------------------------------------------------------------ git diff */

async function gitLines(ctx: RunContext, args: string[]): Promise<string[]> {
  const result = await ctx.exec("git", args, ctx.target);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function collectChanges(ctx: RunContext, base: string): Promise<{ top: string; files: string[] }> {
  const top = (await gitLines(ctx, ["rev-parse", "--show-toplevel"]))[0];
  if (!top) return { top: ctx.target, files: [] };

  const groups = await Promise.all([
    gitLines(ctx, ["diff", "--name-only", base, "--"]),
    gitLines(ctx, ["diff", "--name-only", `${base}...HEAD`, "--"]),
    gitLines(ctx, ["ls-files", "--others", "--exclude-standard"]),
  ]);

  return {
    top: path.resolve(ctx.target, top),
    files: [...new Set(groups.flat())].filter(isRelevant),
  };
}

/* ------------------------------------------------------- @mizchi/test-impact */

function parseJsonLoose(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through: npm banners can precede the payload.
  }

  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Tolerant reader: the CLI's JSON shape may grow, so pick file-ish strings anywhere. */
function collectPaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 4 || value === null || value === undefined) return;

  if (typeof value === "string") {
    out.push(normalize(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["file", "path", "testFile", "test", "name"]) {
      if (typeof record[key] === "string") {
        collectPaths(record[key], out, depth + 1);
        return;
      }
    }
    for (const key of ["files", "tests", "selected", "selectedTests", "matches", "result"]) {
      if (key in record) collectPaths(record[key], out, depth + 1);
    }
  }
}

async function runMizchi(
  ctx: RunContext,
  bin: string,
  base: string,
): Promise<{ tests: string[] } | { error: string }> {
  const result = await ctx.exec(bin, ["--since", base, "--format", "json"], ctx.target);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? "";
    return { error: `test-impact exited ${result.code ?? "?"}${detail ? `: ${detail}` : ""}` };
  }

  const parsed = parseJsonLoose(result.stdout);
  if (parsed === undefined) return { error: "test-impact produced no parsable JSON" };

  const paths: string[] = [];
  collectPaths(parsed, paths);
  return { tests: [...new Set(paths.filter(isTestFile))].sort() };
}

/* -------------------------------------------------------------------- report */

export interface ImpactOptions {
  ctx: RunContext;
  enabled: boolean;
  /** Git revision to compare against. Default: HEAD (working tree). */
  base?: string;
  /** auto: prefer @mizchi/test-impact, fall back to the graph. */
  adapter?: "auto" | "mizchi" | "graph";
}

export async function analyzeImpact(options: ImpactOptions): Promise<ImpactReport> {
  const startedAt = Date.now();
  const { ctx, enabled } = options;
  const base = options.base ?? "HEAD";
  const adapterChoice = options.adapter ?? "auto";

  if (!enabled) {
    return {
      enabled: false,
      adapter: "none",
      base,
      changedFiles: [],
      selectedTests: [],
      candidates: 0,
      reductionPct: 0,
      durationMs: Date.now() - startedAt,
      note: "disabled with --no-impact",
    };
  }

  const { top, files: changed } = await collectChanges(ctx, base);
  const files = (await findPaths(ctx.target, SCRIPT_PATTERNS, 6))
    .filter((file) => !file.endsWith(".d.ts"))
    .filter((file) => isRelevant(normalize(path.relative(ctx.target, file))))
    .slice(0, MAX_FILES);
  const candidates = files.filter((file) => isTestFile(normalize(path.relative(ctx.target, file))));

  const changedAbsolute = changed
    .map((file) => path.resolve(top, file))
    .filter((file) => !normalize(path.relative(ctx.target, file)).startsWith(".."));

  if (changed.length === 0) {
    return {
      enabled: true,
      adapter: "graph",
      base,
      changedFiles: [],
      selectedTests: [],
      candidates: candidates.length,
      reductionPct: 0,
      durationMs: Date.now() - startedAt,
      note: `no changes against ${base} — nothing to select`,
    };
  }

  let fallbackReason: string | undefined;
  let adapter: ImpactAdapterId = "graph";
  let selectedTests: string[] = [];

  const bin = adapterChoice === "graph" ? null : ctx.bin("test-impact");
  if (adapterChoice === "mizchi" && !bin) {
    fallbackReason = "@mizchi/test-impact is not installed in this project";
  }

  if (bin) {
    const outcome = await runMizchi(ctx, bin, base);
    if ("tests" in outcome) {
      adapter = "mizchi-test-impact";
      selectedTests = outcome.tests;
    } else {
      fallbackReason = outcome.error;
    }
  }

  const stats = emptyResolutionStats();
  if (adapter !== "mizchi-test-impact") {
    selectedTests = await selectFromGraph({
      target: ctx.target,
      changed: changedAbsolute,
      files,
      stats,
    });
  }

  const reductionPct =
    candidates.length > 0
      ? Math.round(((candidates.length - selectedTests.length) / candidates.length) * 1000) / 10
      : 0;

  return {
    enabled: true,
    adapter,
    base,
    changedFiles: changed.slice(0, 200),
    selectedTests,
    candidates: candidates.length,
    reductionPct: Math.max(0, reductionPct),
    durationMs: Date.now() - startedAt,
    unresolvedSpecifiers: stats.unresolved,
    ambiguousSpecifiers: stats.ambiguous,
    ...(fallbackReason ? { fallbackReason: `fallback: ${fallbackReason}` } : {}),
  };
}

export async function writeImpactArtifact(
  artifactsRoot: string,
  report: ImpactReport,
): Promise<void> {
  const dir = path.join(artifactsRoot, "impact");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
