import { describe, expect, it } from "vitest";

import { AuthError } from "./auth.js";
import {
  createDoctorService,
  type DoctorDiagnostic,
  type DoctorServiceOptions,
} from "./doctor.js";
import type {
  SkillAgent,
  SkillScope,
  SkillStatusState,
} from "./skill-installation.js";

const PACKAGE = JSON.stringify({
  name: "@diffler/cli",
  version: "1.2.3",
  bin: { diffler: "./dist/cli.js" },
  engines: { node: ">=24" },
});
const SCHEMA = JSON.stringify({ properties: { schemaVersion: { const: 1 } } });
const SKILL = "---\nname: diffler\ndescription: Test fixture\n---\n# Diffler\n";
const KEYCHAIN_ERROR =
  "Unable to access the operating-system keychain; ensure a keychain service is available";

describe("Feature: local Diffler health diagnostics", () => {
  it("Scenario: every local prerequisite is healthy", async () => {
    // Given
    const fixture = healthyFixture();

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(diagnostics).toHaveLength(15);
    expect(diagnostics.every(({ status }) => status === "pass")).toBe(true);
    expect(new Set(diagnostics.map(({ id }) => id)).size).toBe(
      diagnostics.length,
    );
  });

  it("Scenario: the Node runtime is unsupported", async () => {
    // Given
    const fixture = healthyFixture({ nodeVersion: "23.11.0" });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "runtime.node")).toMatchObject({
      status: "fail",
      state: "unsupported",
    });
  });

  it("Scenario: Git is unavailable", async () => {
    // Given
    const fixture = healthyFixture({
      runCommand: () => {
        throw new Error("secret git output");
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "git.executable")).toMatchObject({
      status: "fail",
      state: "unavailable",
    });
    expect(byId(diagnostics, "git.repository").state).toBe("unavailable");
  });

  it("Scenario: the Git version is unsupported", async () => {
    // Given
    const fixture = healthyFixture({
      runCommand: (_command, args) =>
        args[0] === "--version"
          ? "git version 2.41.0"
          : args.includes("--is-inside-work-tree")
            ? "true\n"
            : "",
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "git.executable")).toMatchObject({
      status: "fail",
      state: "unsupported",
    });
  });

  it("Scenario: the command runs outside a repository", async () => {
    // Given
    const fixture = healthyFixture({
      runCommand: (_command, args) => {
        if (args[0] === "--version") return "git version 2.0";
        throw new Error("not a repository");
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "git.repository")).toMatchObject({
      status: "fail",
      state: "missing",
    });
    expect(byId(diagnostics, "git.head").state).toBe("unavailable");
  });

  it("Scenario: HEAD does not resolve to a commit", async () => {
    // Given
    const fixture = healthyFixture({
      runCommand: (_command, args) => {
        if (args.includes("--verify")) throw new Error("bad ref secret");
        return args.includes("--is-inside-work-tree") ? "true\n" : "";
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "git.head")).toMatchObject({
      status: "fail",
      state: "invalid",
    });
  });

  it("Scenario: the repository has uncommitted changes", async () => {
    // Given
    const fixture = healthyFixture({
      runCommand: (_command, args) =>
        args[0] === "status" ? " M private-file\n" : "true\n",
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "git.worktree")).toMatchObject({
      status: "warn",
      state: "dirty",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("private-file");
  });
});

describe("Feature: packaged doctor assets", () => {
  it("Scenario: package metadata is missing or malformed", async () => {
    // Given
    const missing = healthyFixture({ files: { package: missingFile() } });
    const malformed = healthyFixture({ files: { package: "{not-json" } });

    // When
    const missingDiagnostics = await missing.service.diagnose();
    const malformedDiagnostics = await malformed.service.diagnose();

    // Then
    expect(byId(missingDiagnostics, "package.metadata").state).toBe("missing");
    expect(byId(malformedDiagnostics, "package.metadata").state).toBe(
      "invalid",
    );
    expect(byId(malformedDiagnostics, "runtime.node").state).toBe(
      "unavailable",
    );
  });

  it("Scenario: the packaged schema is missing or malformed", async () => {
    // Given
    const missing = healthyFixture({ files: { schema: missingFile() } });
    const malformed = healthyFixture({
      files: { schema: JSON.stringify({ schemaVersion: { const: 2 } }) },
    });

    // When
    const missingDiagnostics = await missing.service.diagnose();
    const malformedDiagnostics = await malformed.service.diagnose();

    // Then
    expect(byId(missingDiagnostics, "asset.schema").state).toBe("missing");
    expect(byId(malformedDiagnostics, "asset.schema")).toMatchObject({
      status: "fail",
      state: "invalid",
    });
  });

  it("Scenario: the packaged skill is missing or malformed", async () => {
    // Given
    const missing = healthyFixture({ files: { skill: missingFile() } });
    const malformed = healthyFixture({
      files: { skill: "---\nname: another-skill\n---\nsecret-body" },
    });

    // When
    const missingDiagnostics = await missing.service.diagnose();
    const malformedDiagnostics = await malformed.service.diagnose();

    // Then
    expect(byId(missingDiagnostics, "asset.skill").state).toBe("missing");
    expect(byId(malformedDiagnostics, "asset.skill")).toMatchObject({
      status: "fail",
      state: "invalid",
    });
    expect(JSON.stringify(malformedDiagnostics)).not.toContain("secret-body");
  });
});

describe("Feature: secret-safe authorization diagnostics", () => {
  it("Scenario: Google authorization is missing", async () => {
    // Given
    const fixture = healthyFixture({ authStatus: false });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "keychain.access").status).toBe("pass");
    expect(byId(diagnostics, "auth.google")).toMatchObject({
      status: "fail",
      state: "missing",
    });
  });

  it("Scenario: Google authorization is invalid", async () => {
    // Given
    const fixture = healthyFixture({
      authError: new AuthError("provider refresh_token=top-secret"),
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "keychain.access").status).toBe("pass");
    expect(byId(diagnostics, "auth.google")).toMatchObject({
      status: "fail",
      state: "invalid",
    });
  });

  it("Scenario: Google authorization is healthy", async () => {
    // Given
    const fixture = healthyFixture({ authStatus: true });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "keychain.access").status).toBe("pass");
    expect(byId(diagnostics, "auth.google")).toMatchObject({
      status: "pass",
      state: "healthy",
    });
  });

  it("Scenario: the operating-system keychain is unavailable", async () => {
    // Given
    const fixture = healthyFixture({
      authError: new AuthError(KEYCHAIN_ERROR),
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "keychain.access")).toMatchObject({
      status: "fail",
      state: "unavailable",
    });
    expect(byId(diagnostics, "auth.google").state).toBe("unavailable");
  });
});

describe("Feature: agent skill discovery diagnostics", () => {
  it("Scenario: project and user skills are current", async () => {
    // Given
    const fixture = healthyFixture();

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(skillDiagnostics(diagnostics)).toEqual([
      expect.objectContaining({ id: "skill.claude.project", status: "pass" }),
      expect.objectContaining({ id: "skill.claude.user", status: "pass" }),
      expect.objectContaining({ id: "skill.opencode.project", status: "pass" }),
      expect.objectContaining({ id: "skill.opencode.user", status: "pass" }),
      expect.objectContaining({ id: "skill.discovery", status: "pass" }),
    ]);
  });

  it("Scenario: skills are missing or outdated", async () => {
    // Given
    const fixture = healthyFixture({
      skillStates: {
        "claude.project": "missing",
        "opencode.user": "outdated",
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "skill.claude.project")).toMatchObject({
      status: "warn",
      state: "missing",
    });
    expect(byId(diagnostics, "skill.opencode.user")).toMatchObject({
      status: "warn",
      state: "outdated",
    });
  });

  it("Scenario: skills are modified or conflicting", async () => {
    // Given
    const fixture = healthyFixture({
      skillStates: {
        "claude.user": "modified",
        "opencode.project": "conflict",
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "skill.claude.user")).toMatchObject({
      status: "fail",
      state: "modified",
    });
    expect(byId(diagnostics, "skill.opencode.project")).toMatchObject({
      status: "fail",
      state: "conflict",
    });
  });

  it("Scenario: no current skill is discoverable", async () => {
    // Given
    const fixture = healthyFixture({
      skillStates: {
        "claude.project": "missing",
        "claude.user": "missing",
        "opencode.project": "missing",
        "opencode.user": "outdated",
      },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "skill.discovery")).toMatchObject({
      status: "fail",
      state: "missing",
    });
  });

  it("Scenario: a matching manually installed skill remains discoverable", async () => {
    // Given
    const fixture = healthyFixture({
      skillStates: {
        "claude.project": "conflict",
        "claude.user": "missing",
        "opencode.project": "missing",
        "opencode.user": "missing",
      },
      skillDiscoverable: { "claude.project": true },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(byId(diagnostics, "skill.claude.project")).toMatchObject({
      status: "warn",
      state: "conflict",
    });
    expect(byId(diagnostics, "skill.discovery")).toMatchObject({
      status: "pass",
      state: "healthy",
    });
  });

  it("Scenario: warnings occur without diagnostic failures", async () => {
    // Given
    const fixture = healthyFixture({
      dirty: true,
      skillStates: { "claude.project": "missing" },
    });

    // When
    const diagnostics = await fixture.service.diagnose();

    // Then
    expect(diagnostics.some(({ status }) => status === "warn")).toBe(true);
    expect(diagnostics.some(({ status }) => status === "fail")).toBe(false);
  });

  it("Scenario: complete output does not disclose secrets, paths, or provider payloads", async () => {
    // Given
    const secrets = [
      "refresh_token=very-secret",
      "/Users/private/.claude/skills/diffler/SKILL.md",
      "provider-payload-secret",
    ];
    const fixture = healthyFixture({
      authError: new AuthError(secrets[0] as string),
      files: { skill: `---\nname: wrong\n---\n${secrets[2]}` },
      skillStates: { "opencode.user": "conflict" },
      skillReason: `${secrets[1]}: ${secrets[2]}`,
    });

    // When
    const output = JSON.stringify(await fixture.service.diagnose());

    // Then
    for (const secret of secrets) expect(output).not.toContain(secret);
  });
});

interface FixtureOptions
  extends Pick<DoctorServiceOptions, "nodeVersion" | "runCommand"> {
  files?: Partial<Record<"package" | "schema" | "skill", string | Error>>;
  authStatus?: boolean;
  authError?: Error;
  dirty?: boolean;
  skillStates?: Partial<
    Record<`${SkillAgent}.${SkillScope}`, SkillStatusState>
  >;
  skillDiscoverable?: Partial<Record<`${SkillAgent}.${SkillScope}`, boolean>>;
  skillReason?: string;
}

function healthyFixture(options: FixtureOptions = {}) {
  const paths = {
    package: "/virtual/package.json",
    schema: "/virtual/schema.json",
    skill: "/virtual/SKILL.md",
  };
  const files: Record<string, string | Error> = {
    [paths.package]: options.files?.package ?? PACKAGE,
    [paths.schema]: options.files?.schema ?? SCHEMA,
    [paths.skill]: options.files?.skill ?? SKILL,
  };
  const service = createDoctorService({
    cwd: "/virtual/repository",
    home: "/virtual/home",
    env: {},
    nodeVersion: options.nodeVersion ?? "24.1.0",
    packagePath: paths.package,
    schemaPath: paths.schema,
    packagedSkillPath: paths.skill,
    readTextFile: async (path) => {
      const value = files[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw missingFile();
      return value;
    },
    runCommand:
      options.runCommand ??
      ((_command, args) => {
        if (args[0] === "--version") return "git version 2.42.0\n";
        if (args.includes("--is-inside-work-tree")) return "true\n";
        if (args[0] === "status")
          return options.dirty === true ? " M file\n" : "";
        return "ok\n";
      }),
    authService: {
      status: async () => {
        if (options.authError !== undefined) throw options.authError;
        return options.authStatus ?? true;
      },
    },
    skillService: (agent, scope) => ({
      status: async () => ({
        state: options.skillStates?.[`${agent}.${scope}`] ?? "current",
        targetPath: `/do/not/disclose/${agent}/${scope}/SKILL.md`,
        manifestPath: `/do/not/disclose/${agent}/${scope}/manifest.json`,
        discoverable:
          options.skillDiscoverable?.[`${agent}.${scope}`] ??
          (options.skillStates?.[`${agent}.${scope}`] ?? "current") ===
            "current",
        ...(options.skillReason === undefined
          ? {}
          : { reason: options.skillReason }),
      }),
    }),
  });
  return { service };
}

function missingFile(): Error {
  return Object.assign(new Error("secret missing path"), { code: "ENOENT" });
}

function byId(
  diagnostics: readonly DoctorDiagnostic[],
  id: string,
): DoctorDiagnostic {
  const result = diagnostics.find((diagnostic) => diagnostic.id === id);
  if (result === undefined) throw new Error(`Missing diagnostic: ${id}`);
  return result;
}

function skillDiagnostics(
  diagnostics: readonly DoctorDiagnostic[],
): DoctorDiagnostic[] {
  return diagnostics.filter(({ id }) => id.startsWith("skill."));
}
