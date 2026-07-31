import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

const DEFAULT_MAX_PATCH_BYTES = 200_000;
const DEFAULT_MAX_CHUNK_BYTES = 32_000;
const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;
const STABLE_DIFF_OPTIONS = [
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--ignore-submodules=none",
  "--inter-hunk-context=0",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--submodule=short",
] as const;

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".diffler",
  "build",
  "coverage",
  "dist",
]);

const DEFAULT_EXCLUDED_FILES = new Set([
  "Cargo.lock",
  "Gemfile.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const SENSITIVE_FILE_EXTENSIONS = new Set([".key", ".p12", ".pem", ".pfx"]);
const SENSITIVE_DIRECTORIES = new Set([".secrets", "credentials", "secrets"]);
const SENSITIVE_CONTENT_PATTERNS = [
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/,
  /\b(?:gh[oprsu]|github_pat)_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bya29\.[A-Za-z0-9_-]{20,}/,
  /\b1\/\/[A-Za-z0-9_-]{20,}/,
  /\b(?:glpat-|sk_live_|xox[baprs]-)[A-Za-z0-9_-]{16,}/,
  /["']?(?:access_token|api[_-]?key|client_secret|password|refresh_token)["']?\s*[:=]\s*["'][^"'\s]{8,}["']/i,
  /^[+-]?(?:[A-Z0-9_]*(?:API_KEY|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)\s*=\s*[^\s]{8,}\s*$/m,
] as const;

export type ChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied";

export type DiffOmissionReason = "binary" | "excluded" | "sensitive" | "budget";

export interface DiffChunk {
  kind: "metadata" | "hunk";
  section: number;
  part: number;
  text: string;
  bytes: number;
}

export interface DiffContextFile {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
  patchBytes: number;
  chunks: readonly DiffChunk[];
}

export interface DiffOmission {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
  reason: DiffOmissionReason;
  patchBytes?: number;
  omittedChunks?: {
    count: number;
    bytes: number;
  };
}

export interface DiffContext {
  schemaVersion: 1;
  repository: {
    name: string;
    remote?: string;
  };
  comparison: {
    baseRef: string;
    baseSha: string;
    mergeBaseSha: string;
    headSha: string;
  };
  diffHash: string;
  files: readonly DiffContextFile[];
  omissions: readonly DiffOmission[];
  limits: {
    maxPatchBytes: number;
    maxChunkBytes: number;
    includedPatchBytes: number;
    excludePaths: readonly string[];
  };
  summary: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    partiallyIncludedFiles: number;
    includedChunks: number;
    omittedChunks: number;
  };
}

export interface CollectDiffContextOptions {
  cwd?: string;
  baseRef?: string;
  excludePaths?: readonly string[];
  maxPatchBytes?: number;
  maxChunkBytes?: number;
}

interface ChangedPath {
  path: string;
  previousPath?: string;
  status: ChangeStatus;
}

export class DiffContextError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DiffContextError";
  }
}

export function collectDiffContext(
  options: CollectDiffContextOptions = {},
): DiffContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const root = repositoryRoot(cwd);
  const baseRef = resolveBaseRef(root, options.baseRef);
  const maxPatchBytes = positiveInteger(
    options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES,
    "Maximum patch bytes",
  );
  const maxChunkBytes = positiveInteger(
    options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
    "Maximum chunk bytes",
  );
  if (maxChunkBytes < 4) {
    throw new DiffContextError("Maximum chunk bytes must be at least 4");
  }
  const excludePaths = (options.excludePaths ?? []).map(normalizeExcludedPath);

  const baseSha = git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
  const headSha = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const mergeBaseSha = git(root, ["merge-base", baseSha, headSha]);
  const mergeBaseTree = git(root, ["rev-parse", `${mergeBaseSha}^{tree}`]);
  const headTree = git(root, ["rev-parse", `${headSha}^{tree}`]);
  const diffHash = createHash("sha256")
    .update(`diffler-diff-v1\0${mergeBaseTree}\0${headTree}`)
    .digest("hex");
  const changedPaths = listChangedPaths(root, mergeBaseSha, headSha);

  const files: DiffContextFile[] = [];
  const omissions: DiffOmission[] = [];
  let includedPatchBytes = 0;

  for (const changedPath of changedPaths) {
    if (isChangedPathSensitive(changedPath)) {
      omissions.push({ ...changedPath, reason: "sensitive" });
      continue;
    }
    if (isChangedPathExcluded(changedPath, excludePaths)) {
      omissions.push({ ...changedPath, reason: "excluded" });
      continue;
    }

    if (isBinary(root, mergeBaseSha, headSha, changedPath)) {
      omissions.push({ ...changedPath, reason: "binary" });
      continue;
    }

    const patch = filePatch(root, mergeBaseSha, headSha, changedPath);
    if (SENSITIVE_CONTENT_PATTERNS.some((pattern) => pattern.test(patch))) {
      omissions.push({ ...changedPath, reason: "sensitive" });
      continue;
    }
    const includedChunks: DiffChunk[] = [];
    let patchBytes = 0;
    let omittedChunkCount = 0;
    let omittedChunkBytes = 0;

    for (const chunk of chunkPatch(patch, maxChunkBytes)) {
      patchBytes += chunk.bytes;
      if (includedPatchBytes + chunk.bytes <= maxPatchBytes) {
        includedChunks.push(chunk);
        includedPatchBytes += chunk.bytes;
      } else {
        omittedChunkCount += 1;
        omittedChunkBytes += chunk.bytes;
      }
    }

    if (omittedChunkCount > 0) {
      omissions.push({
        ...changedPath,
        reason: "budget",
        patchBytes,
        omittedChunks: { count: omittedChunkCount, bytes: omittedChunkBytes },
      });
    }

    if (includedChunks.length > 0) {
      files.push({
        ...changedPath,
        patchBytes,
        chunks: includedChunks,
      });
    }
  }

  const includedPaths = new Set(files.map((file) => file.path));
  const omittedPaths = new Set(omissions.map((omission) => omission.path));
  const partiallyIncludedFiles = [...omittedPaths].filter((path) =>
    includedPaths.has(path),
  ).length;
  const omittedFiles = [...omittedPaths].filter(
    (path) => !includedPaths.has(path),
  ).length;

  return {
    schemaVersion: 1,
    repository: repositoryMetadata(root),
    comparison: { baseRef, baseSha, mergeBaseSha, headSha },
    diffHash,
    files,
    omissions,
    limits: {
      maxPatchBytes,
      maxChunkBytes,
      includedPatchBytes,
      excludePaths,
    },
    summary: {
      totalFiles: changedPaths.length,
      includedFiles: files.length,
      omittedFiles,
      partiallyIncludedFiles,
      includedChunks: files.reduce(
        (total, file) => total + file.chunks.length,
        0,
      ),
      omittedChunks: omissions.reduce(
        (total, omission) => total + (omission.omittedChunks?.count ?? 0),
        0,
      ),
    },
  };
}

function repositoryRoot(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    throw new DiffContextError(`Not a Git repository: ${cwd}`, {
      cause: error,
    });
  }
}

function resolveBaseRef(root: string, explicitBaseRef?: string): string {
  if (explicitBaseRef !== undefined) {
    ensureRef(root, explicitBaseRef);
    return explicitBaseRef;
  }

  const originHead = tryGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const candidates = [originHead, "main", "master"].filter(
    (candidate): candidate is string => candidate !== undefined,
  );

  for (const candidate of candidates) {
    if (refExists(root, candidate)) {
      return candidate;
    }
  }

  throw new DiffContextError(
    "Unable to resolve a base ref; pass one with --base <ref>",
  );
}

function ensureRef(root: string, ref: string): void {
  if (!refExists(root, ref)) {
    throw new DiffContextError(`Unable to resolve base ref: ${ref}`);
  }
}

function refExists(root: string, ref: string): boolean {
  return (
    tryGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]) !== undefined
  );
}

function repositoryMetadata(root: string): DiffContext["repository"] {
  const remote = tryGit(root, ["config", "--get", "remote.origin.url"]);
  const sanitizedRemote =
    remote === undefined ? undefined : sanitizeRemote(remote);
  return sanitizedRemote === undefined
    ? { name: basename(root) }
    : { name: basename(root), remote: sanitizedRemote };
}

function listChangedPaths(
  root: string,
  mergeBaseSha: string,
  headSha: string,
): readonly ChangedPath[] {
  const output = gitDiffRaw(root, headSha, [
    "--find-renames=50%",
    "--name-status",
    "-z",
    mergeBaseSha,
    headSha,
  ]);
  const fields = output.split("\0");
  if (fields.at(-1) === "") {
    fields.pop();
  }

  const changedPaths: ChangedPath[] = [];
  for (let index = 0; index < fields.length; ) {
    const statusToken = fields[index++];
    if (statusToken === undefined) {
      break;
    }

    const code = statusToken[0];
    if (code === "R" || code === "C") {
      const previousPath = requiredField(fields[index++], statusToken);
      const path = requiredField(fields[index++], statusToken);
      changedPaths.push({
        path,
        previousPath,
        status: code === "R" ? "renamed" : "copied",
      });
      continue;
    }

    const path = requiredField(fields[index++], statusToken);
    changedPaths.push({ path, status: statusFromCode(code, statusToken) });
  }

  return changedPaths.sort((left, right) => {
    if (left.path === right.path) {
      return 0;
    }
    return left.path < right.path ? -1 : 1;
  });
}

function requiredField(field: string | undefined, statusToken: string): string {
  if (field === undefined) {
    throw new DiffContextError(
      `Malformed Git name-status output after ${statusToken}`,
    );
  }
  return field;
}

function statusFromCode(code: string | undefined, token: string): ChangeStatus {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
    case "T":
      return "modified";
    default:
      throw new DiffContextError(`Unsupported Git change status: ${token}`);
  }
}

function isExcluded(path: string, excludePaths: readonly string[]): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => DEFAULT_EXCLUDED_DIRECTORIES.has(segment))) {
    return true;
  }
  if (DEFAULT_EXCLUDED_FILES.has(segments.at(-1) ?? "")) {
    return true;
  }
  return excludePaths.some(
    (excludedPath) =>
      path === excludedPath || path.startsWith(`${excludedPath}/`),
  );
}

function isSensitive(path: string): boolean {
  const segments = path.toLowerCase().split("/");
  if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment))) {
    return true;
  }
  const filename = segments.at(-1) ?? "";
  return (
    filename === ".env" ||
    filename.startsWith(".env.") ||
    filename === ".npmrc" ||
    filename === "credentials.json" ||
    filename === "service-account.json" ||
    filename === "token.json" ||
    ((filename.startsWith("client_secret_") ||
      filename === "client_secret.json") &&
      filename.endsWith(".json")) ||
    SENSITIVE_FILE_EXTENSIONS.has(filename.slice(filename.lastIndexOf(".")))
  );
}

function isChangedPathExcluded(
  changedPath: ChangedPath,
  excludePaths: readonly string[],
): boolean {
  return (
    isExcluded(changedPath.path, excludePaths) ||
    (changedPath.previousPath !== undefined &&
      isExcluded(changedPath.previousPath, excludePaths))
  );
}

function isChangedPathSensitive(changedPath: ChangedPath): boolean {
  return (
    isSensitive(changedPath.path) ||
    (changedPath.previousPath !== undefined &&
      isSensitive(changedPath.previousPath))
  );
}

function normalizeExcludedPath(path: string): string {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new DiffContextError(`Invalid excluded path: ${path}`);
  }
  return normalized;
}

function isBinary(
  root: string,
  mergeBaseSha: string,
  headSha: string,
  changedPath: ChangedPath,
): boolean {
  const blobs: Array<[string, string]> = [];
  if (changedPath.status !== "added" && changedPath.status !== "copied") {
    blobs.push([mergeBaseSha, changedPath.previousPath ?? changedPath.path]);
  }
  if (changedPath.status !== "deleted") {
    blobs.push([headSha, changedPath.path]);
  }
  return blobs.some(([sha, path]) => gitBlobContainsNull(root, sha, path));
}

function filePatch(
  root: string,
  mergeBaseSha: string,
  headSha: string,
  changedPath: ChangedPath,
): string {
  return gitDiffRaw(root, headSha, [
    "--find-renames=50%",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--text",
    "--unified=3",
    ...STABLE_DIFF_OPTIONS,
    mergeBaseSha,
    headSha,
    "--",
    ...pathspecs(changedPath),
  ]);
}

function pathspecs(changedPath: ChangedPath): string[] {
  return changedPath.previousPath === undefined
    ? [changedPath.path]
    : [changedPath.previousPath, changedPath.path];
}

function* chunkPatch(patch: string, maxBytes: number): Generator<DiffChunk> {
  if (patch.length === 0) {
    return;
  }

  const lines =
    patch
      .match(/.*(?:\n|$)/g)
      ?.filter((line) => line.length > 0)
      .map(canonicalizeHunkHeader) ?? [];
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));

  if (firstHunk > 0) {
    yield* chunkSection("metadata", 0, lines.slice(0, firstHunk), maxBytes);
  }

  if (firstHunk === -1) {
    yield* chunkSection("metadata", 0, lines, maxBytes);
    return;
  }

  let hunkEnd = firstHunk;
  let section = 1;
  while (hunkEnd < lines.length) {
    const hunkStart = hunkEnd;
    hunkEnd += 1;
    while (hunkEnd < lines.length && !lines[hunkEnd]?.startsWith("@@ ")) {
      hunkEnd += 1;
    }
    yield* chunkSection(
      "hunk",
      section,
      lines.slice(hunkStart, hunkEnd),
      maxBytes,
    );
    section += 1;
  }
}

function* chunkSection(
  kind: DiffChunk["kind"],
  section: number,
  lines: readonly string[],
  maxBytes: number,
): Generator<DiffChunk> {
  let current = "";
  let part = 1;

  for (const line of lines) {
    for (const piece of splitByBytes(line, maxBytes)) {
      if (current.length > 0 && Buffer.byteLength(current + piece) > maxBytes) {
        yield makeChunk(kind, section, part, current);
        part += 1;
        current = "";
      }
      current += piece;
    }
  }
  if (current.length > 0) {
    yield makeChunk(kind, section, part, current);
  }
}

function makeChunk(
  kind: DiffChunk["kind"],
  section: number,
  part: number,
  text: string,
): DiffChunk {
  return { kind, section, part, text, bytes: Buffer.byteLength(text) };
}

function splitByBytes(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value) <= maxBytes) {
    return [value];
  }

  const pieces: string[] = [];
  let current = "";
  for (const character of value) {
    if (
      current.length > 0 &&
      Buffer.byteLength(current + character) > maxBytes
    ) {
      pieces.push(current);
      current = "";
    }
    current += character;
  }
  if (current.length > 0) {
    pieces.push(current);
  }
  return pieces;
}

function canonicalizeHunkHeader(line: string): string {
  if (!line.startsWith("@@ ")) {
    return line;
  }
  const match = /^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@).*(\n?)$/.exec(line);
  return match === null ? line : `${match[1]}${match[2]}`;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DiffContextError(`${label} must be a positive integer`);
  }
  return value;
}

function git(cwd: string, args: readonly string[]): string {
  return gitRaw(cwd, args).trimEnd();
}

function gitDiffRaw(
  cwd: string,
  attributeSource: string,
  args: readonly string[],
): string {
  return gitRaw(
    cwd,
    [
      "-c",
      "core.quotePath=false",
      "-c",
      `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "-c",
      "diff.renameLimit=0",
      "-c",
      "diff.suppressBlankEmpty=false",
      "diff",
      ...args,
    ],
    {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ATTR_SOURCE: attributeSource,
      GIT_LITERAL_PATHSPECS: "1",
    },
  );
}

function gitBlobContainsNull(cwd: string, sha: string, path: string): boolean {
  try {
    const entry = gitRaw(cwd, ["ls-tree", "-z", sha, "--", path], {
      GIT_LITERAL_PATHSPECS: "1",
    });
    const tabIndex = entry.indexOf("\t");
    const metadata = tabIndex === -1 ? [] : entry.slice(0, tabIndex).split(" ");
    const objectType = metadata[1];
    const objectId = metadata[2];
    if (objectType !== "blob") {
      return false;
    }
    if (objectId === undefined) {
      throw new DiffContextError(`Malformed Git tree entry: ${path}`);
    }
    const blob = execFileSync("git", ["cat-file", "blob", objectId], {
      cwd,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return blob.includes(0);
  } catch (error) {
    throw new DiffContextError(`Unable to inspect Git blob: ${path}`, {
      cause: error,
    });
  }
}

function gitRaw(
  cwd: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...environment },
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    const detail = stderr.length > 0 ? `: ${stderr}` : "";
    throw new DiffContextError(
      `Git command failed (${args[0] ?? "unknown"})${detail}`,
      {
        cause: error,
      },
    );
  }
}

function sanitizeRemote(remote: string): string | undefined {
  if (!remote.includes("://")) {
    if (/^[A-Za-z]:[\\/]/.test(remote)) {
      return remote;
    }
    const scpRemote = /^(?:[^@\s/]+@)?([^:\s/]+:.+)$/.exec(remote);
    if (scpRemote?.[1] !== undefined) {
      return scpRemote[1];
    }
    return remote.includes("@") ? undefined : remote;
  }

  try {
    const url = new URL(remote);
    if (url.search.length > 0 || url.hash.length > 0) {
      return undefined;
    }
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function tryGit(cwd: string, args: readonly string[]): string | undefined {
  try {
    return git(cwd, args);
  } catch {
    return undefined;
  }
}
