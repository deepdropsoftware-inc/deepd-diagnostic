import path from "node:path";
import { runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin, RunContext } from "../core/types.js";

const APPLE_TARGETS = ["*.xcodeproj", "*.xcworkspace", "Package.swift"];

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

interface XcodeList {
  project?: { schemes?: string[] };
  workspace?: { schemes?: string[] };
}

async function readSchemes(
  ctx: RunContext,
  xcodebuild: string,
  flag: string,
  container: string,
): Promise<string[]> {
  const list = await ctx.exec(xcodebuild, [flag, container, "-list", "-json"], path.dirname(container));
  if (list.code !== 0) return [];
  try {
    const parsed = JSON.parse(list.stdout) as XcodeList;
    return parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
  } catch {
    return [];
  }
}

const applePlugin: Plugin = {
  id: "apple",
  label: "Apple / Xcode",

  async detect(ctx) {
    return (await ctx.find(APPLE_TARGETS, { maxDepth: 3 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const found = await ctx.find(APPLE_TARGETS, { maxDepth: 3 });

    if (process.platform !== "darwin") {
      return [skipped("xcodebuild", "requires macOS with Xcode installed")];
    }

    const xcodebuild = await ctx.which("xcodebuild");
    if (!xcodebuild) {
      return [skipped("xcodebuild", "xcodebuild not found on PATH")];
    }

    const xcbeautify = await ctx.which("xcbeautify");
    const workspace = found.find((entry) => entry.endsWith(".xcworkspace"));
    const project = found.find((entry) => entry.endsWith(".xcodeproj"));
    const container = workspace ?? project;
    const checks: CheckResult[] = [];

    if (!container) {
      // SwiftPM only: swift test output can also be piped through xcbeautify.
      const swift = await ctx.which("swift");
      if (!swift) return [skipped("swift test", "Package.swift found but swift is not on PATH")];
      if (!xcbeautify) {
        return [skipped("swift test", "xcbeautify is not installed (brew install xcbeautify)")];
      }

      checks.push(
        await runStep(
          ctx,
          "swift test",
          "/bin/sh",
          [
            "-c",
            `set -o pipefail; ${shellQuote(swift)} test 2>&1 | ${shellQuote(xcbeautify)} --report junit --report-path ${shellQuote(artifacts.dir)}`,
          ],
        ),
      );
      return checks;
    }

    const flag = workspace ? "-workspace" : "-project";
    const structure = await runStep(
      ctx,
      "xcodebuild -list",
      xcodebuild,
      [flag, container, "-list", "-json"],
      path.dirname(container),
    );
    checks.push(structure);

    const schemes = await readSchemes(ctx, xcodebuild, flag, container);
    const scheme = schemes[0];
    const destination = process.env.DIAGNOSE_XCODE_DESTINATION ?? "platform=macOS";

    if (!scheme) {
      checks.push(skipped("xcodebuild test", "no shared scheme found in the project"));
      return checks;
    }
    if (!xcbeautify) {
      checks.push(
        skipped("xcodebuild test", "xcbeautify is not installed (brew install xcbeautify)"),
      );
      return checks;
    }

    // xcodebuild has no JUnit reporter; xcbeautify writes junit.xml from its output.
    const pipeline = [
      "set -o pipefail;",
      shellQuote(xcodebuild),
      "test",
      flag,
      shellQuote(container),
      "-scheme",
      shellQuote(scheme),
      "-destination",
      shellQuote(destination),
      "2>&1 |",
      shellQuote(xcbeautify),
      "--report junit --report-path",
      shellQuote(artifacts.dir),
    ].join(" ");

    checks.push(
      await runStep(ctx, "xcodebuild test", "/bin/sh", ["-c", pipeline], path.dirname(container)),
    );

    return checks;
  },
};

export default applePlugin;
