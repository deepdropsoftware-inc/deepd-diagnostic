import path from "node:path";
import { runCapturedJson, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin } from "../core/types.js";

/**
 * Rust toolchain. cargo fmt/clippy give machine output; tests get native JUnit
 * from cargo-nextest when a junit profile is configured.
 */
const rustPlugin: Plugin = {
  id: "rust",
  label: "Rust",

  async detect(ctx) {
    return await ctx.exists("Cargo.toml");
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const cargo = await ctx.which("cargo");
    if (!cargo) {
      return [skipped("cargo", "cargo is not installed")];
    }

    const checks: CheckResult[] = [];

    checks.push(await runStep(ctx, "cargo fmt --check", cargo, ["fmt", "--all", "--", "--check"]));

    // Clippy: JSON diagnostics, warnings promoted to errors (CI stance).
    checks.push(
      await runCapturedJson(
        ctx,
        "cargo clippy",
        cargo,
        ["clippy", "--all-targets", "--message-format=json", "--", "-D", "warnings"],
        artifacts,
        "clippy.json",
      ),
    );

    // Tests: nextest can write JUnit, plain cargo test cannot.
    const nextestProbe = await ctx.exec(cargo, ["nextest", "--version"], ctx.target);
    if (nextestProbe.code === 0) {
      const config = await ctx.read(".config/nextest.toml");
      const profile = config?.includes("[profile.ci") ? "ci" : "default";
      const run = await runStep(ctx, `cargo nextest (${profile})`, cargo, [
        "nextest",
        "run",
        "--profile",
        profile,
        "--no-fail-fast",
      ]);
      checks.push(run);

      const native = await ctx.find(["junit.xml"], {
        dir: path.join(ctx.target, "target", "nextest"),
        maxDepth: 3,
      });

      if (native.length > 0) {
        await artifacts.mergeJUnit(native);
      } else {
        checks.push(
          skipped(
            "nextest junit",
            `add [profile.${profile}.junit] path = "junit.xml" to .config/nextest.toml for native JUnit`,
          ),
        );
      }
    } else {
      checks.push(await runStep(ctx, "cargo test", cargo, ["test", "--all-targets"]));
    }

    return checks;
  },
};

export default rustPlugin;
