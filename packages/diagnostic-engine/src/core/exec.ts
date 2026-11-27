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

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }

  return result;
}

/**
 * Resolve npm's JavaScript entrypoints without launching Windows .cmd shims.
 * npm_execpath may identify either npm-cli.js or npx-cli.js; use its directory
 * for both commands, but never trust an unrelated executable path. When npm is
 * invoked directly from a terminal, npm_execpath is unset, so npm is also
 * searched beside node.exe, on PATH, and in %APPDATA%\npm.
 */
export function commandFor(
  platform: NodeJS.Platform,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): CommandInvocation | null {
  if (platform !== "win32" || (command !== "npm" && command !== "npx")) {
    return { command, args };
  }

  const cliName = command === "npm" ? "npm-cli.js" : "npx-cli.js";
  const npmExecPath = env.npm_execpath;
  const npmExecBasename = npmExecPath ? path.basename(npmExecPath).toLowerCase() : "";
  const directories: string[] = [];

  if (npmExecPath && (npmExecBasename === "npm-cli.js" || npmExecBasename === "npx-cli.js")) {
    directories.push(path.dirname(npmExecPath));
  }

  // Node installers ship npm beside node.exe (node_modules/npm/bin).
  directories.push(path.join(path.dirname(nodePath), "node_modules", "npm", "bin"));

  // Global npm prefixes and Node directories on PATH, for direct CLI usage.
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const rawEntry of pathValue.split(platform === "win32" ? ";" : path.delimiter)) {
    const entry = rawEntry.trim().replace(/^"|"$/g, "");
    if (!entry) continue;
    directories.push(path.join(entry, "node_modules", "npm", "bin"));
  }

  if (env.APPDATA) {
    directories.push(path.join(env.APPDATA, "npm", "node_modules", "npm", "bin"));
  }

  const candidates = uniquePaths(directories).map((directory) => path.join(directory, cliName));
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  return cliPath ? { command: nodePath, args: [cliPath, ...args] } : null;
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
    const message = `Unable to locate the Windows ${command} CLI entrypoint. Checked npm beside Node.js (${path.dirname(process.execPath)}), PATH entries, and %APPDATA%\\npm. Set npm_execpath to npm-cli.js or npx-cli.js, or install npm alongside Node.js.`;

    return {
      command: printable,
      code: null,
      stdout: "",
      stderr: message,
      timedOut: false,
      environmentError: message,
    };
  }

  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let environmentError: string | undefined;

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
        environmentError,
      });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && (command === "npm" || command === "npx")) {
        environmentError = `${invocation.command} not found`;
      }
      stderr += `\n${error.code === "ENOENT" ? `${invocation.command} not found` : error.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
