# DeepDrop

The DeepDrop monorepo. One package today, built so the next ones can slot in.

## Packages

| Package | Role |
| --- | --- |
| [`@deepdrop/diagnose`](packages/diagnostic-engine) | Universal diagnostic engine. Auto-detects ecosystems, runs the mandatory Angel Armor gate, routes work to the right tools, and writes one report. |

## What the engine does

```
PASS 1 · Syntax & Structure   Angel Armor gate → per-ecosystem plugins → artifacts/<plugin>/junit.xml
PASS 2 · Logic & Debt         cross-file reference graph → blocker triage → safe automation
SIGNALS                       flaky detection · test impact · failure triage (read-only)
                              ↓
diagnostic-report.json + UNRESOLVED.md + artifacts/
```

Nine ecosystems are covered out of the box (Node, Go, Python, Rust, Apple, Android,
.NET, Ruby, PHP), with a stable plugin contract for anything else. Blockers live in a
ledger (`blockers.json` / `UNRESOLVED.md`) that opens itself, closes itself when the
owning plugin actually runs green, and re-opens on regression.

## Quick start

```bash
git clone <this repo>
cd packages/diagnostic-engine
npm install
npm run build

node dist/cli.js init     # writes diagnose.config.json
node dist/cli.js          # diagnose the repo
```

Requires Node 18.18 or newer.

## Development

```bash
cd packages/diagnostic-engine
npm run typecheck
npm test
npm run build

# the engine gates this repository: Armor maps to the three checks above
cd ../.. && node packages/diagnostic-engine/dist/cli.js
```

CI runs typecheck, tests and build on Node 20, 22 and 24, then the engine against
this repo on 24.

## License

MIT — see [LICENSE](LICENSE).
