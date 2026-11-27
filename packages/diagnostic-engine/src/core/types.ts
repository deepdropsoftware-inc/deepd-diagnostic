import type { EngineConfig } from "./config.js";

export type CheckStatus = "passed" | "failed" | "skipped";

/**
 * "blocker": a capability that should work but does not yet (missing tool, parser, config).
 *   Tracked in blockers.json / UNRESOLVED.md until it passes.
 * "not-applicable": intentionally skipped for this project (no tsconfig, Android-only task).
 */
export type CheckKind = "blocker" | "not-applicable";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  kind?: CheckKind;
  command?: string;
  exitCode?: number | null;
  durationMs: number;
  message?: string;
  output?: string;
}

export interface PluginArtifactPaths {
  dir: string;
  junit: string;
  json: string;
}

export interface PluginResult {
  id: string;
  label: string;
  /** Mirrors Plugin.base so the report shows which plugin is mandatory. */
  base: boolean;
  status: CheckStatus;
  durationMs: number;
  checks: CheckResult[];
  /** True when Angel Armor failed and this plugin was held back. */
  blocked?: boolean;
  message?: string;
  artifacts?: PluginArtifactPaths;
}

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  [key: string]: unknown;
}

export interface CommandResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the execution environment itself could not launch the command. */
  environmentError?: string;
}

/**
 * The standard output contract: every plugin writes `junit.xml` and `report.json`
 * into artifacts/<plugin>/.
 */
export interface Artifacts {
  dir: string;
  junitPath: string;
  jsonPath: string;
  /** Create the folder without deleting anything (used before a tool writes into it). */
  ensure(): Promise<void>;
  /** Delete stale output from a previous run, then recreate the folder. */
  clear(): Promise<void>;
  /** Delete the folder entirely (used when a plugin is blocked and produces nothing). */
  remove(): Promise<void>;
  writeFile(name: string, content: string): Promise<string>;
  writeJson(name: string, data: unknown): Promise<string>;
  /** Copy a file a tool produced elsewhere into the artifacts folder. */
  adopt(source: string, name?: string): Promise<string | null>;
  /** Append the <testsuite> blocks of native JUnit reports into artifacts/junit.xml. */
  mergeJUnit(sources: string[]): Promise<string[]>;
}

/**
 * Everything a plugin needs. Nothing here is global, so a plugin can be run
 * against any folder (root repo, a cassette, a fixture in a test).
 */
export interface RunContext {
  /** Repository root, used by base plugins (e.g. Angel Armor) and workspace-bound tooling. */
  repoRoot: string;
  /** Absolute folder currently being diagnosed (repo root, or the chosen cassette). */
  target: string;
  /** "target" as shown to humans, relative to the repo root. */
  relativeTarget: string;
  /** Cassette name when `--cassette` was used. */
  cassette: string | null;
  /** `--fix`: plugins may run safe, simple repairs (install, format). */
  fix: boolean;
  /** Root of the per-plugin artifact folders (default <repoRoot>/artifacts). */
  artifactsRoot: string;
  /** Parsed diagnose.config.json, so plugins read project conventions instead of hardcoding them. */
  config: EngineConfig;
  log: (line: string) => void;
  exec: (command: string, args: string[], cwd?: string) => Promise<CommandResult>;
  /** Resolve a tool on PATH (go, cargo, dotnet, gradle, php, ...). */
  which: (name: string) => Promise<string | null>;
  /** Read a file relative to the target, or null when it does not exist. */
  read: (relativePath: string) => Promise<string | null>;
  /** Path existence relative to the target folder. */
  exists: (...segments: string[]) => Promise<boolean>;
  /** Recursive lookup for file/folder names ("package.json", "*.xcodeproj"). */
  find: (names: string[], options?: { maxDepth?: number; dir?: string }) => Promise<string[]>;
  pkg: (dir?: string) => Promise<PackageJson | null>;
  packageScripts: (dir?: string) => Promise<Record<string, string>>;
  /** Path to an installed tool in the target/repo node_modules/.bin, or null. */
  bin: (name: string) => string | null;
}

/**
 * A plugin module default-exports this object. Drop a file in src/plugins to register it.
 * Every plugin is rooted to Angel Armor: the engine runs base plugins first and gates
 * language plugins on their result.
 */
export interface Plugin {
  id: string;
  label: string;
  /** Base plugins run first, in every project (Angel Armor). */
  base?: boolean;
  detect(ctx: RunContext): boolean | Promise<boolean>;
  run(ctx: RunContext, artifacts: Artifacts): Promise<CheckResult[]>;
}

export type BlockerStatus = "open" | "resolved";

/** One tracked capability that was skipped and must become green. */
export interface Blocker {
  id: string;
  plugin: string;
  check: string;
  reason: string;
  status: BlockerStatus;
  firstSeen: string;
  lastSeen: string;
  occurrences: number;
  resolvedAt?: string;
  resolution?: string;
}

export interface BlockerLedger {
  version: number;
  updatedAt: string;
  blockers: Blocker[];
}

export interface BlockerSummary {
  open: number;
  resolved: number;
  newlyOpened: number;
  reopened: number;
  newlyResolved: number;
  file: string;
  board: string;
}

export interface PassSummary {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  durationMs: number;
}

export interface Pass1Report {
  label: string;
  approach: string;
  summary: PassSummary;
  plugins: PluginResult[];
}

/** Kinds of relational problems only Pass 2 can see. */
export type Pass2FindingKind =
  | "broken-reference"
  | "unresolved-import"
  | "missing-symbol";

export interface Pass2Finding {
  id: string;
  kind: Pass2FindingKind;
  severity: "error" | "warning";
  file: string;
  reference?: string;
  message: string;
  hint?: string;
}

export interface Pass2Fix {
  blockerId: string;
  description: string;
  applied: boolean;
  files: string[];
  reason?: string;
}

export interface Pass2Triage {
  blockerId: string;
  plugin: string;
  check: string;
  disposition: "auto-fixable" | "manual";
  action: string;
  applied?: boolean;
}

export interface Pass2Summary {
  ok: boolean;
  errors: number;
  warnings: number;
  filesScanned: number;
  blockersOpen: number;
  fixable: number;
  manual: number;
  fixesApplied: number;
  durationMs: number;
}

export interface Pass2Report {
  label: string;
  approach: string;
  summary: Pass2Summary;
  findings: Pass2Finding[];
  fixes: Pass2Fix[];
  triage: Pass2Triage[];
}

export type FlakyStatus = "flaky" | "stable-failing" | "stable-passing" | "insufficient-history";

/** One test's outcome history across runs — the unit the signals layer scores. */
export interface FlakyTestRecord {
  id: string;
  plugin: string;
  name: string;
  classname?: string;
  runs: number;
  passes: number;
  failures: number;
  skips: number;
  /** min(passes, failures) / runs — 0 means never flipped. */
  flakeRate: number;
  /** Passed and failed while the working tree was at the same commit. */
  sameCommitMixed: boolean;
  status: FlakyStatus;
  lastStatus: CheckStatus;
  lastSeen: string;
}

export interface FlakyReport {
  enabled: boolean;
  historyFile: string;
  commit: string;
  dirty: boolean;
  runsStored: number;
  testsTracked: number;
  /** (stable tests / tracked tests) * 100 — same shape DeFlaky reports. */
  flakeScore: number;
  minRuns: number;
  flaky: FlakyTestRecord[];
  stableFailing: FlakyTestRecord[];
  insufficient: number;
  durationMs: number;
  note?: string;
}

export type ImpactAdapterId = "mizchi-test-impact" | "graph" | "none";

/** Which tests a diff can reach — selection only; nothing is executed here. */
export interface ImpactReport {
  enabled: boolean;
  adapter: ImpactAdapterId;
  base: string;
  changedFiles: string[];
  selectedTests: string[];
  candidates: number;
  reductionPct: number;
  /** Relative/alias imports the graph could not resolve: selection may be partial. */
  unresolvedSpecifiers?: number;
  /** Alias specifiers that matched more than one file: left unresolved on purpose. */
  ambiguousSpecifiers?: number;
  fallbackReason?: string;
  durationMs: number;
  note?: string;
}

export type FailureCategory =
  | "missing-tool"
  | "type-error"
  | "compile-error"
  | "test-assertion"
  | "timeout"
  | "network"
  | "permissions"
  | "dependency"
  | "configuration"
  | "unknown";

/** Structured failure record shared by --ai-explain and any external triage tool. */
export interface ExplainedFailure {
  id: string;
  plugin: string;
  check: string;
  category: FailureCategory;
  severity: "error";
  confidence: number;
  command?: string;
  exitCode?: number | null;
  excerpt?: string;
  suggestion?: string;
  source: "rules" | "llm";
}

export interface ExplainReport {
  enabled: boolean;
  mode: "rules-only" | "llm" | "disabled";
  model?: string;
  failures: ExplainedFailure[];
  note?: string;
  durationMs: number;
}

/** Post-pass analytics over artifacts. Pass 1/2 execute tools; signals only read. */
export interface SignalsReport {
  flaky: FlakyReport;
  impact?: ImpactReport;
  explain?: ExplainReport;
}

export interface DiagnosticReport {
  engine: string;
  engineVersion: string;
  generatedAt: string;
  target: {
    relative: string;
    root: string;
    repoRoot: string;
    cassette: string | null;
  };
  artifacts: {
    root: string;
    junit: string;
  };
  twoPass: boolean;
  summary: PassSummary;
  pass1: Pass1Report;
  pass2?: Pass2Report;
  signals?: SignalsReport;
  blockers: BlockerSummary;
  availablePlugins: string[];
}
