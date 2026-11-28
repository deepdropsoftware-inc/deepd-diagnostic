import type { Artifacts, CheckKind, CheckResult, RunContext } from "./types.js";

const MAX_STORED_OUTPUT = 6_000;

/**
 * A skip that is a real to-do. It is logged in blockers.json / UNRESOLVED.md as [OPEN]
 * and flips to [RESOLVED] once the check passes on a later run.
 */
export function skipped(name: string, message: string, kind: CheckKind = "blocker"): CheckResult {
  return { name, status: "skipped", kind, durationMs: 0, message };
}

/** A skip that is correct for this project and never needs tracking. */
export function notApplicable(name: string, message: string): CheckResult {
  return skipped(name, message, "not-applicable");
}

export interface RawStep {
  check: CheckResult;
  stdout: string;
}

/** Run one tool invocation, keeping the untruncated stdout for artifact capture. */
export async function runStepRaw(
  ctx: RunContext,
  name: string,
  command: string,
  args: string[],
  cwd = ctx.target,
): Promise<RawStep> {
  const startedAt = Date.now();
  const result = await ctx.exec(command, args, cwd);
  const passed = !result.timedOut && result.code === 0;

  // An unavailable launcher is an environment problem, not evidence that the
  // project's check failed. Record it as an actionable blocker instead of an
  // "exit code unknown" failure.
  if (result.environmentError) {
    return {
      stdout: result.stdout,
      check: {
        name,
        status: "skipped",
        kind: "blocker",
        command: result.command,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        message: `environment unavailable: ${result.environmentError}`,
        output: `${result.stdout}${result.stderr}`.trim().slice(-MAX_STORED_OUTPUT) || undefined,
      },
    };
  }

  return {
    stdout: result.stdout,
    check: {
      name,
      status: passed ? "passed" : "failed",
      command: result.command,
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      message: result.timedOut
        ? "timed out"
        : passed
          ? undefined
          : `exit code ${result.code ?? "unknown"}`,
      output: `${result.stdout}${result.stderr}`.trim().slice(-MAX_STORED_OUTPUT) || undefined,
    },
  };
}

/** Run one tool invocation and record it as a check. */
export async function runStep(
  ctx: RunContext,
  name: string,
  command: string,
  args: string[],
  cwd = ctx.target,
): Promise<CheckResult> {
  return (await runStepRaw(ctx, name, command, args, cwd)).check;
}

/**
 * Run a tool whose machine output is written to stdout (ruff, phpstan, clippy,
 * ...) and save that output as a JSON artifact. Non-empty output is saved even
 * when the tool exits non-zero, because that is where the findings live.
 */
export async function runCapturedJson(
  ctx: RunContext,
  name: string,
  command: string,
  args: string[],
  artifacts: Artifacts,
  fileName: string,
  cwd = ctx.target,
): Promise<CheckResult> {
  const { check, stdout } = await runStepRaw(ctx, name, command, args, cwd);
  const payload = stdout.trim();

  if (payload.length > 0) {
    await artifacts.writeFile(fileName, `${payload}\n`);
  }

  return check;
}

/** `npm run <script>` in the folder that owns the script. */
export function runScript(ctx: RunContext, script: string, cwd: string): Promise<CheckResult> {
  return runStep(ctx, script, "npm", ["run", script], cwd);
}
