#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const HELP_TEXT = `Diffler

Generate comprehension quizzes from Git branch diffs.

Usage:
  diffler --help
`;

type WriteOutput = (message: string) => void;

export function run(
  args: readonly string[],
  write: WriteOutput = console.log,
): number {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    write(HELP_TEXT);
    return 0;
  }

  write(`Unknown argument: ${args[0]}`);
  return 1;
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = run(process.argv.slice(2));
}
