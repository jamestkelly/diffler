#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { collectDiffContext, DiffContextError } from "./diff-context.js";

export const HELP_TEXT = `Diffler

Generate comprehension quizzes from Git branch diffs.

Usage:
  diffler --help
  diffler context [--base <ref>] [--output <path>]
                  [--max-bytes <bytes>] [--chunk-bytes <bytes>]
                  [--exclude <path>]...
`;

type WriteOutput = (message: string) => void;

export function run(
  args: readonly string[],
  write: WriteOutput = console.log,
  writeError: WriteOutput = console.error,
  cwd: string = process.cwd(),
): number {
  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    (args[0] === "context" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h"))
  ) {
    write(HELP_TEXT);
    return 0;
  }

  if (args[0] !== "context") {
    writeError(`Unknown command: ${args[0]}`);
    return 1;
  }

  try {
    const options = parseContextArgs(args.slice(1));
    const context = collectDiffContext({
      cwd,
      ...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
      excludePaths: options.excludePaths,
      ...(options.maxPatchBytes === undefined
        ? {}
        : { maxPatchBytes: options.maxPatchBytes }),
      ...(options.maxChunkBytes === undefined
        ? {}
        : { maxChunkBytes: options.maxChunkBytes }),
    });
    const outputPath = resolve(cwd, options.outputPath);
    writePrivateFile(cwd, outputPath, `${JSON.stringify(context, null, 2)}\n`);
    write(`Wrote diff context to ${options.outputPath}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeError(message);
    return 1;
  }
}

interface ContextCliOptions {
  baseRef?: string;
  outputPath: string;
  excludePaths: string[];
  maxPatchBytes?: number;
  maxChunkBytes?: number;
}

function parseContextArgs(args: readonly string[]): ContextCliOptions {
  const options: ContextCliOptions = {
    outputPath: ".diffler/context.json",
    excludePaths: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (
      argument !== "--base" &&
      argument !== "--output" &&
      argument !== "--exclude" &&
      argument !== "--max-bytes" &&
      argument !== "--chunk-bytes"
    ) {
      throw new DiffContextError(`Unknown context argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new DiffContextError(`Missing value for ${argument ?? "argument"}`);
    }

    switch (argument) {
      case "--base":
        options.baseRef = value;
        break;
      case "--output":
        options.outputPath = value;
        break;
      case "--exclude":
        options.excludePaths.push(value);
        break;
      case "--max-bytes":
        options.maxPatchBytes = parseInteger(value, argument);
        break;
      case "--chunk-bytes":
        options.maxChunkBytes = parseInteger(value, argument);
        break;
    }
    index += 1;
  }

  return options;
}

function parseInteger(value: string, argument: string): number {
  if (!/^\d+$/.test(value)) {
    throw new DiffContextError(`${argument} must be a positive integer`);
  }
  return Number(value);
}

function writePrivateFile(
  cwd: string,
  outputPath: string,
  contents: string,
): void {
  const relativeOutput = relative(resolve(cwd), outputPath);
  if (
    relativeOutput === ".." ||
    relativeOutput.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutput)
  ) {
    throw new DiffContextError(
      "Output path must remain inside the working directory",
    );
  }

  const realCwd = realpathSync(cwd);
  const realOutput = resolve(realCwd, relativeOutput);
  let currentDirectory = realCwd;
  const relativeDirectory = dirname(relativeOutput);

  if (relativeDirectory !== ".") {
    for (const segment of relativeDirectory.split(sep)) {
      currentDirectory = join(currentDirectory, segment);
      try {
        const status = lstatSync(currentDirectory);
        if (status.isSymbolicLink() || !status.isDirectory()) {
          throw new DiffContextError(
            `Unsafe output directory: ${currentDirectory}`,
          );
        }
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        mkdirSync(currentDirectory, { mode: 0o700 });
      }
    }
  }

  try {
    const status = lstatSync(realOutput);
    if (!status.isFile() || status.isSymbolicLink() || status.nlink > 1) {
      throw new DiffContextError(`Unsafe output file: ${outputPath}`);
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const descriptor = openSync(
    realOutput,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents);
  } finally {
    closeSync(descriptor);
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  process.exitCode = run(process.argv.slice(2));
}
