import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandFor } from "../src/core/exec.js";

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
