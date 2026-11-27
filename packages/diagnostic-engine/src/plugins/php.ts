import path from "node:path";
import { runCapturedJson, runStep, skipped } from "../core/checks.js";
import type { Artifacts, CheckResult, Plugin } from "../core/types.js";

const PHP_MARKERS = ["composer.json", "phpunit.xml", "phpunit.xml.dist", "artisan", "composer.lock"];

const phpPlugin: Plugin = {
  id: "php",
  label: "PHP",

  async detect(ctx) {
    for (const marker of PHP_MARKERS) {
      if (await ctx.exists(marker)) return true;
    }
    return (await ctx.find(["*.php"], { maxDepth: 2 })).length > 0;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const php = await ctx.which("php");
    if (!php) {
      return [skipped("php", "php is not installed")];
    }

    const checks: CheckResult[] = [];
    const phpunit = (await ctx.exists("vendor/bin/phpunit"))
      ? path.join(ctx.target, "vendor", "bin", "phpunit")
      : null;

    // Tests — PHPUnit writes JUnit with --log-junit.
    if (phpunit) {
      checks.push(
        await runStep(ctx, "phpunit", php, [phpunit, "--log-junit", artifacts.junitPath]),
      );
    } else {
      checks.push(skipped("phpunit", "vendor/bin/phpunit not found (composer install)"));
    }

    // Static analysis — PHPStan prints JSON on stdout.
    const phpstan = (await ctx.exists("vendor/bin/phpstan"))
      ? path.join(ctx.target, "vendor", "bin", "phpstan")
      : null;

    if (phpstan) {
      checks.push(
        await runCapturedJson(
          ctx,
          "phpstan",
          php,
          [phpstan, "analyse", "--error-format=json", "--no-progress"],
          artifacts,
          "phpstan.json",
        ),
      );
    } else {
      checks.push(skipped("phpstan", "vendor/bin/phpstan not found (composer install)"));
    }

    return checks;
  },
};

export default phpPlugin;
