import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs.js";
import { buildJUnitDocument, extractSuites, junitFromChecks } from "./junit.js";
import type { Artifacts, PluginArtifactPaths, PluginResult } from "./types.js";

export function artifactPathsFor(artifactsRoot: string, pluginId: string): PluginArtifactPaths {
  const dir = path.join(artifactsRoot, pluginId);
  return { dir, junit: path.join(dir, "junit.xml"), json: path.join(dir, "report.json") };
}

export function createArtifacts(artifactsRoot: string, pluginId: string): Artifacts {
  const paths = artifactPathsFor(artifactsRoot, pluginId);

  const ensure = async () => {
    await mkdir(paths.dir, { recursive: true });
  };

  const artifacts: Artifacts = {
    dir: paths.dir,
    junitPath: paths.junit,
    jsonPath: paths.json,
    ensure,
    clear: async () => {
      await rm(paths.dir, { recursive: true, force: true });
      await ensure();
    },
    remove: async () => {
      await rm(paths.dir, { recursive: true, force: true });
    },
    writeFile: async (name, content) => {
      await ensure();
      const target = path.join(paths.dir, name);
      await writeFile(target, content, "utf8");
      return target;
    },
    writeJson: async (name, data) => {
      return artifacts.writeFile(name, `${JSON.stringify(data, null, 2)}\n`);
    },
    adopt: async (source, name) => {
      if (!(await pathExists(source))) return null;
      await ensure();
      const target = path.join(paths.dir, name ?? path.basename(source));
      await copyFile(source, target);
      return target;
    },
    mergeJUnit: async (sources) => {
      const blocks: string[] = [];

      if (await pathExists(paths.junit)) {
        const existing = extractSuites(await readFile(paths.junit, "utf8"));
        if (existing) blocks.push(existing);
      }

      const merged: string[] = [];
      for (const source of sources) {
        if (!(await pathExists(source))) continue;
        const block = extractSuites(await readFile(source, "utf8"));
        if (!block) continue;
        blocks.push(block);
        merged.push(source);
      }

      if (merged.length > 0) {
        await artifacts.writeFile("junit.xml", buildJUnitDocument(pluginId, blocks));
      }

      return merged;
    },
  };

  return artifacts;
}

/**
 * Guarantee the contract: after a plugin runs, artifacts/<id>/junit.xml and
 * artifacts/<id>/report.json always exist, even if the tool had no XML reporter.
 */
export async function finalizeArtifacts(
  artifacts: Artifacts,
  result: PluginResult,
): Promise<PluginArtifactPaths> {
  await artifacts.ensure();

  if (!(await pathExists(artifacts.junitPath))) {
    await artifacts.writeFile(
      "junit.xml",
      junitFromChecks(result.id, result.checks, result.durationMs),
    );
  }

  const paths = artifactPathsFor(path.dirname(artifacts.dir), path.basename(artifacts.dir));

  await artifacts.writeJson("report.json", {
    plugin: result.id,
    label: result.label,
    base: result.base,
    blocked: result.blocked ?? false,
    status: result.status,
    generatedAt: new Date().toISOString(),
    durationMs: result.durationMs,
    junit: "junit.xml",
    checks: result.checks.map((check) => ({
      name: check.name,
      status: check.status,
      command: check.command,
      exitCode: check.exitCode,
      durationMs: check.durationMs,
      message: check.message,
    })),
  });

  return paths;
}

/** artifacts/junit.xml — every plugin's suites in one file for CI test reporters. */
export async function writeAggregateJUnit(
  artifactsRoot: string,
  results: PluginResult[],
): Promise<string | null> {
  const blocks: string[] = [];

  for (const result of results) {
    if (!result.artifacts) continue;
    if (!(await pathExists(result.artifacts.junit))) continue;
    const block = extractSuites(await readFile(result.artifacts.junit, "utf8"));
    if (block) blocks.push(block);
  }

  if (blocks.length === 0) return null;

  await mkdir(artifactsRoot, { recursive: true });
  const target = path.join(artifactsRoot, "junit.xml");
  await writeFile(target, buildJUnitDocument("diagnostic-engine", blocks), "utf8");
  return target;
}
