import { runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin } from "../core/types.js";

const DOTNET_TARGETS = ["*.sln", "*.csproj", "*.fsproj", "*.vbproj"];

const dotnetPlugin: Plugin = {
  id: "dotnet",
  label: "C# / .NET",

  async detect(ctx) {
    return (await ctx.find(DOTNET_TARGETS, { maxDepth: 3 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const dotnet = await ctx.which("dotnet");
    if (!dotnet) {
      return [skipped("dotnet", "dotnet SDK is not installed")];
    }

    const checks: CheckResult[] = [
      await runStep(ctx, "dotnet build", dotnet, ["build", "--nologo", "-v", "quiet"]),
    ];

    // JunitXml.TestLogger writes the report; without the package dotnet errors out.
    const logger = `junit;LogFilePath=${artifacts.junitPath};FailureBodyFormat=Verbose`;
    const tested = await runStep(ctx, "dotnet test", dotnet, [
      "test",
      "--nologo",
      "-v",
      "quiet",
      "--logger",
      logger,
    ]);

    const loggerMissing =
      tested.status === "failed" &&
      /logger|TestLogger/i.test(tested.output ?? "") &&
      /not (found|recognized)|could not be found|No test logger/i.test(tested.output ?? "");

    if (loggerMissing) {
      // Retry without the logger so test failures still surface; JUnit is synthesized.
      checks.push(
        await runStep(ctx, "dotnet test (no junit logger)", dotnet, [
          "test",
          "--nologo",
          "-v",
          "quiet",
        ]),
      );
      checks.push(
        skipped(
          "junit logger",
          "add JunitXml.TestLogger to the test project for native JUnit output",
        ),
      );
    } else {
      checks.push(tested);
    }

    return checks;
  },
};

export default dotnetPlugin;
