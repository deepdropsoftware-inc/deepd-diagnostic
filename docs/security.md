# Security

**Baseline:** commit `0313c5b` · evidence classes: EXECUTED · TESTED · SOURCE-VERIFIED · UNTESTED.

DeepDiagnose runs other people's tools against other people's code. This document states what it does, what it does not protect, and where the risk sits. It does not claim protections that are not implemented.

## 1. Execution model

| Property | Current behavior | Evidence |
|---|---|---|
| Process creation | `spawn(executable, args, { shell: false })`: Node never parses a command string, so `&`, `|`, `$()` and quotes inside arguments stay literal | SOURCE-VERIFIED `core/exec.ts` |
| Explicit shell | `shell: false` does **not** mean "no shell is involved". The Apple plugin deliberately spawns `/bin/sh` with `-c` and a pipeline string in two places (`swift test \| xcbeautify`, `xcodebuild test \| xcbeautify`). Every dynamic value (container path, scheme, `DIAGNOSE_XCODE_DESTINATION`) passes through `shellQuote`, which wraps it in single quotes and rewrites an embedded `'` as `'\''`; only the pipeline structure itself is fixed text | SOURCE-VERIFIED `plugins/apple.ts` |
| Timeout | 240 s default per command; on timeout `SIGTERM` is sent, `timedOut: true` | SOURCE-VERIFIED; **weakness below** |
| Output capture | Last 20 kB of stdout and stderr kept in memory | SOURCE-VERIFIED |
| Environment | Child processes **inherit the full parent environment**, including any secrets present in CI | SOURCE-VERIFIED `exec.ts` |
| Working directory | Repo root or target package | SOURCE-VERIFIED |

What this distinction means in practice:

- For every non-Apple command there is no shell layer at all. Injection would have to abuse the target tool's own argument semantics, not shell metacharacters.
- For the two Apple pipelines a shell exists by design. Their safety rests entirely on `shellQuote` covering every dynamic token; an unquoted path or scheme would be an injection vector.
- The timeout applies to `/bin/sh`, not to `xcodebuild` or `xcbeautify`. Killing the shell does not kill those grandchildren, so S4 is worse for these two calls than for a direct spawn.
- `exec` inherits the full environment and only normalizes `FORCE_COLOR` and `CI`; no variable is stripped.

### Known weakness — process termination (S4)

`exec` sends `SIGTERM` and resolves only when the child emits `close`. A child that ignores `SIGTERM` keeps the engine waiting indefinitely, and grandchildren are not signalled at all because no process group is created.

Reproduced (EXECUTED): a child trapping `SIGTERM` was still unresolved after 4,007 ms with a 500 ms timeout; the child survived the engine call and had to be killed manually. Status: **open**, planned for S4.

## 2. Plugins are code, not configuration

- Plugins are imported dynamically in the engine process (`import(pathToFileURL(...))`) and run with full Node privileges: filesystem, network, environment, child processes.
- **There is no sandbox.** Repo-local plugin folders configured through `pluginsDir` execute arbitrary code from that repository.
- Any repository that can add a plugin file is therefore equivalent to a build script running in your CI.

This matters most for pull requests from forks. The engine does not currently refuse repo-local plugins in CI. If your workflow runs DeepDiagnose on untrusted pull requests with secrets in the environment, assume those secrets are reachable by the PR's plugin code.

### Node permission model — measured, not assumed

Node 24's permission model was tested in this workspace (EXECUTED):

| Operation | Result under `--permission --allow-fs-read=…` |
|---|---|
| Write a file | `ERR_ACCESS_DENIED` |
| Read outside the allowed path | `ERR_ACCESS_DENIED` |
| Spawn a child process | `ERR_ACCESS_DENIED` |
| Open a network connection | **ALLOWED** |

There is no `--allow-net` flag; the permission model does not restrict network egress. DeepDiagnose does not use the permission model today, and it must not be described as network-isolated.

## 3. Data the engine produces

| Output | Content | Risk |
|---|---|---|
| `diagnostic-report.json` | check names, commands, exit codes, messages, last 6 kB of tool output per failed check, findings, blocker ledger summary | Tool output can contain file paths, code snippets, test data, occasionally secrets printed by tools |
| `artifacts/<plugin>/junit.xml` | failure bodies up to 4,000 characters, including stack traces | Same |
| `artifacts/<plugin>/*.json` | raw ESLint / Ruff / Clippy / PHPStan / RuboCop / golangci output | Source excerpts and paths |
| `blockers.json`, `UNRESOLVED.md` | skip reasons, toolchain names, history | Low |
| `.deepdiagnose/flaky-history.json` | test ids and outcomes per run | Reveals test names and failure patterns |
| `.deepdiagnose/ai-cache.json` | model categories/suggestions keyed by failure hash | May embed failure text indirectly |

Artifacts are ordinary files. They are not encrypted, not access-controlled and not automatically safe to publish; CI uploads them as build artifacts in the provided template.

## 4. Network behavior

The runtime is network-silent **except** for AI triage.

- Trigger: `--ai-explain` **and** `OPENAI_API_KEY` set.
- Destination: `${DEEPDIAGNOSE_AI_BASE_URL:-https://api.openai.com/v1}/chat/completions`.
- Model: `${DEEPDIAGNOSE_AI_MODEL:-gpt-4o-mini}`.
- Timeout: 25 s via `AbortController`.
- Payload: up to 12 failures, each with `id`, `plugin`, `check`, `command`, `exitCode`, `excerpt` (truncated tool output), plus the system prompt.
- Not sent: environment variables, source files as a whole, file contents beyond what tool output already contained.
- Credentials: `OPENAI_API_KEY` is read from the environment and sent as a bearer token. It is not written to disk by the engine.

### Data exposure (S5)

The excerpt is raw tool output. If a failing tool printed a token, connection string or customer data, that text is transmitted to the configured endpoint. There is **no redaction** and **no blocking** at this baseline.

The cache has a second issue: entries are keyed by plugin/check/excerpt/command only — not by model or prompt version — and a cached `category` is merged over the rule-based category. Changing `DEEPDIAGNOSE_AI_MODEL` therefore reuses another model's verdicts.

Status: **open**, planned for S5.

Recommended operator mitigations until then: enable `--ai-explain` only where logs are already permitted to leave the network; point `DEEPDIAGNOSE_AI_BASE_URL` at a self-hosted, OpenAI-compatible endpoint; keep secrets out of tool output.

## 5. CI guidance

- **Trusted branches:** the full engine is appropriate; runner secrets are visible to the tools it invokes.
- **Fork PRs:** assume repo-controlled plugins, test code and build scripts execute. Do not expose deployment credentials to such jobs. Prefer a separate, secret-free workflow for untrusted PRs.
- The shipped template uses `permissions: contents: read` and uploads `artifacts/` with `if: always()`. It does not pin actions by SHA and does not isolate forks beyond GitHub's default token behavior.
- `--fix` mutates the workspace (dependency install, formatting, nextest profile). Do not enable it on untrusted checkouts.

## 6. Confirmed protections vs missing protections

**Present:**
- No shell interpolation for plugin commands (except the two quoted Apple pipelines).
- Per-command timeout and output truncation.
- Gate prevents language tools from running on a failed foundation.
- Credentials are not persisted by the engine.
- AI call is opt-in and requires a key.

**Missing:**
- No plugin sandbox or privilege separation.
- No process-group kill / `SIGKILL` escalation (S4).
- No secret redaction before transmission (S5).
- No schema/automation to mark artifacts as sensitive.
- No refusal of repo-local plugins in untrusted CI.
- No network isolation; Node does not provide it via permissions.

## 7. Recommended priorities

1. **S4:** kill the process tree (POSIX process group, `taskkill /T` on Windows) and settle on the grace deadline.
2. **S5:** allowlist the outbound payload, redact credential-shaped strings, block on uncertainty, include model + prompt version in the cache key.
3. **S3:** fail closed on a corrupt blocker ledger instead of resetting history.
4. Trust policy for repo-local plugins in CI, documented and enforced by an explicit config flag.
