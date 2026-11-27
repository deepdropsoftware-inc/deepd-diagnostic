import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CommandResult } from "./types.js";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 240_000;

export interface CommandInvocation {
  command: string;
  args: string[];
}

/**
 * Windows cannot spawn .cmd shims (npm.cmd / npx.cmd) with shell:false.
 * Launch the npm CLI JavaScript entrypoint with the current Node executable
 * instead. This keeps argument boundaries intact and avoids a shell.
 */
export function commandFor(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
): CommandInvocation | null {
  if (platform !== "win32" || (command !== "npm" && command !== "npx")) {
    return { command, args };
  }

  const cliName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
  const npmExecPath = process.env.npm_execpath;
  const candidates = [
    npmExecPath && (command === "npm"
      ? npmExecPath
      : npmExecPath.replace(/npm-cli\.js$/i, "npx-cli.js")),
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", cliName),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const cliPath = candidates.find((candidate) => existsSync(candidate));
  return cliPath
    ? { command: process.execPath, args: [cliPath, ...args] }
    : null;
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
  const invocation = commandFor(process.platform, command, args);

  if (!invocation) {
    return {
      command: printable,
      code: null,
      stdout: "",
      stderr: `Unable to locate the Windows ${command} CLI entrypoint. Ensure npm is installed alongside Node.js.`,
      timedOut: false,
    };
  }

  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(invocation.command, invocation.args, {
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
      stderr += `\n${error.code === "ENOENT" ? `${invocation.command} not found` : error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
