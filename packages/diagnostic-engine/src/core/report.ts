import { writeFile } from "node:fs/promises";
import type {
  CheckResult,
  CheckStatus,
  DiagnosticReport,
  ExplainReport,
  FlakyReport,
  ImpactReport,
  Pass2Report,
  PluginResult,
} from "./types.js";

const COLOR_ENABLED =
  !process.env.NO_COLOR && (process.stdout.isTTY === true || Boolean(process.env.FORCE_COLOR));

const style = (code: string) => (text: string) =>
  COLOR_ENABLED ? `\u001b[${code}m${text}\u001b[0m` : text;

const red = style("31");
const green = style("32");
const yellow = style("33");
const magenta = style("35");
const cyan = style("36");
const dim = style("2");
const bold = style("1");

const ICONS: Record<CheckStatus, string> = { passed: "✔", failed: "✖", skipped: "◌" };

function colorStatus(status: CheckStatus, text: string): string {
  if (status === "failed") return red(text);
  if (status === "passed") return green(text);
  return yellow(text);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function indentOutput(output: string, prefix = "      "): string[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const kept = lines.slice(-40);
  const rendered = kept.map((line) => dim(`${prefix}${line}`));
  if (lines.length > kept.length) {
    rendered.unshift(dim(`${prefix}… ${lines.length - kept.length} earlier lines omitted`));
  }
  return rendered;
}

function renderCheck(check: CheckResult): string[] {
  const lines: string[] = [];
  const detail = check.command ? ` ${dim(`(${check.command})`)}` : "";
  lines.push(
    `    ${colorStatus(check.status, ICONS[check.status])} ${pad(check.name, 22)} ${colorStatus(
      check.status,
      check.status,
    )}${detail}${check.message ? ` ${dim(check.message)}` : ""}`,
  );

  if (check.status === "failed" && check.output) lines.push(...indentOutput(check.output));
  return lines;
}

function sectionHeader(title: string, subtitle: string): string[] {
  return ["", bold(cyan(title)), dim(`  ${subtitle}`)];
}

function renderPass1(plugins: PluginResult[], durationMs: number): string[] {
  const lines: string[] = [];

  if (plugins.length === 0) {
    lines.push(yellow("  No plugin recognized this folder. Nothing was run."));
    return lines;
  }

  for (const plugin of plugins) {
    const marker = plugin.base ? "!" : " ";

    if (plugin.blocked) {
      lines.push(
        `  ${marker} ${magenta("⊘")} ${pad(plugin.label, 24)} ${pad(magenta("blocked"), 12)} ${dim(
          plugin.message ?? "Angel Armor failed",
        )}`,
      );
      continue;
    }

    lines.push(
      `  ${marker} ${colorStatus(plugin.status, ICONS[plugin.status])} ${pad(plugin.label, 24)} ${pad(
        colorStatus(plugin.status, plugin.status),
        12,
      )} ${dim(`${plugin.checks.length} checks · ${formatDuration(plugin.durationMs)}`)}`,
    );

    for (const check of plugin.checks) {
      if (check.status === "passed") continue;
      lines.push(...renderCheck(check));
    }
  }

  const checks = plugins.flatMap((plugin) => plugin.checks);
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.filter((check) => check.status === "passed").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  lines.push(
    dim(`  ${passed} passed · ${failed} failed · ${skipped} skipped · ${formatDuration(durationMs)}`),
  );

  return lines;
}

function renderPass2(pass2: Pass2Report): string[] {
  const lines: string[] = [];
  const { summary } = pass2;

  lines.push(
    dim(
      `  ${summary.filesScanned} files scanned · ${summary.errors} errors · ${summary.warnings} warnings · ${summary.fixesApplied} fixes applied · ${formatDuration(summary.durationMs)}`,
    ),
  );

  const shown = pass2.findings.slice(0, 25);
  for (const finding of shown) {
    const mark = finding.severity === "error" ? red("✖") : yellow("⚠");
    const where = finding.reference ? `${finding.file} → ${finding.reference}` : finding.file;
    lines.push(`  ${mark} ${bold(where)} ${dim(`[${finding.kind}]`)}`);
    lines.push(`      ${finding.message}`);
    if (finding.hint) lines.push(dim(`      hint: ${finding.hint}`));
  }
  if (pass2.findings.length > shown.length) {
    lines.push(dim(`  … ${pass2.findings.length - shown.length} more findings in the report`));
  }

  if (pass2.summary.blockersOpen > 0 || pass2.triage.length > 0) {
    lines.push(
      `  ${dim(
        `debt: ${summary.blockersOpen} open blockers · ${summary.fixable} auto-fixable · ${summary.manual} manual`,
      )}`,
    );
    for (const entry of pass2.triage.slice(0, 12)) {
      const resolved = entry.applied ? green("fixed") : dim(entry.disposition);
      lines.push(`      ${entry.applied ? green("✔") : "○"} ${pad(entry.blockerId, 30)} ${resolved}`);
      lines.push(dim(`        ${entry.action}`));
    }
    if (pass2.triage.length > 12) {
      lines.push(dim(`      … ${pass2.triage.length - 12} more in blockers.json`));
    }
  }

  if (summary.ok) lines.push(green("  ✔ pass 2 clean"));
  return lines;
}

function renderSignals(flaky: FlakyReport): string[] {
  const lines: string[] = [];

  if (!flaky.enabled) {
    lines.push(dim("  disabled with --no-flaky"));
    return lines;
  }

  lines.push(
    dim(
      `  history: ${flaky.runsStored} run(s) · commit ${flaky.commit}${
        flaky.dirty ? " (dirty tree)" : ""
      } · ${flaky.testsTracked} tests tracked · flake score ${flaky.flakeScore}%`,
    ),
  );

  if (flaky.note) lines.push(yellow(`  ${flaky.note}`));

  if (flaky.flaky.length === 0 && flaky.testsTracked > 0) {
    lines.push(green(`  ✔ no flaky tests across ${flaky.runsStored} run(s)`));
  }

  for (const test of flaky.flaky.slice(0, 12)) {
    lines.push(
      `  ${red("✖")} ${bold(test.id)} ${red("flaky")} ${dim(
        `rate ${Math.round(test.flakeRate * 100)}% · same-commit mixed: ${
          test.sameCommitMixed ? "yes" : "no"
        } · ${test.runs} runs (${test.passes} pass / ${test.failures} fail)`,
      )}`,
    );
  }

  for (const test of flaky.stableFailing.slice(0, 6)) {
    lines.push(
      `  ${yellow("⚠")} ${bold(test.id)} ${yellow("stable-failing")} ${dim(
        `${test.failures}/${test.runs} runs failed`,
      )}`,
    );
  }

  if (flaky.insufficient > 0) {
    lines.push(dim(`  ○ ${flaky.insufficient} test(s) below ${flaky.minRuns} runs — history still building`));
  }

  return lines;
}

function renderImpact(impact: ImpactReport): string[] {
  const lines: string[] = [];

  if (!impact.enabled) {
    lines.push(dim(`  ${impact.note ?? "disabled"}`));
    return lines;
  }

  lines.push(
    dim(
      `  adapter: ${impact.adapter} · base: ${impact.base} · ${impact.changedFiles.length} changed file(s) · ` +
        `${impact.selectedTests.length}/${impact.candidates} test(s) selected (${impact.reductionPct}% smaller)`,
    ),
  );
  if (impact.fallbackReason) lines.push(yellow(`  ${impact.fallbackReason}`));
  if (impact.note) lines.push(yellow(`  ${impact.note}`));

  for (const test of impact.selectedTests.slice(0, 10)) {
    lines.push(`  ${green("○")} ${dim(test)}`);
  }
  if (impact.selectedTests.length > 10) {
    lines.push(
      dim(`  … ${impact.selectedTests.length - 10} more in artifacts/impact/report.json`),
    );
  }

  return lines;
}

function renderExplain(explain: ExplainReport): string[] {
  const lines: string[] = [];

  if (!explain.enabled) {
    lines.push(dim(`  ${explain.note ?? "disabled"}`));
    return lines;
  }

  const model = explain.mode === "llm" && explain.model ? ` · model: ${explain.model}` : "";
  lines.push(
    dim(`  mode: ${explain.mode}${model} · ${explain.failures.length} failure(s)`),
  );
  if (explain.note) lines.push(yellow(`  ${explain.note}`));

  for (const failure of explain.failures.slice(0, 10)) {
    lines.push(
      `  ${red("✖")} ${bold(failure.category)} ${dim(
        `[${failure.id}] · ${Math.round(failure.confidence * 100)}% ${failure.source}`,
      )}`,
    );
    if (failure.excerpt) lines.push(dim(`      ${failure.excerpt}`));
    if (failure.suggestion) lines.push(`      ${failure.suggestion}`);
  }
  if (explain.failures.length > 10) {
    lines.push(dim(`  … ${explain.failures.length - 10} more in artifacts/explain/report.json`));
  }

  return lines;
}

export function printReport(report: DiagnosticReport, reportPath: string): void {
  const lines: string[] = ["", bold(`${report.engine} v${report.engineVersion}`)];
  const cassetteLabel = report.target.cassette ? ` (cassette: ${report.target.cassette})` : "";

  lines.push(dim(`target: ${report.target.relative}${cassetteLabel}`));
  lines.push(dim(`repo:   ${report.target.repoRoot}`));

  lines.push(...sectionHeader(`PASS 1 · ${report.pass1.label}`, report.pass1.approach));
  lines.push(...renderPass1(report.pass1.plugins, report.pass1.summary.durationMs));

  if (report.twoPass && report.pass2) {
    lines.push(...sectionHeader(`PASS 2 · ${report.pass2.label}`, report.pass2.approach));
    lines.push(...renderPass2(report.pass2));
  } else {
    lines.push("", dim("PASS 2 · disabled (twoPass: false)"));
  }

  if (report.signals) {
    lines.push(
      ...sectionHeader(
        "SIGNALS · Flaky detection",
        "per-test history over the JUnit artifacts Pass 1 already produced",
      ),
    );
    lines.push(...renderSignals(report.signals.flaky));

    if (report.signals.impact) {
      lines.push(
        ...sectionHeader(
          "SIGNALS · Test impact",
          "which tests the diff can reach — selection only, nothing is executed",
        ),
      );
      lines.push(...renderImpact(report.signals.impact));
    }

    if (report.signals.explain) {
      lines.push(
        ...sectionHeader(
          "SIGNALS · Failure triage",
          "rules first; a model is asked only when --ai-explain and OPENAI_API_KEY are both present",
        ),
      );
      lines.push(...renderExplain(report.signals.explain));
    }
  }

  const { passed, failed, skipped, blocked, durationMs, ok } = report.summary;
  lines.push("");
  lines.push(
    `${ok ? green("✔ diagnostics passed") : red("✖ diagnostics failed")} ${dim(
      `${passed} passed · ${failed} failed · ${skipped} skipped · ${blocked} blocked · ${formatDuration(
        durationMs,
      )}`,
    )}`,
  );
  const rootNote = report.target.repoRoot === report.target.root ? "" : ` (root: ${report.target.repoRoot})`;
  lines.push(dim(`report:  ${reportPath}${rootNote}`));
  lines.push(dim(`artifacts: ${report.artifacts.root}`));

  const blockerState =
    report.blockers.open === 0 ? green("0 open") : red(`${report.blockers.open} open`);
  const movement: string[] = [];
  if (report.blockers.newlyOpened > 0) movement.push(`${report.blockers.newlyOpened} newly tracked`);
  if (report.blockers.newlyResolved > 0) movement.push(green(`${report.blockers.newlyResolved} resolved`));
  if (report.blockers.reopened > 0) movement.push(red(`${report.blockers.reopened} re-opened`));

  lines.push(
    `blockers: ${blockerState} ${dim(
      `· ${report.blockers.resolved} resolved${movement.length > 0 ? ` · ${movement.join(" · ")}` : ""}`,
    )}`,
  );
  lines.push(dim(`board:   ${report.blockers.board}`));
  lines.push("");

  console.log(lines.join("\n"));
}

export async function writeReport(report: DiagnosticReport, reportPath: string): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
