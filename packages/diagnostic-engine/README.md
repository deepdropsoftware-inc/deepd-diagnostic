# DeepDiagnose

One diagnostic command for every project. DeepDiagnose detects which ecosystems a
folder contains, runs **Angel Armor first** as a mandatory foundation, then routes to
the right tool per language, and writes a single report plus standardized machine
output.

```
PASS 1 · Syntax & Structure   detect → Angel Armor gate → language plugins → blockers.json
        ↓   Pass 2 consumes Pass 1's output; it never re-runs a linter
PASS 2 · Logic & Debt         cross-file reference graph → blocker triage → safe automation
        ↓   Signals read the JUnit artifacts; they never run a tool
SIGNALS                       flaky history → test impact → failure triage (read-only)
        ↓
diagnostic-report.json + UNRESOLVED.md + artifacts/
```

- **Angel Armor is the gate.** If `check:armor`, `check:editions` or `check:export`
  fails, language plugins are reported as `blocked` and never run (override with
  `--no-gate`).
- **Zero config to start.** `init` writes `diagnose.config.json` and a `diagnose` script.
- **One contract.** Every plugin writes `artifacts/<plugin>/junit.xml` and
  `artifacts/<plugin>/report.json`; all suites are merged into `artifacts/junit.xml`.
- **Two passes, two brains.** Pass 1 validates files (deterministic, per-tool). Pass 2
  relates files to each other and audits the debt (relational, cross-file) — see
  [Two passes](#two-passes-two-different-brains).
- **Signals, not just checks.** Every run adds its JUnit results to a per-test history,
  so a test that passes and fails on the same commit is identified as flaky with a
  score — see [Signals layer](#signals-layer-flaky-detection).
- **Test impact without a new runner.** The diff is mapped to the tests that can reach
  it, through `@mizchi/test-impact` when the project has it or through Pass 2's own
  import graph otherwise — see [Test impact](#test-impact).
- **Failures with a category.** `--ai-explain` classifies every failed check and, if you
  provide a key, adds a root cause and next action — see [Failure triage](#failure-triage---ai-explain).
- **A board that closes itself.** Skips are tracked in `blockers.json` and rendered as
  `[OPEN]` / `[RESOLVED]` in `UNRESOLVED.md`. Fix the cause, rerun, and the row crosses
  itself off — see [Blocker lifecycle](#blocker-lifecycle).
- **Drop-in plugins.** A file in a plugin folder registers a tool — no core changes.

## Install

```bash
# one-off, no install
npx @deepdrop/diagnose init

# per project (recommended)
npm install --save-dev @deepdrop/diagnose

# globally, available as `deepdiagnose` and `diagnose`
npm install --global @deepdrop/diagnose
```

Requires Node.js 18.18 or newer. The toolchain for each language (Go, Rust, .NET,
Ruby, PHP, Gradle, Xcode) comes from the project itself; anything missing is reported
as `skipped`, never as a failure.

## Quick start

```bash
cd my-project
npx @deepdrop/diagnose init     # writes diagnose.config.json + "diagnose" script
npm run diagnose                # run everything
```

```
deepdiagnose v0.2.0
target: .
repo:   /Users/you/my-project
"!" = Angel Armor base plugin, always runs first and gates the rest

! ✔ Angel Armor              passed       3 checks · 337ms

  ✖ Node / TypeScript        failed       3 checks · 8.4s
    ✖ vitest run             failed (vitest run ...) exit code 1
      > FAIL src/sum.test.ts > adds 1 + 1
```

Exit code is `0` when every check passes and `1` when anything fails, so CI fails
automatically.

## Commands

| Command | What it does |
| --- | --- |
| `deepdiagnose init` | Create `diagnose.config.json` and add the `diagnose` script to `package.json`. Idempotent. |
| `deepdiagnose` / `npm run diagnose` | Diagnose the whole repository. |
| `deepdiagnose -- --cassette=bookpilot` | Diagnose one cassette (workspace package) only. |
| `deepdiagnose --fix` | Safe repairs only: install missing dependencies, run formatters. Never rewrites code. |
| `deepdiagnose --no-gate` | Run language plugins even when Angel Armor fails. |
| `deepdiagnose --no-two-pass` | Run Pass 1 only (syntax & structure). |
| `deepdiagnose --no-flaky` | Skip the flaky-test signal. |
| `deepdiagnose --no-impact` | Skip test-impact selection. |
| `deepdiagnose --ai-explain` | Classify failures; add model root causes when `OPENAI_API_KEY` is set. |
| `deepdiagnose --json <path>` | Write the aggregate report somewhere else. |
| `deepdiagnose --quiet` | Write reports without printing the summary. |

`init` options: `--dir <path>`, `--force`, `--armor-scripts a,b,c`,
`--script "<command>"`.

## Configuration: `diagnose.config.json`

Everything is optional; the defaults below are what `init` writes.

```json
{
  "cassettesDir": "cassettes",
  "artifactsDir": "artifacts",
  "reportPath": "diagnostic-report.json",
  "gate": true,
  "twoPass": true,
  "pass2Ignore": ["vendor/", "generated/"],
  "flaky": { "enabled": true, "minRuns": 3, "failOnFlaky": false },
  "impact": { "enabled": true, "base": "HEAD", "adapter": "auto" },
  "pluginsDir": ["./diagnose-plugins"],
  "armor": {
    "scripts": ["check:armor", "check:editions", "check:export"],
    "packageDirs": ["packages/angel-armor", "angel-armor"]
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `cassettesDir` | `"cassettes"` | Where `--cassette <name>` looks first. Falls back to `packages/`, `apps/`, then the root. |
| `artifactsDir` | `"artifacts"` | Root of the per-plugin artifact folders. |
| `reportPath` | `"diagnostic-report.json"` | Aggregate JSON report location. |
| `blockersFile` | `"blockers.json"` | Machine-readable ledger of tracked blockers. |
| `boardFile` | `"UNRESOLVED.md"` | Generated tracking board. |
| `gate` | `true` | Stop language plugins when Angel Armor fails. |
| `twoPass` | `true` | Run Pass 2 (logic & debt) after Pass 1. |
| `pass2Ignore` | — | Substrings to exclude from Pass 2's cross-file scan. |
| `flaky.enabled` | `true` | Track per-test outcomes and detect flakiness. |
| `flaky.historyFile` | `.deepdiagnose/flaky-history.json` | Where the per-test history lives. |
| `flaky.minRuns` | `3` | Observations before a test can be called flaky. |
| `flaky.maxRuns` | `50` | History depth kept on disk. |
| `flaky.failOnFlaky` | `false` | Fail the run (non-zero) when flaky tests exist. |
| `impact.enabled` | `true` | Select the tests a diff can reach. |
| `impact.base` | `HEAD` | Git revision to diff against (`main` in a PR job). |
| `impact.adapter` | `auto` | `auto` prefers `@mizchi/test-impact`; `graph` forces the fallback. |
| `pluginsDir` | — | Extra plugin folders (string or array), relative to the repo root. Loaded after the built-ins, so a project plugin can override a built-in by reusing its `id`. |
| `armor.scripts` | `check:armor`, `check:editions`, `check:export` | The foundation scripts, run in order. |
| `armor.packageDirs` | `packages/angel-armor`, `angel-armor` | Folders that may own those scripts, relative to the repo root. The target folder and repo root are always checked too. |

The pre-release filename `diagnostic-engine.config.json` is still read when
`diagnose.config.json` is absent.

## Two passes, two different brains

Pass 2 is not Pass 1 run twice. It has a different input, a different question and a
different strategy: Pass 1 asks *"is this file valid?"* with real tools; Pass 2 asks
*"do these files still agree with each other, and what debt is left?"* by relating them.

| | Pass 1 · Syntax & Structure | Pass 2 · Logic & Debt |
| --- | --- | --- |
| Strategy | deterministic, tool-driven, file-level | relational, graph-driven, cross-file |
| Question | is this file valid? | do these files fit together? |
| Input | project files + toolchains | Pass 1 results, `blockers.json`, `UNRESOLVED.md` |
| Output | plugin checks, `junit.xml`, `blockers.json` | findings, blocker triage, applied fixes |
| Fails when | a check fails | a cross-file error remains |

What Pass 2 actually does:

1. **Reads the debt.** It loads `blockers.json` and triages every `[OPEN]` row into
   `auto-fixable` or `manual`, with the concrete action for each.
2. **Builds a reference graph across languages.** HTML `<script>`/`<link>`/`<img>` targets
   must exist; relative JS/TS import specifiers must resolve; relative Python imports
   must land on a module. A page pointing at a deleted bundle fails here, not in any
   linter.
3. **Checks symbols across files.** For each `import { a } from "./b"`, Pass 2 parses
   `b`'s exports and flags names that were never exported — a function called from one
   file and defined nowhere. Ambiguous shapes (`export *`, CommonJS) are skipped rather
   than guessed.
4. **Applies automation it actually knows** (`--fix`), then makes Pass 1 re-verify the
   result, so a fix is only claimed when a green run proves it. The registry currently
   generates the cargo-nextest JUnit profile; new automations are added there, not
   scattered through plugins.

Severity is deliberate: missing assets, unresolved relative imports and missing symbols
are errors (they break the build); root-absolute paths that a server may rewrite are
warnings. `pass2Ignore` silences generated code. Set `"twoPass": false` (or
`--no-two-pass`) for the shallow sweep only.

## Signals layer: flaky detection

Pass 1 and Pass 2 execute tools. The signals layer only reads: it consumes the JUnit
artifacts Pass 1 already produced and adds history, which is the one thing a single run
cannot have.

```
run N: artifacts/*/junit.xml ─┐
                              ├─→ .deepdiagnose/flaky-history.json ─→ flake score
run N+1: artifacts/*/junit.xml ┘                                     + flaky list
```

- Each run records every test's outcome keyed by `git rev-parse --short HEAD` (and
  whether the tree was dirty).
- A test is **flaky** when it has both passed and failed within `minRuns` observations;
  `sameCommitMixed: true` means both outcomes were seen at an identical commit — the
  strongest evidence available without re-running tests N times.
- `flakeScore` follows DeFlaky's definition: the percentage of evaluated tests whose
  outcomes were consistent (always pass or always fail). Flipping lowers it; a test
  that always fails does not. Tests below `minRuns` are excluded, not scored as broken.
- Output: a `SIGNALS · Flaky detection` console section, `signals.flaky` in
  `diagnostic-report.json`, and `artifacts/flaky/report.json`.

```json
{
  "id": "node::src/sum.test.ts::sum > adds",
  "runs": 4, "passes": 2, "failures": 2, "flakeRate": 0.5,
  "sameCommitMixed": true, "status": "flaky"
}
```

Flakiness is reported by default and does **not** fail a run; set `"failOnFlaky": true`
to gate CI on it once the number is trusted. `.deepdiagnose/flaky-history.json` is local
state — commit it or cache it in CI (see the template) if you want the trend to survive.

Why this is built in rather than shelled out: the reviewed JUnit flake tools
([flakeguard](https://pypi.org/project/flakeguard/), [DeFlaky](https://deflaky.com/docs),
[flakewall](https://github.com/Cicatriiz/flakewall)) all need repeated executions to
compare — DeFlaky and smartcontractkit's flakeguard re-run your suite themselves, and the
TS flakeguard is a GitHub App with Postgres/Redis. DeepDiagnose already runs the suite
and writes JUnit, so it owns the comparison and keeps zero extra runtime dependencies.

## Test impact

Selection, not execution: the signal answers "which tests can this diff reach?" and
leaves running them to the project's own runner. Two adapters behind one contract:

| Adapter | When | How |
|---|---|---|
| `mizchi-test-impact` | `@mizchi/test-impact` is installed (`auto`/`mizchi`) | runs `test-impact --since <base> --format json` and reads its selected files |
| `graph` | always available, and the fallback for any adapter failure | inverts the import graph Pass 2 already parses and walks from changed files to their importers |

The fallback matters more than the adapter: an optional tool that fails, is missing, or
returns no JSON must never break the run. When it does, `fallbackReason` is recorded and
the graph answers instead — same report shape either way.

```json
{ "adapter": "graph", "base": "HEAD", "changedFiles": ["src/math.ts"],
  "selectedTests": ["tests/math.test.ts"], "candidates": 2, "reductionPct": 50 }
```

Build output, `node_modules/`, caches and `artifacts/` are filtered from the diff, so our
own reports never select tests. `artifacts/impact/report.json` holds the full list.

Ecosystem reference points, deliberately **not** dependencies: [`pyrn`](https://pypi.org/project/pyrn/)
(Rust core, Python TIA) and `pytest-tia` (coverage map) for Python, `cargo-affected`
(LLVM coverage → diff hunks; its own README says CI should still run everything) for Rust.
They need a coverage collection phase we do not own; the graph adapter covers those
languages today, and a wrapper would go in the same adapter slot.

## Failure triage (`--ai-explain`)

Rules run first and always; a model only enriches them. This keeps the flag useful in
offline CI and keeps cost bounded.

1. Every failed check becomes `{ id, plugin, check, category, confidence, command, exitCode, excerpt, suggestion, source }`
   with a category from `missing-tool`, `type-error`, `dependency`, `timeout`, `network`,
   `permissions`, `test-assertion`, `configuration`, `compile-error`, `unknown`.
2. With `--ai-explain` **and** `OPENAI_API_KEY`, one request is sent for the failures
   (OpenAI-compatible `chat/completions`, `DEEPDIAGNOSE_AI_BASE_URL` / `DEEPDIAGNOSE_AI_MODEL`
   to point elsewhere). Answers are cached in `.deepdiagnose/ai-cache.json` by failure hash,
   so a repeatedly red pipeline is not billed repeatedly.
3. Without a key the report says `mode: "rules-only"` — never a silent failure.

`artifacts/explain/report.json` is the integration point: any external triage tool can
read it, and its category vocabulary is deliberately plain. ([ci-triage](https://www.npmjs.com/package/ci-triage)
classifies CI logs with 16 categories and a SQLite flake DB; it is a useful consumer, not
a dependency.)

## Blocker lifecycle

A skipped check is not noise to be ignored — if a capability *should* work and does not,
it is a blocker with a lifecycle. Every run reconciles the ledger:

1. **A skip is logged `[OPEN]`.** Missing toolchain (`go is not installed`), missing
   parser, missing config profile (`add [profile.ci.junit] …`) — the check appears in
   `blockers.json` and on `UNRESOLVED.md` as `- [ ] **[OPEN]**`.
2. **Fix the cause**, not the report: install the tool, write the parser, add the
   profile.
3. **Rerun `deepdiagnose`.** When the check passes, that same run moves the row to
   `- [x] **[RESOLVED]**` in `UNRESOLVED.md` and sets `status: "resolved"` in
   `blockers.json`. The console prints `N resolved`.
4. **Regressions re-open.** If the capability breaks again, the row returns to `[OPEN]`
   with an incremented run count — history is kept, nothing is silently dropped.

```bash
npm run diagnose          # 3 open blockers
```
```
blockers: 3 open · 0 resolved · 3 newly tracked
board:   /repo/UNRESOLVED.md
```
```bash
# install the missing toolchain, then:
npm run diagnose
```
```
blockers: 0 open · 3 resolved · 3 resolved
```

Rules that keep the board honest:

- `UNRESOLVED.md` is **generated**; the ledger `blockers.json` is the source of truth.
  Do not hand-edit either — a fix is only real when a run proves it green.
- A blocker is only closed when **its plugin actually ran** in that run. Running
  `--cassette=<name>` (or a blocked plugin) never resolves another project's rows.
- Skips that are correct by design (no `tsconfig.json`, or the Android-only `lint`
  task in a plain JVM project) are marked `not-applicable` and never enter the ledger.
  Only real gaps become blockers.
- Commit both files. The diff between runs *is* the progress report: a blocker moving
  from `[OPEN]` to `[RESOLVED]` is the visible proof the tool is getting stronger.
- The tool is not finished while `blockers.json` has open entries it can close. If a
  blocker can never close (e.g. Xcode on a Linux-only repo), say so and mark it
  intentionally out of scope rather than leaving it silently red.

## Supported ecosystems

| Plugin | Marker files | Tests → JUnit | Lint / types |
| --- | --- | --- | --- |
| `armor` (base) | always runs | synthesized | `npm run check:armor` / `check:editions` / `check:export` |
| `node` | `package.json`, `tsconfig.json` | Vitest `--reporter=junit` | ESLint `--format json`; `tsc` |
| `go` | `go.mod`, `go.work`, `*.go` | gotestsum `--junitfile` | golangci-lint JUnit + JSON (v1/v2 flags detected), `go vet` |
| `python` | `pyproject.toml`, `requirements.txt`, `*.py` | pytest `--junitxml` | ruff JSON, mypy `--junit-xml` |
| `rust` | `Cargo.toml` | cargo-nextest JUnit | clippy `--message-format=json`, `cargo fmt --check` |
| `apple` | `*.xcodeproj`, `*.xcworkspace`, `Package.swift` | `xcodebuild test \| xcbeautify --report junit` | `xcodebuild -list` |
| `android` | `build.gradle(.kts)`, `pom.xml`, `AndroidManifest.xml`, `*.kt`/`*.java` | Gradle `testDebugUnitTest` / Maven surefire | Android `lint`, `mvn test` |
| `dotnet` | `*.sln`, `*.csproj`, `*.fsproj` | `dotnet test --logger "junit;..."` | `dotnet build` |
| `ruby` | `Gemfile`, `Rakefile`, `*.gemspec` | RSpec via `rspec_junit_formatter` | RuboCop JUnit + JSON |
| `php` | `composer.json`, `phpunit.xml`, `*.php` | PHPUnit `--log-junit` | PHPStan JSON |

Tools that have no machine format (`tsc`, `go build`, `cargo test`) still get a
synthesized `junit.xml`, so the artifact contract always holds.

## Artifacts

```
diagnostic-report.json          aggregate report: { summary, pass1: { plugins }, pass2: { findings, triage, fixes }, blockers }
blockers.json                   blocker ledger (committed)
UNRESOLVED.md                   generated tracking board: [OPEN] / [RESOLVED] (committed)
.deepdiagnose/flaky-history.json   per-test outcome history (local state)
.deepdiagnose/ai-cache.json        model answers, keyed by failure hash
artifacts/
├── flaky/report.json           flake score + flaky test list
├── impact/report.json          changed files, selected tests, adapter used
├── explain/report.json         structured failure records (--ai-explain)
├── junit.xml                   every suite merged, for CI test reporters
├── armor/
│   ├── junit.xml
│   └── report.json             normalized per-plugin result
├── node/
│   ├── junit.xml               native Vitest output
│   ├── eslint.json             native ESLint output
│   └── report.json
└── ...
```

`report.json` per plugin: `plugin`, `label`, `base`, `blocked`, `status`,
`generatedAt`, `durationMs`, `junit`, `checks[]`.

## CI

Copy [`.github/workflows/diagnose-template.yml`](.github/workflows/diagnose-template.yml)
to `.github/workflows/diagnose.yml`, uncomment the toolchain setup steps you need, and
commit. It runs `npx @deepdrop/diagnose`, fails the job on any failed check, and
uploads `diagnostic-report.json` + `artifacts/` with `if: always()` so the report is
available even on failure.

## Custom plugins

Point `pluginsDir` at a folder and drop in an ES module. The engine loads every
`.js`, `.mjs` or `.ts` file in it at runtime, so no core changes are needed.

```js
// diagnose-plugins/swift-format.mjs
import { exec } from "node:child_process";

/** @type {import("@deepdrop/diagnose").Plugin} */
export default {
  id: "swift-format",
  label: "Swift Format",
  // Rooted to Angel Armor automatically: the engine runs it only after the base
  // plugin passes, and marks it `blocked` otherwise.
  async detect(ctx) {
    return ctx.find(["Package.swift"], { maxDepth: 2 }).then((found) => found.length > 0);
  },
  async run(ctx, artifacts) {
    const startedAt = Date.now();
    const { code, stdout, stderr } = await ctx.exec("swift", ["format", "lint", "--strict", "."]);
    return [
      {
        name: "swift format lint",
        status: code === 0 ? "passed" : "failed",
        command: "swift format lint --strict .",
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output: `${stdout}${stderr}`.trim().slice(-4000) || undefined,
      },
    ];
  },
};
```

Plugin contract:

```ts
interface Plugin {
  id: string;            // unique; reuse a built-in id to override it
  label: string;         // shown in the console and report
  base?: boolean;        // true only for Angel Armor-style foundations
  detect(ctx): boolean | Promise<boolean>;
  run(ctx, artifacts): Promise<CheckResult[]>;
}
```

`ctx` gives you `repoRoot`, `target`, `config`, `exists()`, `find()`, `read()`,
`pkg()`, `packageScripts()`, `bin()`, `which()` and `exec()`. `artifacts` gives you
`dir`, `junitPath`, `jsonPath`, `writeFile()`, `writeJson()`, `adopt()` and
`mergeJUnit()`.

When a plugin skips a check, mark it correctly so the board stays honest:

```ts
import { notApplicable, skipped } from "@deepdrop/diagnose";

skipped("go toolchain", "go is not installed"); // real gap → [OPEN] on the board
notApplicable("lint", "Android-only task");     // by design → never tracked
```

Write your tool's native JUnit straight to `artifacts.junitPath` when it supports it;
otherwise just return checks and the engine synthesizes `junit.xml` for you.

## Development

```bash
npm run typecheck   # strict TS, no emit
npm test            # node:test over the pure units (JUnit reader, triage rules)
npm run build       # dist/ for the bin
```

Tests run against `src/` via `tsx`, so they do not need a build. The functional
contracts (two passes, ledger, signals) are exercised by running the CLI against a
fixture repo; the unit tests cover the parsing and classification edges.

## Notes and limits

- **Apple** needs macOS with Xcode, plus `brew install xcbeautify`. Override the
  destination with `DIAGNOSE_XCODE_DESTINATION` (default `platform=macOS`).
- **.NET** produces native JUnit only when `JunitXml.TestLogger` is referenced by the
  test project; otherwise the plugin retries without the logger and says so.
- **Rust** gets native JUnit from `cargo-nextest` with
  `[profile.ci.junit] path = "junit.xml"` in `.config/nextest.toml`; without it the
  report notes the missing profile.
- **`--fix`** is intentionally conservative: dependency install and formatting only.
- DeepDiagnose does not manage toolchains, containers, or deployments.

## License

MIT — see [LICENSE](LICENSE).
