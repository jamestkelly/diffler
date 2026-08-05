import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { AuthError, GoogleAuthService } from "./auth.js";
import {
  type SkillAgent,
  SkillInstallationService,
  type SkillScope,
  type SkillStatus,
} from "./skill-installation.js";

export type DiagnosticStatus = "pass" | "warn" | "fail";

export type DiagnosticState =
  | "healthy"
  | "missing"
  | "invalid"
  | "unavailable"
  | "unsupported"
  | "dirty"
  | "outdated"
  | "modified"
  | "conflict";

export interface DoctorDiagnostic {
  id: string;
  status: DiagnosticStatus;
  state: DiagnosticState;
  message: string;
}

export interface DoctorService {
  diagnose(): Promise<DoctorDiagnostic[]>;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => string;

interface StatusService {
  status(): Promise<boolean>;
}

interface SkillStatusService {
  status(): Promise<SkillStatus>;
}

export interface DoctorServiceOptions {
  cwd?: string;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  nodeVersion?: string;
  packagePath?: string;
  schemaPath?: string;
  packagedSkillPath?: string;
  readTextFile?: (filePath: string) => Promise<string>;
  runCommand?: CommandRunner;
  authService?: StatusService;
  skillService?: (agent: SkillAgent, scope: SkillScope) => SkillStatusService;
}

interface PackageMetadata {
  name: string;
  version: string;
  nodeEngine: string;
}

interface PackageResult {
  diagnostic: DoctorDiagnostic;
  metadata?: PackageMetadata;
}

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const SCHEMA_PATH = fileURLToPath(
  new URL("../schemas/quiz-document.schema.json", import.meta.url),
);
const PACKAGED_SKILL_PATH = fileURLToPath(
  new URL("../skills/diffler/SKILL.md", import.meta.url),
);
const KEYCHAIN_ERROR_MESSAGE =
  "Unable to access the operating-system keychain; ensure a keychain service is available";
const SKILL_TARGETS = [
  ["claude", "project"],
  ["claude", "user"],
  ["opencode", "project"],
  ["opencode", "user"],
] as const satisfies readonly (readonly [SkillAgent, SkillScope])[];

export class ProductionDoctorService implements DoctorService {
  private readonly cwd: string;
  private readonly nodeVersion: string;
  private readonly packagePath: string;
  private readonly schemaPath: string;
  private readonly packagedSkillPath: string;
  private readonly readTextFile: (filePath: string) => Promise<string>;
  private readonly runCommand: CommandRunner;
  private readonly authService: StatusService;
  private readonly skillService: (
    agent: SkillAgent,
    scope: SkillScope,
  ) => SkillStatusService;

  constructor(options: DoctorServiceOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
    this.packagePath = options.packagePath ?? PACKAGE_PATH;
    this.schemaPath = options.schemaPath ?? SCHEMA_PATH;
    this.packagedSkillPath = options.packagedSkillPath ?? PACKAGED_SKILL_PATH;
    this.readTextFile =
      options.readTextFile ?? ((path) => readFile(path, "utf8"));
    this.runCommand = options.runCommand ?? runCommand;
    this.authService = options.authService ?? new GoogleAuthService();
    const home = options.home ?? homedir();
    const env = options.env ?? process.env;
    this.skillService =
      options.skillService ??
      ((agent, scope) =>
        new SkillInstallationService({
          agent,
          scope,
          cwd: this.cwd,
          home,
          env,
          packagedSkillPath: this.packagedSkillPath,
        }));
  }

  async diagnose(): Promise<DoctorDiagnostic[]> {
    const packageResult = await this.checkPackage();
    const diagnostics = [
      this.checkNode(packageResult.metadata),
      packageResult.diagnostic,
    ];
    diagnostics.push(...this.checkGit());
    diagnostics.push(await this.checkSchema());
    diagnostics.push(await this.checkPackagedSkill());
    diagnostics.push(...(await this.checkAuth()));
    diagnostics.push(...(await this.checkSkills()));
    return diagnostics;
  }

  private async checkPackage(): Promise<PackageResult> {
    let input: string;
    try {
      input = await this.readTextFile(this.packagePath);
    } catch (error) {
      return {
        diagnostic: diagnostic(
          "package.metadata",
          "fail",
          isMissingFile(error) ? "missing" : "unavailable",
          "Diffler package metadata is unavailable; reinstall Diffler.",
        ),
      };
    }

    try {
      const value: unknown = JSON.parse(input);
      if (
        !isRecord(value) ||
        !isRecord(value.bin) ||
        !isRecord(value.engines)
      ) {
        throw new Error("invalid package metadata");
      }
      if (
        value.name !== "@diffler/cli" ||
        typeof value.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version) ||
        typeof value.bin.diffler !== "string" ||
        typeof value.engines.node !== "string"
      ) {
        throw new Error("invalid package metadata");
      }
      return {
        diagnostic: diagnostic(
          "package.metadata",
          "pass",
          "healthy",
          `Diffler CLI package metadata is valid (${value.name} ${value.version}).`,
        ),
        metadata: {
          name: value.name,
          version: value.version,
          nodeEngine: value.engines.node,
        },
      };
    } catch {
      return {
        diagnostic: diagnostic(
          "package.metadata",
          "fail",
          "invalid",
          "Diffler package metadata is invalid; reinstall Diffler.",
        ),
      };
    }
  }

  private checkNode(metadata: PackageMetadata | undefined): DoctorDiagnostic {
    if (metadata === undefined) {
      return diagnostic(
        "runtime.node",
        "fail",
        "unavailable",
        "The required Node.js version cannot be determined; reinstall Diffler.",
      );
    }
    const supported = satisfiesMinimum(this.nodeVersion, metadata.nodeEngine);
    if (supported === undefined) {
      return diagnostic(
        "runtime.node",
        "fail",
        "invalid",
        "The Node.js runtime or package engine requirement is invalid.",
      );
    }
    return supported
      ? diagnostic(
          "runtime.node",
          "pass",
          "healthy",
          "Node.js satisfies Diffler's runtime requirement.",
        )
      : diagnostic(
          "runtime.node",
          "fail",
          "unsupported",
          `Node.js ${metadata.nodeEngine} is required; install a supported Node.js release.`,
        );
  }

  private checkGit(): DoctorDiagnostic[] {
    let versionOutput: string;
    try {
      versionOutput = this.runCommand("git", ["--version"], this.cwd);
    } catch {
      return [
        diagnostic(
          "git.executable",
          "fail",
          "unavailable",
          "Git is unavailable; install Git and ensure it is on PATH.",
        ),
        diagnostic(
          "git.repository",
          "fail",
          "unavailable",
          "Repository status is unavailable until Git can run.",
        ),
        diagnostic(
          "git.head",
          "fail",
          "unavailable",
          "HEAD status is unavailable until Git can run.",
        ),
        diagnostic(
          "git.worktree",
          "fail",
          "unavailable",
          "Worktree status is unavailable until Git can run.",
        ),
      ];
    }

    const versionSupported = satisfiesGitMinimum(versionOutput);
    const diagnostics = [
      versionSupported === true
        ? diagnostic(
            "git.executable",
            "pass",
            "healthy",
            "Git 2.42 or newer is available.",
          )
        : diagnostic(
            "git.executable",
            "fail",
            versionSupported === false ? "unsupported" : "invalid",
            versionSupported === false
              ? "Git 2.42 or newer is required; install a supported Git release."
              : "The installed Git version could not be determined.",
          ),
    ];
    try {
      if (
        this.runCommand(
          "git",
          ["rev-parse", "--is-inside-work-tree"],
          this.cwd,
        ).trim() !== "true"
      ) {
        throw new Error("outside worktree");
      }
    } catch {
      diagnostics.push(
        diagnostic(
          "git.repository",
          "fail",
          "missing",
          "The current directory is not a Git worktree; run Diffler in a repository.",
        ),
        diagnostic(
          "git.head",
          "fail",
          "unavailable",
          "HEAD status is unavailable outside a Git worktree.",
        ),
        diagnostic(
          "git.worktree",
          "fail",
          "unavailable",
          "Worktree status is unavailable outside a Git worktree.",
        ),
      );
      return diagnostics;
    }
    diagnostics.push(
      diagnostic(
        "git.repository",
        "pass",
        "healthy",
        "The current directory is a Git worktree.",
      ),
    );

    try {
      this.runCommand(
        "git",
        ["rev-parse", "--verify", "HEAD^{commit}"],
        this.cwd,
      );
      diagnostics.push(
        diagnostic("git.head", "pass", "healthy", "HEAD resolves to a commit."),
      );
    } catch {
      diagnostics.push(
        diagnostic(
          "git.head",
          "fail",
          "invalid",
          "HEAD does not resolve to a commit; create or select a valid commit.",
        ),
      );
    }

    try {
      const dirty =
        this.runCommand("git", ["status", "--porcelain"], this.cwd).length > 0;
      diagnostics.push(
        dirty
          ? diagnostic(
              "git.worktree",
              "warn",
              "dirty",
              "The Git worktree has uncommitted changes; commit or stash them for reproducible results.",
            )
          : diagnostic(
              "git.worktree",
              "pass",
              "healthy",
              "The Git worktree is clean.",
            ),
      );
    } catch {
      diagnostics.push(
        diagnostic(
          "git.worktree",
          "fail",
          "unavailable",
          "The Git worktree state could not be determined.",
        ),
      );
    }
    return diagnostics;
  }

  private async checkSchema(): Promise<DoctorDiagnostic> {
    try {
      const value: unknown = JSON.parse(
        await this.readTextFile(this.schemaPath),
      );
      if (
        !isRecord(value) ||
        !isRecord(value.properties) ||
        !isRecord(value.properties.schemaVersion) ||
        value.properties.schemaVersion.const !== 1
      ) {
        throw new Error("invalid schema");
      }
      return diagnostic(
        "asset.schema",
        "pass",
        "healthy",
        "The packaged quiz schema is valid.",
      );
    } catch (error) {
      return diagnostic(
        "asset.schema",
        "fail",
        isMissingFile(error) ? "missing" : "invalid",
        "The packaged quiz schema is missing or invalid; reinstall Diffler.",
      );
    }
  }

  private async checkPackagedSkill(): Promise<DoctorDiagnostic> {
    try {
      const contents = await this.readTextFile(this.packagedSkillPath);
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
        contents,
      )?.[1];
      if (
        frontmatter === undefined ||
        !/^name:\s*diffler\s*$/m.test(frontmatter)
      ) {
        throw new Error("invalid skill");
      }
      return diagnostic(
        "asset.skill",
        "pass",
        "healthy",
        "The packaged Diffler skill is valid.",
      );
    } catch (error) {
      return diagnostic(
        "asset.skill",
        "fail",
        isMissingFile(error) ? "missing" : "invalid",
        "The packaged Diffler skill is missing or invalid; reinstall Diffler.",
      );
    }
  }

  private async checkAuth(): Promise<DoctorDiagnostic[]> {
    try {
      const authorized = await this.authService.status();
      return [
        diagnostic(
          "keychain.access",
          "pass",
          "healthy",
          "The operating-system keychain is accessible.",
        ),
        authorized
          ? diagnostic(
              "auth.google",
              "pass",
              "healthy",
              "Google authorization is valid.",
            )
          : diagnostic(
              "auth.google",
              "fail",
              "missing",
              "Google authorization is missing; run diffler auth login.",
            ),
      ];
    } catch (error) {
      if (isKeychainAccessError(error)) {
        return [
          diagnostic(
            "keychain.access",
            "fail",
            "unavailable",
            "The operating-system keychain is unavailable; start or unlock a supported keychain service.",
          ),
          diagnostic(
            "auth.google",
            "fail",
            "unavailable",
            "Google authorization cannot be checked until the keychain is accessible.",
          ),
        ];
      }
      return [
        diagnostic(
          "keychain.access",
          "pass",
          "healthy",
          "The operating-system keychain is accessible.",
        ),
        diagnostic(
          "auth.google",
          "fail",
          "invalid",
          "Google authorization is invalid; run diffler auth login again.",
        ),
      ];
    }
  }

  private async checkSkills(): Promise<DoctorDiagnostic[]> {
    const checks = await Promise.all(
      SKILL_TARGETS.map(async ([agent, scope]) => {
        const id = `skill.${agent}.${scope}`;
        try {
          const status = await this.skillService(agent, scope).status();
          let result: DoctorDiagnostic;
          const { state } = status;
          switch (state) {
            case "current":
              result = diagnostic(
                id,
                "pass",
                "healthy",
                `${skillLabel(agent, scope)} is current.`,
              );
              break;
            case "missing":
              result = diagnostic(
                id,
                "warn",
                "missing",
                `${skillLabel(agent, scope)} is not installed; run diffler skill install ${agent} --scope ${scope}.`,
              );
              break;
            case "outdated":
              result = diagnostic(
                id,
                "warn",
                "outdated",
                `${skillLabel(agent, scope)} is outdated; reinstall it to update.`,
              );
              break;
            case "modified":
              result = diagnostic(
                id,
                "fail",
                "modified",
                `${skillLabel(agent, scope)} was modified; review it before reinstalling.`,
              );
              break;
            case "conflict":
              result = status.discoverable
                ? diagnostic(
                    id,
                    "warn",
                    "conflict",
                    `${skillLabel(agent, scope)} is discoverable but is not managed by Diffler.`,
                  )
                : diagnostic(
                    id,
                    "fail",
                    "conflict",
                    `${skillLabel(agent, scope)} conflicts with the packaged skill; resolve it before installing.`,
                  );
              break;
          }
          return { diagnostic: result, discoverable: status.discoverable };
        } catch {
          return {
            diagnostic: diagnostic(
              id,
              "fail",
              "unavailable",
              `${skillLabel(agent, scope)} status could not be determined.`,
            ),
            discoverable: false,
          };
        }
      }),
    );
    const diagnostics = checks.map(({ diagnostic: result }) => result);
    const discoverable = checks.some((check) => check.discoverable);
    diagnostics.push(
      discoverable
        ? diagnostic(
            "skill.discovery",
            "pass",
            "healthy",
            "At least one current Diffler skill is installed at a discoverable path.",
          )
        : diagnostic(
            "skill.discovery",
            "fail",
            "missing",
            "No current Diffler skill is discoverable; install one with diffler skill install.",
          ),
    );
    return diagnostics;
  }
}

export function createDoctorService(
  options: DoctorServiceOptions = {},
): DoctorService {
  return new ProductionDoctorService(options);
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function diagnostic(
  id: string,
  status: DiagnosticStatus,
  state: DiagnosticState,
  message: string,
): DoctorDiagnostic {
  return { id, status, state, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isKeychainAccessError(error: unknown): boolean {
  return error instanceof AuthError && error.message === KEYCHAIN_ERROR_MESSAGE;
}

function satisfiesMinimum(
  version: string,
  engine: string,
): boolean | undefined {
  const actual = parseVersion(version);
  const required = /^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(engine.trim());
  if (actual === undefined || required === null) {
    return undefined;
  }
  const minimum = [
    Number(required[1]),
    Number(required[2] ?? 0),
    Number(required[3] ?? 0),
  ];
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== minimum[index]) {
      return (actual[index] ?? 0) > (minimum[index] ?? 0);
    }
  }
  return true;
}

function parseVersion(
  version: string,
): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function satisfiesGitMinimum(output: string): boolean | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/i.exec(output.trim());
  if (match === null) {
    return undefined;
  }
  const version: readonly [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  ];
  const minimum: readonly [number, number, number] = [2, 42, 0];
  for (let index = 0; index < version.length; index += 1) {
    if (version[index] !== minimum[index]) {
      return (version[index] ?? 0) > (minimum[index] ?? 0);
    }
  }
  return true;
}

function skillLabel(agent: SkillAgent, scope: SkillScope): string {
  return `${agent === "claude" ? "Claude Code" : "OpenCode"} ${scope} skill`;
}
