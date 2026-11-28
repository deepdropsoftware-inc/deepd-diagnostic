import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { commandFor, exec } from "../src/core/exec.js";

async function makeLocalScriptPackage(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-npm-script-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "dd-exec-fixture",
      version: "1.0.0",
      private: true,
      scripts: {
        "echo-args": "node echo-args.js",
        fail: "node fail.js",
      },
    }),
  );
  await writeFile(
    path.join(dir, "echo-args.js"),
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
  );
  await writeFile(path.join(dir, "fail.js"), "process.exit(7);");
  return dir;
}

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

test("integration: npm preserves arguments containing spaces using a local script", async () => {
  const dir = await makeLocalScriptPackage();
  const expected = ["argument with spaces", 'quote"inside', "backslash\\path", "trailing "];

  try {
    const result = await exec(
      "npm",
      ["run", "--silent", "echo-args", "--", ...expected],
      dir,
      30_000,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("integration: npm propagates a failing local script exit code", async () => {
  const dir = await makeLocalScriptPackage();

  try {
    const result = await exec("npm", ["run", "--silent", "fail"], dir, 30_000);
    assert.equal(result.code, 7, result.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("integration: direct child timeout is reported", async () => {
  const result = await exec("node", ["-e", "setTimeout(() => {}, 5000)"], process.cwd(), 250);
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
});
