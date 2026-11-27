import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { findPaths, isFile } from "./fs.js";
import { extractImports } from "./pass2-analysis.js";
import type { ImpactAdapterId, ImpactReport, RunContext } from "./types.js";

/**
 * Test impact selection: which tests can the working-tree diff even reach?
 *
 * Two adapters, one contract:
 *   - `@mizchi/test-impact` (optional, installed by the project): static TS/JS
 *     resolver + per-test V8 coverage, `--format json`.
 *   - the Pass 2 import graph: invert the import edges we already parse and walk
 *     from the changed files up to the tests that import them.
 *
 * Nothing here executes a test suite. Selection is a signal; running the selected
 * tests stays with the project's own runner.
 */

const SCRIPT_PATTERNS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
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
const IGNORED_PREFIXES = [
  "node_modules/",
  "artifacts/",
  ".deepdiagnose/",
  "dist/",
  "build/",
  "out/",
  "coverage/",
  "target/",
  ".git/",
];
const IGNORED_FILES = new Set(["diagnostic-report.json", "blockers.json", "UNRESOLVED.md"]);

function isRelevant(relativePath: string): boolean {
  const rel = normalize(relativePath);
  if (IGNORED_FILES.has(rel)) return false;
  return !IGNORED_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

async function gitLines(ctx: RunContext, args: string[]): Promise<string[]> {
  const result = await ctx.exec("git", args, ctx.target);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveSpecifier(fromDir: string, spec: string): Promise<string | null> {
  const base = path.resolve(fromDir, spec);
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => `${base}${ext}`),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
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

/** Walk the inverted import graph until every test that reaches a change is found. */
async function selectViaGraph(
  ctx: RunContext,
  changedAbsolute: string[],
  files: string[],
): Promise<string[]> {
  const importers = new Map<string, Set<string>>();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const ref of extractImports(text)) {
      if (!ref.spec.startsWith(".")) continue;
      const resolved = await resolveSpecifier(path.dirname(file), ref.spec);
      if (!resolved) continue;
      const bucket = importers.get(resolved) ?? new Set<string>();
      bucket.add(file);
      importers.set(resolved, bucket);
    }
  }

  const selected = new Set<string>();
  const queue = [...changedAbsolute];
  const seen = new Set(queue);

  while (queue.length > 0) {
    const current = queue.pop() as string;
    const relative = normalize(path.relative(ctx.target, current));
    if (!relative.startsWith("..") && isTestFile(relative)) selected.add(relative);

    for (const importer of importers.get(current) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }

  return [...selected].sort();
}

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

  if (adapter !== "mizchi-test-impact") {
    selectedTests = await selectViaGraph(ctx, changedAbsolute, files);
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
