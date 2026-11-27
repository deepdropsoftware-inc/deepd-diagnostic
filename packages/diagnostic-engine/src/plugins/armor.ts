import path from "node:path";
import { runScript, skipped } from "../core/checks.js";
import { armorPackageDirs, armorScripts } from "../core/config.js";
import type { Artifacts, CheckResult, Plugin, RunContext } from "../core/types.js";

/**
 * THE FOUNDATION. Enterprise classification and drop-locations live in these scripts.
 * The engine runs this plugin before every language plugin and gates the rest on it.
 *
 * Script names and the folders that own them come from diagnose.config.json
 * (`armor.scripts` / `armor.packageDirs`), so this is not tied to one repo layout.
 */
function candidateDirs(ctx: RunContext): string[] {
  const configured = armorPackageDirs(ctx.config)
    .map((dir) => path.resolve(ctx.repoRoot, dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);

  return [ctx.target, ctx.repoRoot, ...configured];
}

/** First folder that defines `script` in its package.json. */
async function findOwner(ctx: RunContext, script: string): Promise<string | null> {
  for (const dir of candidateDirs(ctx)) {
    const scripts = await ctx.packageScripts(dir);
    if (scripts[script]) return dir;
  }
  return null;
}

const armorPlugin: Plugin = {
  id: "armor",
  label: "Angel Armor",
  base: true,

  // Mandatory: runs before every language plugin, on every target.
  detect() {
    return true;
  },

  async run(ctx, artifacts: Artifacts): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    const scripts = armorScripts(ctx.config);

    for (const script of scripts) {
      const owner = await findOwner(ctx, script);
      if (!owner) {
        checks.push(
          skipped(
            script,
            `script not defined in the target, the repo root, or ${armorPackageDirs(ctx.config).join(", ")}`,
          ),
        );
        continue;
      }

      checks.push(await runScript(ctx, script, owner));
    }

    const ran = checks.filter((check) => check.status !== "skipped").length;
    if (ran === 0) {
      ctx.log(
        "   armor: no Angel Armor scripts found — add them in diagnose.config.json (armor.scripts) once packages/angel-armor is installed",
      );
    }

    await artifacts.ensure();
    return checks;
  },
};

export default armorPlugin;
