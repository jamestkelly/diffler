import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillAgent = "claude" | "opencode";
export type SkillScope = "project" | "user";
export type PathImplementation = Pick<typeof path, "join">;

export type SkillStatusState =
  | "missing"
  | "current"
  | "outdated"
  | "modified"
  | "conflict";

export interface SkillTargetOptions {
  agent: SkillAgent;
  scope: SkillScope;
  cwd: string;
  home: string;
  env?: Readonly<Record<string, string | undefined>>;
  path?: PathImplementation;
}

export interface SkillStatus {
  state: SkillStatusState;
  targetPath: string;
  manifestPath: string;
  discoverable: boolean;
  fingerprint?: string;
  reason?: string;
}

export interface SkillInstallResult {
  outcome: "installed" | "unchanged" | "upgraded" | "replaced" | "refused";
  targetPath: string;
  status: SkillStatus;
}

export interface SkillUninstallResult {
  outcome: "removed" | "missing" | "refused";
  targetPath: string;
  status: SkillStatus;
}

export interface SkillInstallationServiceOptions
  extends Omit<SkillTargetOptions, "cwd" | "home"> {
  cwd?: string;
  home?: string;
  packagedSkillPath?: string;
}

interface Manifest {
  schemaVersion: 1;
  sha256: string;
}

const MANIFEST_NAME = ".diffler-install.json";
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export const DEFAULT_PACKAGED_SKILL_PATH = fileURLToPath(
  new URL("../skills/diffler/SKILL.md", import.meta.url),
);

export function resolveSkillTarget(options: SkillTargetOptions): string {
  const pathApi = options.path ?? path;
  const relative = ["skills", "diffler", "SKILL.md"];

  if (options.scope === "project") {
    return pathApi.join(
      options.cwd,
      options.agent === "claude" ? ".claude" : ".opencode",
      ...relative,
    );
  }

  if (options.agent === "claude") {
    return pathApi.join(options.home, ".claude", ...relative);
  }

  const configRoot =
    nonEmpty(options.env?.OPENCODE_CONFIG_DIR) ??
    (nonEmpty(options.env?.XDG_CONFIG_HOME) === undefined
      ? pathApi.join(options.home, ".config", "opencode")
      : pathApi.join(options.env?.XDG_CONFIG_HOME as string, "opencode"));
  return pathApi.join(configRoot, ...relative);
}

export class SkillInstallationService {
  readonly targetPath: string;
  readonly manifestPath: string;
  readonly packagedSkillPath: string;

  constructor(options: SkillInstallationServiceOptions) {
    this.targetPath = resolveSkillTarget({
      agent: options.agent,
      scope: options.scope,
      cwd: options.cwd ?? process.cwd(),
      home: options.home ?? homedir(),
      env: options.env ?? process.env,
      ...(options.path === undefined ? {} : { path: options.path }),
    });
    this.manifestPath = path.join(path.dirname(this.targetPath), MANIFEST_NAME);
    this.packagedSkillPath =
      options.packagedSkillPath ?? DEFAULT_PACKAGED_SKILL_PATH;
  }

  async status(): Promise<SkillStatus> {
    const packagedBytes = await readFile(this.packagedSkillPath);
    return inspect(this.targetPath, this.manifestPath, digest(packagedBytes));
  }

  async install(
    options: { force?: boolean } = {},
  ): Promise<SkillInstallResult> {
    const packagedBytes = await readFile(this.packagedSkillPath);
    const packagedDigest = digest(packagedBytes);
    const before = await inspect(
      this.targetPath,
      this.manifestPath,
      packagedDigest,
    );

    if (before.state === "current") {
      return result("unchanged", before);
    }
    if (
      (before.state === "modified" || before.state === "conflict") &&
      options.force !== true
    ) {
      return result("refused", before);
    }
    if (isUnsafeConflict(before)) {
      return result("refused", before);
    }

    const directory = path.dirname(this.targetPath);
    try {
      await ensureSafeDirectory(directory);
      await rejectUnsafeFile(this.targetPath);
      await rejectUnsafeFile(this.manifestPath);
    } catch (error) {
      return result(
        "refused",
        conflictStatus(this.targetPath, errorMessage(error)),
      );
    }

    const confirmed = await inspect(
      this.targetPath,
      this.manifestPath,
      packagedDigest,
    );
    if (!sameStatus(before, confirmed)) {
      return result(
        "refused",
        conflictStatus(
          this.targetPath,
          "skill changed while installation was in progress",
          confirmed.discoverable,
        ),
      );
    }

    const manifest: Manifest = { schemaVersion: 1, sha256: packagedDigest };
    const previousTarget = await readOptionalFile(this.targetPath);
    const previousManifest = await readOptionalFile(this.manifestPath);
    let targetWritten = false;
    try {
      await atomicWrite(this.targetPath, packagedBytes);
      targetWritten = true;
      await atomicWrite(
        this.manifestPath,
        Buffer.from(`${JSON.stringify(manifest)}\n`),
      );
    } catch (error) {
      if (targetWritten) {
        try {
          await restoreFile(this.targetPath, previousTarget);
          await restoreFile(this.manifestPath, previousManifest);
        } catch {
          return result(
            "refused",
            conflictStatus(
              this.targetPath,
              "partial installation could not be restored safely",
            ),
          );
        }
      }
      return result(
        "refused",
        conflictStatus(this.targetPath, errorMessage(error)),
      );
    }

    const after = await inspect(
      this.targetPath,
      this.manifestPath,
      packagedDigest,
    );
    if (after.state !== "current") {
      return result("refused", after);
    }
    const outcome =
      before.state === "missing"
        ? "installed"
        : before.state === "outdated"
          ? "upgraded"
          : "replaced";
    return result(outcome, after);
  }

  async uninstall(
    options: { force?: boolean } = {},
  ): Promise<SkillUninstallResult> {
    const packagedBytes = await readFile(this.packagedSkillPath);
    const before = await inspect(
      this.targetPath,
      this.manifestPath,
      digest(packagedBytes),
    );

    if (before.state === "missing") {
      return uninstallResult("missing", before);
    }
    if (before.state === "modified" && options.force !== true) {
      return uninstallResult("refused", before);
    }
    if (before.state === "conflict" || isUnsafeConflict(before)) {
      return uninstallResult("refused", before);
    }

    try {
      await validateExistingComponents(this.targetPath);
      await validateExistingComponents(this.manifestPath);
      await rejectUnsafeFile(this.targetPath);
      await rejectUnsafeFile(this.manifestPath);
      const confirmed = await inspect(
        this.targetPath,
        this.manifestPath,
        digest(packagedBytes),
      );
      if (!sameStatus(before, confirmed)) {
        return uninstallResult(
          "refused",
          conflictStatus(
            this.targetPath,
            "skill changed while uninstall was in progress",
            confirmed.discoverable,
            confirmed.fingerprint,
          ),
        );
      }
      await rm(this.targetPath, { force: true });
      await rm(this.manifestPath, { force: true });
      try {
        await rmdir(path.dirname(this.targetPath));
      } catch (error) {
        if (!isNodeError(error, "ENOTEMPTY") && !isNodeError(error, "ENOENT")) {
          throw error;
        }
      }
    } catch (error) {
      return uninstallResult(
        "refused",
        conflictStatus(this.targetPath, errorMessage(error)),
      );
    }

    return uninstallResult(
      "removed",
      baseStatus("missing", this.targetPath, this.manifestPath, false),
    );
  }
}

export function createSkillInstallationService(
  options: SkillInstallationServiceOptions,
): SkillInstallationService {
  return new SkillInstallationService(options);
}

export async function getSkillStatus(
  options: SkillInstallationServiceOptions,
): Promise<SkillStatus> {
  return createSkillInstallationService(options).status();
}

export async function installSkill(
  options: SkillInstallationServiceOptions & { force?: boolean },
): Promise<SkillInstallResult> {
  const { force, ...serviceOptions } = options;
  return createSkillInstallationService(serviceOptions).install(
    force === undefined ? {} : { force },
  );
}

export async function uninstallSkill(
  options: SkillInstallationServiceOptions & { force?: boolean },
): Promise<SkillUninstallResult> {
  const { force, ...serviceOptions } = options;
  return createSkillInstallationService(serviceOptions).uninstall(
    force === undefined ? {} : { force },
  );
}

async function inspect(
  targetPath: string,
  manifestPath: string,
  packagedDigest: string,
): Promise<SkillStatus> {
  try {
    await validateExistingComponents(targetPath);
    await validateExistingComponents(manifestPath);
  } catch (error) {
    return conflictStatus(targetPath, errorMessage(error));
  }

  const target = await readRegularFile(targetPath);
  const manifestFile = await readRegularFile(manifestPath);
  if (target.kind === "unsafe") {
    return conflictStatus(targetPath, target.reason);
  }
  if (manifestFile.kind === "unsafe") {
    return conflictStatus(targetPath, manifestFile.reason);
  }
  if (target.kind === "missing" && manifestFile.kind === "missing") {
    return baseStatus("missing", targetPath, manifestPath, false);
  }
  if (target.kind === "missing" || manifestFile.kind === "missing") {
    const fingerprint =
      target.kind === "file" ? digest(target.bytes) : undefined;
    const discoverable =
      target.kind === "file" && isDiscoverableSkill(target.bytes);
    return conflictStatus(
      targetPath,
      "skill or ownership manifest is missing",
      discoverable,
      fingerprint,
    );
  }

  const currentDigest = digest(target.bytes);
  const discoverable = isDiscoverableSkill(target.bytes);
  const manifest = parseManifest(manifestFile.bytes);
  if (manifest === undefined) {
    return conflictStatus(
      targetPath,
      "ownership manifest is malformed",
      discoverable,
      currentDigest,
    );
  }
  if (currentDigest !== manifest.sha256) {
    return baseStatus(
      "modified",
      targetPath,
      manifestPath,
      discoverable,
      currentDigest,
    );
  }
  return baseStatus(
    currentDigest === packagedDigest ? "current" : "outdated",
    targetPath,
    manifestPath,
    discoverable,
    currentDigest,
  );
}

type ReadResult =
  | { kind: "missing" }
  | { kind: "file"; bytes: Buffer }
  | { kind: "unsafe"; reason: string };

async function readRegularFile(filePath: string): Promise<ReadResult> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      return { kind: "unsafe", reason: `${filePath} is a symbolic link` };
    }
    if (!stats.isFile()) {
      return { kind: "unsafe", reason: `${filePath} is not a regular file` };
    }
    if (stats.nlink > 1) {
      return { kind: "unsafe", reason: `${filePath} is hard-linked` };
    }
    return { kind: "file", bytes: await readFile(filePath) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { kind: "missing" };
    }
    return { kind: "unsafe", reason: errorMessage(error) };
  }
}

function parseManifest(bytes: Buffer): Manifest | undefined {
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      record.schemaVersion !== 1 ||
      typeof record.sha256 !== "string" ||
      !DIGEST_PATTERN.test(record.sha256)
    ) {
      return undefined;
    }
    return { schemaVersion: 1, sha256: record.sha256 };
  } catch {
    return undefined;
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await validateExistingComponents(directory);
  const missing: string[] = [];
  let cursor = directory;
  for (;;) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`${cursor} is a symbolic link`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`${cursor} is not a directory`);
      }
      break;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new Error(`no existing parent directory for ${directory}`);
      }
      cursor = parent;
    }
  }
  for (const component of missing.reverse()) {
    await mkdir(component);
    const stats = await lstat(component);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${component} could not be created safely`);
    }
  }
}

async function validateExistingComponents(filePath: string): Promise<void> {
  let cursor = filePath;
  for (;;) {
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        throw new Error(`${cursor} is a symbolic link`);
      }
      if (cursor !== filePath && !stats.isDirectory()) {
        throw new Error(`${cursor} is not a directory`);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return;
    }
    cursor = parent;
  }
}

async function rejectUnsafeFile(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`${filePath} is a symbolic link`);
    }
    if (!stats.isFile()) {
      throw new Error(`${filePath} is not a regular file`);
    }
    if (stats.nlink > 1) {
      throw new Error(`${filePath} is hard-linked`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readOptionalFile(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function restoreFile(
  filePath: string,
  previous: Buffer | undefined,
): Promise<void> {
  if (previous === undefined) {
    await rm(filePath, { force: true });
  } else {
    await atomicWrite(filePath, previous);
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function baseStatus(
  state: SkillStatusState,
  targetPath: string,
  manifestPath: string,
  discoverable: boolean,
  fingerprint?: string,
): SkillStatus {
  return {
    state,
    targetPath,
    manifestPath,
    discoverable,
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

function conflictStatus(
  targetPath: string,
  reason: string,
  discoverable = false,
  fingerprint?: string,
): SkillStatus {
  return {
    state: "conflict",
    targetPath,
    manifestPath: path.join(path.dirname(targetPath), MANIFEST_NAME),
    discoverable,
    ...(fingerprint === undefined ? {} : { fingerprint }),
    reason,
  };
}

function sameStatus(left: SkillStatus, right: SkillStatus): boolean {
  return (
    left.state === right.state &&
    left.discoverable === right.discoverable &&
    left.fingerprint === right.fingerprint &&
    left.reason === right.reason
  );
}

function isDiscoverableSkill(bytes: Buffer): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    bytes.toString("utf8"),
  )?.[1];
  return frontmatter !== undefined && /^name:\s*diffler\s*$/m.test(frontmatter);
}

function isUnsafeConflict(status: SkillStatus): boolean {
  return (
    status.state === "conflict" &&
    status.reason !== undefined &&
    [
      "symbolic link",
      "hard-linked",
      "not a directory",
      "not a regular file",
    ].some((description) => status.reason?.includes(description) === true)
  );
}

function result(
  outcome: SkillInstallResult["outcome"],
  status: SkillStatus,
): SkillInstallResult {
  return { outcome, targetPath: status.targetPath, status };
}

function uninstallResult(
  outcome: SkillUninstallResult["outcome"],
  status: SkillStatus,
): SkillUninstallResult {
  return { outcome, targetPath: status.targetPath, status };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown filesystem error";
}
