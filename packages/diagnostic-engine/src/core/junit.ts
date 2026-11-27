import type { CheckResult } from "./types.js";

/** Escape text for XML 1.0 and drop characters that are illegal in XML. */
export function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function counts(checks: CheckResult[]) {
  return {
    tests: checks.length,
    failures: checks.filter((check) => check.status === "failed").length,
    skipped: checks.filter((check) => check.status === "skipped").length,
  };
}

/**
 * Synthesize JUnit from check results. Used when a toolchain has no native
 * JUnit reporter (tsc, go test, cargo test), so every plugin still publishes
 * the same machine-readable contract.
 */
export function junitFromChecks(
  suite: string,
  checks: CheckResult[],
  durationMs: number,
): string {
  const { tests, failures, skipped } = counts(checks);
  const totalTime = (durationMs / 1000).toFixed(3);

  const cases = checks.map((check) => {
    const time = (check.durationMs / 1000).toFixed(3);
    const open = `    <testcase classname="${escapeXml(suite)}" name="${escapeXml(check.name)}" time="${time}"`;

    if (check.status === "failed") {
      return [
        `${open}>`,
        `      <failure message="${escapeXml(check.message ?? "failed")}">${escapeXml(
          (check.output ?? "").slice(-4000),
        )}</failure>`,
        "    </testcase>",
      ].join("\n");
    }

    if (check.status === "skipped") {
      return [
        `${open}>`,
        `      <skipped message="${escapeXml(check.message ?? "skipped")}"/>`,
        "    </testcase>",
      ].join("\n");
    }

    return `${open}/>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(suite)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${totalTime}">`,
    `  <testsuite name="${escapeXml(suite)}" tests="${tests}" failures="${failures}" skipped="${skipped}" time="${totalTime}">`,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

/**
 * Pull the <testsuite> blocks out of any JUnit file, whether the tool wrapped
 * them in <testsuites> or emitted a bare <testsuite>.
 */
export function extractSuites(xml: string): string {
  const clean = xml
    .replace(/<\?xml[^>]*\?>/g, "")
    .replace(/<!DOCTYPE[^>]*>/g, "")
    .trim();

  if (clean.startsWith("<testsuites")) {
    const open = clean.indexOf(">");
    const close = clean.lastIndexOf("</testsuites>");
    if (open === -1 || close <= open) return "";
    return clean.slice(open + 1, close).trim();
  }

  if (clean.startsWith("<testsuite")) return clean;
  return "";
}

export function buildJUnitDocument(name: string, suiteBlocks: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(name)}">`,
    ...suiteBlocks.map((block) => block.replace(/^/gm, "  ")),
    "</testsuites>",
    "",
  ].join("\n");
}
