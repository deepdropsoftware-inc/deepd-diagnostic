import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readBlockers } from "./blockers.js";
import {
  collectSourceFiles,
  scanHtmlReferences,
  scanModuleGraph,
  scanPythonImports,
} from "./pass2-analysis.js";
import type {
  Blocker,
  Pass2Fix,
  Pass2Finding,
  Pass2Report,
  Pass2Triage,
  RunContext,
} from "./types.js";

export const PASS2_LABEL = "Logic & Debt";
export const PASS2_APPROACH =
  "relational — cross-file reference graph + blocker triage (Pass 1 output is input, not re-run)";

/** Where automation for a blocker is known, Pass 2 can write it. */
interface FixHandler {
  id: string;
  matches(blocker: Blocker): boolean;
  describe(blocker: Blocker): string;
  apply(ctx: RunContext): Promise<string[]>;
}

const NEXTEST_CONFIG = path.join(".config", "nextest.toml");

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

const FIX_HANDLERS: FixHandler[] = [
  {
    id: "nextest-junit-profile",
    matches: (blocker) => blocker.id === "rust:nextest junit",
    describe: () => `write [profile.ci.junit] path = "junit.xml" to ${NEXTEST_CONFIG}`,
    apply: async (ctx) => {
      const file = path.join(ctx.target, NEXTEST_CONFIG);
      const existing = await readText(file);
      if (existing?.includes("[profile.ci.junit]")) return [];

      const block = '[profile.ci.junit]\npath = "junit.xml"\n';
      const content = existing
        ? `${existing.replace(/\s*$/, "")}\n\n${block}`
        : `# Added by deepdiagnose Pass 2\n${block}`;

      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      return [NEXTEST_CONFIG];
    },
  },
];

/** How to close a blocker that needs a human or a machine-level change. */
const MANUAL_ACTIONS: Record<string, string> = {
  armor:
    "install packages/angel-armor, or point armor.scripts at the scripts this project actually has",
  node: "npm install (eslint / vitest / typescript are declared but missing)",
  go: "install Go, then: go install gotest.tools/gotestsum@latest && go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest",
  python: "install the missing tool: pip install pytest ruff mypy",
  rust: "install Rust, then: cargo install cargo-nextest",
  dotnet: "install the .NET SDK; add JunitXml.TestLogger to the test project for native JUnit",
  ruby: "bundle add rubocop rspec_junit_formatter",
  php: "composer install, or composer require --dev phpunit/phpunit phpstan/phpstan",
  android: "install a JDK, or add the Gradle wrapper (./gradlew)",
  apple: "run on macOS with Xcode installed, plus: brew install xcbeautify",
};

function triageFor(openBlockers: Blocker[]): Pass2Triage[] {
  return openBlockers.map((blocker) => {
    const handler = FIX_HANDLERS.find((candidate) => candidate.matches(blocker));

    if (handler) {
      return {
        blockerId: blocker.id,
        plugin: blocker.plugin,
        check: blocker.check,
        disposition: "auto-fixable",
        action: handler.describe(blocker),
      };
    }

    return {
      blockerId: blocker.id,
      plugin: blocker.plugin,
      check: blocker.check,
      disposition: "manual",
      action: MANUAL_ACTIONS[blocker.plugin] ?? "resolve the cause, then rerun deepdiagnose",
    };
  });
}

export interface Pass2Params {
  ctx: RunContext;
  /** `--fix`: apply known automations. Analysis itself always runs. */
  fix: boolean;
  /** Fixes applied by an earlier Pass 2 in this same run (post-fix verification). */
  previousFixes?: Pass2Fix[];
}

/**
 * Pass 2 asks a different question than Pass 1: not "is this file valid?" but
 * "do these files still agree with each other, and what debt is left?".
 * It never re-runs a linter; it relates files and audits the blocker ledger.
 */
export async function runPass2(params: Pass2Params): Promise<Pass2Report> {
  const startedAt = Date.now();
  const { ctx } = params;

  // 1. Relational analysis across file types.
  const files = await collectSourceFiles(ctx.target, {
    ignore: ctx.config.pass2Ignore ?? [],
  });

  const rawFindings: Pass2Finding[] = [
    ...(await scanHtmlReferences(ctx.target, files.html)),
    ...(await scanModuleGraph(ctx.target, files.scripts)),
    ...(await scanPythonImports(ctx.target, files.python)),
  ];

  const findings = [...new Map(rawFindings.map((finding) => [finding.id, finding])).values()];
  findings.sort((a, b) =>
    a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === "error" ? -1 : 1,
  );

  // 2. Debt audit from the ledger Pass 1 just wrote.
  const blockersPath = path.resolve(ctx.repoRoot, ctx.config.blockersFile ?? "blockers.json");
  const openBlockers = (await readBlockers(blockersPath)).filter(
    (blocker) => blocker.status === "open",
  );
  const triage = triageFor(openBlockers);

  // 3. Attempt the automation we actually know how to build.
  const fixes: Pass2Fix[] = params.previousFixes ? [...params.previousFixes] : [];

  for (const entry of triage) {
    if (entry.disposition !== "auto-fixable") continue;

    const alreadyHandled = fixes.find(
      (fix) => fix.blockerId === entry.blockerId && fix.applied,
    );
    if (alreadyHandled) {
      entry.applied = true;
      continue;
    }

    const blocker = openBlockers.find((candidate) => candidate.id === entry.blockerId);
    const handler = blocker
      ? FIX_HANDLERS.find((candidate) => candidate.matches(blocker))
      : undefined;
    if (!blocker || !handler) continue;

    if (!params.fix) {
      fixes.push({
        blockerId: blocker.id,
        description: entry.action,
        applied: false,
        files: [],
        reason: "run with --fix to apply",
      });
      continue;
    }

    try {
      const changed = await handler.apply(ctx);
      entry.applied = true;
      fixes.push({
        blockerId: blocker.id,
        description: entry.action,
        applied: true,
        files: changed,
      });
    } catch (error) {
      fixes.push({
        blockerId: blocker.id,
        description: entry.action,
        applied: false,
        files: [],
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;

  return {
    label: PASS2_LABEL,
    approach: PASS2_APPROACH,
    summary: {
      ok: errors === 0,
      errors,
      warnings,
      filesScanned: files.all.length,
      blockersOpen: openBlockers.length,
      fixable: triage.filter((entry) => entry.disposition === "auto-fixable").length,
      manual: triage.filter((entry) => entry.disposition === "manual").length,
      fixesApplied: fixes.filter((fix) => fix.applied).length,
      durationMs: Date.now() - startedAt,
    },
    findings,
    fixes,
    triage,
  };
}
