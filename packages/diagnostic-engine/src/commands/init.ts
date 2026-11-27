import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CONFIG_FILE,
  DEFAULT_ARMOR_SCRIPTS,
  DEFAULT_CONFIG,
  type EngineConfig,
} from "../core/config.js";
import type { PackageJson } from "../core/types.js";

export const DIAGNOSE_SCRIPT = "diagnose";
/** The binary this package installs; works for local, global and npx installs. */
export const DIAGNOSE_SCRIPT_VALUE = "deepdiagnose";

export interface InitOptions {
  /** Project directory to initialize. Defaults to process.cwd(). */
  cwd?: string;
  /** Overwrite an existing diagnose.config.json. */
  force?: boolean;
  /** Replace the default Angel Armor script list. */
  armorScripts?: string[];
  /** Replace the default "diagnose" script value (e.g. "tsx ./diagnose.ts"). */
  scriptValue?: string;
}

export interface InitResult {
  directory: string;
  configPath: string;
  configCreated: boolean;
  packageJsonPath: string;
  packageJsonCreated: boolean;
  scriptAdded: boolean;
  scriptName: string;
  scriptValue: string;
}

async function readPackageJson(file: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function buildConfig(options: InitOptions): EngineConfig {
  const scripts = options.armorScripts?.map((script) => script.trim()).filter(Boolean);

  return {
    artifactsDir: DEFAULT_CONFIG.artifactsDir,
    cassettesDir: DEFAULT_CONFIG.cassettesDir,
    reportPath: DEFAULT_CONFIG.reportPath,
    blockersFile: DEFAULT_CONFIG.blockersFile,
    boardFile: DEFAULT_CONFIG.boardFile,
    gate: DEFAULT_CONFIG.gate,
    twoPass: true,
    flaky: {
      enabled: true,
      historyFile: ".deepdiagnose/flaky-history.json",
      minRuns: 3,
      maxRuns: 50,
      failOnFlaky: false,
    },
    impact: {
      enabled: true,
      base: "HEAD",
      adapter: "auto",
    },
    armor: {
      scripts: scripts && scripts.length > 0 ? scripts : DEFAULT_ARMOR_SCRIPTS,
      packageDirs: DEFAULT_CONFIG.armor?.packageDirs,
    },
  };
}

/**
 * Scaffold a project: write diagnose.config.json and add the `diagnose` script.
 * Idempotent — existing config and an existing script value are never clobbered
 * unless `force` is passed for the config.
 */
export async function initProject(options: InitOptions = {}): Promise<InitResult> {
  const directory = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.join(directory, CONFIG_FILE);
  const packageJsonPath = path.join(directory, "package.json");
  const scriptValue = options.scriptValue ?? DIAGNOSE_SCRIPT_VALUE;

  // 1. diagnose.config.json
  const existingConfig = await readPackageJson(configPath);
  let configCreated = false;

  if (!existingConfig || options.force) {
    await writeFile(configPath, `${JSON.stringify(buildConfig(options), null, 2)}\n`, "utf8");
    configCreated = true;
  }

  // 2. package.json script
  const existingPackage = await readPackageJson(packageJsonPath);
  const pkg: PackageJson = existingPackage ?? {
    name: path.basename(directory) || "project",
    version: "0.0.0",
    private: true,
  };

  const scripts: Record<string, string> = { ...(pkg.scripts ?? {}) };
  const scriptAdded = !scripts[DIAGNOSE_SCRIPT];
  if (scriptAdded) scripts[DIAGNOSE_SCRIPT] = scriptValue;
  pkg.scripts = scripts;

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  return {
    directory,
    configPath,
    configCreated,
    packageJsonPath,
    packageJsonCreated: existingPackage === null,
    scriptAdded,
    scriptName: DIAGNOSE_SCRIPT,
    scriptValue: scripts[DIAGNOSE_SCRIPT] as string,
  };
}

/** Human-readable summary for the CLI. */
export function describeInit(result: InitResult): string[] {
  const lines: string[] = [];

  lines.push(
    result.configCreated
      ? `✔ created ${path.basename(result.configPath)}`
      : `• kept existing ${path.basename(result.configPath)} (--force to overwrite)`,
  );

  if (result.packageJsonCreated) {
    lines.push(`✔ created package.json (name: ${path.basename(result.directory)})`);
  }

  lines.push(
    result.scriptAdded
      ? `✔ added "${result.scriptName}": "${result.scriptValue}" to package.json`
      : `• package.json already has a "${result.scriptName}" script (left untouched)`,
  );

  lines.push("");
  lines.push("Next steps:");
  lines.push("  1. npm install --save-dev @deepdrop/diagnose   (or: npm install -g @deepdrop/diagnose)");
  lines.push(`  2. npm run ${result.scriptName}`);
  lines.push(
    `  3. Commit ${path.basename(result.configPath)} + blockers.json + UNRESOLVED.md; reports land in diagnostic-report.json + artifacts/`,
  );

  return lines;
}
