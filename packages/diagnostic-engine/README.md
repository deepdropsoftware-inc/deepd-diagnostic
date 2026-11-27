# DeepDiagnose

One diagnostic command per repository: detect the ecosystems present, run the mandatory **Angel Armor** foundation first, route work to each ecosystem's own tools, then relate the results across files and record every unresolved capability in a ledger that closes itself when the cause is fixed.

**Status:** beta, `0.2.0`, source at commit `0313c5b`. Registry publication is not verified for this baseline; build it from source. See [Known limitations](#23-known-limitations) before trusting any signal in a release gate.

- [Architecture](../../docs/architecture.md)
- [Ecosystem support matrix](../../docs/ecosystem-support.md)
- [Security](../../docs/security.md)
- [Roadmap](../../docs/roadmap.md)
- [Testing guide](../../docs/testing.md)

## 1. Overview

```
PASS 1 · Syntax & Structure   armor gate → ecosystem plugins → artifacts/<plugin>/junit.xml
        ↓
PASS 2 · Logic & Debt         cross-file findings → blocker triage → known automation
        ↓
SIGNALS                       flaky history · test impact · failure triage (read-only)
        ↓
diagnostic-report.json + UNRESOLVED.md + artifacts/
```

Three properties define the design:

1. **The gate is real.** Language plugins do not run while Angel Armor fails; their results are marked `blocked` and stale artifacts are removed.
2. **Two passes ask different questions.** Pass 1 runs tools per file. Pass 2 relates files to each other and audits the debt Pass 1 left behind; it never re-runs a linter.
3. **Signals read, they do not execute.** Flaky detection, impact selection and triage consume artifacts and git state. Running selected tests remains the project's job.

## 2. Installation

From this repository (no registry release is documented):

```bash
cd packages/diagnostic-engine
npm ci
npm run build
node dist/cli.js --version
```

Use it in another project without installing globally:

```bash
node /path/to/packages/diagnostic-engine/dist/cli.js init
node /path/to/packages/diagnostic-engine/dist/cli.js
```

The `deepdiagnose` / `diagnose` binaries exist in `package.json`, so a local `npm install <path>` or a future registry release exposes the normal commands.

## 3. Runtime requirements

| Use | Requirement | Basis |
|---|---|---|
| Running the built CLI | Node.js `>=18.18` (declared in `engines`); a targeted grep found no post-18 API (`import.meta.dirname`, `structuredClone`, `Object.groupBy`, `toSorted`, `AbortSignal.timeout`, `randomUUID`) | SOURCE-VERIFIED; the declared floor was not executed here |
| Building | Node.js supported by TypeScript 5.7; `tsc -p tsconfig.json` | SOURCE-VERIFIED |
| Running tests | `node --import tsx --test test/*.test.ts`. The `--import` loader flag is available from Node 20.6; CI uses 20, 22 and 24 | SOURCE-VERIFIED script; Node 18 was not executed |
| Development | Same as tests | SOURCE-VERIFIED |

The declared `engines.node >=18.18` therefore covers the runtime, but not the test script. Do not claim Node 18 test support without running it.

Each ecosystem's toolchain (Go, Cargo, .NET, Ruby, PHP, JDK/Gradle, Xcode) comes from the project under test. A missing toolchain is reported as a skipped check and recorded as a blocker, never as a failure.

## 4. CLI commands

| Command | What it does |
|---|---|
| `deepdiagnose` | Diagnose the repository root |
| `deepdiagnose <cassette>` | Diagnose one workspace package/cassette |
| `deepdiagnose init` | Write `diagnose.config.json` and add a `diagnose` script |

## 5. CLI options

| Option | Effect |
|---|---|
| `--cassette <name>` | Target one package instead of the whole repo |
| `--fix` | Conservative automation only: install dependencies, run formatters, apply known Pass 2 handlers. It does not rewrite code |
| `--json <path>` | Write the aggregate report elsewhere |
| `--no-gate` | Run language plugins even when Angel Armor fails |
| `--no-two-pass` | Pass 1 only |
| `--no-flaky` | Skip the flaky signal |
| `--no-impact` | Skip impact selection |
| `--ai-explain` | Classify failures; add model root causes when `OPENAI_API_KEY` is set |
| `--quiet` | Write reports without the console summary |
| `-V, --version` | Print the engine version |

`init` options: `--dir <path>`, `--force`, `--armor-scripts a,b,c`, `--script "<command>"`.

## 6. Configuration reference

`diagnose.config.json` at the repository root. Every key is optional. The pre-release filename `diagnostic-engine.config.json` is still read when the current name is absent.

| Key | Default | Actual behavior |
|---|---|---|
| `cassettesDir` | `"cassettes"` | First place `--cassette` looks; then `packages/`, `apps/`, root |
| `artifactsDir` | `"artifacts"` | Root of per-plugin artifact folders, relative to the repo root |
| `reportPath` | `"diagnostic-report.json"` | Aggregate report path, relative to the invocation directory unless `--json` overrides |
| `blockersFile` | `"blockers.json"` | Machine-readable ledger |
| `boardFile` | `"UNRESOLVED.md"` | Generated board |
| `gate` | `true` | Block language plugins when Angel Armor fails |
| `twoPass` | `true` | Run Pass 2 after Pass 1 |
| `pass2Ignore` | none (`[]`) | Substring matches excluded from Pass 2's scan |
| `flaky.enabled` | `true` | Run the flaky signal |
| `flaky.historyFile` | `".deepdiagnose/flaky-history.json"` | Per-test history, relative to the repo root |
| `flaky.minRuns` | `3` | Observations before a verdict |
| `flaky.maxRuns` | `50` | Runs retained; older runs are sliced off |
| `flaky.failOnFlaky` | `false` | Make flaky tests affect the exit code |
| `impact.enabled` | `true` | Run impact selection |
| `impact.base` | `"HEAD"` | Revision to diff against; in CI use the PR base branch |
| `impact.adapter` | `"auto"` | `auto` prefers `@mizchi/test-impact`; `graph` forces the built-in graph; `mizchi` requires it |
| `pluginsDir` | none | Extra plugin folders (string or array), relative to the repo root; loaded after built-ins, so an `id` collision overrides |
| `armor.scripts` | `["check:armor","check:editions","check:export"]` | Foundation scripts, run in order |
| `armor.packageDirs` | `["packages/angel-armor","angel-armor"]` | Folders that may own those scripts; the target and repo root are always checked first |

Values are **not validated**. Invalid numbers/types are used as given (for example `flaky.maxRuns: 0` retains every run instead of none). Rejecting invalid configuration is planned (S6).

## 7. Configuration defaults

What `init` writes:

```json
{
  "artifactsDir": "artifacts",
  "cassettesDir": "cassettes",
  "reportPath": "diagnostic-report.json",
  "blockersFile": "blockers.json",
  "boardFile": "UNRESOLVED.md",
  "gate": true,
  "twoPass": true,
  "flaky": {
    "enabled": true,
    "historyFile": ".deepdiagnose/flaky-history.json",
    "minRuns": 3,
    "maxRuns": 50,
    "failOnFlaky": false
  },
  "impact": { "enabled": true, "base": "HEAD", "adapter": "auto" },
  "armor": {
    "scripts": ["check:armor", "check:editions", "check:export"],
    "packageDirs": ["packages/angel-armor", "angel-armor"]
  }
}
```

`init` never overwrites an existing config without `--force`, and never replaces an existing `diagnose` script.

## 8. Initialization

```bash
deepdiagnose init            # current directory
deepdiagnose init --dir app  # another directory
```

It writes the config above, creates `package.json` if absent, and adds `"diagnose": "deepdiagnose"` when that script name is free. It does not install the engine, create a lockfile or modify CI.

## 9. Pass 1 architecture

1. Plugins are imported from the built-in folder and any configured folders; duplicate ids throw; `base` plugins sort first.
2. Each plugin's `detect(ctx)` decides whether it applies. A throwing detector becomes a failed check, not a crash.
3. A detected plugin gets a clean `artifacts/<id>/` folder, runs its tools, and returns checks.
4. Every plugin ends with `junit.xml` and `report.json`, even when the tool has no JUnit reporter: the engine synthesizes JUnit from the checks.
5. Checks are classified `passed`, `failed` or `skipped`; only design-correct skips use `kind: "not-applicable"` and stay out of the ledger.

## 10. Mandatory Armor gate

Angel Armor is a `base` plugin with `detect() => true`. It runs the configured scripts in the folder that actually defines them (target, repo root, configured package dirs).

- A missing script is a skipped check and a blocker, not a silent pass.
- If any armor check fails and `gate` is on, later plugins are recorded `blocked`, their stale artifacts are deleted, and their tools never run.
- `--no-gate` is the explicit override; the report still records the armor failure.

## 11. Pass 2 architecture

| | Pass 1 | Pass 2 |
|---|---|---|
| Strategy | deterministic, tool-driven, per file | relational, graph-driven, cross-file |
| Input | project files + toolchains | Pass 1 results and the blocker ledger |
| Question | is this file valid? | do these files still agree? |
| Output | checks, JUnit, ledger | findings, triage, applied fixes |

Findings:

- HTML `<script>`/`<link>`/`<img>` targets must exist; root-absolute paths are warnings.
- Relative and root-absolute JS/TS specifiers must resolve; named imports must exist in the resolved module. NodeNext `.js`/`.mjs`/`.cjs` specifiers resolve to `.ts`/`.mts`/`.cts` sources, and tsconfig `extends`/`paths` are honored.
- Python relative imports must land on a module or `__init__.py`. This is an existence check, not a dependency graph.
- Ambiguous cases (`export *`, CommonJS targets, unresolvable aliases) are skipped, never guessed.

Debt: every open blocker is triaged `auto-fixable` or `manual` with a concrete action. With `--fix`, known handlers run, Pass 1 is re-run and Pass 2 re-analyzed, so a fix is only claimed after a green run. The only handler today writes a `cargo-nextest` JUnit profile.

## 12. Signal generation

Signals run after Pass 2 and never execute a test suite. Each writes a section in `diagnostic-report.json` plus a JSON artifact, and each is advisory unless explicitly configured otherwise.

**Prior art reviewed during design** (none is a dependency, and none was re-verified for this document): flakeguard/DeFlaky informed the flake-score semantics, `@mizchi/test-impact` is the optional impact adapter, and `pyrn`, `pytest-tia` and `cargo-affected` were examined as references for other ecosystems. They require coverage data or repeated executions the engine does not own.

## 13. Flaky-test analysis

Each run appends every test outcome to `.deepdiagnose/flaky-history.json` (keyed by short commit), then scores the current tests across stored history.

- `flaky`: both a pass and a failure seen, with at least `minRuns` observations.
- `sameCommitMixed`: both outcomes seen at the same commit **as recorded today**; see the limitation below.
- `flakeScore`: percentage of evaluated tests whose outcomes were consistent (always passing or always failing), following DeFlaky's definition. Tests below `minRuns` are excluded.
- `stable-failing` tests are listed separately; a test that always fails is stable, not flaky.
- Default: report only. `"failOnFlaky": true` adds flaky tests to the exit code.

**Known limitation (S2):** `dirty` is derived from `git status --porcelain`, which includes the engine's own untracked artifacts, and `sameCommitMixed` groups by commit only. Two runs at the same SHA with different working-tree content can therefore be reported as same-commit evidence. Treat `sameCommitMixed` as a lead until S2 lands.

## 14. Impact analysis

Selection only: which tests can the diff reach? Nothing is executed.

- Changed files come from the working tree, `base...HEAD`, and untracked files; build output, `node_modules`, caches and `artifacts/` are filtered.
- Adapter `auto` uses `@mizchi/test-impact --since <base> --format json` when installed, otherwise the Pass 2 import graph.
- The graph resolves through the same resolver as Pass 2, so NodeNext and tsconfig aliases behave identically.
- `unresolvedSpecifiers` and `ambiguousSpecifiers` count graph gaps; a non-zero value means the selection may be partial. The console warns when either is non-zero.
- Limits: static `import`/`require` only (dynamic `import()` is not an edge), max 2,000 source files, JS/TS only.
- Default base is `HEAD`, which compares the working tree. In pull-request CI set `impact.base` to the target branch, otherwise a clean checkout selects nothing.
- An invalid or unfetched base is **not detected**: git failures yield an empty changed set and the note `no changes against <base>` instead of an error (S7). Reproduced with `impact.base: "origin/does-not-exist"`.

## 15. AI-assisted triage

Rules run first, always. `--ai-explain` adds a model pass only when `OPENAI_API_KEY` is set.

- Categories: `missing-tool`, `type-error`, `compile-error`, `test-assertion`, `timeout`, `network`, `permissions`, `dependency`, `configuration`, `unknown`.
- One request per run for up to 12 failures; 25 s timeout; OpenAI-compatible `chat/completions`.
- Endpoint: `DEEPDIAGNOSE_AI_BASE_URL` (default `https://api.openai.com/v1`); model: `DEEPDIAGNOSE_AI_MODEL` (default `gpt-4o-mini`).
- Answers are cached in `.deepdiagnose/ai-cache.json` by a hash of plugin/check/excerpt/command.
- Without a key, `mode` is `rules-only`; a failed call also falls back with a note.

**Known limitations (S5):** excerpts are transmitted without redaction, and the cache key omits model and prompt version, so cached model categories can override rule categories. See [Security](../../docs/security.md).

## 16. Blocker lifecycle

1. A skip that means "this capability should work" is logged `[OPEN]` in `blockers.json` and `UNRESOLVED.md`.
2. Fix the cause, not the report.
3. The next run that passes the check marks it `[RESOLVED]`.
4. A regression reopens it, incrementing occurrences.

A blocker is only closed when its plugin actually ran; a blocked plugin or another cassette never resolves rows it did not exercise. `UNRESOLVED.md` is generated — the ledger is the source of truth.

**Known limitation (S3):** a corrupt or unparseable ledger is treated as empty and overwritten, losing resolution history; and there is no automated test of the lifecycle. Both are planned (S3). Commit the ledger, and keep backups if it matters.

## 17. Artifacts and output schemas

```
diagnostic-report.json              aggregate report
blockers.json                       ledger (commit it)
UNRESOLVED.md                       generated board (commit it)
.deepdiagnose/flaky-history.json    per-test history
.deepdiagnose/ai-cache.json         model answers
artifacts/
├── junit.xml                       all suites merged
├── flaky/report.json
├── impact/report.json
├── explain/report.json
├── node/{junit.xml, eslint.json, report.json}
├── go/{junit.xml, golangci.json, ...}
└── ...
```

Report keys: `engine`, `engineVersion`, `generatedAt`, `target`, `artifacts`, `twoPass`, `summary`, `pass1`, `pass2`, `signals`, `blockers`, `availablePlugins`.

Per-plugin `report.json`: `plugin`, `label`, `base`, `blocked`, `status`, `generatedAt`, `durationMs`, `junit`, `checks[]` with `name`, `status`, `command`, `exitCode`, `durationMs`, `message`.

**There is no `schemaVersion` field yet.** Consumers must tolerate unknown fields, and any consumer built now will need updating when versioning lands (S7).

## 18. Exit codes

| Code | Meaning |
|---|---|
| `0` | Every executed check passed (Pass 2 errors and flaky failures included when configured) |
| `1` | At least one failed check, a Pass 2 error, or flaky tests with `failOnFlaky` |
| `2` | Unhandled CLI error (the CLI catch-all) |

Skipped checks do not fail a run. Blocked plugins do not add failures of their own, but the armor failure that blocked them does.

## 19. Plugin architecture

The engine loads every `.ts`, `.js` or `.mjs` file in the built-in plugin folder and in configured folders, in sorted order, then orders `base` plugins first. A plugin is any default export with:

```ts
interface Plugin {
  id: string;      // unique; reusing a built-in id overrides it
  label: string;
  base?: boolean;  // true only for foundation plugins
  detect(ctx: RunContext): boolean | Promise<boolean>;
  run(ctx: RunContext, artifacts: Artifacts): Promise<CheckResult[]>;
}
```

Plugins are imported **into the engine process** and are not sandboxed. A plugin is executable code from the repository under analysis; see [Security](../../docs/security.md).

## 20. Custom plugin development

```js
// diagnose-plugins/swift-format.mjs
export default {
  id: "swift-format",
  label: "Swift Format",
  async detect(ctx) {
    return (await ctx.find(["Package.swift"], { maxDepth: 2 })).length > 0;
  },
  async run(ctx, artifacts) {
    const startedAt = Date.now();
    const result = await ctx.exec("swift", ["format", "lint", "--strict", "."]);
    return [{
      name: "swift format lint",
      status: result.code === 0 ? "passed" : "failed",
      command: result.command,
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      output: `${result.stdout}${result.stderr}`.trim().slice(-4000) || undefined,
    }];
  },
};
```

`ctx` exposes `repoRoot`, `target`, `relativeTarget`, `cassette`, `fix`, `artifactsRoot`, `config`, `log`, `exec`, `which`, `read`, `exists`, `find`, `pkg`, `packageScripts`, `bin`.

`artifacts` exposes `dir`, `junitPath`, `jsonPath`, `ensure`, `clear`, `remove`, `writeFile`, `writeJson`, `adopt`, `mergeJUnit`.

Use `skipped(name, message)` for a real gap (tracked as a blocker) and `notApplicable(name, message)` for a design-correct skip. Write native JUnit to `artifacts.junitPath` when available; otherwise return checks and the engine synthesizes it.

## 21. CI integration

Copy [`.github/workflows/diagnose-template.yml`](.github/workflows/diagnose-template.yml), uncomment the toolchain setup you need, and commit. The template:

- runs on Node 20, `permissions: contents: read`;
- restores `.deepdiagnose/flaky-history.json` through `actions/cache`;
- runs `npx --yes @deepdrop/diagnose` (requires a published package or a local substitute);
- uploads `diagnostic-report.json`, `UNRESOLVED.md`, `blockers.json`, `artifacts/` and `.deepdiagnose/` with `if: always()`.

This repository's own workflow instead builds the package and runs it against the repo; see `.github/workflows/ci.yml`.

## 22. Security considerations

Summary; full detail in [docs/security.md](../../docs/security.md).

- Plugin commands are spawned with `shell: false`. Two Apple pipelines intentionally call `/bin/sh -c` with every dynamic value single-quoted; the timeout then applies to the shell, not to `xcodebuild`/`xcbeautify`. All calls have a 240 s timeout and truncated output.
- Plugins run in-process with full privileges and **no sandbox**.
- Child processes inherit the environment, including secrets.
- Network egress happens only with `--ai-explain` + `OPENAI_API_KEY`; excerpts are unredacted today (S5).
- Node's permission model blocks filesystem writes and child processes but **not network**; it is not used here.
- Artifacts contain tool output and stack traces; they are not automatically safe to publish.

## 23. Known limitations

| ID | Limitation | Status |
|---|---|---|
| **S2** | No source-tree fingerprint. `dirty` comes from `git status --porcelain`, which includes the engine's own untracked output, and `sameCommitMixed` groups by commit SHA only — so two runs with different working trees can be reported as same-commit evidence. Untracked source, staged changes and symlinks/submodules are not hashed. | Open |
| **S3** | State persistence is not crash- or concurrency-safe. Writes are plain `writeFile` (no temp+rename); a corrupt `blockers.json` is treated as empty and overwritten, losing resolution history; there is no lock or stale-lock handling, and no automated test covers open→resolve→reopen. Quarantine for history/cache is also missing. | Open |
| **S4** | Timeout sends `SIGTERM` only and resolves on `close`, so a child that traps `SIGTERM` hangs the engine; no process group and no `SIGKILL` escalation, so grandchildren survive. Windows `taskkill /T` handling does not exist. Reproduced: unresolved at 4,007 ms with a 500 ms timeout. Apple's `/bin/sh` pipelines are affected doubly. | Open |
| **S5** | AI triage sends raw excerpts with no redaction and no block-on-uncertainty; model output is cast rather than schema-validated, so an invalid category can replace the rule category; the cache key omits model and prompt version, and cached categories are merged over rule categories. | Open |
| **S6** | Configuration is not validated. Wrong types are used as-is and impossible values are accepted (`flaky.maxRuns: 0` retains every run because of `slice(-0)`); errors are silent rather than actionable. | Open |
| **S7** | The report has no `schemaVersion`, and impact base resolution is not fail-closed: an invalid or unfetched base returns an empty diff and the note `no changes against <base>` instead of an error (reproduced with `origin/does-not-exist`). | Open |
| — | No built-in language plugin is exercised in this repository: the self-run reaches only the `armor` gate, so plugin behavior is source-verified | Open |
| — | Engine-side analysis is JS/TS only; Python is an existence check | By design |

## 24. Troubleshooting

| Symptom | Cause and action |
|---|---|
| Every language plugin says `blocked` | Angel Armor failed. Fix the foundation or use `--no-gate` deliberately |
| `tsc --noEmit` skipped as "typescript is not installed" | Declared but not installed; run `npm install` |
| `vitest run` skipped | Vitest declared but missing, or no Vitest config; install it or ignore the blocker |
| Ledger shows a capability you know works | That plugin did not run this invocation (blocked, undetected, or another cassette) |
| Flaky list is empty | No JUnit yet, or fewer than `minRuns` observations; history is local and must be cached in CI |
| Impact selects nothing | Default base is `HEAD`; on a clean checkout set `impact.base` to the PR base branch. Check `unresolvedSpecifiers` |
| Triage says `rules-only` | `--ai-explain` without `OPENAI_API_KEY`, or the model call failed; the note explains which |
| Xcode checks skipped | Not macOS, no Xcode, or no `xcbeautify`; install it or run on macOS |
| `Unknown cassette` | The name is not in `cassettesDir`, `packages/`, `apps/` or the root |
| Command appears to hang | Known S4: a child that ignores `SIGTERM`. Kill the process tree manually and report it |

## License

MIT. See [LICENSE](LICENSE).
