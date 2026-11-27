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
 *     from the changed files up to the tests that import them. `tsconfig` path
 *     aliases (`@/*`) are resolved so an aliased edge is not a blind spot.
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
const IGNORED_DIRS =
  /(?:^|\/)(?:node_modules|artifacts|\.deepdiagnose|dist|build|out|coverage|target|\.git)\//;
const IGNORED_FILES = new Set(["diagnostic-report.json", "blockers.json", "UNRESOLVED.md"]);

function isRelevant(relativePath: string): boolean {
  const rel = normalize(relativePath);
  if (IGNORED_FILES.has(rel)) return false;
  return !IGNORED_DIRS.test(rel);
}

/* ------------------------------------------------------------- path aliases */

export interface AliasConfig {
  /** Absolute directory the `paths` targets resolve against. */
  baseUrl: string;
  paths: Array<{ pattern: string; targets: string[] }>;
}

/** tsconfig is JSONC in practice: comments and trailing commas must not break us. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let quote = "";

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }

    out += char;
  }

  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

/** Read `compilerOptions.paths` from tsconfig.json / jsconfig.json, if present. */
export async function loadAliases(target: string): Promise<AliasConfig | null> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(target, name);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    const parsed = parseJsonc(text) as
      | { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
      | undefined;
    const options = parsed?.compilerOptions;
    if (!options?.paths) continue;

    const paths = Object.entries(options.paths)
      .filter(([, targets]) => Array.isArray(targets) && targets.length > 0)
      .map(([pattern, targets]) => ({ pattern, targets }));

    return {
      baseUrl: path.resolve(target, options.baseUrl ?? "."),
      paths,
    };
  }

  return null;
}

function aliasCandidates(spec: string, aliases: AliasConfig): string[] {
  const candidates: string[] = [];

  for (const entry of aliases.paths) {
    const star = entry.pattern.indexOf("*");
    if (star === -1) {
      if (spec === entry.pattern) {
        candidates.push(...entry.targets.map((target) => path.resolve(aliases.baseUrl, target)));
      }
      continue;
    }

    const prefix = entry.pattern.slice(0, star);
    const suffix = entry.pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;

    const captured = spec.slice(prefix.length, spec.length - suffix.length);
    for (const target of entry.targets) {
      candidates.push(path.resolve(aliases.baseUrl, target.replace("*", captured)));
    }
  }

  return candidates;
}

function withExtensions(base: string): string[] {
  return [base, ...EXTENSIONS.map((ext) => `${base}${ext}`), ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`))];
}

async function firstFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

async function resolveSpecifier(
  fromDir: string,
  spec: string,
  aliases: AliasConfig | null,
): Promise<string | null> {
  if (spec.startsWith(".")) {
    return firstFile(withExtensions(path.resolve(fromDir, spec)));
  }

  if (!aliases) return null;
  for (const base of aliasCandidates(spec, aliases)) {
    const resolved = await firstFile(withExtensions(base));
    if (resolved) return resolved;
  }
  return null;
}

/* ------------------------------------------------------------- graph adapter */

/**
 * Walk the inverted import graph from every changed file up to the tests that
 * reach it. Exported so the alias behaviour is testable without a full engine run.
 */
export async function selectFromGraph(params: {
  target: string;
  changed: string[];
  files: string[];
}): Promise<string[]> {
  const { target, changed, files } = params;
  const aliases = await loadAliases(target);
  const importers = new Map<string, Set<string>>();

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const ref of extractImports(text)) {
      if (!ref.spec.startsWith(".") && !aliases) continue;
      const resolved = await resolveSpecifier(path.dirname(file), ref.spec, aliases);
      if (!resolved) continue;
      const bucket = importers.get(resolved) ?? new Set<string>();
      bucket.add(file);
      importers.set(resolved, bucket);
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

  if (adapter !== "mizchi-test-impact") {
    selectedTests = await selectFromGraph({ target: ctx.target, changed: changedAbsolute, files });
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
