import path from "node:path";
import { readJson } from "./fs.js";

export interface ArmorConfig {
  /** The mandatory foundation scripts, run in this order. */
  scripts?: string[];
  /** Folders that may own those scripts, relative to the repo root. */
  packageDirs?: string[];
}

export interface FlakyConfig {
  /** Run the flaky signal. Default: true. */
  enabled?: boolean;
  /** Per-test outcome history, relative to the repo root. */
  historyFile?: string;
  /** Observations before a test can be called flaky. Default: 3. */
  minRuns?: number;
  /** History depth to keep. Default: 50. */
  maxRuns?: number;
  /** Make flaky tests fail the run. Default: false (report only). */
  failOnFlaky?: boolean;
}

export interface ImpactConfig {
  /** Run test-impact selection. Default: true. */
  enabled?: boolean;
  /** Git revision to diff against. Default: "HEAD" (working tree). */
  base?: string;
  /** auto prefers @mizchi/test-impact when installed, else the Pass 2 graph. */
  adapter?: "auto" | "mizchi" | "graph";
}

export interface EngineConfig {
  /** Where cassettes live, relative to the repo root. Default: "cassettes". */
  cassettesDir?: string;
  /** Aggregate report path, relative to the repo root. */
  reportPath?: string;
  /** Per-plugin artifact folder, relative to the repo root. Default: "artifacts". */
  artifactsDir?: string;
  /** Extra plugin folders, relative to the repo root (built-ins are still loaded). */
  pluginsDir?: string | string[];
  /** Machine-readable blocker ledger. Default: "blockers.json". */
  blockersFile?: string;
  /** Generated tracking board. Default: "UNRESOLVED.md". */
  boardFile?: string;
  /** Run language plugins even when Angel Armor fails. Default: true (gated). */
  gate?: boolean;
  /** Run Pass 2 (logic & debt) after Pass 1. Default: true. */
  twoPass?: boolean;
  /** Substrings (relative to the target) excluded from Pass 2's analysis. */
  pass2Ignore?: string[];
  /** Flaky-test signal over the JUnit artifacts. */
  flaky?: FlakyConfig;
  /** Test-impact selection: which tests a diff can reach. */
  impact?: ImpactConfig;
  armor?: ArmorConfig;
}

export const CONFIG_FILE = "diagnose.config.json";
export const LEGACY_CONFIG_FILE = "diagnostic-engine.config.json";

export const DEFAULT_ARMOR_SCRIPTS = ["check:armor", "check:editions", "check:export"];
export const DEFAULT_ARMOR_DIRS = ["packages/angel-armor", "angel-armor"];

export const DEFAULT_CONFIG: EngineConfig = {
  artifactsDir: "artifacts",
  cassettesDir: "cassettes",
  reportPath: "diagnostic-report.json",
  blockersFile: "blockers.json",
  boardFile: "UNRESOLVED.md",
  gate: true,
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
    scripts: DEFAULT_ARMOR_SCRIPTS,
    packageDirs: DEFAULT_ARMOR_DIRS,
  },
};

/** Read diagnose.config.json, falling back to the pre-release filename. */
export async function readEngineConfig(repoRoot: string): Promise<EngineConfig> {
  const primary = await readJson<EngineConfig>(path.join(repoRoot, CONFIG_FILE));
  if (primary) return primary;

  const legacy = await readJson<EngineConfig>(path.join(repoRoot, LEGACY_CONFIG_FILE));
  return legacy ?? {};
}

export function armorScripts(config: EngineConfig): string[] {
  const configured = config.armor?.scripts?.filter((script) => script.trim().length > 0);
  return configured && configured.length > 0 ? configured : DEFAULT_ARMOR_SCRIPTS;
}

export function armorPackageDirs(config: EngineConfig): string[] {
  const configured = config.armor?.packageDirs?.filter((dir) => dir.trim().length > 0);
  return configured && configured.length > 0 ? configured : DEFAULT_ARMOR_DIRS;
}

/** A project may add several plugin folders; a single string is allowed too. */
export function pluginDirs(config: EngineConfig): string[] {
  if (!config.pluginsDir) return [];
  return Array.isArray(config.pluginsDir) ? config.pluginsDir : [config.pluginsDir];
}
