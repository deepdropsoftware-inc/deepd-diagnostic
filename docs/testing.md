# Testing guide

**Baseline:** commit `0313c5b` · package `@deepdrop/diagnose@0.2.0` · runtime used for the recorded results: Node 24.22.1, npm 11.19.1, Linux.

This guide describes how to reproduce every check that is claimed for this project, what each check actually proves, and what **cannot** be verified in a bare environment. A command listed here has been executed only where it is marked EXECUTED; everything else is a procedure waiting for a capable machine.

Status vocabulary: **EXECUTED** (run and recorded), **TESTED** (covered by an automated test), **SOURCE-VERIFIED** (code inspected, not run), **UNTESTED**, **PLANNED**.

## 1. Runtime and prerequisites

| Requirement | Version | Status |
|---|---|---|
| Node.js — build and CLI | `>=18.18` declared; 24.22.1 used | EXECUTED on 24.22.1; 18.x UNTESTED |
| Node.js — tests | `>=20.6` (`node --import tsx`) | EXECUTED on 24.22.1 |
| npm with committed lockfile | 11.19.1 | EXECUTED (`npm ci`) |
| Git | any recent version | EXECUTED (self-run reads Git state) |
| Ecosystem toolchains | supplied by the project under test | NOT INSTALLED here except `python3` |

CI declares Node 20, 22 and 24 (`.github/workflows/ci.yml`); it has never run on GitHub because the repository has not been pushed.

The repository root has **no** `package.json`. All install and build commands run inside `packages/diagnostic-engine`.

## 2. Clean setup

```bash
cd packages/diagnostic-engine
npm ci                 # uses package-lock.json; do not substitute npm install for reproducible runs
npm run build
node dist/cli.js --version    # 0.2.0
```

Expected: install succeeds without audit-blocking errors; `dist/cli.js` exists. `dist/` and `node_modules/` are Git-ignored and must be regenerated after a fresh clone.

## 3. Environment variables

All are optional. Do not create a committed `.env`; export them in the shell or use the CI secret store.

| Variable | Effect | Example |
|---|---|---|
| `OPENAI_API_KEY` | Enables the model pass with `--ai-explain` | secret store only |
| `DEEPDIAGNOSE_AI_BASE_URL` | OpenAI-compatible endpoint | `https://api.openai.com/v1` |
| `DEEPDIAGNOSE_AI_MODEL` | Model name | `gpt-4o-mini` |
| `DIAGNOSE_XCODE_DESTINATION` | Apple destination | `platform=macOS` |

Without a key, triage reports `mode: rules-only`. AI mode transmits failure excerpts with **no redaction** (S5); do not enable it on logs containing secrets.

## 4. Automated checks

```bash
cd packages/diagnostic-engine
npm run typecheck      # tsc --noEmit, exits 0
npm test               # 26 tests, 0 failures
npm run build          # emits dist/, exits 0
```

**Status:** all three EXECUTED at `0313c5b` (typecheck 0, 26/26 pass, build 0). The suite uses `node:test` with local fixtures; no network is needed. The AI test stubs the provider.

What the 26 tests cover: JUnit parsing, Pass 2 resolution, the shared module resolver, tsconfig alias handling, test-impact selection, and rule/model triage. They do **not** cover the blocker lifecycle, flaky fingerprinting, process termination, AI safety, config validation, or schema versioning — those are S2–S7 and currently UNTESTED.

## 5. CLI surface

```bash
node dist/cli.js --version     # 0.2.0
node dist/cli.js --help        # command and option list
```

**Status:** EXECUTED. A non-zero exit here means the build is missing.

## 6. Initialization smoke test

```bash
rm -rf /tmp/dd-init && mkdir -p /tmp/dd-init
node /absolute/path/to/packages/diagnostic-engine/dist/cli.js init --dir /tmp/dd-init
ls /tmp/dd-init                    # diagnose.config.json, package.json
```

Expected: exit `0`; `diagnose.config.json` written with defaults; `package.json` created if absent. `init` never overwrites an existing config without `--force`. **Status:** EXECUTED in a temporary directory (exit 0).

## 7. Diagnostic self-run

From the repository root:

```bash
node packages/diagnostic-engine/dist/cli.js --quiet
echo $?        # 0
```

Expected: exit `0`; the armor gate passes 3/3 (`check:armor`, `check:editions`, `check:export` map to typecheck, tests, build); Pass 2 reports 0 errors; no open blockers. This run analyzes the TypeScript sources only — **it does not execute any language plugin**, because the repository root has no application ecosystem for them to detect.

**Status:** EXECUTED, exit 0.

## 8. End-to-end smoke test in a scratch project

```bash
rm -rf /tmp/dd-smoke && mkdir -p /tmp/dd-smoke
cd /tmp/dd-smoke
git init -q . && git commit --allow-empty -m init
node /absolute/path/to/dist/cli.js init --dir .
node /absolute/path/to/dist/cli.js --quiet
cat diagnostic-report.json | head
cat UNRESOLVED.md
```

Expected: exit `0` with skipped armor checks recorded as blockers (nothing is installed in the scratch project), plus `diagnostic-report.json`, `blockers.json`, `UNRESOLVED.md` and `artifacts/`. Skipped checks are not failures. Confirm the report's top-level keys: `engine`, `engineVersion`, `generatedAt`, `target`, `artifacts`, `twoPass`, `summary`, `pass1`, `pass2`, `signals`, `blockers`, `availablePlugins`.

To exercise a language plugin, create a project with that ecosystem's manifest and toolchain installed (for example a Node project with `eslint` and `vitest`), then rerun and inspect `artifacts/<plugin>/report.json`.

## 9. Ecosystem verification matrix

None of these have been executed in this workspace. Each row needs the listed tool on `PATH` and a fixture project; only then may its status become TESTED.

| Ecosystem | Tool probe | Fixture requirement |
|---|---|---|
| Node / TypeScript | `node -v`, `npx tsc -v` | `package.json`, tsconfig, eslint/vitest as desired |
| Go | `go version` | `go.mod`, test files |
| Python | `python3 --version` | `pyproject.toml`/`requirements.txt` |
| Rust | `cargo --version` | `Cargo.toml`, tests |
| Apple / Swift | `swift --version`, `xcodebuild -version`, `xcbeautify --version` (macOS) | `Package.swift` or Xcode project |
| Android / Kotlin / Java | `java -version`, `gradle -v` | Gradle project |
| .NET | `dotnet --version` | `.sln`/`.csproj` |
| Ruby | `ruby --version`, `bundle -v` | `Gemfile` |
| PHP | `php --version`, `composer -V` | `composer.json` |

Only `python3` is present in the reference environment; every other probe is unavailable, so no plugin execution claim is possible there. Missing tools are reported as `skipped` and logged as blockers — that is expected, not a failure.

## 10. What each check proves

| Check | Proves | Does not prove |
|---|---|---|
| `npm test` | The unit-level behavior covered by 26 tests | Plugin execution, CI behavior, Windows/macOS behavior |
| Self-run | The armor gate and the engine's own pipeline work on this repo | Any language plugin |
| Scratch `init` | Config scaffolding and a clean run | Real toolchain adapters |
| Typecheck/build | The package compiles under TypeScript 5.7 with Node 24 types | Runtime correctness on Node 18 |
| CI workflow file | The intended command sequence is recorded | That GitHub Actions executes it |

## 11. CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: `npm ci`, typecheck, tests, build on Node 20/22/24, and the self-run on Node 24. It uses `permissions: contents: read` and no secrets. It is accurate for the commands above but **has not executed on GitHub yet**.

## 12. Troubleshooting

| Symptom | Cause and action |
|---|---|
| `Cannot find module dist/cli.js` | Build first: `npm run build` |
| `node --import` rejected | Node older than 20.6; use a newer Node for tests |
| Every plugin `blocked` | Armor failed; fix the gate or use `--no-gate` deliberately |
| Ledger shows a capability you believe works | That plugin did not run this invocation |
| Impact selects nothing | Default base is `HEAD`; set `impact.base` to the PR base branch |
| Triage `rules-only` | No `OPENAI_API_KEY`, or the model call failed |
| Hang after timeout | Known S4: `SIGTERM`-only termination; kill the process tree manually |
| Corrupt `blockers.json` | Known S3: it is reset on read; restore from a backup |

## 13. Known limitations of this guide

- No Windows, macOS, Node 18/20/22 run has been recorded.
- No ecosystem fixture was exercised; all nine rows remain SOURCE-VERIFIED.
- No test covers S2–S7.
- CI is defined but unexecuted on GitHub.
- The original 26-point requirements register is missing, so no acceptance criterion beyond the checks above can be claimed. See [Roadmap](roadmap.md#requirement-register-recovery-blocked).
