import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFailures } from "../src/core/explain.js";
import type { PluginResult } from "../src/core/types.js";

function resultWith(checks: PluginResult["checks"]): PluginResult {
  return { id: "probe", label: "Probe", base: false, status: "failed", durationMs: 1, checks };
}

test("classifies known signatures in rule order and ignores passing checks", () => {
  const failures = classifyFailures([
    resultWith([
      {
        name: "toolchain",
        status: "failed",
        durationMs: 1,
        command: "rustc --version",
        exitCode: 127,
        output: "sh: rustc: command not found",
      },
      {
        name: "types",
        status: "failed",
        durationMs: 1,
        output: "src/a.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      },
      { name: "unit", status: "failed", durationMs: 1, output: "AssertionError: expected 1 to be 2" },
      { name: "ok", status: "passed", durationMs: 1 },
    ]),
  ]);

  assert.deepEqual(
    failures.map((failure) => failure.category),
    ["missing-tool", "type-error", "test-assertion"],
  );
  assert.equal(failures.length, 3);
  assert.ok(failures.every((failure) => failure.source === "rules"));
  assert.equal(failures[0]?.exitCode, 127);
  assert.equal(failures[0]?.command, "rustc --version");
  assert.match(failures[0]?.excerpt ?? "", /command not found/);
});

test("unknown output still produces a record instead of being dropped", () => {
  const failures = classifyFailures([
    resultWith([{ name: "mystery", status: "failed", durationMs: 1, output: "something odd happened" }]),
  ]);

  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.category, "unknown");
  assert.equal(failures[0]?.confidence, 0.3);
  assert.equal(failures[0]?.id, "probe::mystery");
});

test("a clean run has nothing to explain", () => {
  assert.deepEqual(classifyFailures([resultWith([{ name: "ok", status: "passed", durationMs: 1 }])]), []);
});
