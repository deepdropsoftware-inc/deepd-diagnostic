# Roadmap

**Status labels:** IMPLEMENTED · PARTIALLY IMPLEMENTED · PLANNED · RESEARCH · BLOCKED.
No dates, milestones or requirement numbers are assigned here. The canonical 26-point requirements register is not stored in this repository; roadmap items are capabilities, not new requirements.

## Current position

| Capability | Status | Basis |
|---|---|---|
| Deterministic diagnostics (Pass 1, 9 ecosystems, armor gate) | IMPLEMENTED | `src/plugins/*`, `core/runner.ts`; armor gate exercised (self-run exit 0), language plugins source-verified |
| Relational analysis (Pass 2: imports, symbols, Python relative imports, HTML refs) | IMPLEMENTED | `core/pass2.ts`, `core/pass2-analysis.ts`; 0 errors on this repo |
| Blocker ledger with `[OPEN]`/`[RESOLVED]` lifecycle | PARTIALLY IMPLEMENTED | Lifecycle code exists; no automated lifecycle test; corrupt ledger resets (S3) |
| Flaky detection from JUnit history | PARTIALLY IMPLEMENTED | Implemented; dirty-tree evidence weakness (S2) |
| Test-impact selection (JS/TS) | PARTIALLY IMPLEMENTED | Resolver fixed at `0313c5b`; static imports only, 2,000-file cap; advisory |
| AI-assisted triage | PARTIALLY IMPLEMENTED | Rules always; model opt-in; no redaction/cache isolation (S5) |
| Project digital twin | PLANNED | No project model exists |
| Time machine / regression archaeology | PLANNED | Flaky history is not history reconstruction |
| Isolated repair lab | PLANNED | No candidate generation or sandbox |
| Predictive failure intelligence | PLANNED | No risk scoring; triage describes observed failures |
| Universal ecosystem intelligence | PLANNED | 9 detectors; engine-side analysis is JS/TS + Python existence only |
| UI / visualization | PLANNED | No server, no UI; JSON is the only interface |
| Controlled self-repair | PLANNED | `--fix` installs dependencies and formats; it does not repair code |

## Phase 0 — Stabilize the foundation (in progress)

| Item | Status | Note |
|---|---|---|
| Shared resolver (S1) | IMPLEMENTED | `0313c5b`, 26/26 tests; not pushed; explicit approval of the S1 review is still outstanding |
| Fingerprint / flaky evidence (S2) | PLANNED | Must precede any confidence claim |
| Atomic state + ledger recovery (S3) | PLANNED | Fail-closed design agreed |
| Process-tree termination (S4) | PLANNED | Reproduced hang documented |
| Model output validation + redaction (S5) | PLANNED | Security-relevant |
| Config validation (S6) | PLANNED | Reject invalid values with actionable errors instead of silent coercion |
| Report `schemaVersion` + fail-closed impact base (S7) | PLANNED | Versioned schema before any UI consumes JSON; an unresolvable base must error, not report "no changes" |

## Requirement register recovery (blocked)

The canonical 26-point register, the master to-do and the "Second Pass — 26-Point Review" are **not recoverable from available records**. Searches performed: all 7 commits; all 594 Git blobs including unreachable objects; 31 checkpoint trees; both verified bundles (`pre-review`, `pre-docs`); the artifact store. No requirements file has ever been tracked, no keyword match exists outside this repository's own disclaimers, and no First Pass or Second Pass completion state survives.

**Missing artifacts required from the owner:** (1) the 26 numbered requirements with their acceptance criteria; (2) the master to-do; (3) the First Pass and Second Pass review records. Until they are supplied, no requirement may be marked complete, S1–S7 map to provisional capability domains only, and this file must not be treated as the register.

### Reopen candidates — earlier completion claims contradicted by evidence

| Capability previously recorded as done or verified | Contradicting evidence | Reopened as |
|---|---|---|
| Blocker ledger lifecycle | No automated lifecycle test; corrupt ledger resets history; no lock (S3) | S3 plus a testing gap |
| Flaky same-commit evidence | A dirty tree can produce `sameCommitMixed` (S2) | S2 |
| AI triage | Cached/model category can replace rule category; excerpts unredacted (S5) | S5 |
| Config and `init` "verified" | Invalid values accepted silently, e.g. `maxRuns: 0` (S6) | S6 |
| Artifact contract "verified" | No `schemaVersion`; impact base failures silent (S7) | S7 |
| Nine ecosystem plugins "verified" | No built-in language plugin has ever executed here; self-run reaches only the armor gate | Verification reopened (source-verified only) |
| `@mizchi/test-impact` adapter | Adapter path never exercised in CI | Testing gap |
| 240 s execution timeout | `SIGTERM`-only termination hangs on a trapping child (S4) | S4 |

### Execution queue (contingent on register mapping and owner approval)

| Priority | Concern | Acceptance criterion | Verification |
|---|---|---|---|
| P0 | S5 egress + model-output safety | Unredacted excerpts cannot leave; model cannot overwrite rule category; cache key includes model and prompt | Egress fixture, invalid-model-output fixture, cache tests |
| P0 | S3 state integrity | Writes atomic; corrupt ledger fails closed with byte-identical quarantine; lock prevents interleaving | Crash/corruption/concurrency tests |
| P0 | S4 process termination | Timeout kills the whole tree within a bounded grace period on POSIX and Windows | Trapping-child and grandchild tests |
| P1 | S2 tree fingerprint | Same-commit mixed evidence only from genuinely different source trees; engine artifacts excluded | Dirty/untracked/staged/symlink fixtures |
| P1 | S6 config validation | Invalid values rejected with actionable errors, never clamped | Invalid-config matrix |
| P2 | S7 report contract + base | `schemaVersion` present; unresolvable base fails with a distinct error | Schema snapshot; missing-base fixture |

Each stage requires its own report, full regression (typecheck, tests, build, self-run) and independent review before the next begins. No stage is marked resolved by documentation.

## Phase 1 — Project intelligence / digital twin

**Status: RESEARCH.** No implementation.

Intended scope: a persisted model of modules, files, dependencies, APIs, configuration and tests; coverage and uncertainty tracking; downstream-impact queries; an interactive map.

What exists to build on: the Pass 2 import graph (`core/pass2-analysis.ts`), the shared resolver (`core/module-resolution.ts`) and the impact selection (`core/impact.ts`). These are single-run computations; there is no store, no schema and no incremental update.

Blocked by: S7 (schema stability) and a decision on where the model lives.

## Phase 2 — Time machine

**Status: RESEARCH.**

Intended scope: reconstruct historical states, compare healthy vs current, bisect regressions, link findings to commits, track reopened problems.

What exists: flaky history records per-run test outcomes keyed by short commit; blocker history records first/last seen. Neither reconstructs a project state nor walks history.

## Phase 3 — Repair lab

**Status: RESEARCH.**

Intended scope: disposable environments, multiple candidate fixes, independent test runs, rejection of fixes that introduce failures, human approval.

What exists: conservative automation only — dependency install, Prettier/ESLint fixes, one `nextest` profile writer. Pass 2 verifies applied fixes by re-running Pass 1, which is the pattern a repair lab would extend, not the lab itself.

Hard requirement for this phase: no change to a user's working tree without explicit approval, and rejected candidates must be reported with the tests that rejected them.

## Phase 4 — Predictive failure intelligence

**Status: RESEARCH.**

Intended scope: dependency/compatibility/config risk, architectural fragility, estimated change impact, preventive test recommendations, explicit separation of confirmed defects from predictions.

What exists: rule-based classification of observed failures (`core/explain.ts`). It must not be relabeled as prediction.

Schema requirement: predicted risks must be a distinct type from failed checks and must never enter `blockers.json` as a check result.

## Phase 5 — Universal ecosystem intelligence

**Status: PARTIALLY IMPLEMENTED (detection breadth), RESEARCH (depth).**

Nine ecosystems are detected and their tools executed. Engine-side analysis exists only for JS/TS, plus a Python relative-import existence check. C and C++ have no plugin. Expanding depth must be justified per ecosystem by tests, not by a longer matrix.

## Phase 6 — Engineering intelligence layer

**Status: RESEARCH.** No knowledge store, no cross-session memory, no fact/hypothesis separation. This depends on Phases 1–4 producing verifiable data first.

## Phase 7 — UI and visualization

**Status: PLANNED, intentionally last.**

The CLI and JSON report are the contract. A UI would consume `diagnostic-report.json` and `artifacts/*`; without a `schemaVersion` field, building it now would lock in churn.

## Phase 8 — Open-source and competitive research

**Status: PLANNED.** Not performed in this repository. Leads must be verified for existence, license, maintenance and actual capability before use; no third-party code has been incorporated.

## Gating rules

1. S2–S7 precede Phase 1 implementation.
2. Predictions are never recorded as confirmed defects.
3. Repair never touches a real project without approval.
4. UI work waits for schema versioning.
5. No roadmap item becomes a new requirement; mapping waits for the canonical register.
