import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  Blocker,
  BlockerLedger,
  BlockerSummary,
  CheckResult,
  PluginResult,
} from "./types.js";

export const BLOCKERS_FILE = "blockers.json";
export const BOARD_FILE = "UNRESOLVED.md";

const LEDGER_VERSION = 1;

/** Stable across runs: the same broken capability maps to the same row. */
export function blockerId(plugin: string, check: string): string {
  return `${plugin}:${check}`.trim().toLowerCase().replace(/\s+/g, " ");
}

interface CurrentSkip {
  id: string;
  plugin: string;
  check: string;
  reason: string;
}

function isActionable(check: CheckResult): boolean {
  return check.status === "skipped" && check.kind !== "not-applicable";
}

/** Skips that mean "this capability is not working yet", not "not applicable here". */
export function collectSkips(results: PluginResult[]): CurrentSkip[] {
  const skips: CurrentSkip[] = [];

  for (const result of results) {
    if (result.blocked) continue;
    for (const check of result.checks) {
      if (!isActionable(check)) continue;
      skips.push({
        id: blockerId(result.id, check.name),
        plugin: result.id,
        check: check.name,
        reason: check.message ?? "skipped",
      });
    }
  }

  return skips;
}

async function readLedger(file: string): Promise<BlockerLedger> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<BlockerLedger>;
    if (Array.isArray(parsed.blockers)) {
      return {
        version: LEDGER_VERSION,
        updatedAt: parsed.updatedAt ?? "",
        blockers: parsed.blockers.filter(
          (blocker): blocker is Blocker =>
            Boolean(blocker) &&
            typeof blocker.id === "string" &&
            typeof blocker.plugin === "string" &&
            typeof blocker.check === "string" &&
            (blocker.status === "open" || blocker.status === "resolved"),
        ),
      };
    }
  } catch {
    // Missing or corrupt ledger: start a fresh one rather than failing the run.
  }

  return { version: LEDGER_VERSION, updatedAt: "", blockers: [] };
}

/** Read the persisted ledger so Pass 2 can triage what Pass 1 left behind. */
export async function readBlockers(file: string): Promise<Blocker[]> {
  return (await readLedger(file)).blockers;
}

function sortForStorage(blockers: Blocker[]): Blocker[] {
  return [...blockers].sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return a.plugin.localeCompare(b.plugin) || a.check.localeCompare(b.check);
  });
}

export interface ReconcileParams {
  repoRoot: string;
  results: PluginResult[];
  blockersFile?: string;
  boardFile?: string;
}

/**
 * Fold this run into the ledger:
 *  - new skip                      → [OPEN]
 *  - still skipped                 → stays [OPEN], occurrence count bumps
 *  - open + now passing            → [RESOLVED] (only if its plugin actually ran)
 *  - resolved + broken again       → re-opens to [OPEN]
 */
export async function reconcileBlockers(params: ReconcileParams): Promise<BlockerSummary> {
  const now = new Date().toISOString();
  const blockersPath = path.resolve(params.repoRoot, params.blockersFile ?? BLOCKERS_FILE);
  const boardPath = path.resolve(params.repoRoot, params.boardFile ?? BOARD_FILE);

  const ledger = await readLedger(blockersPath);
  const skips = collectSkips(params.results);
  const skippedIds = new Set(skips.map((skip) => skip.id));
  const ranPlugins = new Set(
    params.results.filter((result) => !result.blocked).map((result) => result.id),
  );

  let newlyOpened = 0;
  let reopened = 0;
  let newlyResolved = 0;

  for (const skip of skips) {
    const existing = ledger.blockers.find((blocker) => blocker.id === skip.id);

    if (!existing) {
      ledger.blockers.push({
        id: skip.id,
        plugin: skip.plugin,
        check: skip.check,
        reason: skip.reason,
        status: "open",
        firstSeen: now,
        lastSeen: now,
        occurrences: 1,
      });
      newlyOpened += 1;
      continue;
    }

    existing.plugin = skip.plugin;
    existing.check = skip.check;
    existing.reason = skip.reason;
    existing.lastSeen = now;
    existing.occurrences += 1;

    if (existing.status === "resolved") {
      existing.status = "open";
      existing.firstSeen = now;
      delete existing.resolvedAt;
      delete existing.resolution;
      reopened += 1;
    }
  }

  for (const blocker of ledger.blockers) {
    if (blocker.status !== "open") continue;
    if (skippedIds.has(blocker.id)) continue;
    // Only close a blocker when its plugin actually ran this time.
    if (!ranPlugins.has(blocker.plugin)) continue;

    blocker.status = "resolved";
    blocker.resolvedAt = now;
    blocker.resolution = "check passed on this run";
    newlyResolved += 1;
  }

  ledger.version = LEDGER_VERSION;
  ledger.updatedAt = now;
  ledger.blockers = sortForStorage(ledger.blockers);

  await writeFile(blockersPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await writeFile(boardPath, renderBoard(ledger), "utf8");

  return {
    open: ledger.blockers.filter((blocker) => blocker.status === "open").length,
    resolved: ledger.blockers.filter((blocker) => blocker.status === "resolved").length,
    newlyOpened,
    reopened,
    newlyResolved,
    file: blockersPath,
    board: boardPath,
  };
}

export function renderBoard(ledger: BlockerLedger): string {
  const open = ledger.blockers
    .filter((blocker) => blocker.status === "open")
    .sort((a, b) => a.plugin.localeCompare(b.plugin) || a.check.localeCompare(b.check));
  const resolved = ledger.blockers
    .filter((blocker) => blocker.status === "resolved")
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""));

  const lines: string[] = [
    "# UNRESOLVED — DeepDiagnose blockers",
    "",
    "<!-- Generated by deepdiagnose on every run. Do not hand-edit this file: fix the cause,",
    "     rerun the engine, and the row crosses itself off. The ledger lives in blockers.json. -->",
    "",
    `Updated: ${ledger.updatedAt || "never"}`,
    "",
    `**${open.length} open** · **${resolved.length} resolved**`,
    "",
    "## Lifecycle",
    "",
    "1. A skipped check (missing toolchain, missing parser, missing config) is logged here as **[OPEN]**.",
    "2. Fix the cause: install the tool, add the parser, write the profile.",
    "3. Rerun `deepdiagnose`. When the check passes, the next run marks the row **[RESOLVED]**.",
    "4. If the cause comes back, the row re-opens automatically.",
    "",
  ];

  lines.push(`## [OPEN] ${open.length}`, "");

  if (open.length === 0) {
    lines.push(
      "_Nothing open. Every check that ran either passed or was intentionally not applicable._",
      "",
    );
  }

  for (const blocker of open) {
    lines.push(`- [ ] **[OPEN]** \`${blocker.plugin}\` → ${blocker.check} — ${blocker.reason}`);
    lines.push(
      `  - first seen ${blocker.firstSeen} · last seen ${blocker.lastSeen} · ${blocker.occurrences} run(s)`,
    );
  }

  if (open.length > 0) lines.push("");

  lines.push(`## [RESOLVED] ${resolved.length}`, "");

  if (resolved.length === 0) {
    lines.push("_Nothing resolved yet._", "");
  }

  for (const blocker of resolved) {
    lines.push(
      `- [x] **[RESOLVED]** \`${blocker.plugin}\` → ${blocker.check} — ${blocker.resolution ?? "resolved"} (${blocker.resolvedAt ?? "unknown"})`,
    );
    lines.push(
      `  - first seen ${blocker.firstSeen} · ${blocker.occurrences} run(s) before resolution`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
