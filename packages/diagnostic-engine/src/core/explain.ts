import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CheckResult,
  ExplainedFailure,
  ExplainReport,
  FailureCategory,
  PluginResult,
} from "./types.js";

/**
 * `--ai-explain`: turn failed checks into a structured failure record, then
 * (optionally) ask an LLM for a root cause.
 *
 * Rules run first and always. The model only enriches what the rules already
 * classified, is opt-in via the flag, requires OPENAI_API_KEY, and results are
 * cached by failure hash so a red pipeline is not billed twice.
 *
 * The record shape is stable on purpose: id / plugin / check / category /
 * confidence / command / exitCode / excerpt / suggestion. Any external triage
 * tool can consume `artifacts/explain/report.json` without knowing about us.
 */

interface Rule {
  category: FailureCategory;
  pattern: RegExp;
  confidence: number;
  suggestion: string;
}

const RULES: Rule[] = [
  {
    category: "missing-tool",
    pattern:
      /command not found|not recognized as an internal|is not installed|executable file not found|spawn \S+ ENOENT|no such file or directory/i,
    confidence: 0.92,
    suggestion: "install the toolchain the plugin expects, then rerun; --fix only installs npm dependencies",
  },
  {
    category: "type-error",
    pattern: /error TS\d+|TS\d{3,5}:|is not assignable to type|cannot find name |implicitly has an 'any'/i,
    confidence: 0.9,
    suggestion: "fix the reported type error; CI may compile with stricter settings than the editor",
  },
  {
    category: "dependency",
    pattern:
      /cannot find module|module not found|is not exported by|could not resolve|unresolved import|no matching export/i,
    confidence: 0.85,
    suggestion: "the module or named export moved — run the package install, then update the import",
  },
  {
    category: "timeout",
    pattern: /timed out|timeout (?:after|of)|ETIMEDOUT|exceeded .*time limit/i,
    confidence: 0.8,
    suggestion: "raise the step timeout or make the wait bounded; a timeout is rarely the root cause",
  },
  {
    category: "network",
    pattern: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network error|503 Service Unavailable|502 Bad Gateway/i,
    confidence: 0.75,
    suggestion: "treat as infrastructure first: retry once, then check the service or registry status",
  },
  {
    category: "permissions",
    pattern: /EACCES|EPERM|permission denied|403 Forbidden|401 Unauthorized|not authorized/i,
    confidence: 0.8,
    suggestion: "check the token scope or file mode; CI secrets are usually the difference from a local run",
  },
  {
    category: "test-assertion",
    pattern: /AssertionError|expected .* (?:to be|toEqual|to equal|to match)|Tests?\s+\d+ failed|✕|✖/i,
    confidence: 0.7,
    suggestion: "a real behavioural difference — compare the failing case with the last green run before changing the test",
  },
  {
    category: "configuration",
    pattern: /unknown (?:flag|option)|invalid (?:option|config)|config(?:uration)? file .*not found|not a git repository/i,
    confidence: 0.75,
    suggestion: "the command and the config disagree — align the flag with diagnose.config.json",
  },
  {
    category: "compile-error",
    pattern: /\berror\b|SyntaxError|Unexpected token|cannot compile|failed to compile/i,
    confidence: 0.55,
    suggestion: "read the first error only; later ones are usually fallout",
  },
];

function classify(text: string): Rule {
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule;
  }
  return {
    category: "unknown",
    pattern: /$^/,
    confidence: 0.3,
    suggestion: "no known signature — inspect the full output in the report",
  };
}

function excerptOf(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  const interesting = lines.find((line) => /error|fail|✕|✖|denied|not found/i.test(line));
  return (interesting ?? lines[0] ?? "").slice(0, 240);
}

function failureText(check: CheckResult): string {
  return [check.message, check.output].filter(Boolean).join("\n").slice(0, 2_000);
}

export function classifyFailures(results: PluginResult[]): ExplainedFailure[] {
  const failures: ExplainedFailure[] = [];

  for (const plugin of results) {
    for (const check of plugin.checks) {
      if (check.status !== "failed") continue;
      const text = failureText(check);
      const rule = classify(text);

      failures.push({
        id: `${plugin.id}::${check.name}`,
        plugin: plugin.id,
        check: check.name,
        category: rule.category,
        severity: "error",
        confidence: rule.confidence,
        ...(check.command ? { command: check.command } : {}),
        ...(check.exitCode !== undefined ? { exitCode: check.exitCode } : {}),
        ...(excerptOf(text) ? { excerpt: excerptOf(text) } : {}),
        suggestion: rule.suggestion,
        source: "rules",
      });
    }
  }

  return failures;
}

/* --------------------------------------------------------------- model pass */

const API_BASE = (process.env.DEEPDIAGNOSE_AI_BASE_URL ?? "https://api.openai.com/v1").replace(
  /\/$/,
  "",
);
const MODEL = process.env.DEEPDIAGNOSE_AI_MODEL ?? "gpt-4o-mini";
const CACHE_FILE = ".deepdiagnose/ai-cache.json";

type CacheEntry = { category: FailureCategory; suggestion: string };
type Cache = Record<string, CacheEntry>;

async function readCache(repoRoot: string): Promise<Cache> {
  try {
    const text = await readFile(path.join(repoRoot, CACHE_FILE), "utf8");
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

async function writeCache(repoRoot: string, cache: Cache): Promise<void> {
  const file = path.join(repoRoot, CACHE_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function cacheKey(failure: ExplainedFailure): string {
  return createHash("sha256")
    .update([failure.plugin, failure.check, failure.excerpt ?? "", failure.command ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
}

const PROMPT =
  "You triage CI failures. For each failure, return the most probable root cause and one concrete next action. " +
  'Reply with JSON only: {"failures":[{"id":"...","category":"missing-tool|type-error|compile-error|test-assertion|timeout|network|permissions|dependency|configuration|unknown","rootCause":"...","suggestion":"...","confidence":0.0}]}';

async function askModel(
  failures: ExplainedFailure[],
): Promise<Map<string, { category?: FailureCategory; suggestion: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              failures: failures.slice(0, 12).map((failure) => ({
                id: failure.id,
                plugin: failure.plugin,
                check: failure.check,
                command: failure.command,
                exitCode: failure.exitCode,
                excerpt: failure.excerpt,
              })),
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("empty completion");

    const parsed = JSON.parse(content) as {
      failures?: Array<{ id?: string; category?: string; rootCause?: string; suggestion?: string }>;
    };

    const merged = new Map<string, { category?: FailureCategory; suggestion: string }>();
    for (const entry of parsed.failures ?? []) {
      if (!entry.id) continue;
      const suggestion = [entry.rootCause, entry.suggestion].filter(Boolean).join(" — ");
      if (!suggestion) continue;
      merged.set(entry.id, {
        ...(entry.category ? { category: entry.category as FailureCategory } : {}),
        suggestion,
      });
    }
    return merged;
  } finally {
    clearTimeout(timer);
  }
}

export interface ExplainOptions {
  enabled: boolean;
  results: PluginResult[];
  repoRoot: string;
}

export async function analyzeExplain(options: ExplainOptions): Promise<ExplainReport> {
  const startedAt = Date.now();

  if (!options.enabled) {
    return {
      enabled: false,
      mode: "disabled",
      failures: [],
      durationMs: Date.now() - startedAt,
      note: "disabled — pass --ai-explain to triage failures",
    };
  }

  const failures = classifyFailures(options.results);
  if (failures.length === 0) {
    return {
      enabled: true,
      mode: "rules-only",
      failures: [],
      durationMs: Date.now() - startedAt,
      note: "no failed checks to explain",
    };
  }

  if (!process.env.OPENAI_API_KEY) {
    return {
      enabled: true,
      mode: "rules-only",
      failures,
      durationMs: Date.now() - startedAt,
      note: "OPENAI_API_KEY not set — deterministic classification only, no model call",
    };
  }

  const cache = await readCache(options.repoRoot);
  const enriched: ExplainedFailure[] = [];
  const pending: ExplainedFailure[] = [];

  for (const failure of failures) {
    const hit = cache[cacheKey(failure)];
    if (hit) {
      enriched.push({ ...failure, ...hit, source: "llm" });
    } else {
      pending.push(failure);
    }
  }

  let note: string | undefined;
  if (pending.length > 0) {
    try {
      const answers = await askModel(pending);
      for (const failure of pending) {
        const answer = answers.get(failure.id);
        if (!answer) {
          enriched.push(failure);
          continue;
        }
        const merged: ExplainedFailure = {
          ...failure,
          ...(answer.category ? { category: answer.category } : {}),
          suggestion: answer.suggestion,
          source: "llm",
        };
        cache[cacheKey(failure)] = {
          category: merged.category,
          suggestion: merged.suggestion ?? failure.suggestion ?? "",
        };
        enriched.push(merged);
      }
      await writeCache(options.repoRoot, cache);
    } catch (error) {
      note = `model unavailable (${error instanceof Error ? error.message : String(error)}) — rules only`;
      enriched.push(...pending);
    }
  }

  const order = new Map(failures.map((failure, index) => [failure.id, index]));
  enriched.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return {
    enabled: true,
    mode: note ? "rules-only" : "llm",
    model: MODEL,
    failures: enriched,
    durationMs: Date.now() - startedAt,
    ...(note ? { note } : {}),
  };
}

export async function writeExplainArtifact(
  artifactsRoot: string,
  report: ExplainReport,
): Promise<void> {
  const dir = path.join(artifactsRoot, "explain");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
