# Ecosystem support

**Baseline:** commit `0313c5b` · evidence classes: EXECUTED · TESTED · SOURCE-VERIFIED · UNTESTED.

Detection is not language support. This engine detects ecosystems, executes their tools and normalizes results. It performs its own code analysis only for JavaScript/TypeScript (imports, symbols, tsconfig aliases) and a narrow Python relative-import existence check.

## Capability tiers

| Tier | Meaning |
|---|---|
| **T0** | Ecosystem detection from marker files |
| **T1** | Execution of the ecosystem's own tools |
| **T2** | Normalized machine-readable output (native JUnit/JSON, or synthesized JUnit) |
| **T3** | Engine-side static analysis of source code |
| **T4** | Dependency / impact graph participation |
| **T5** | Repair or automation |

## Matrix

| Ecosystem | T0 detect | T1 tools executed | T2 native output | T3 engine analysis | T4 graph | T5 automation | Verified here |
|---|---|---|---|---|---|---|---|
| Node / TypeScript | `package.json`, `tsconfig.json`, ESLint/Vitest configs | `typecheck` script or `tsc --noEmit`, `eslint`, `vitest` (or `npm test`) | Vitest JUnit; ESLint JSON; synthesized JUnit for tsc | **Yes** — imports, symbols, aliases | **Yes** | `prettier --write`, `eslint --fix` (engine-level `--fix` also installs npm deps) | **UNVERIFIED** — plugin not executed here |
| Go | `go.mod`, `go.work`, `*.go` (depth 1) | `go build`, `go vet`, `golangci-lint`, `gotestsum` or `go test` | golangci JUnit + JSON; gotestsum JUnit; synthesized otherwise | No | No | None | UNTESTED (no toolchain) |
| Python | 7 markers incl. `pyproject.toml`, `requirements.txt`; or `*.py` (depth 2) | `python -m pytest`, `ruff`, `mypy` | pytest JUnit; ruff/mypy JSON/JUnit | **Existence only** — relative imports (Pass 2); no symbol or graph analysis | No | None | UNTESTED (no pytest/ruff/mypy) |
| Rust | `Cargo.toml` | `cargo fmt --check`, `cargo clippy`, `cargo nextest run` or `cargo test` | clippy JSON; nextest JUnit when configured; synthesized otherwise | No | No | Writes `[profile.ci.junit]` on `--fix` | UNVERIFIED (no cargo) |
| Apple / Swift | `*.xcodeproj`, `*.xcworkspace`, `Package.swift` (depth 3) | `xcodebuild -list`, `xcodebuild test`, `swift test` (macOS only) | JUnit via `xcbeautify`; synthesized otherwise | No | No | None | UNTESTED (Linux; skipped by design) |
| Android / Kotlin / Java | Gradle/Maven markers, `AndroidManifest.xml`, `*.kt`/`*.java` | `mvn test`, Gradle `test`/`testDebugUnitTest`, `lint` | Gradle/Maven JUnit merged; lint XML adopted | No — Java/Kotlin are not parsed by the engine | No | None | UNTESTED (no JVM) |
| .NET | `*.sln`, `*.csproj`, `*.fsproj`, `*.vbproj` (depth 3) | `dotnet build`, `dotnet test` | JUnit via `JunitXml.TestLogger`, else retry + synthesized | No | No | None | UNTESTED (no SDK) |
| Ruby | `Gemfile`, `Gemfile.lock`, `Rakefile`, `.ruby-version`, `.rspec`, `*.gemspec` | `rubocop`, `rspec`, `rake test` | RuboCop JUnit + JSON; RSpec via `rspec_junit_formatter` | No | No | None | UNTESTED (no ruby) |
| PHP | `composer.json`, `phpunit.xml(.dist)`, `artisan`, `composer.lock`, `*.php` | `phpunit`, `phpstan` | PHPUnit JUnit; PHPStan JSON | No | No | None | UNTESTED (no php) |

"Verified here" means the code path was executed in this Linux workspace at the baseline commit. **No built-in language plugin has been executed**: the repository's self-run targets a root with no `package.json`, so only the `armor` base plugin runs. Every row is therefore SOURCE-VERIFIED, and none may be described as tested.

## Ecosystem details

### Node / TypeScript

- **Detection:** `package.json`, `tsconfig.json`, any ESLint config (flat or legacy), any Vitest config.
- **Types:** prefers the project's `typecheck` script; otherwise `tsc --noEmit -p tsconfig.json`; `notApplicable` when there is no `tsconfig.json`.
- **Lint:** ESLint only when a config file and the binary exist; writes `artifacts/node/eslint.json`. Missing binary is a blocker; missing config is not applicable.
- **Tests:** Vitest with `--reporter=junit --outputFile.junit=…`; if Vitest is declared but not installed, a blocker; if the `test` script uses Vitest, it is run through npm.
- **Engine analysis:** the only full T3/T4 implementation. Relative/root-absolute imports, named-export checks, tsconfig `extends`/`paths`, NodeNext `.js`→`.ts`.
- **Automation:** `--fix` runs Prettier (`--write .`) and ESLint (`--fix`) when configured; `--fix` also installs npm dependencies when `node_modules` is absent and a lockfile exists.

### Go

- `go build ./...` and `go vet ./...` are always run; both are synthesized into JUnit because Go has no machine format for them.
- `golangci-lint` major version is detected (`v2` flags vs `v1`), producing JUnit and JSON.
- `gotestsum` gives native JUnit; otherwise `go test ./...` is synthesized.
- No engine-side code analysis, no graph participation, no repair.

### Python

- `python -m pytest --junitxml=… -q`; a missing pytest module is reported as a blocker, not a failure.
- `ruff check --output-format json` (binary or `-m ruff`), `mypy . --junit-xml=artifacts/python/mypy.junit.xml`.
- **Important:** `mypy.junit.xml` is written inside the plugin folder but is **not merged** into `artifacts/python/junit.xml`, so the flaky signal only sees pytest cases. This is current behavior, not a documented feature.
- Pass 2 checks that relative imports land on a `.py` file or package `__init__.py`. That is not a dependency graph and does not participate in impact selection.

### Rust

- `cargo fmt --all -- --check`; `cargo clippy --all-targets --message-format=json -- -D warnings` (warnings fail); nextest when the subcommand exists, else `cargo test --all-targets`.
- Nextest JUnit is merged only when a JUnit file is produced under `target/nextest`; otherwise a blocker explains the missing profile.
- Pass 2 can add `[profile.ci.junit]` to `.config/nextest.toml` on `--fix`.

### Apple / Swift

- Requires macOS and Xcode; on other platforms the plugin returns a single blocker (skipped).
- `xcodebuild -list -json` is captured; the first shared scheme is tested; `xcbeautify --report junit` produces JUnit.
- Destination defaults to `platform=macOS`, overridable with `DIAGNOSE_XCODE_DESTINATION`.
- No engine-side Swift analysis.

### Android / Kotlin / Java

- Maven projects run `mvn -B -q test` and merge `target/surefire-reports/*.xml`.
- Gradle projects run `test` (or `testDebugUnitTest` when an Android manifest/plugin is detected) and merge `build/test-results/**/*.xml`.
- Android lint reports are adopted as `artifacts/android/lint.xml`.
- Java/Kotlin source is not parsed by the engine; all findings come from the build tools.

### .NET

- `dotnet build`, then `dotnet test` with a JUnit logger.
- If the logger package is missing, the plugin detects the specific error, retries without the logger so real test failures still surface, and records a blocker for native JUnit.

### Ruby

- RuboCop runs only when it appears in `Gemfile.lock` or a gemspec, producing JUnit and JSON.
- RSpec requires `rspec_junit_formatter`; without it RSpec runs and a blocker records the missing JUnit.
- `rake test` is the fallback when RSpec is absent.

### PHP

- `vendor/bin/phpunit --log-junit artifacts/php/junit.xml`; missing binary is a blocker.
- `vendor/bin/phpstan analyse --error-format=json` writes `phpstan.json`; missing binary is a blocker.

## Not supported

The engine has no parser, symbol model or dependency graph for Go, Rust, Python (beyond relative-import existence), Ruby, PHP, C#, Swift, Kotlin, Java, C or C++. C and C++ have no plugin at all. Any claim of "full support" for these ecosystems would be false.
