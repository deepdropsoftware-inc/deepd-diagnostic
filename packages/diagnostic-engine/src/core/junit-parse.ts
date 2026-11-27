import { readFile } from "node:fs/promises";
import path from "node:path";
import { findPaths } from "./fs.js";
import type { CheckStatus } from "./types.js";

/** Minimal, dependency-free JUnit reader for the artifacts we already write. */
export interface JUnitCase {
  plugin: string;
  suite?: string;
  classname?: string;
  name: string;
  status: CheckStatus;
  timeMs: number;
  message?: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function attributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of text.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1] as string] = decodeEntities(match[2] as string);
  }
  return attrs;
}

export function parseJUnit(xml: string): Array<Omit<JUnitCase, "plugin">> {
  const cases: Array<Omit<JUnitCase, "plugin">> = [];
  const suite = /<testsuite\b[^>]*\bname="([^"]*)"/.exec(xml)?.[1];

  // Each <testcase> segment ends either self-closed (passed) or with children.
  for (const segment of xml.split(/<testcase\b/).slice(1)) {
    const headEnd = segment.indexOf(">");
    if (headEnd === -1) continue;

    const head = segment.slice(0, headEnd);
    const selfClosing = head.trimEnd().endsWith("/");
    const attrs = attributes(head);
    const name = attrs.name;
    if (!name) continue;

    let status: CheckStatus = "passed";
    let message: string | undefined;

    if (!selfClosing) {
      const rest = segment.slice(headEnd + 1);
      const close = rest.indexOf("</testcase>");
      const body = close === -1 ? rest : rest.slice(0, close);

      if (/<failure\b|<error\b/.test(body)) {
        status = "failed";
        const tag = /<(?:failure|error)\b([^>]*)>/.exec(body)?.[1] ?? "";
        message = attributes(tag).message;
        if (!message) {
          message = body
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240);
        }
        message ||= undefined;
      } else if (/<skipped\b/.test(body)) {
        status = "skipped";
      }
    }

    cases.push({
      suite: suite ? decodeEntities(suite) : undefined,
      classname: attrs.classname,
      name,
      status,
      timeMs: Math.round(Number(attrs.time ?? 0) * 1000),
      ...(message ? { message } : {}),
    });
  }

  return cases;
}

/**
 * Read every plugin's `artifacts/<plugin>/junit.xml`.
 * The aggregate `artifacts/junit.xml` is skipped: its suites are already counted
 * per plugin, and double-counting would poison the history.
 */
export async function readJUnitResults(artifactsRoot: string): Promise<JUnitCase[]> {
  const cases: JUnitCase[] = [];
  const files = await findPaths(artifactsRoot, ["junit.xml"], 2);

  for (const file of files) {
    const relative = path.relative(artifactsRoot, file);
    const segments = relative.split(/[\\/]/);
    if (segments.length !== 2) continue;
    const plugin = segments[0] as string;

    let xml: string;
    try {
      xml = await readFile(file, "utf8");
    } catch {
      continue;
    }

    for (const parsed of parseJUnit(xml)) cases.push({ plugin, ...parsed });
  }

  return cases;
}

export function testId(test: Pick<JUnitCase, "plugin" | "classname" | "name">): string {
  const scope = (test.classname ?? "").trim();
  const name = test.name.trim();
  return scope ? `${test.plugin}::${scope}::${name}` : `${test.plugin}::${name}`;
}
