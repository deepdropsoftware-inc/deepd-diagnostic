import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 240_000;

function commandFor(platform: NodeJS.Platform, command: string): string {
  if (platform === "win32" && (command === "npm" || command === "npx")) {
    return `${command}.cmd`;
  }
  return command;
}

/**
 * Run a command with arguments, no shell, captured output.
 * A missing binary resolves to code null rather than throwing.
 */
export async function exec(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CommandResult> {
  const printable = [command, ...args].join(" ");
  const executable = commandFor(process.platform, command);

  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(executable, args, {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: "0", CI: process.env.CI ?? "" },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: printable,
        code: timedOut ? null : code,
        stdout: stdout.slice(-MAX_OUTPUT),
        stderr: stderr.slice(-MAX_OUTPUT),
        timedOut,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      stderr += `\n${error.code === "ENOENT" ? `${executable} not found` : error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
