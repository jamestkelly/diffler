#!/usr/bin/env node

import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { type AuthService, GoogleAuthService } from "./auth.js";
import { collectDiffContext, DiffContextError } from "./diff-context.js";
import { createDoctorService, type DoctorService } from "./doctor.js";
import { publishWithStoredAuth, type QuizPublisher } from "./google-forms.js";
import {
  conductLocalQuiz,
  LocalQuizError,
  QuizCancelledError,
  type QuizPrompt,
  sanitizeQuizDisplayText,
  validateLocalQuizDisplay,
} from "./local-quiz.js";
import { parseQuizDocument, QuizValidationError } from "./quiz.js";
import {
  parseQuizContext,
  validateQuizAgainstContext,
} from "./quiz-context.js";
import {
  type SkillAgent,
  SkillInstallationService,
  type SkillScope,
} from "./skill-installation.js";
import { createTerminalQuizPrompt } from "./terminal-quiz-prompt.js";

export const HELP_TEXT = `Diffler

Generate comprehension quizzes from Git branch diffs.

Usage:
  diffler --help
  diffler auth login [--credentials <path>]
  diffler auth status
  diffler auth logout
  diffler skill install <claude|opencode> --scope <project|user> [--force]
  diffler skill status <claude|opencode> --scope <project|user>
  diffler skill uninstall <claude|opencode> --scope <project|user> [--force]
  diffler doctor
  diffler validate <quiz.json> [--context <context.json>]
  diffler quiz <quiz.json> [--context <context.json>]
  diffler publish <quiz.json> --context <context.json>
  diffler context [--base <ref>] [--output <path>]
                  [--max-bytes <bytes>] [--chunk-bytes <bytes>]
                  [--exclude <path>]...
`;

type WriteOutput = (message: string) => void;

interface SkillService {
  status(): ReturnType<SkillInstallationService["status"]>;
  install(options?: {
    force?: boolean;
  }): ReturnType<SkillInstallationService["install"]>;
  uninstall(options?: {
    force?: boolean;
  }): ReturnType<SkillInstallationService["uninstall"]>;
}

export interface CliServices {
  createSkillService?: (agent: SkillAgent, scope: SkillScope) => SkillService;
  createQuizPrompt?: () => QuizPrompt;
  doctor?: DoctorService;
}

export async function run(
  args: readonly string[],
  write: WriteOutput = console.log,
  writeError: WriteOutput = console.error,
  cwd: string = process.cwd(),
  auth: AuthService = new GoogleAuthService(),
  publisher: QuizPublisher = { publish: publishWithStoredAuth },
  services: CliServices = {},
): Promise<number> {
  if (
    args.length === 0 ||
    args[0] === "--help" ||
    args[0] === "-h" ||
    (args[0] === "context" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h")) ||
    (args[0] === "publish" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h")) ||
    (args[0] === "validate" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h")) ||
    (args[0] === "quiz" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h")) ||
    (args[0] === "skill" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h")) ||
    (args[0] === "doctor" &&
      args.length === 2 &&
      (args[1] === "--help" || args[1] === "-h"))
  ) {
    write(HELP_TEXT);
    return 0;
  }

  if (args[0] === "auth") {
    return runAuth(args.slice(1), auth, write, writeError, cwd);
  }

  if (args[0] === "publish") {
    return runPublish(args.slice(1), publisher, write, writeError, cwd);
  }

  if (args[0] === "validate") {
    return runValidate(args.slice(1), write, writeError, cwd);
  }

  if (args[0] === "quiz") {
    return runQuiz(
      args.slice(1),
      services.createQuizPrompt ?? createTerminalQuizPrompt,
      write,
      writeError,
      cwd,
    );
  }

  if (args[0] === "skill") {
    const createSkillService =
      services.createSkillService ??
      ((agent: SkillAgent, scope: SkillScope) =>
        new SkillInstallationService({ agent, scope, cwd }));
    return runSkill(args.slice(1), createSkillService, write, writeError);
  }

  if (args[0] === "doctor") {
    const doctor =
      services.doctor ?? createDoctorService({ cwd, authService: auth });
    return runDoctor(args.slice(1), doctor, write, writeError);
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

async function runSkill(
  args: readonly string[],
  createService: (agent: SkillAgent, scope: SkillScope) => SkillService,
  write: WriteOutput,
  writeError: WriteOutput,
): Promise<number> {
  try {
    const options = parseSkillArgs(args);
    const service = createService(options.agent, options.scope);

    if (options.operation === "status") {
      const status = await service.status();
      if (status.state === "current") {
        write(
          `Diffler skill is current for ${options.agent} ${options.scope} scope`,
        );
        return 0;
      }
      writeError(skillStatusMessage(status.state, options));
      return 1;
    }

    if (options.operation === "install") {
      const result = await service.install(
        options.force ? { force: true } : {},
      );
      if (result.outcome === "refused") {
        writeError(skillStatusMessage(result.status.state, options));
        return 1;
      }
      write(
        result.outcome === "unchanged"
          ? `Diffler skill is already current for ${options.agent} ${options.scope} scope`
          : `Diffler skill ${result.outcome} for ${options.agent} ${options.scope} scope`,
      );
      write(
        options.agent === "claude"
          ? "If Claude Code does not discover the skill, restart it once"
          : "Restart OpenCode to ensure skill discovery",
      );
      return 0;
    }

    const result = await service.uninstall(
      options.force ? { force: true } : {},
    );
    if (result.outcome === "refused") {
      writeError(skillStatusMessage(result.status.state, options));
      return 1;
    }
    write(
      result.outcome === "missing"
        ? `No Diffler skill installed for ${options.agent} ${options.scope} scope`
        : `Removed Diffler skill for ${options.agent} ${options.scope} scope`,
    );
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : "Unknown error");
    return 1;
  }
}

async function runDoctor(
  args: readonly string[],
  doctor: DoctorService,
  write: WriteOutput,
  writeError: WriteOutput,
): Promise<number> {
  if (args.length !== 0) {
    writeError("Usage: diffler doctor");
    return 1;
  }
  try {
    const diagnostics = await doctor.diagnose();
    for (const result of diagnostics) {
      write(`[${result.status.toUpperCase()}] ${result.message}`);
    }
    return diagnostics.some(({ status }) => status === "fail") ? 1 : 0;
  } catch {
    writeError("Unable to complete Diffler diagnostics");
    return 1;
  }
}

interface SkillCliOptions {
  operation: "install" | "status" | "uninstall";
  agent: SkillAgent;
  scope: SkillScope;
  force: boolean;
}

function parseSkillArgs(args: readonly string[]): SkillCliOptions {
  const usage =
    "Usage: diffler skill <install|status|uninstall> <claude|opencode> --scope <project|user> [--force]";
  const operation = args[0];
  const agent = args[1];
  if (
    (operation !== "install" &&
      operation !== "status" &&
      operation !== "uninstall") ||
    (agent !== "claude" && agent !== "opencode")
  ) {
    throw new Error(usage);
  }

  let scope: SkillScope | undefined;
  let force = false;
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--scope") {
      const value = args[index + 1];
      if (scope !== undefined || (value !== "project" && value !== "user")) {
        throw new Error(usage);
      }
      scope = value;
      index += 1;
    } else if (argument === "--force" && operation !== "status" && !force) {
      force = true;
    } else {
      throw new Error(usage);
    }
  }
  if (scope === undefined) {
    throw new Error(usage);
  }
  return { operation, agent, scope, force };
}

function skillStatusMessage(
  state: "missing" | "current" | "outdated" | "modified" | "conflict",
  options: Pick<SkillCliOptions, "agent" | "scope" | "operation">,
): string {
  const label = `${options.agent} ${options.scope} scope`;
  switch (state) {
    case "missing":
      return `Diffler skill is not installed for ${label}`;
    case "outdated":
      return `Diffler skill is outdated for ${label}; run skill install again`;
    case "modified":
      return `Diffler skill has local modifications for ${label}; review them before using --force`;
    case "conflict":
      return options.operation === "uninstall"
        ? `A conflicting unowned skill exists for ${label}; Diffler will not remove it`
        : `A conflicting skill exists for ${label}; review it before using --force`;
    case "current":
      return `Diffler skill is current for ${label}`;
  }
}

async function runPublish(
  args: readonly string[],
  publisher: QuizPublisher,
  write: WriteOutput,
  writeError: WriteOutput,
  cwd: string,
): Promise<number> {
  try {
    const options = parseQuizFileArgs(args, "publish");
    const result = await publisher.publish(
      readQuizDocument(cwd, options.inputPath, options.contextPath),
    );
    write(`Published Google Form ${result.formId}`);
    write(`Responder: ${result.responderUrl}`);
    write(`Editor: ${result.editUrl}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeError(message);
    return 1;
  }
}

function runValidate(
  args: readonly string[],
  write: WriteOutput,
  writeError: WriteOutput,
  cwd: string,
): number {
  try {
    const options = parseQuizFileArgs(args, "validate");
    const document = readQuizDocument(
      cwd,
      options.inputPath,
      options.contextPath,
    );
    write(`Quiz document is valid: ${document.questions.length} questions`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeError(message);
    return 1;
  }
}

async function runQuiz(
  args: readonly string[],
  createPrompt: () => QuizPrompt,
  write: WriteOutput,
  writeError: WriteOutput,
  cwd: string,
): Promise<number> {
  let document: ReturnType<typeof parseQuizDocument>;
  try {
    const options = parseQuizFileArgs(args, "quiz");
    document = readQuizDocument(cwd, options.inputPath, options.contextPath);
    validateLocalQuizDisplay(document);
  } catch (error) {
    writeError(
      error instanceof QuizValidationError
        ? "Quiz document is invalid; run diffler validate before starting a local quiz"
        : sanitizeQuizDisplayText(
            error instanceof Error ? error.message : "Unknown error",
          ),
    );
    return 1;
  }

  try {
    await conductLocalQuiz(document, createPrompt(), write);
    return 0;
  } catch (error) {
    if (error instanceof QuizCancelledError) {
      writeError("Quiz cancelled; no responses were saved.");
    } else if (error instanceof LocalQuizError) {
      writeError(
        error.message === "Interactive quiz requires a TTY on stdin and stdout"
          ? error.message
          : "Invalid local quiz response.",
      );
    } else {
      writeError("Unable to conduct local quiz");
    }
    return 1;
  }
}

interface QuizFileOptions {
  inputPath: string;
  contextPath?: string;
}

function parseQuizFileArgs(
  args: readonly string[],
  command: "publish" | "quiz" | "validate",
): QuizFileOptions {
  const usage =
    command === "publish"
      ? "Usage: diffler publish <quiz.json> --context <context.json>"
      : `Usage: diffler ${command} <quiz.json> [--context <context.json>]`;
  const inputPath = args[0];
  if (inputPath === undefined) {
    throw new Error(usage);
  }
  if (args.length === 1) {
    if (command === "publish") {
      throw new Error(usage);
    }
    return { inputPath };
  }
  if (args.length === 3 && args[1] === "--context" && args[2] !== undefined) {
    return { inputPath, contextPath: args[2] };
  }
  throw new Error(usage);
}

function readQuizDocument(
  cwd: string,
  inputPath: string,
  contextPath?: string,
) {
  const document = parseQuizDocument(readJsonFile(cwd, inputPath, "quiz"));
  if (contextPath !== undefined) {
    const context = parseQuizContext(readJsonFile(cwd, contextPath, "context"));
    const current = parseQuizContext(
      collectDiffContext({
        cwd,
        baseRef: context.comparison.baseRef,
        maxPatchBytes: context.limits.maxPatchBytes,
        maxChunkBytes: context.limits.maxChunkBytes,
        excludePaths: context.limits.excludePaths,
      }),
    );
    validateQuizAgainstContext(document, context, current);
  }
  return document;
}

function readJsonFile(
  cwd: string,
  inputPath: string,
  kind: "context" | "quiz",
): unknown {
  let input: string;
  try {
    input = readFileSync(resolve(cwd, inputPath), "utf8");
  } catch {
    throw new Error(`Unable to read ${kind} document: ${inputPath}`);
  }
  try {
    return JSON.parse(input);
  } catch {
    const label = kind === "quiz" ? "Quiz" : "Context";
    throw new Error(`${label} document is not valid JSON: ${inputPath}`);
  }
}

async function runAuth(
  args: readonly string[],
  auth: AuthService,
  write: WriteOutput,
  writeError: WriteOutput,
  cwd: string,
): Promise<number> {
  try {
    switch (args[0]) {
      case "login": {
        if (args.length === 1) {
          await auth.login();
        } else if (
          args.length === 3 &&
          args[1] === "--credentials" &&
          args[2] !== undefined
        ) {
          await auth.login(resolve(cwd, args[2]));
        } else {
          throw new Error("Usage: diffler auth login [--credentials <path>]");
        }
        write(
          "Authenticated with Google; refresh credentials stored in the OS keychain",
        );
        return 0;
      }
      case "status":
        if (args.length !== 1) {
          throw new Error("Usage: diffler auth status");
        }
        if (await auth.status()) {
          write("Authenticated with Google");
          return 0;
        }
        writeError("Not authenticated with Google; run diffler auth login");
        return 1;
      case "logout":
        if (args.length !== 1) {
          throw new Error("Usage: diffler auth logout");
        }
        if (await auth.logout()) {
          write("Removed Google authorization from the OS keychain");
        } else {
          write("No stored Google authorization found");
        }
        return 0;
      default:
        throw new Error(`Unknown auth command: ${args[0] ?? "(missing)"}`);
    }
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
  import.meta.url === pathToFileURL(realpathSync(entrypoint)).href
) {
  process.exitCode = await run(process.argv.slice(2));
}
