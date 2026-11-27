import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  emptyResolutionStats,
  loadAliases,
  loadTsProjects,
  projectForFile,
  resolveSpecifier,
  resolveSpecifierInto,
} from "../src/core/module-resolution.js";

async function workspace(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), `dd-resolver-${prefix}-`));
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeDeep(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Fixtures nest files under directories that do not exist yet. */
async function writeDeep(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

test("NodeNext .js/.mjs/.cjs specifiers resolve to their TypeScript sources", async () => {
  const dir = await workspace("nodenext");
  await writeDeep(path.join(dir, "b.ts"), "export const b = 1;\n");
  await writeDeep(path.join(dir, "c.mts"), "export const c = 1;\n");
  await writeDeep(path.join(dir, "d.cts"), "export const d = 1;\n");

  for (const [spec, expected] of [
    ["./b.js", "b.ts"],
    ["./c.mjs", "c.mts"],
    ["./d.cjs", "d.cts"],
  ] as const) {
    const resolution = await resolveSpecifier({
      fromFile: path.join(dir, "a.ts"),
      spec,
    });
    assert.equal(resolution.path, path.join(dir, expected), spec);
  }
});

test("a missing relative module is reported as missing, not guessed", async () => {
  const dir = await workspace("missing");
  const resolution = await resolveSpecifier({
    fromFile: path.join(dir, "a.ts"),
    spec: "./nope.js",
  });
  assert.equal(resolution.path, null);
  assert.equal(resolution.reason, "missing");
});

test("index files and extensionless imports still resolve", async () => {
  const dir = await workspace("index");
  await mkdir(path.join(dir, "pkg"), { recursive: true });
  await writeDeep(path.join(dir, "pkg", "index.ts"), "export const pkg = 1;\n");

  const resolution = await resolveSpecifier({
    fromFile: path.join(dir, "a.ts"),
    spec: "./pkg",
  });
  assert.equal(resolution.path, path.join(dir, "pkg", "index.ts"));
});

test("tsconfig extends inherits paths, and a child paths block replaces the parent's", async () => {
  const dir = await workspace("extends");
  await writeDeep(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeDeep(path.join(dir, "wrong", "a.ts"), "export const a = 2;\n");

  await writeJson(path.join(dir, "tsconfig.base.json"), {
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["wrong/*"] } },
  });
  await writeJson(path.join(dir, "tsconfig.json"), {
    extends: "./tsconfig.base.json",
    include: ["src/**/*.ts"],
  });

  const projects = await loadTsProjects(dir);
  assert.equal(projects.length, 1);
  const fromFile = path.join(dir, "src", "a.ts");
  const project = projectForFile(projects, fromFile);
  assert.ok(project);

  // Without an override the inherited alias wins.
  assert.equal(
    (await resolveSpecifier({ fromFile, spec: "@/a", project })).path,
    path.join(dir, "wrong", "a.ts"),
  );

  await writeJson(path.join(dir, "tsconfig.json"), {
    extends: "./tsconfig.base.json",
    include: ["src/**/*.ts"],
    compilerOptions: { paths: { "@/*": ["src/*"] } },
  });

  const overridden = projectForFile(await loadTsProjects(dir), fromFile);
  assert.equal(
    (await resolveSpecifier({ fromFile, spec: "@/a", project: overridden })).path,
    path.join(dir, "src", "a.ts"),
  );
});

test("inherited paths keep the baseUrl of the config that declared them", async () => {
  const dir = await workspace("inherit-baseurl");
  await mkdir(path.join(dir, "config"), { recursive: true });
  await writeDeep(path.join(dir, "lib", "a.ts"), "export const a = 1;\n");
  await writeDeep(path.join(dir, "app", "main.ts"), "export const m = 1;\n");

  // baseUrl lives next to the base config; paths must resolve against it, not the child.
  await writeJson(path.join(dir, "config", "tsconfig.base.json"), {
    compilerOptions: { baseUrl: "../lib", paths: { "~/*": ["*"] } },
  });
  await writeJson(path.join(dir, "app", "tsconfig.json"), {
    extends: "../config/tsconfig.base.json",
    include: ["**/*.ts"],
  });

  const fromFile = path.join(dir, "app", "main.ts");
  const project = projectForFile(await loadTsProjects(dir), fromFile);
  assert.ok(project);
  assert.equal(
    (await resolveSpecifier({ fromFile, spec: "~/a", project })).path,
    path.join(dir, "lib", "a.ts"),
  );
});

test("multiple project configs pick the nearest owning tsconfig", async () => {
  const dir = await workspace("multi");
  await writeDeep(path.join(dir, "root-src", "a.ts"), "export const a = 1;\n");
  await writeDeep(path.join(dir, "apps", "app", "app-src", "a.ts"), "export const a = 2;\n");
  await writeDeep(path.join(dir, "apps", "app", "main.ts"), "export const m = 1;\n");

  await writeJson(path.join(dir, "tsconfig.json"), {
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["root-src/*"] } },
  });
  await writeJson(path.join(dir, "apps", "app", "tsconfig.json"), {
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["app-src/*"] } },
    include: ["**/*.ts"],
  });

  const projects = await loadTsProjects(dir);
  assert.equal(projects.length, 2);

  const fromFile = path.join(dir, "apps", "app", "main.ts");
  const project = projectForFile(projects, fromFile);
  assert.equal(project?.configPath, path.join(dir, "apps", "app", "tsconfig.json"));
  assert.equal(
    (await resolveSpecifier({ fromFile, spec: "@/a", project })).path,
    path.join(dir, "apps", "app", "app-src", "a.ts"),
  );

  const rootFile = path.join(dir, "root-src", "a.ts");
  assert.equal(
    (await resolveSpecifier({ fromFile: rootFile, spec: "@/a", project: projectForFile(projects, rootFile) }))
      .path,
    path.join(dir, "root-src", "a.ts"),
  );
});

test("equally-long alias patterns that disagree are ambiguous, not guessed", async () => {
  const dir = await workspace("ambiguous");
  await writeDeep(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
  await writeDeep(path.join(dir, "lib", "x.ts"), "export const x = 2;\n");
  await writeDeep(path.join(dir, "main.ts"), "export const m = 1;\n");

  await writeJson(path.join(dir, "tsconfig.json"), {
    compilerOptions: {
      baseUrl: ".",
      // Same prefix length ("@/"); both match "@/x.js" but point at different files.
      paths: { "@/*": ["src/*"], "@/*.js": ["lib/*"] },
    },
  });

  const fromFile = path.join(dir, "main.ts");
  const project = projectForFile(await loadTsProjects(dir), fromFile);
  const resolution = await resolveSpecifier({ fromFile, spec: "@/x.js", project });

  assert.equal(resolution.path, null);
  assert.equal(resolution.reason, "ambiguous");
});

test("bare packages are left alone; their counter is separate from unresolved ones", async () => {
  const dir = await workspace("bare");
  await writeDeep(path.join(dir, "main.ts"), "export const m = 1;\n");
  await writeJson(path.join(dir, "tsconfig.json"), {
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
  });

  const fromFile = path.join(dir, "main.ts");
  const project = projectForFile(await loadTsProjects(dir), fromFile);
  assert.equal(project?.aliases.length, 1);

  const stats = emptyResolutionStats();
  assert.equal(await resolveSpecifierInto({ fromFile, spec: "node:fs", project }, stats), null);
  assert.equal(await resolveSpecifierInto({ fromFile, spec: "@/gone", project }, stats), null);
  assert.deepEqual(stats, { bare: 1, unresolved: 1, ambiguous: 0 });
});

test("loadAliases keeps its public shape and reads JSONC", async () => {
  const dir = await workspace("jsonc");
  await writeDeep(
    path.join(dir, "tsconfig.json"),
    `{
      // aliases
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },
    }`,
  );

  const aliases = await loadAliases(dir);
  assert.deepEqual(aliases?.paths, [{ pattern: "@/*", targets: ["src/*"] }]);
  assert.equal(aliases?.baseUrl, dir);
  assert.equal(aliases?.entries?.[0]?.baseUrl, dir);
});
