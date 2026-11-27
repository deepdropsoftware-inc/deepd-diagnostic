import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandFor, exec } from "../src/core/exec.js";

test("Windows npm and npx resolution derives the requested CLI from either npm_execpath", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-exec-windows-"));
  const bin = path.join(dir, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true });
  const npmCli = path.join(bin, "npm-cli.js");
  const npxCli = path.join(bin, "npx-cli.js");
  await writeFile(npmCli, "");
  await writeFile(npxCli, "");

  try {
    assert.deepEqual(
      commandFor("win32", "npm", ["run", "check:armor"], { npm_execpath: npxCli }, "C:\\node\\node.exe"),
      { command: "C:\\node\\node.exe", args: [npmCli, "run", "check:armor"] },
    );
    assert.deepEqual(
      commandFor("win32", "npx", ["tsc", "--noEmit"], { npm_execpath: npmCli }, "C:\\node\\node.exe"),
      { command: "C:\\node\\node.exe", args: [npxCli, "tsc", "--noEmit"] },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows direct CLI resolution works without npm_execpath when npm is beside Node", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-node-install-"));
  const bin = path.join(dir, "node_modules", "npm", "bin");
  await mkdir(bin, { recursive: true });
  const npmCli = path.join(bin, "npm-cli.js");
  await writeFile(npmCli, "");

  try {
    assert.deepEqual(
      commandFor("win32", "npm", ["--version"], {}, path.join(dir, "node.exe")),
      { command: path.join(dir, "node.exe"), args: [npmCli, "--version"] },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Windows resolution rejects an unrelated npm_execpath and reports unavailable CLI", () => {
  assert.equal(
    commandFor("win32", "npm", ["--version"], { npm_execpath: "C:\\tools\\custom.js" }, "C:\\node\\node.exe"),
    null,
  );
});

test("non-Windows commands retain their executable and argument boundaries", () => {
  const args = ["run", "check:armor", "--", "argument with spaces"];
  assert.deepEqual(commandFor("linux", "npm", args), { command: "npm", args });
});

test("integration: npm and npx execute through the production launcher", async () => {
  const npm = await exec("npm", ["--version"], process.cwd(), 30_000);
  assert.equal(npm.code, 0, npm.stderr);
  const npx = await exec("npx", ["--version"], process.cwd(), 30_000);
  assert.equal(npx.code, 0, npx.stderr);
});

test("integration: npm preserves arguments containing spaces", async () => {
  const result = await exec(
    "npm",
    ["exec", "--", "node", "-e", "process.stdout.write(process.argv[1])", "argument with spaces"],
    process.cwd(),
    30_000,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /argument with spaces/);
});

test("integration: npm propagates a failing child exit code", async () => {
  const result = await exec("npm", ["exec", "--", "node", "-e", "process.exit(7)"], process.cwd(), 30_000);
  assert.equal(result.code, 7, result.stderr);
});

test("integration: direct child timeout is reported", async () => {
  const result = await exec("node", ["-e", "setTimeout(() => {}, 5000)"], process.cwd(), 250);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});
