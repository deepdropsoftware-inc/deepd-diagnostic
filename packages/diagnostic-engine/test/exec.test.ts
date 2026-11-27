import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandFor } from "../src/core/exec.js";
import { runStepRaw } from "../src/core/checks.js";
import type { CommandResult, RunContext } from "../src/core/types.js";

test("Windows npm and npx commands use Node to launch CLI JavaScript without a shell", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-exec-windows-"));
  const bin = path.join(dir, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true });
  const npmCli = path.join(bin, "npm-cli.js");
  const npxCli = path.join(bin, "npx-cli.js");
  await writeFile(npmCli, "");
  await writeFile(npxCli, "");

  const previous = process.env.npm_execpath;
  process.env.npm_execpath = npmCli;
  try {
    const npm = commandFor("win32", "npm", ["run", "check:armor"]);
    assert.deepEqual(npm, {
      command: process.execPath,
      args: [npmCli, "run", "check:armor"],
    });

    const npx = commandFor("win32", "npx", ["tsc", "--noEmit"]);
    assert.deepEqual(npx, {
      command: process.execPath,
      args: [npxCli, "tsc", "--noEmit"],
    });
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-Windows commands retain their original executable and argument boundaries", () => {
  const args = ["run", "check:armor", "--", "argument with spaces"];
  assert.deepEqual(commandFor("linux", "npm", args), {
    command: "npm",
    args,
  });
});

test("direct Windows CLI resolution searches PATH when npm_execpath is unset", async () => {
  const nodeDir = await mkdtemp(path.join(tmpdir(), "dd-node-dir-"));
  const pathDir = await mkdtemp(path.join(tmpdir(), "dd-path-dir-"));
  const bin = path.join(pathDir, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true });
  const npmCli = path.join(bin, "npm-cli.js");
  await writeFile(npmCli, "");

  try {
    const npm = commandFor("win32", "npm", ["--version"], { PATH: pathDir }, path.join(nodeDir, "node.exe"));
    assert.deepEqual(npm, {
      command: path.join(nodeDir, "node.exe"),
      args: [npmCli, "--version"],
    });
  } finally {
    await rm(nodeDir, { recursive: true, force: true });
    await rm(pathDir, { recursive: true, force: true });
  }
});

test("missing npm and npx CLIs resolve to null rather than a wrong executable", async () => {
  const nodeDir = await mkdtemp(path.join(tmpdir(), "dd-missing-node-"));
  try {
    for (const command of ["npm", "npx"] as const) {
      assert.equal(
        commandFor("win32", command, ["--version"], { PATH: "", APPDATA: "" }, path.join(nodeDir, "node.exe")),
        null,
      );
    }
  } finally {
    await rm(nodeDir, { recursive: true, force: true });
  }
});

test("an unavailable npm launcher is classified as an environment blocker, not a failed check", async () => {
  const result: CommandResult = {
    command: "npm run typecheck",
    code: null,
    stdout: "",
    stderr: "Unable to locate the Windows npm CLI entrypoint",
    timedOut: false,
    environmentError: "Unable to locate the Windows npm CLI entrypoint",
  };
  const ctx = {
    exec: async () => result,
  } as unknown as RunContext;

  const { check } = await runStepRaw(ctx, "typecheck", "npm", ["run", "typecheck"], "/tmp");

  assert.equal(check.status, "skipped");
  assert.equal(check.kind, "blocker");
  assert.equal(check.exitCode, null);
  assert.match(check.message ?? "", /environment unavailable/);
});
