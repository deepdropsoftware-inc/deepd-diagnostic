import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadAliases, selectFromGraph } from "../src/core/impact.js";

async function fixture(): Promise<{ dir: string; files: string[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-impact-"));
  await mkdir(path.join(dir, "src", "nested"), { recursive: true });
  await mkdir(path.join(dir, "tests"), { recursive: true });

  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(dir, "src", "nested", "b.ts"), "export const b = 2;\n");
  await writeFile(
    path.join(dir, "tests", "alias.test.ts"),
    'import { a } from "@/a";\nexport const t = a;\n',
  );
  await writeFile(
    path.join(dir, "tests", "nested.test.ts"),
    'import { b } from "@/nested/b";\nexport const t = b;\n',
  );

  // tsconfig is JSONC in practice: a comment and a trailing comma must not break the reader.
  await writeFile(
    path.join(dir, "tsconfig.json"),
    `{
      // path aliases
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["src/*"] },
      },
    }`,
  );

  const files = ["src/a.ts", "src/nested/b.ts", "tests/alias.test.ts", "tests/nested.test.ts"].map(
    (file) => path.join(dir, file),
  );

  return { dir, files };
}

test("resolves tsconfig aliases so an aliased test is selected", async () => {
  const { dir, files } = await fixture();

  const aliases = await loadAliases(dir);
  assert.deepEqual(aliases?.paths, [{ pattern: "@/*", targets: ["src/*"] }]);

  const selected = await selectFromGraph({
    target: dir,
    changed: [path.join(dir, "src", "a.ts")],
    files,
  });
  assert.deepEqual(selected, ["tests/alias.test.ts"]);
});

test("nested aliases resolve, and a changed test selects itself", async () => {
  const { dir, files } = await fixture();

  assert.deepEqual(
    await selectFromGraph({
      target: dir,
      changed: [path.join(dir, "src", "nested", "b.ts")],
      files,
    }),
    ["tests/nested.test.ts"],
  );

  assert.deepEqual(
    await selectFromGraph({
      target: dir,
      changed: [path.join(dir, "tests", "nested.test.ts")],
      files,
    }),
    ["tests/nested.test.ts"],
  );
});

test("NodeNext .js specifiers are followed through the graph", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-impact-nodenext-"));
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "tests"), { recursive: true });

  await writeFile(path.join(dir, "src", "b.ts"), "export const b = 1;\n");
  await writeFile(
    path.join(dir, "src", "a.ts"),
    'import { b } from "./b.js";\nexport const a = b;\n',
  );
  await writeFile(
    path.join(dir, "tests", "a.test.ts"),
    'import { a } from "../src/a.js";\nexport const t = a;\n',
  );

  const selected = await selectFromGraph({
    target: dir,
    changed: [path.join(dir, "src", "b.ts")],
    files: ["src/a.ts", "src/b.ts", "tests/a.test.ts"].map((file) => path.join(dir, file)),
  });
  assert.deepEqual(selected, ["tests/a.test.ts"]);
});

test("an alias that does not resolve is counted, so a partial selection is visible", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-impact-unresolved-"));
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(
    path.join(dir, "tests", "gone.test.ts"),
    'import { x } from "@/gone";\nexport const t = x;\n',
  );
  await writeFile(
    path.join(dir, "tsconfig.json"),
    '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}\n',
  );

  const stats = { unresolved: 0, ambiguous: 0, bare: 0 };
  await selectFromGraph({
    target: dir,
    changed: [path.join(dir, "src", "gone.ts")],
    files: [path.join(dir, "tests", "gone.test.ts")],
    stats,
  });
  assert.equal(stats.unresolved, 1);
});

test("a project without aliases still resolves relative imports only", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "dd-impact-bare-"));
  await mkdir(path.join(dir, "tests"), { recursive: true });
  await writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(dir, "tests", "a.test.ts"), 'import { a } from "../a";\nexport const t = a;\n');

  const selected = await selectFromGraph({
    target: dir,
    changed: [path.join(dir, "a.ts")],
    files: [path.join(dir, "a.ts"), path.join(dir, "tests", "a.test.ts")],
  });
  assert.deepEqual(selected, ["tests/a.test.ts"]);
  assert.equal(await loadAliases(dir), null);
});
