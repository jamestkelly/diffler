import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  checkCloudReadiness,
  type CloudCheckOptions,
  type RunGcloud,
  runGcloud,
} from "../src/cloud-readiness.js";

const manifestSchema = z.object({
  environments: z.array(
    z
      .object({
        name: z.string().min(1),
        projectId: z.string().min(1),
        projectNumber: z.string().regex(/^\d+$/),
        requiredApis: z.array(z.string().min(1)).min(1),
      })
      .passthrough(),
  ),
});

function parseArgs(args: readonly string[]): CloudCheckOptions {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const credentialsPaths: Record<string, string> = {};
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const flag = normalizedArgs[index];
    const path = normalizedArgs[index + 1];
    if (
      path === undefined ||
      (flag !== "--test-credentials" && flag !== "--production-credentials")
    ) {
      throw new Error(
        "Usage: pnpm cloud:check [--test-credentials <path>] [--production-credentials <path>]",
      );
    }
    credentialsPaths[flag === "--test-credentials" ? "test" : "production"] =
      resolve(path);
  }
  return Object.keys(credentialsPaths).length === 0 ? {} : { credentialsPaths };
}

export function run(
  args: readonly string[],
  execute: RunGcloud = runGcloud,
  write: (message: string) => void = console.log,
  writeError: (message: string) => void = console.error,
): number {
  try {
    const manifest = manifestSchema.parse(
      JSON.parse(
        readFileSync(
          new URL("../config/google-cloud-projects.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    const results = checkCloudReadiness(
      manifest.environments,
      parseArgs(args),
      execute,
    );
    for (const result of results) {
      const environment =
        result.environment === undefined ? "" : ` [${result.environment}]`;
      write(`[${result.status.toUpperCase()}]${environment} ${result.message}`);
    }
    return results.some((result) => result.status === "fail") ? 1 : 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : "Cloud check failed");
    return 1;
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = run(process.argv.slice(2));
}
