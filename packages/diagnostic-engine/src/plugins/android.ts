import path from "node:path";
import { notApplicable, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin, RunContext } from "../core/types.js";

/**
 * Android / Kotlin / Java cassette.
 *
 * ROOTED TO ANGEL ARMOR: this plugin is not self-starting. The engine runs the
 * `armor` base plugin first and only calls `run()` below when the foundation passes;
 * if `check:armor`, `check:editions` or `check:export` fail, this plugin's report
 * entry is marked `blocked` and no Gradle task is executed (see core/runner.ts).
 *
 * Machine output:
 *   - Gradle writes JUnit XML itself under <module>/build/test-results/<task>/*.xml
 *   - Maven writes JUnit XML under <module>/target/surefire-reports/*.xml
 *   - Android lint writes build/reports/lint-results-*.xml
 * Those native reports are merged into artifacts/android/junit.xml.
 */
const GRADLE_MARKERS = [
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradlew",
];

const MAVEN_MARKERS = ["pom.xml"];

async function isAndroidProject(ctx: RunContext): Promise<boolean> {
  if ((await ctx.find(["AndroidManifest.xml"], { maxDepth: 4 })).length > 0) return true;

  const gradle =
    (await ctx.read("build.gradle")) ?? (await ctx.read("build.gradle.kts")) ?? "";
  return /com\.android\.(application|library)|^\s*android\s*\{/m.test(gradle);
}

/** Gradle and Maven both write JUnit XML themselves, just not into our folder. */
async function collectJUnit(ctx: RunContext): Promise<string[]> {
  const files: string[] = [];

  for (const buildDir of await ctx.find(["build"], { maxDepth: 3 })) {
    files.push(
      ...(await ctx.find(["*.xml"], { dir: path.join(buildDir, "test-results"), maxDepth: 4 })),
    );
  }

  for (const targetDir of await ctx.find(["target"], { maxDepth: 3 })) {
    files.push(
      ...(await ctx.find(["*.xml"], {
        dir: path.join(targetDir, "surefire-reports"),
        maxDepth: 2,
      })),
    );
  }

  return files;
}

async function collectLintReports(ctx: RunContext): Promise<string[]> {
  const files: string[] = [];

  for (const buildDir of await ctx.find(["build"], { maxDepth: 3 })) {
    files.push(
      ...(await ctx.find(["lint-results*.xml"], {
        dir: path.join(buildDir, "reports"),
        maxDepth: 2,
      })),
    );
  }

  return files;
}

const androidPlugin: Plugin = {
  id: "android",
  label: "Android / Kotlin / Java",

  async detect(ctx) {
    for (const marker of [...GRADLE_MARKERS, ...MAVEN_MARKERS]) {
      if (await ctx.exists(marker)) return true;
    }
    if ((await ctx.find(["AndroidManifest.xml"], { maxDepth: 4 })).length > 0) return true;
    return (await ctx.find(["*.kt", "*.java"], { maxDepth: 2 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];

    if (await ctx.exists("pom.xml")) {
      const mvn = await ctx.which("mvn");
      if (!mvn) return [skipped("mvn", "mvn is not installed")];

      checks.push(await runStep(ctx, "mvn test", mvn, ["-B", "-q", "test"]));
      const reports = await collectJUnit(ctx);
      if (reports.length > 0) await artifacts.mergeJUnit(reports);
      else checks.push(skipped("surefire junit", "no target/surefire-reports/*.xml found"));

      return checks;
    }

    const gradle = (await ctx.exists("gradlew"))
      ? path.join(ctx.target, "gradlew")
      : await ctx.which("gradle");

    if (!gradle) {
      return [skipped("gradle", "no ./gradlew wrapper and gradle is not on PATH")];
    }

    const android = await isAndroidProject(ctx);
    const testTask = android ? "testDebugUnitTest" : "test";

    checks.push(await runStep(ctx, testTask, gradle, [testTask, "--continue", "--console=plain"]));

    const reports = await collectJUnit(ctx);
    if (reports.length > 0) {
      await artifacts.mergeJUnit(reports);
    } else {
      checks.push(
        skipped("gradle junit", `no build/test-results/${testTask}/*.xml produced`),
      );
    }

    if (android) {
      checks.push(await runStep(ctx, "lint", gradle, ["lint", "--continue", "--console=plain"]));
      const lintReports = await collectLintReports(ctx);
      if (lintReports.length > 0) {
        await artifacts.adopt(lintReports[0] as string, "lint.xml");
      }
    } else {
      checks.push(notApplicable("lint", "Android-only task"));
    }

    return checks;
  },
};

export default androidPlugin;
