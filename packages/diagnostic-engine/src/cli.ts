#!/usr/bin/env node
import { Command } from "commander";
import { describeInit, initProject } from "./commands/init.js";
import { runDiagnose } from "./core/engine.js";
import { ENGINE_VERSION } from "./core/version.js";

const program = new Command();

program
  .name("deepdiagnose")
  .description(
    "Universal diagnostic engine: detects ecosystems, runs Angel Armor first, then the right tools",
  )
  .version(ENGINE_VERSION);

program
  .command("init")
  .description("create diagnose.config.json and add the diagnose script to package.json")
  .option("--dir <path>", "project directory to initialize", ".")
  .option("--force", "overwrite an existing diagnose.config.json", false)
  .option(
    "--armor-scripts <list>",
    "comma-separated Angel Armor scripts (default: check:armor,check:editions,check:export)",
    (value: string) => value.split(",").map((script) => script.trim()).filter(Boolean),
  )
  .option("--script <command>", 'value for the "diagnose" script', "deepdiagnose")
  .action(
    async (options: {
      dir: string;
      force: boolean;
      armorScripts?: string[];
      script: string;
    }) => {
      const result = await initProject({
        cwd: options.dir,
        force: options.force,
        armorScripts: options.armorScripts,
        scriptValue: options.script,
      });

      console.log("");
      console.log(describeInit(result).join("\n"));
      console.log("");
    },
  );

program
  .argument("[cassette]", "optional cassette name (same as --cassette)")
  .option("--cassette <name>", "diagnose a single cassette instead of the whole repo")
  .option("--fix", "apply simple fixes only (install missing deps, format)", false)
  .option("--json <path>", "where to write diagnostic-report.json")
  .option("--no-gate", "run language plugins even when Angel Armor fails")
  .option("--no-two-pass", "run only Pass 1 (syntax & structure), skip the logic & debt sweep")
  .option("--no-flaky", "skip the flaky-test signal")
  .option("--no-impact", "skip test-impact selection")
  .option(
    "--ai-explain",
    "classify failures and, with OPENAI_API_KEY set, ask a model for root causes",
    false,
  )
  .option("--quiet", "write the report without printing the summary", false)
  .action(
    async (
      cassetteArg: string | undefined,
      options: {
        cassette?: string;
        fix?: boolean;
        json?: string;
        gate?: boolean;
        twoPass?: boolean;
        flaky?: boolean;
        impact?: boolean;
        aiExplain?: boolean;
        quiet?: boolean;
      },
    ) => {
      const outcome = await runDiagnose({
        cassette: options.cassette ?? cassetteArg,
        fix: options.fix,
        reportPath: options.json,
        gate: options.gate,
        twoPass: options.twoPass,
        flaky: options.flaky,
        impact: options.impact,
        aiExplain: options.aiExplain,
        quiet: options.quiet,
      });

      process.exitCode = outcome.exitCode;
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n✖ deepdiagnose failed\n${message}\n`);
  process.exitCode = 2;
});
