# DeepDiagnose

DeepDiagnose is a universal diagnostic engine for software repositories: it detects which ecosystems are present, runs a mandatory foundation gate (**Angel Armor**), routes work to each ecosystem's own tools, relates the results across files, and writes one report plus a self-closing blocker ledger.

Published package name: `@deepdrop/diagnose` · version `0.2.0` (beta) · MIT.

**Honest status:** the engine is implemented and its own test suite passes, but **no registry publication is verified**, the repository has not yet been pushed to a remote, and **no built-in language plugin has ever been executed in this workspace** — the self-run exercises the Angel Armor gate only. See [Known limitations](#14-known-limitations-and-open-defects) before trusting any signal.

## 1. What DeepDiagnose is

One command per repository:

```
PASS 1 · Syntax & Structure   armor gate → ecosystem plugins → artifacts/<plugin>/junit.xml
PASS 2 · Logic & Debt         cross-file findings → blocker triage → known automation
SIGNALS                       flaky history · test impact · failure triage (read-only)
                              ↓
diagnostic-report.json + UNRESOLVED.md + artifacts/
```

Three design rules:

1. **The gate is real.** Language plugins do not run while Angel Armor fails; their results are marked `blocked` and stale artifacts are removed.
2. **Two passes ask different questions.** Pass 1 runs tools per file; Pass 2 relates files to each other. Pass 2 never re-runs a linter.
3. **Signals read, they do not execute.** Flaky detection, impact selection and triage consume artifacts and Git state. Running selected tests stays the project's job.

## 2. The problem it solves

Repositories contain several toolchains at once, each with its own output format. CI either runs a fraction of them or drowns in unrelated logs, and skipped tools look identical to passing ones. DeepDiagnose:

- detects the ecosystems actually present;
- runs each ecosystem's tools through one adapter contract;
- refuses to report language results when the foundation gate fails;
- normalizes everything into JUnit plus one JSON report;
- records every unresolved capability as a tracked blocker that closes itself when the cause is fixed;
- adds advisory signals (flaky tests, test impact, failure triage) without executing test suites.

## 3. Current capabilities

| Capability | Status | Evidence |
|---|---|---|
| Ecosystem detection + 9 built-in plugins | IMPLEMENTED, SOURCE-VERIFIED | `src/plugins/*.ts`; detection code inspected, not executed here |
| Mandatory Angel Armor gate | IMPLEMENTED, TESTED (self-run) | Armor 3/3 on this repo; gate blocking is source-verified |
| Pass 1 → Pass 2 separation | IMPLEMENTED, TESTED (unit) | `core/pass2-analysis.ts`, `test/pass2-resolution.test.ts` |
| Shared module resolver (S1) | IMPLEMENTED, TESTED, COMMITTED | `core/module-resolution.ts`, `test/resolver.test.ts`, commit `0313c5b` |
| Unified artifact + merged JUnit | IMPLEMENTED, TESTED | `core/artifacts.ts`, `test/junit-parse.test.ts` |
| Blocker ledger open → resolve → reopen | IMPLEMENTED, UNTESTED lifecycle | `core/blockers.ts`; no lifecycle test; S3 defects open |
| Flaky analysis from JUnit history | IMPLEMENTED, UNTESTED evidence quality | `core/flaky.ts`; S2 defect open |
| Test-impact selection (JS/TS) | IMPLEMENTED, TESTED for resolution | `core/impact.ts`, 1,201-file chain selects its test in 145 ms |
| Failure triage (rules; optional model) | IMPLEMENTED, PARTIALLY TESTED | Rules tested; model path unhardened (S5) |
| Config + `init` scaffolding | IMPLEMENTED, TESTED manually | `core/config.ts`, `commands/init.ts`; values unvalidated (S6) |
| Project model, history reconstruction, repair, prediction, UI | **PLANNED — not implemented** | See [Roadmap](docs/roadmap.md) |

## 4. Supported ecosystems and verified capability levels

Detection and tool execution are broad; **engine-side analysis is narrow**. No row below was executed in this workspace, so every ecosystem is **SOURCE-VERIFIED**, not TESTED.

| Ecosystem | Detect + run tools | Engine-side analysis | Impact graph | Verified here |
|---|---|---|---|---|
| Node / TypeScript | Yes | Imports, symbols, tsconfig aliases, NodeNext specifiers | Yes | No — plugin not executed |
| Go | Yes | No | No | No |
| Python | Yes | Relative-import existence only | No | No |
| Rust | Yes | No | No | No |
| Apple / Swift | macOS only | No | No | No |
| Android / Kotlin / Java | Yes | No | No | No |
| .NET | Yes | No | No | No |
| Ruby | Yes | No | No | No |
| PHP | Yes | No | No | No |

C and C++ have no plugin. A missing toolchain is reported as `skipped` and recorded as a blocker, never as a failure. Full matrix, tools and output formats: [docs/ecosystem-support.md](docs/ecosystem-support.md).

## 5. Architecture and project structure

```
CLI (commander)
  └─ engine
       ├─ config · repo detection · plugin registry
       ├─ Pass 1: armor gate → plugins → tool execution → artifacts
       ├─ Pass 2: import/symbol graph · HTML refs · Python imports · triage
       ├─ Signals: flaky (JUnit) · impact (git diff + graph) · triage (rules/model)
       └─ report + blocker ledger
```

Component map, module table and separate implemented/planned Mermaid diagrams: [docs/architecture.md](docs/architecture.md).

```
.
├── .github/workflows/ci.yml        CI: Node 20/22/24, typecheck, tests, build, self-run
├── diagnose.config.json            self-diagnosis configuration for this repo
├── docs/
│   ├── architecture.md             components, flows, implemented vs planned
│   ├── ecosystem-support.md        T0–T5 capability tiers, 9-row matrix
│   ├── security.md                 execution model, sandboxing (none), egress
│   ├── roadmap.md                  status, S2–S7 queue, missing-register note
│   └── testing.md                  reproducible setup and verification guide
├── LICENSE                         MIT
└── packages/diagnostic-engine/
    ├── README.md                   engine reference (CLI, config, artifacts)
    ├── package.json                @deepdrop/diagnose 0.2.0
    ├── package-lock.json           npm lockfile (npm ci)
    ├── tsconfig.json
    ├── src/
    │   ├── cli.ts                  command surface
    │   ├── commands/init.ts        config scaffolding
    │   ├── core/                   engine, passes, signals, report, ledger
    │   └── plugins/                armor + 9 ecosystem adapters
    ├── test/                       node:test suites (26 tests)
    └── .github/workflows/          consumer workflow template
```

## 6. Prerequisites and supported runtime versions

| Use | Requirement | Evidence |
|---|---|---|
| Running the built CLI | Node.js `>=18.18` (declared in `engines`) | SOURCE-VERIFIED; the 18.x floor was not executed |
| Running tests | Node.js `>=20.6` (`node --import tsx`) | SOURCE-VERIFIED; executed on Node 24.22.1 |
| Package manager | npm with the committed `package-lock.json` | `npm ci` verified with npm 11.19.1 on Linux |
| Ecosystem tools | Optional; supplied by the project under test | Missing tools are skipped, not failed |

Runtime used for all verification recorded here: **Node 24.22.1, npm 11.19.1, Linux**. CI declares Node 20, 22 and 24. Node 18 and Windows were not tested.

## 7. Installation and setup

From a clone of this repository:

```bash
cd packages/diagnostic-engine
npm ci
npm run build
node dist/cli.js --version        # 0.2.0
node dist/cli.js --help
```

Use it against another project without installing globally:

```bash
node /absolute/path/to/packages/diagnostic-engine/dist/cli.js init
node /absolute/path/to/packages/diagnostic-engine/dist/cli.js
```

`npm install <path-to-package>` or a future registry release exposes the `deepdiagnose` and `diagnose` binaries. **No registry release is verified for this baseline**; build from source.

The root directory intentionally has no `package.json`; install and build inside `packages/diagnostic-engine`.

## 8. Configuration and environment variables

`diagnose.config.json` at the target repository root; every key is optional. Defaults written by `init`:

```json
{
  "artifactsDir": "artifacts",
  "cassettesDir": "cassettes",
  "reportPath": "diagnostic-report.json",
  "blockersFile": "blockers.json",
  "boardFile": "UNRESOLVED.md",
  "gate": true,
  "twoPass": true,
  "flaky": { "enabled": true, "minRuns": 3, "maxRuns": 50, "failOnFlaky": false },
  "impact": { "enabled": true, "base": "HEAD", "adapter": "auto" },
  "armor": { "scripts": ["check:armor", "check:editions", "check:export"] }
}
```

Notable keys: `gate` blocks language plugins on armor failure; `flaky.failOnFlaky` lets flaky tests affect the exit code; `impact.base` is the revision to diff against (in PR CI set it to the target branch); `pluginsDir` loads repository-local plugins, which are executable code.

**Config values are not validated** — wrong types and impossible values are used as given (S6). The full key table with actual behavior is in the [engine reference](packages/diagnostic-engine/README.md#6-configuration-reference).

Environment variables (all optional; never commit them):

| Variable | Purpose | Safe example |
|---|---|---|
| `OPENAI_API_KEY` | Enables the model pass with `--ai-explain` | set in CI secret store, never in the repo |
| `DEEPDIAGNOSE_AI_BASE_URL` | OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `DEEPDIAGNOSE_AI_MODEL` | Model name | `gpt-4o-mini` |
| `DIAGNOSE_XCODE_DESTINATION` | Apple destination | `platform=macOS` |

Without `OPENAI_API_KEY`, triage stays `rules-only`. AI mode sends failure excerpts off-machine with **no redaction** (S5).

## 9. CLI commands — verified examples

| Command | Purpose |
|---|---|
| `deepdiagnose` | Diagnose the repository root |
| `deepdiagnose <cassette>` | Diagnose one workspace package |
| `deepdiagnose init` | Write config and add a `diagnose` npm script |
| `--json <path>` | Write the aggregate report elsewhere |
| `--fix` | Install dependencies, run formatters, apply known Pass 2 handlers only |
| `--no-gate`, `--no-two-pass`, `--no-flaky`, `--no-impact` | Disable one stage deliberately |
| `--ai-explain` | Rules triage plus model pass when a key is set |
| `--quiet` | No console summary |
| `-V, --version` | Print version |

Verified in this workspace: `--version` → `0.2.0`; `--help` completes; `init` in a temporary directory exits `0`; `node dist/cli.js --quiet` self-run exits `0`. Exact option semantics: [engine reference §4–§5](packages/diagnostic-engine/README.md#4-cli-commands).

## 10. Running the diagnostic engine

```bash
# from the repository you want to diagnose
node /path/to/packages/diagnostic-engine/dist/cli.js init   # first time only
node /path/to/packages/diagnostic-engine/dist/cli.js        # diagnose

cat diagnostic-report.json
cat UNRESOLVED.md
```

Exit codes: `0` all executed checks passed; `1` at least one failure, Pass 2 error, or flaky failure when configured; `2` unhandled CLI error. Skipped checks do not fail a run. A blocked plugin does not add its own failure, but the armor failure that blocked it does.

## 11. Running tests

```bash
cd packages/diagnostic-engine
npm test        # node --import tsx --test test/*.test.ts
```

Expected: **26 passing tests, 0 failures** (junit parsing, Pass 2 resolution, shared resolver, aliases, impact, and triage with and without a model). Tests use only local fixtures; no network is required. The AI test never calls a provider.

## 12. Type checking and builds

```bash
cd packages/diagnostic-engine
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run build        # tsc -p tsconfig.json  → dist/
npm run clean        # remove dist/
```

`dist/` is generated and Git-ignored; a fresh clone must build before running the CLI. There is no bundling step and one runtime dependency (`commander`).

## 13. Reports and artifacts

```
diagnostic-report.json              aggregate report (no schemaVersion yet — S7)
blockers.json                       machine-readable ledger (commit it)
UNRESOLVED.md                       generated human board (commit it)
.deepdiagnose/flaky-history.json    per-test history
.deepdiagnose/ai-cache.json         cached model answers
artifacts/
├── junit.xml                       all suites merged
├── flaky/report.json
├── impact/report.json
├── explain/report.json
├── node/{junit.xml, eslint.json, report.json}
└── <plugin>/...
```

Report keys: `engine`, `engineVersion`, `generatedAt`, `target`, `artifacts`, `twoPass`, `summary`, `pass1`, `pass2`, `signals`, `blockers`, `availablePlugins`. Per-plugin `report.json` carries checks with `name`, `status`, `command`, `exitCode`, `durationMs`, `message`. Consumers must tolerate unknown fields until S7 adds versioning. Artifacts contain tool output and stack traces and are **not automatically safe to publish**.

## 14. Known limitations and open defects

**S2–S7 are open engineering work. Documenting them is not fixing them.**

| ID | Defect |
|---|---|
| S2 | No source-tree fingerprint: dirty-tree evidence can produce false `sameCommitMixed`; engine output is counted as dirty |
| S3 | State writes are not atomic; a corrupt ledger is reset and history lost; no lock; no lifecycle test |
| S4 | Timeout sends `SIGTERM` only and resolves on close; grandchildren survive; a trapping child hangs the run (reproduced at 4,007 ms with a 500 ms timeout) |
| S5 | AI excerpts are sent unredacted; model output is not schema-validated; cache can override rule categories |
| S6 | Configuration is not validated; impossible values are accepted silently |
| S7 | No report `schemaVersion`; an unresolvable impact base reports "no changes" instead of failing |

Also outstanding:

- **No built-in language plugin has executed here.** Only the armor gate has run; the ecosystem matrix is SOURCE-VERIFIED.
- **The original 26-point requirements register, master to-do, and First/Second Pass review records are missing.** They could not be recovered from repository history, checkpoints, bundles, or records. No replacement register exists, and no requirement is claimed complete. This limitation is recorded in [docs/roadmap.md](docs/roadmap.md#requirement-register-recovery-blocked).
- No test covers the ledger lifecycle, tree fingerprint, process termination, AI safety, config validation, or schema versioning.
- No registry publication, no remote push yet.

## 15. Security and privacy

- Plugins run **in-process with full Node privileges**; there is **no sandbox**. A repository-local plugin is arbitrary code in your CI. Do not run untrusted pull requests with secrets in the environment.
- Child processes inherit the full environment, including secrets. Timeouts do not kill process trees (S4).
- Plugin commands use `spawn(..., { shell: false })`; the Apple plugin intentionally adds two `/bin/sh -c` pipelines with every dynamic value single-quoted. Node's permission model blocks filesystem writes and spawning but **not network**; it is not used here.
- Network egress occurs only with `--ai-explain` plus a key, and excerpts are unredacted today (S5).
- Reports and artifacts can contain secrets from tool output; review before publishing.

Full model, measured permission results and CI guidance: [docs/security.md](docs/security.md).

## 16. Current development status

- Version `0.2.0`, beta; baseline commit `0313c5b` on branch `freebuff/db4db7f48810d22bbbea4874`.
- S1 shared resolver: implemented, tested, committed (`0313c5b`); not pushed.
- Documentation: six files prepared and audited; this transfer adds a testing guide.
- CI workflow exists and matches the verified commands, but it has **never run on GitHub** because nothing has been pushed.
- Not production-ready. Not published. S2–S7 remain open.

## 17. Contributing and development workflow

```bash
cd packages/diagnostic-engine
npm ci
npm run typecheck && npm test && npm run build
cd ../..
node packages/diagnostic-engine/dist/cli.js --quiet   # self-diagnosis, exit 0
```

- Read [docs/testing.md](docs/testing.md) before adding tests or claiming ecosystem support.
- Keep status labels honest: IMPLEMENTED, TESTED, SOURCE-VERIFIED, UNTESTED, PLANNED, KNOWN DEFECT.
- Do not invent requirement numbers; S1–S7 are technical work items, not the missing 26-point register.
- New plugins need detection, execution, artifact and skip-path tests before their row can leave SOURCE-VERIFIED.
- Never commit `.env`, tokens, private keys, `node_modules`, `dist/`, caches or generated artifacts.

## Documentation

- [Architecture](docs/architecture.md)
- [Ecosystem support](docs/ecosystem-support.md)
- [Security](docs/security.md)
- [Roadmap and open defects](docs/roadmap.md)
- [Testing guide](docs/testing.md)
- [Engine reference](packages/diagnostic-engine/README.md)

## License

MIT — see [LICENSE](LICENSE) and the package [LICENSE](packages/diagnostic-engine/LICENSE).
