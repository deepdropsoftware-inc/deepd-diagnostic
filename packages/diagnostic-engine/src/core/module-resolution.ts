import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { findPaths, isFile } from "./fs.js";

/**
 * One module resolver for Pass 2 and test impact.
 *
 * The two used to carry their own copy of "try extensions, then index" and drifted:
 * Pass 2 learned the NodeNext `.js` → `.ts` rewrite, impact never did, so impact
 * silently resolved nothing in an ESM TypeScript repository. Resolution now lives
 * here once and both passes call it.
 *
 * Policy: anything ambiguous is left unresolved rather than guessed. A missed
 * selection is a signal the caller reports; a wrong selection is a lie.
 */

const MODULE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

/** NodeNext emits `./foo.js` from `foo.ts`; resolve the source, not the build output. */
const TS_REWRITES: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const MAX_EXTENDS_DEPTH = 10;
const MAX_PROJECTS = 50;

export interface AliasPattern {
  pattern: string;
  targets: string[];
}

/** A `paths` entry paired with the directory its targets resolve against. */
export interface AliasEntry extends AliasPattern {
  baseUrl: string;
}

/** Kept for compatibility with callers that only need the root config. */
export interface AliasConfig {
  baseUrl: string;
  paths: AliasPattern[];
  entries?: AliasEntry[];
}

export interface TsProject {
  configPath: string;
  dir: string;
  baseUrl: string;
  aliases: AliasEntry[];
  include?: string[];
  exclude?: string[];
  files?: string[];
}

export interface ResolutionStats {
  /** Relative or alias specifiers that matched nothing. */
  unresolved: number;
  /** Specifiers with more than one equally-long alias match. */
  ambiguous: number;
  /** Bare package specifiers, which are not ours to resolve. */
  bare: number;
}

export function emptyResolutionStats(): ResolutionStats {
  return { unresolved: 0, ambiguous: 0, bare: 0 };
}

/* ------------------------------------------------------------------- config */

/** tsconfig is JSONC in practice: comments and trailing commas must not break us. */
export function parseJsonc(text: string): unknown {
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

interface RawTsConfig {
  dir: string;
  baseUrl?: string;
  pathBaseUrl?: string;
  paths?: AliasPattern[];
  include?: string[];
  exclude?: string[];
  files?: string[];
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeSlashes(file: string): string {
  return file.split(path.sep).join("/");
}

/** Resolve one `extends` entry the way tsc does: relative, or a package path. */
function resolveExtends(fromDir: string, spec: string): string | null {
  const candidates: string[] = [];
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    const base = path.resolve(fromDir, spec);
    candidates.push(base, `${base}.json`, path.join(base, "tsconfig.json"));
  } else {
    try {
      const require = createRequire(path.join(fromDir, "noop.js"));
      const resolved = require.resolve(spec);
      candidates.push(resolved, `${resolved}.json`, path.join(resolved, "tsconfig.json"));
    } catch {
      try {
        const require = createRequire(path.join(fromDir, "noop.js"));
        candidates.push(require.resolve(path.join(spec, "tsconfig.json")));
      } catch {
        return null;
      }
    }
  }

  for (const candidate of candidates) {
    if (candidate.endsWith(".json")) return candidate;
  }
  return candidates[0] ?? null;
}

async function readConfigFile(
  file: string,
  seen: Set<string>,
  depth: number,
): Promise<RawTsConfig | null> {
  const configPath = path.resolve(file);
  if (depth > MAX_EXTENDS_DEPTH || seen.has(configPath)) return null;
  seen.add(configPath);

  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  const parsed = parseJsonc(text) as
    | {
        extends?: string | string[];
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
        include?: unknown;
        exclude?: unknown;
        files?: unknown;
      }
    | undefined;
  if (!parsed || typeof parsed !== "object") return null;

  const dir = path.dirname(configPath);
  const extendsList =
    typeof parsed.extends === "string"
      ? [parsed.extends]
      : Array.isArray(parsed.extends)
        ? parsed.extends.filter((item): item is string => typeof item === "string")
        : [];

  // Parents first, then this file: tsc merges compilerOptions with the child winning.
  let inherited: RawTsConfig = { dir };
  for (const parentSpec of extendsList) {
    const parentFile = resolveExtends(dir, parentSpec);
    if (!parentFile) continue;
    const parent = await readConfigFile(parentFile, seen, depth + 1);
    if (!parent) continue;
    inherited = {
      dir: parent.dir,
      baseUrl: parent.baseUrl ?? inherited.baseUrl,
      pathBaseUrl: parent.pathBaseUrl ?? inherited.pathBaseUrl,
      paths: parent.paths ?? inherited.paths,
      include: parent.include ?? inherited.include,
      exclude: parent.exclude ?? inherited.exclude,
      files: parent.files ?? inherited.files,
    };
  }
  seen.delete(configPath);

  const options = parsed.compilerOptions ?? {};
  const childBaseUrl =
    typeof options.baseUrl === "string" ? path.resolve(dir, options.baseUrl) : undefined;

  const rawPaths = options.paths;
  const paths: AliasPattern[] | undefined =
    rawPaths && typeof rawPaths === "object"
      ? Object.entries(rawPaths)
          .filter((entry): entry is [string, string[]] => {
            const [, targets] = entry;
            return Array.isArray(targets) && targets.every((item) => typeof item === "string");
          })
          .map(([pattern, targets]) => ({ pattern, targets }))
      : inherited.paths;

  // A child that declares `paths` replaces the parent's set, and those targets
  // resolve against the child's own baseUrl (or the child's directory).
  const declaresPaths = Boolean(rawPaths && typeof rawPaths === "object");
  const pathBaseUrl = declaresPaths
    ? (childBaseUrl ?? dir)
    : (inherited.pathBaseUrl ?? childBaseUrl ?? inherited.baseUrl);

  return {
    dir,
    baseUrl: childBaseUrl ?? inherited.baseUrl,
    pathBaseUrl,
    paths,
    include: stringArray(parsed.include) ?? inherited.include,
    exclude: stringArray(parsed.exclude) ?? inherited.exclude,
    files: stringArray(parsed.files) ?? inherited.files,
  };
}

function toProject(configPath: string, raw: RawTsConfig): TsProject {
  const baseUrl = raw.pathBaseUrl ?? raw.baseUrl ?? raw.dir;
  const aliases: AliasEntry[] = (raw.paths ?? []).map((entry) => ({ ...entry, baseUrl }));

  return {
    configPath,
    dir: raw.dir,
    baseUrl,
    aliases,
    ...(raw.include ? { include: raw.include } : {}),
    ...(raw.exclude ? { exclude: raw.exclude } : {}),
    ...(raw.files ? { files: raw.files } : {}),
  };
}

/** Every tsconfig/jsconfig under `target`, longest path first. */
export async function loadTsProjects(target: string): Promise<TsProject[]> {
  const configs = await findPaths(target, ["tsconfig.json", "jsconfig.json"], 6);
  const projects: TsProject[] = [];

  for (const configPath of configs.slice(0, MAX_PROJECTS)) {
    const raw = await readConfigFile(configPath, new Set(), 0);
    if (raw) projects.push(toProject(configPath, raw));
  }

  return projects.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
}

/* --------------------------------------------------------------- glob match */

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeSlashes(pattern).replace(/^\.\//, "");
  let regex = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string;
    const next = normalized[index + 1];

    if (char === "*" && next === "*") {
      const slashAfter = normalized[index + 2] === "/";
      regex += slashAfter ? "(?:.*/)?" : ".*";
      index += slashAfter ? 2 : 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${regex}$`);
}

function matchesGlob(relativePath: string, pattern: string): boolean {
  const normalized = normalizeSlashes(pattern).replace(/\/+$/, "");
  if (!normalized) return false;

  const hasWildcard = /[*?]/.test(normalized);
  const looksLikeFile = /\.[A-Za-z0-9]+$/.test(normalized);
  const expanded = hasWildcard
    ? normalized
    : looksLikeFile
      ? normalized
      : `${normalized}/**/*`;

  if (globToRegExp(expanded).test(relativePath)) return true;
  // `include: ["src"]` also covers `src/index.ts` itself.
  return !looksLikeFile && (relativePath === normalized || relativePath.startsWith(`${normalized}/`));
}

function isAncestor(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function projectCovers(project: TsProject, file: string): boolean {
  const relative = normalizeSlashes(path.relative(project.dir, file));
  const excluded = (project.exclude ?? []).some((pattern) => matchesGlob(relative, pattern));
  if (excluded) return false;

  if (project.files) {
    return project.files.some((entry) => normalizeSlashes(entry) === relative);
  }
  if (project.include) {
    return project.include.some((pattern) => matchesGlob(relative, pattern));
  }
  return true;
}

/**
 * Pick the config that owns `file`: deepest ancestor whose include/exclude or
 * `files` list accepts it. Falls back to the deepest ancestor config so aliases
 * still apply when the include patterns are unusual.
 */
export function projectForFile(projects: TsProject[], file: string): TsProject | undefined {
  const ancestors = projects.filter((project) => isAncestor(project.dir, file));
  const covered = ancestors.find((project) => projectCovers(project, file));
  return covered ?? ancestors[0];
}

/* ------------------------------------------------------------------- lookup */

/** Root-level alias view, kept for the existing public helper. */
export async function loadAliases(target: string): Promise<AliasConfig | null> {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = path.join(target, name);
    const raw = await readConfigFile(file, new Set(), 0);
    if (!raw || !raw.paths || raw.paths.length === 0) continue;

    const project = toProject(file, raw);
    return {
      baseUrl: project.baseUrl,
      paths: raw.paths,
      entries: project.aliases,
    };
  }

  return null;
}

interface AliasCandidate {
  pattern: string;
  base: string;
  prefix: number;
}

/**
 * All `paths` entries that match `spec`. tsc prefers the longest prefix and, inside
 * one pattern, the first target that exists; two patterns with the same prefix are
 * a genuine tie, which the caller leaves unresolved.
 */
function aliasCandidates(spec: string, entries: AliasEntry[]): AliasCandidate[] {
  const candidates: AliasCandidate[] = [];

  for (const entry of entries) {
    const star = entry.pattern.indexOf("*");
    if (star === -1) {
      if (spec === entry.pattern) {
        for (const target of entry.targets) {
          candidates.push({
            pattern: entry.pattern,
            base: path.resolve(entry.baseUrl, target),
            prefix: entry.pattern.length,
          });
        }
      }
      continue;
    }

    const prefix = entry.pattern.slice(0, star);
    const suffix = entry.pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;

    const captured = spec.slice(prefix.length, spec.length - suffix.length);
    for (const target of entry.targets) {
      candidates.push({
        pattern: entry.pattern,
        base: path.resolve(entry.baseUrl, target.replace("*", captured)),
        prefix: prefix.length,
      });
    }
  }

  return candidates;
}

/** Does this bare specifier look like one of the project's aliases? */
export function isAliasSpecifier(spec: string, project: TsProject | undefined): boolean {
  if (!project || spec.startsWith(".") || spec.startsWith("/")) return false;
  return aliasCandidates(spec, project.aliases).length > 0;
}

function withExtensions(base: string): string[] {
  const declared = path.extname(base);
  const rewrites = declared ? TS_REWRITES[declared] : undefined;
  const candidates: string[] = [];

  // NodeNext: `./b.js` means `b.ts`, so the source rewrite comes before the file itself.
  if (rewrites) {
    const stem = base.slice(0, base.length - declared.length);
    for (const rewrite of rewrites) candidates.push(`${stem}${rewrite}`);
  }

  candidates.push(base);
  for (const extension of MODULE_EXTENSIONS) candidates.push(`${base}${extension}`);
  for (const extension of MODULE_EXTENSIONS) candidates.push(path.join(base, `index${extension}`));

  return candidates;
}

async function firstFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

export interface ResolveParams {
  fromFile: string;
  spec: string;
  /** Owning tsconfig, when one was found. */
  project?: TsProject;
  /** Directory used for root-absolute specifiers (`/foo`). */
  root?: string;
}

export type Resolution =
  | { path: string; reason: "resolved" }
  | { path: null; reason: "bare" | "missing" | "ambiguous" };

/**
 * Resolve an import specifier to a file on disk.
 *
 * - relative specifiers always resolve against the importing file;
 * - root-absolute specifiers resolve against `root`;
 * - bare specifiers resolve only through tsconfig `paths` aliases;
 * - equally-long alias patterns resolving to different files are ambiguous → null.
 */
export async function resolveSpecifier(params: ResolveParams): Promise<Resolution> {
  const { fromFile, spec, project, root } = params;

  if (spec.startsWith(".")) {
    const resolved = await firstFile(withExtensions(path.resolve(path.dirname(fromFile), spec)));
    return resolved ? { path: resolved, reason: "resolved" } : { path: null, reason: "missing" };
  }

  if (spec.startsWith("/")) {
    const base = root ?? project?.dir;
    if (!base) return { path: null, reason: "missing" };
    const resolved = await firstFile(withExtensions(path.resolve(base, spec.replace(/^\/+/, ""))));
    return resolved ? { path: resolved, reason: "resolved" } : { path: null, reason: "missing" };
  }

  if (!project) return { path: null, reason: "bare" };

  const candidates = aliasCandidates(spec, project.aliases);
  if (candidates.length === 0) return { path: null, reason: "bare" };

  const longest = Math.max(...candidates.map((candidate) => candidate.prefix));
  const best = candidates.filter((candidate) => candidate.prefix === longest);
  const patterns = [...new Set(best.map((candidate) => candidate.pattern))];

  if (patterns.length === 1) {
    // One pattern: tsc takes its first existing target, in declaration order.
    for (const candidate of best) {
      const found = await firstFile(withExtensions(candidate.base));
      if (found) return { path: found, reason: "resolved" };
    }
    return { path: null, reason: "missing" };
  }

  // Equal-length patterns: only accept the tie when every pattern agrees.
  const resolved: string[] = [];
  for (const pattern of patterns) {
    const candidate = best.find((entry) => entry.pattern === pattern);
    if (!candidate) continue;
    const found = await firstFile(withExtensions(candidate.base));
    if (found) resolved.push(found);
  }

  const unique = [...new Set(resolved)];
  if (unique.length > 1) return { path: null, reason: "ambiguous" };
  if (unique.length === 1) return { path: unique[0] as string, reason: "resolved" };
  return { path: null, reason: "missing" };
}

/** Resolve a specifier and fold the outcome into caller-owned counters. */
export async function resolveSpecifierInto(
  params: ResolveParams,
  stats: ResolutionStats,
): Promise<string | null> {
  const resolution = await resolveSpecifier(params);
  if (resolution.path) return resolution.path;
  if (resolution.reason === "bare") stats.bare += 1;
  else if (resolution.reason === "ambiguous") stats.ambiguous += 1;
  else stats.unresolved += 1;
  return null;
}
