import assert from "node:assert/strict";
import { test } from "node:test";
import { parseJUnit, testId } from "../src/core/junit-parse.js";

const XML = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="unit &amp; more" tests="4">
    <testcase classname="math" name="adds" time="0.125"/>
    <testcase classname="math" name="subtracts" time="0.5">
      <failure message="expected 1 to be 2">Error: expected 1 to be 2
    at math.test.ts:4</failure>
    </testcase>
    <testcase classname="math" name="divides"><error message="boom"/></testcase>
    <testcase classname="math" name="skips"><skipped/></testcase>
  </testsuite>
</testsuites>`;

test("reads every status, the suite name and rounded timings", () => {
  const cases = parseJUnit(XML);

  assert.equal(cases.length, 4);
  assert.deepEqual(
    cases.map((entry) => entry.status),
    ["passed", "failed", "failed", "skipped"],
  );
  assert.equal(cases[0]?.timeMs, 125);
  assert.equal(cases[0]?.suite, "unit & more");
  assert.equal(cases[1]?.message, "expected 1 to be 2");
});

test("ignores malformed or unnamed test cases", () => {
  assert.deepEqual(parseJUnit("<testcase name=\"\"/>"), []);
  assert.deepEqual(parseJUnit("not xml"), []);
});

test("builds stable ids with and without a classname", () => {
  assert.equal(testId({ plugin: "node", classname: "math", name: "adds" }), "node::math::adds");
  assert.equal(testId({ plugin: "node", name: "adds" }), "node::adds");
});
