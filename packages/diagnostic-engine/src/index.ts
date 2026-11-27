/**
 * Public API for @deepdrop/diagnose.
 *
 * Most projects only need the CLI (`deepdiagnose`), but the engine and plugin
 * contract are exported so custom plugins and tooling can import the types.
 */
export { runDiagnose } from "./core/engine.js";
export type { DiagnoseOptions, DiagnoseOutcome } from "./core/engine.js";
export { loadPlugins, DEFAULT_PLUGINS_DIR } from "./core/registry.js";
export { notApplicable, skipped } from "./core/checks.js";
export {
  CONFIG_FILE,
  DEFAULT_ARMOR_DIRS,
  DEFAULT_ARMOR_SCRIPTS,
  DEFAULT_CONFIG,
  readEngineConfig,
} from "./core/config.js";
export type { ArmorConfig, EngineConfig } from "./core/config.js";
export type {
  Artifacts,
  CheckResult,
  CheckStatus,
  DiagnosticReport,
  Plugin,
  PluginArtifactPaths,
  PluginResult,
  RunContext,
} from "./core/types.js";
export { parseJUnit, testId } from "./core/junit-parse.js";
export type { JUnitCase } from "./core/junit-parse.js";
export { classifyFailures } from "./core/explain.js";
export type {
  ExplainedFailure,
  ExplainReport,
  FailureCategory,
  FlakyReport,
  ImpactReport,
  SignalsReport,
} from "./core/types.js";
export { ENGINE_NAME, ENGINE_VERSION } from "./core/version.js";
