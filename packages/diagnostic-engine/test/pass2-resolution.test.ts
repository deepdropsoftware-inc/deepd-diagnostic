import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scanModuleGraph } from "../src/core/pass2-analysis.js";

test("NodeNext .js specifiers resolve to their .ts sources", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-pass2-"));
  await writeFile(path.join(dir, "b.ts"), "export const value = 1;\n");
  await writeFile(
    path.join(dir, "a.ts"),
    'import { value } from "./b.js";\nexport const doubled = value * 2;\n',
  );

  const findings = await scanModuleGraph(dir, [path.join(dir, "a.ts"), path.join(dir, "b.ts")]);
  assert.deepEqual(findings, []);
});

test("a genuinely missing module is still reported", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-pass2-missing-"));
  await writeFile(path.join(dir, "a.ts"), 'import { gone } from "./gone.js";\n');

  const findings = await scanModuleGraph(dir, [path.join(dir, "a.ts")]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "unresolved-import");
  assert.equal(findings[0]?.severity, "error");
});

test("inline `type` modifiers are not mistaken for symbol names", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-pass2-types-"));
  await writeFile(
    path.join(dir, "b.ts"),
    "export interface Shape { size: number }\nexport const value = 1;\n",
  );
  await writeFile(
    path.join(dir, "a.ts"),
    'import { type Shape, value } from "./b.js";\nexport const use = (shape: Shape) => value + shape.size;\n',
  );

  const findings = await scanModuleGraph(dir, [path.join(dir, "a.ts"), path.join(dir, "b.ts")]);
  assert.deepEqual(findings, []);
});

test("named imports are checked against the resolved .ts module", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-pass2-symbol-"));
  await writeFile(path.join(dir, "b.ts"), "export const value = 1;\n");
  await writeFile(path.join(dir, "a.ts"), 'import { missing } from "./b.js";\n');

  const findings = await scanModuleGraph(dir, [path.join(dir, "a.ts"), path.join(dir, "b.ts")]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.kind, "missing-symbol");
  assert.match(findings[0]?.message ?? "", /does not export it/);
});
