import { readFile } from "node:fs/promises";
import path from "node:path";
import { findPaths, isFile } from "./fs.js";
import type { Pass2Finding } from "./types.js";

/**
 * Pass 2 analysis is relational, not rule-per-file: it builds a reference graph
 * between artifacts and asks whether the edges actually land on something.
 *
 * It deliberately avoids full language servers. The checks below are conservative:
 * anything ambiguous (package specifiers, `export *`, CommonJS) is skipped rather
 * than reported, so CI is not broken by a heuristic.
 */

const HTML_PATTERNS = ["*.html", "*.htm"];
const SCRIPT_PATTERNS = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];
const PYTHON_PATTERNS = ["*.py"];

const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"];

export interface ScanOptions {
  /** Substring matches (relative to the target) to leave out of the scan. */
  ignore?: string[];
  maxFiles?: number;
}

function relative(target: string, file: string): string {
  return path.relative(target, file) || ".";
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function isExternalSpecifier(spec: string): boolean {
  return (
    /^(?:https?:)?\/\//.test(spec) ||
    /^(?:data|mailto|tel|javascript|blob):/.test(spec) ||
    spec.startsWith("#") ||
    spec.length === 0
  );
}

function stripQuery(spec: string): string {
  return spec.split(/[?#]/)[0] ?? spec;
}

function ignored(file: string, target: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const rel = relative(target, file);
  return patterns.some((pattern) => rel.includes(pattern));
}

/** Collect the files Pass 2 should relate to each other. */
export async function collectSourceFiles(
  target: string,
  options: ScanOptions = {},
): Promise<{ html: string[]; scripts: string[]; python: string[]; all: string[] }> {
  const maxFiles = options.maxFiles ?? 2_000;
  const ignore = options.ignore ?? [];

  const gather = async (patterns: string[]) => {
    const found = await findPaths(target, patterns, 6);
    return found
      .filter((file) => !file.endsWith(".d.ts"))
      .filter((file) => !ignored(file, target, ignore))
      .sort()
      .slice(0, maxFiles);
  };

  const html = await gather(HTML_PATTERNS);
  const scripts = await gather(SCRIPT_PATTERNS);
  const python = await gather(PYTHON_PATTERNS);

  return { html, scripts, python, all: [...html, ...scripts, ...python] };
}

/* ------------------------------------------------------------------ assets */

interface HtmlRef {
  tag: string;
  spec: string;
}

export function extractHtmlRefs(text: string): HtmlRef[] {
  const refs: HtmlRef[] = [];
  const tagPattern = /<(script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;

  for (const match of text.matchAll(tagPattern)) {
    refs.push({ tag: match[1] as string, spec: match[2] as string });
  }

  return refs;
}

async function resolveAsset(
  target: string,
  baseDir: string,
  spec: string,
): Promise<"found" | "missing" | "skip"> {
  const cleaned = stripQuery(spec).trim();
  if (isExternalSpecifier(cleaned)) return "skip";

  const rooted = cleaned.startsWith("/");
  const candidate = path.resolve(rooted ? target : baseDir, cleaned.replace(/^\//, ""));

  if (await isFile(candidate)) return "found";
  if (await isFile(path.join(candidate, "index.html"))) return "found";
  return "missing";
}

/** HTML → linked assets: does every script/link/img actually exist? */
export async function scanHtmlReferences(
  target: string,
  files: string[],
): Promise<Pass2Finding[]> {
  const findings: Pass2Finding[] = [];

  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;

    for (const ref of extractHtmlRefs(text)) {
      if ((await resolveAsset(target, path.dirname(file), ref.spec)) !== "missing") continue;

      // Root-absolute paths may be rewritten by a server/base path: warn, don't fail.
      const severity = ref.spec.startsWith("/") ? "warning" : "error";
      findings.push({
        id: `html:${relative(target, file)}:${ref.spec}`,
        kind: "broken-reference",
        severity,
        file: relative(target, file),
        reference: ref.spec,
        message: `<${ref.tag}> points to "${ref.spec}" which does not exist`,
        hint: "fix the path or add the missing asset",
      });
    }
  }

  return findings;
}

/* ----------------------------------------------------------------- modules */

interface ImportRef {
  spec: string;
  named: string[];
  hasDefault: boolean;
  hasNamespace: boolean;
}

interface ExportInfo {
  names: Set<string>;
  hasDefault: boolean;
  star: boolean;
  commonjs: boolean;
}

export function extractImports(text: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const statement = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g;

  for (const match of text.matchAll(statement)) {
    const clause = match[1] ?? "";
    const spec = match[2] as string;
    const braces = /\{([^}]*)\}/.exec(clause);
    const named = (braces?.[1] ?? "")
      .split(",")
      // `import { type Foo }` declares a type, not a symbol called "type Foo".
      .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "")
      .filter((name) => name.length > 0);

    refs.push({
      spec,
      named,
      hasDefault: /^[A-Za-z_$][\w$]*\s*(?:,|$)/.test(clause.trim()),
      hasNamespace: /\*\s*as\s+[A-Za-z_$]/.test(clause),
    });
  }

  for (const match of text.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) {
    refs.push({ spec: match[1] as string, named: [], hasDefault: false, hasNamespace: false });
  }

  for (const match of text.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    refs.push({ spec: match[1] as string, named: [], hasDefault: false, hasNamespace: false });
  }

  return refs;
}

export function parseExports(text: string): ExportInfo {
  const names = new Set<string>();

  for (const pattern of [
    /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:abstract\s+)?(?:class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    for (const match of text.matchAll(pattern)) names.add(match[1] as string);
  }

  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? "").split(",")) {
      const alias = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (alias) names.add(alias);
    }
  }

  return {
    names,
    hasDefault: /export\s+default\b/.test(text),
    star: /export\s*\*\s*from/.test(text),
    commonjs: /module\.exports\b|exports\.[A-Za-z_$][\w$]*\s*=/.test(text),
  };
}

/** NodeNext emits `./foo.js` from `foo.ts`; resolve the source, not the build output. */
const TS_REWRITES: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

async function resolveModule(baseDir: string, spec: string): Promise<string | null> {
  const candidate = path.resolve(baseDir, spec);

  if (await isFile(candidate)) return candidate;

  const declared = path.extname(spec);
  const rewrites = TS_REWRITES[declared];
  if (rewrites && declared) {
    const stem = candidate.slice(0, candidate.length - declared.length);
    for (const rewrite of rewrites) {
      if (await isFile(`${stem}${rewrite}`)) return `${stem}${rewrite}`;
    }
  }

  for (const extension of MODULE_EXTENSIONS) {
    if (await isFile(`${candidate}${extension}`)) return `${candidate}${extension}`;
  }
  for (const extension of MODULE_EXTENSIONS) {
    if (await isFile(path.join(candidate, `index${extension}`))) {
      return path.join(candidate, `index${extension}`);
    }
  }

  return null;
}

/**
 * JS/TS → JS/TS: resolve relative specifiers and verify named imports exist in the
 * target module's exports. A function called from another file that was never
 * defined shows up here.
 */
export async function scanModuleGraph(
  target: string,
  files: string[],
): Promise<Pass2Finding[]> {
  const findings: Pass2Finding[] = [];
  const exportCache = new Map<string, ExportInfo>();

  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;

    for (const importRef of extractImports(text)) {
      const spec = importRef.spec;
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // package or alias: not ours to judge
      if (isExternalSpecifier(spec)) continue;

      const baseDir = spec.startsWith("/") ? target : path.dirname(file);
      const resolved = await resolveModule(baseDir, spec.startsWith("/") ? spec.replace(/^\//, "") : spec);

      if (!resolved) {
        findings.push({
          id: `import:${relative(target, file)}:${spec}`,
          kind: "unresolved-import",
          severity: "error",
          file: relative(target, file),
          reference: spec,
          message: `imports "${spec}" but no matching module exists`,
          hint: "fix the specifier or add the missing module",
        });
        continue;
      }

      if (importRef.named.length === 0) continue;

      let exported = exportCache.get(resolved);
      if (!exported) {
        const targetText = await readText(resolved);
        exported = parseExports(targetText ?? "");
        exportCache.set(resolved, exported);
      }

      // Ambiguous export shapes are skipped, never guessed.
      if (exported.star || exported.commonjs) continue;

      for (const name of importRef.named) {
        if (exported.names.has(name)) continue;
        findings.push({
          id: `symbol:${relative(target, file)}:${spec}:${name}`,
          kind: "missing-symbol",
          severity: "error",
          file: relative(target, file),
          reference: `${spec}#${name}`,
          message: `imports "${name}" from "${spec}", but ${relative(target, resolved)} does not export it`,
          hint: `export ${name} from ${relative(target, resolved)}, or fix the import`,
        });
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ python */

/** Python relative imports: `from .pkg.mod import x` must land on a real module. */
export async function scanPythonImports(
  target: string,
  files: string[],
): Promise<Pass2Finding[]> {
  const findings: Pass2Finding[] = [];

  for (const file of files) {
    const text = await readText(file);
    if (!text) continue;

    for (const match of text.matchAll(/(?:^|\n)\s*from\s+(\.{1,3}[\w.]*)\s+import\b/g)) {
      const moduleExpr = match[1] as string;
      const dots = /^\.+/.exec(moduleExpr)?.[0].length ?? 1;
      const modulePath = moduleExpr.slice(dots).replace(/\./g, path.sep);

      let baseDir = path.dirname(file);
      for (let level = 1; level < dots; level += 1) baseDir = path.dirname(baseDir);

      const candidate = modulePath
        ? path.join(baseDir, `${modulePath}.py`)
        : path.join(baseDir, "__init__.py");

      const exists =
        (await isFile(candidate)) || (await isFile(path.join(baseDir, modulePath, "__init__.py")));

      if (exists) continue;

      findings.push({
        id: `py:${relative(target, file)}:${moduleExpr}`,
        kind: "broken-reference",
        severity: "error",
        file: relative(target, file),
        reference: moduleExpr,
        message: `relative import "${moduleExpr}" does not resolve to a module`,
        hint: "fix the import path or add the missing module",
      });
    }
  }

  return findings;
}
