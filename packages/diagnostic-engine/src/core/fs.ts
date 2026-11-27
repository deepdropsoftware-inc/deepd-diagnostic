import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Folders we never walk: dependencies, build output, VCS and tool caches. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "Pods",
  "DerivedData",
  ".gradle",
]);

export async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(target: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(target, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function safeReaddir(target: string) {
  try {
    return await readdir(target, { withFileTypes: true });
  } catch {
    return [];
  }
}

function matchesName(name: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return name === pattern;
}

/**
 * Breadth-first search for file/folder names under `root`.
 * Returns absolute paths, deepest `maxDepth` levels down.
 */
export async function findPaths(
  root: string,
  patterns: string[],
  maxDepth = 3,
): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const entries = await safeReaddir(current.dir);

    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      if (patterns.some((pattern) => matchesName(entry.name, pattern))) {
        found.push(full);
      }
      if (
        entry.isDirectory() &&
        current.depth < maxDepth &&
        !IGNORED_DIRS.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }

  return found;
}
