import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginResult } from "../src/core/types.js";

const RESULTS: PluginResult[] = [
  {
    id: "probe",
    label: "Probe",
    base: false,
    status: "failed",
    durationMs: 1,
    checks: [
      {
        name: "toolchain",
        status: "failed",
        durationMs: 1,
        command: "rustc --version",
        exitCode: 127,
        output: "sh: rustc: command not found",
      },
    ],
  },
];

test("model answers are merged, cached, and degrade to rules when the model is down", async () => {
  let calls = 0;
  let mode: "ok" | "error" = "ok";

  const server = createServer((request, response) => {
    calls += 1;
    request.resume();
    request.on("end", () => {
      if (mode === "error") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "stub failure" }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  failures: [
                    {
                      id: "probe::toolchain",
                      category: "missing-tool",
                      rootCause: "the Rust toolchain is absent",
                      suggestion: "install rustup and rerun",
                      confidence: 0.95,
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  // Set before importing: the module reads these once, at load time.
  process.env.OPENAI_API_KEY = "stub-key";
  process.env.DEEPDIAGNOSE_AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.DEEPDIAGNOSE_AI_MODEL = "stub-model";

  const { analyzeExplain } = await import("../src/core/explain.js");

  const firstDir = await mkdtemp(path.join(tmpdir(), "dd-explain-llm-"));
  const first = await analyzeExplain({ enabled: true, results: RESULTS, repoRoot: firstDir });

  assert.equal(first.mode, "llm");
  assert.equal(first.model, "stub-model");
  assert.equal(first.failures[0]?.source, "llm");
  assert.equal(first.failures[0]?.source === "llm" && first.failures[0]?.category, "missing-tool");
  assert.match(first.failures[0]?.suggestion ?? "", /install rustup/);
  assert.equal(calls, 1);

  const cache = JSON.parse(
    await readFile(path.join(firstDir, ".deepdiagnose", "ai-cache.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.ok(Object.keys(cache).length >= 1, "answers must be written to the cache");

  const second = await analyzeExplain({ enabled: true, results: RESULTS, repoRoot: firstDir });
  assert.equal(second.mode, "llm");
  assert.equal(calls, 1, "a cached failure must not hit the model again");

  // A different project has no cache; a failing endpoint must degrade, not throw.
  mode = "error";
  const secondDir = await mkdtemp(path.join(tmpdir(), "dd-explain-down-"));
  const degraded = await analyzeExplain({ enabled: true, results: RESULTS, repoRoot: secondDir });

  assert.equal(degraded.mode, "rules-only");
  assert.match(degraded.note ?? "", /model unavailable/);
  assert.equal(degraded.failures[0]?.category, "missing-tool");
  assert.equal(degraded.failures[0]?.source, "rules");

  await new Promise<void>((resolve) => server.close(() => resolve()));
});
