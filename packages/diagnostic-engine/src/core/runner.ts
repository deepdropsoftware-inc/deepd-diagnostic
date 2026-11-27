import { createArtifacts, finalizeArtifacts } from "./artifacts.js";
import type { CheckResult, CheckStatus, Plugin, PluginResult, RunContext } from "./types.js";

export function statusFor(checks: CheckResult[]): CheckStatus {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.length === 0 || checks.every((check) => check.status === "skipped")) return "skipped";
  return "passed";
}

export interface RunPluginsOptions {
  /**
   * Angel Armor gate (default on). When a base plugin fails, language plugins are
   * recorded as blocked instead of running on an unclassified tree.
   */
  gate?: boolean;
}

/**
 * Rooted execution: base plugins (Angel Armor) always run first. Language plugins
 * only run once the foundation has been checked.
 */
export async function runPlugins(
  plugins: Plugin[],
  ctx: RunContext,
  options: RunPluginsOptions = {},
): Promise<PluginResult[]> {
  const gate = options.gate ?? true;
  const ordered = [
    ...plugins.filter((plugin) => plugin.base),
    ...plugins.filter((plugin) => !plugin.base),
  ];

  const results: PluginResult[] = [];
  let foundationFailed = false;

  for (const plugin of ordered) {
    let detected = false;

    try {
      detected = await plugin.detect(ctx);
    } catch (error) {
      results.push({
        id: plugin.id,
        label: plugin.label,
        base: plugin.base ?? false,
        status: "failed",
        durationMs: 0,
        checks: [
          {
            name: "detect",
            status: "failed",
            durationMs: 0,
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      });
      continue;
    }

    if (!detected) continue;

    const artifacts = createArtifacts(ctx.artifactsRoot, plugin.id);

    // Blocked: drop stale output so CI never uploads a previous run's results.
    if (gate && !plugin.base && foundationFailed) {
      await artifacts.remove();
      results.push({
        id: plugin.id,
        label: plugin.label,
        base: plugin.base ?? false,
        status: "skipped",
        blocked: true,
        durationMs: 0,
        message: "blocked: Angel Armor checks failed",
        checks: [
          {
            name: "armor-gate",
            status: "skipped",
            durationMs: 0,
            message:
              "blocked: Angel Armor checks failed — fix the foundation, or pass --no-gate to run language checks anyway",
          },
        ],
      });
      continue;
    }

    await artifacts.clear();
    const startedAt = Date.now();
    let checks: CheckResult[];

    try {
      checks = await plugin.run(ctx, artifacts);
    } catch (error) {
      checks = [
        {
          name: plugin.id,
          status: "failed",
          durationMs: 0,
          message: `plugin crashed: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }

    const result: PluginResult = {
      id: plugin.id,
      label: plugin.label,
      base: plugin.base ?? false,
      status: statusFor(checks),
      durationMs: Date.now() - startedAt,
      checks,
    };

    result.artifacts = await finalizeArtifacts(artifacts, result);

    if (plugin.base && result.status === "failed") foundationFailed = true;

    results.push(result);
  }

  return results;
}
