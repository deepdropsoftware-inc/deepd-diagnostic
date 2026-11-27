import path from "node:path";
import { CONFIG_FILE, type EngineConfig } from "./config.js";
import { findPaths, isDirectory, pathExists, readJson, safeReaddir } from "./fs.js";
import type { PackageJson } from "./types.js";

/** Walk up until we find the monorepo root (.git, pnpm/npm workspaces). */
export async function findRepoRoot(start: string): Promise<string> {
  let dir = path.resolve(start);
  let firstPackageDir: string | null = null;

  for (;;) {
    if (await pathExists(path.join(dir, ".git"))) return dir;
    if (await pathExists(path.join(dir, "pnpm-workspace.yaml"))) return dir;

    const pkg = await readJson<PackageJson>(path.join(dir, "package.json"));
    if (pkg) {
      if (pkg.workspaces) return dir;
      firstPackageDir ??= dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return firstPackageDir ?? path.resolve(start);
    dir = parent;
  }
}

async function listCassettes(repoRoot: string, cassettesDir: string): Promise<string[]> {
  const names = new Set<string>();
  const bases = [
    path.join(repoRoot, cassettesDir),
    path.join(repoRoot, "packages"),
    path.join(repoRoot, "apps"),
    repoRoot,
  ];

  for (const base of bases) {
    for (const entry of await safeReaddir(base)) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      if (await pathExists(path.join(base, entry.name, "package.json"))) names.add(entry.name);
    }
  }

  return [...names].sort();
}

/**
 * Resolve `--cassette=<name>` or `init --cassette` to an absolute folder.
 * Looks in the configured cassettes dir first, then packages/, apps/ and the root.
 */
export async function resolveCassette(
  repoRoot: string,
  name: string,
  config: EngineConfig,
): Promise<string> {
  const cassettesDir = config.cassettesDir ?? "cassettes";
  const candidates = [
    path.join(repoRoot, cassettesDir, name),
    path.join(repoRoot, "packages", name),
    path.join(repoRoot, "apps", name),
    path.join(repoRoot, name),
  ];

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  const available = await listCassettes(repoRoot, cassettesDir);
  const hint =
    available.length > 0
      ? `Available cassettes: ${available.join(", ")}`
      : `No cassettes found. Expected them in ${path.join(repoRoot, cassettesDir)} (change cassettesDir in ${CONFIG_FILE}).`;

  throw new Error(`Unknown cassette "${name}".\nLooked in: ${candidates.join(", ")}\n${hint}`);
}

/** Files that identify the kinds of project a folder holds. Used for the header line. */
export async function describeProject(target: string): Promise<string[]> {
  const kinds: string[] = [];

  if (await pathExists(path.join(target, "package.json"))) kinds.push("node");
  if (await pathExists(path.join(target, "tsconfig.json"))) kinds.push("typescript");
  if (await pathExists(path.join(target, "angular.json"))) kinds.push("angular");
  if ((await findPaths(target, ["*.xcodeproj", "*.xcworkspace", "Package.swift"], 2)).length > 0) {
    kinds.push("apple");
  }
  if ((await findPaths(target, ["pyproject.toml", "requirements.txt", "setup.py"], 2)).length > 0) {
    kinds.push("python");
  }

  return kinds.length > 0 ? kinds : ["unknown"];
}
