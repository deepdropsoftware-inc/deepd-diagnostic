import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "./types.js";

/** src/plugins when running through tsx, dist/plugins after a build. */
export const DEFAULT_PLUGINS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
);

const MODULE_EXTENSIONS = [".ts", ".js", ".mjs"];

function isBundledName(file: string): boolean {
  return (
    file.startsWith("_") ||
    file.endsWith(".d.ts") ||
    file.startsWith("index.") ||
    file.endsWith(".map")
  );
}

function isPlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Plugin>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.label === "string" &&
    typeof candidate.detect === "function" &&
    typeof candidate.run === "function"
  );
}

async function loadFromDir(dir: string): Promise<Plugin[]> {
  let files: string[] = [];

  try {
    const entries = await readdir(dir);
    files = entries
      .filter((name) => MODULE_EXTENSIONS.some((ext) => name.endsWith(ext)))
      .filter((name) => !isBundledName(name))
      .sort();
  } catch {
    return [];
  }

  const plugins: Plugin[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const module = (await import(pathToFileURL(path.join(dir, file)).href)) as {
      default?: unknown;
      plugin?: unknown;
    };
    const candidate = module.default ?? module.plugin;

    if (!isPlugin(candidate)) {
      throw new Error(
        `[deepdiagnose] ${path.join(dir, file)} must default-export a plugin with { id, label, detect(), run() }.`,
      );
    }
    if (seen.has(candidate.id)) {
      throw new Error(`[deepdiagnose] duplicate plugin id "${candidate.id}" in ${dir}.`);
    }

    seen.add(candidate.id);
    plugins.push(candidate);
  }

  return plugins;
}

/**
 * Load every plugin module from one or more folders.
 * Adding a file is all it takes to register a tool. A project's plugin folder is
 * loaded after the built-ins, so a project can override a built-in by reusing its id.
 */
export async function loadPlugins(dirs: string | string[] = DEFAULT_PLUGINS_DIR): Promise<Plugin[]> {
  const directories = Array.isArray(dirs) ? dirs : [dirs];
  const byId = new Map<string, Plugin>();

  for (const dir of directories) {
    for (const plugin of await loadFromDir(dir)) {
      byId.set(plugin.id, plugin);
    }
  }

  return [...byId.values()].sort(
    (a, b) => Number(b.base ?? false) - Number(a.base ?? false) || a.id.localeCompare(b.id),
  );
}
