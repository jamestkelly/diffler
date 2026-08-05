import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveSkillTarget,
  SkillInstallationService,
} from "./skill-installation.js";

describe("Feature: Diffler skill target resolution", () => {
  it("Scenario: macOS and Linux project paths use the current directory", () => {
    // Given
    const cwd = "/work/diffler";

    // When
    const claude = resolveSkillTarget({
      agent: "claude",
      scope: "project",
      cwd,
      home: "/Users/alex",
      path: posix,
    });
    const opencode = resolveSkillTarget({
      agent: "opencode",
      scope: "project",
      cwd,
      home: "/home/alex",
      path: posix,
    });

    // Then
    expect(claude).toBe("/work/diffler/.claude/skills/diffler/SKILL.md");
    expect(opencode).toBe("/work/diffler/.opencode/skills/diffler/SKILL.md");
  });

  it("Scenario: macOS and Linux user paths honor OpenCode precedence", () => {
    // Given
    const common = {
      agent: "opencode" as const,
      scope: "user" as const,
      cwd: "/work",
      home: "/home/alex",
      path: posix,
    };

    // When
    const explicit = resolveSkillTarget({
      ...common,
      env: {
        OPENCODE_CONFIG_DIR: "/opt/opencode",
        XDG_CONFIG_HOME: "/xdg",
      },
    });
    const xdg = resolveSkillTarget({
      ...common,
      env: { XDG_CONFIG_HOME: "/xdg" },
    });
    const fallback = resolveSkillTarget(common);
    const claude = resolveSkillTarget({
      ...common,
      agent: "claude",
      home: "/Users/alex",
      env: { OPENCODE_CONFIG_DIR: "/ignored" },
    });

    // Then
    expect(explicit).toBe("/opt/opencode/skills/diffler/SKILL.md");
    expect(xdg).toBe("/xdg/opencode/skills/diffler/SKILL.md");
    expect(fallback).toBe(
      "/home/alex/.config/opencode/skills/diffler/SKILL.md",
    );
    expect(claude).toBe("/Users/alex/.claude/skills/diffler/SKILL.md");
  });

  it("Scenario: Windows paths use win32 separators", () => {
    // Given
    const options = {
      agent: "opencode" as const,
      scope: "user" as const,
      cwd: "C:\\repo",
      home: "C:\\Users\\Alex",
      env: { XDG_CONFIG_HOME: "D:\\Config" },
      path: win32,
    };

    // When
    const target = resolveSkillTarget(options);

    // Then
    expect(target).toBe("D:\\Config\\opencode\\skills\\diffler\\SKILL.md");
  });
});

describe("Feature: Diffler skill installation lifecycle", () => {
  it("Scenario: a fresh install writes packaged bytes and a minimal manifest", async () => {
    // Given
    const fixture = await createFixture("packaged-v1");

    // When
    const result = await fixture.service.install();

    // Then
    expect(result.outcome).toBe("installed");
    expect(await readFile(fixture.service.targetPath, "utf8")).toBe(
      "packaged-v1",
    );
    const manifest = JSON.parse(
      await readFile(fixture.service.manifestPath, "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(manifest).sort()).toEqual(["schemaVersion", "sha256"]);
    expect(manifest).toMatchObject({ schemaVersion: 1 });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await fixture.service.status()).state).toBe("current");
  });

  it("Scenario: an exact repeat is unchanged", async () => {
    // Given
    const fixture = await createFixture("same bytes");
    await fixture.service.install();
    const manifestBefore = await readFile(fixture.service.manifestPath, "utf8");

    // When
    const result = await fixture.service.install();

    // Then
    expect(result.outcome).toBe("unchanged");
    expect(await readFile(fixture.service.manifestPath, "utf8")).toBe(
      manifestBefore,
    );
  });

  it("Scenario: an owned unmodified installation upgrades", async () => {
    // Given
    const fixture = await createFixture("packaged-v1");
    await fixture.service.install();
    await writeFile(fixture.packagedSkillPath, "packaged-v2");

    // When
    const before = await fixture.service.status();
    const result = await fixture.service.install();

    // Then
    expect(before.state).toBe("outdated");
    expect(result.outcome).toBe("upgraded");
    expect(await readFile(fixture.service.targetPath, "utf8")).toBe(
      "packaged-v2",
    );
  });

  it("Scenario: an unowned conflict is refused or force-replaced", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await mkdir(path.dirname(fixture.service.targetPath), { recursive: true });
    await writeFile(fixture.service.targetPath, "user-owned");

    // When
    const refused = await fixture.service.install();
    const replaced = await fixture.service.install({ force: true });

    // Then
    expect(refused.outcome).toBe("refused");
    expect(refused.status.state).toBe("conflict");
    expect(replaced.outcome).toBe("replaced");
    expect(await readFile(fixture.service.targetPath, "utf8")).toBe("packaged");
  });

  it("Scenario: a matching manually installed skill is discoverable but unowned", async () => {
    // Given
    const packaged = "---\nname: diffler\n---\n# Diffler\n";
    const fixture = await createFixture(packaged);
    await mkdir(path.dirname(fixture.service.targetPath), { recursive: true });
    await writeFile(fixture.service.targetPath, packaged);

    // When
    const status = await fixture.service.status();

    // Then
    expect(status).toMatchObject({
      state: "conflict",
      discoverable: true,
    });
  });

  it("Scenario: a modified owned file is refused", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await fixture.service.install();
    await writeFile(fixture.service.targetPath, "local edit");

    // When
    const status = await fixture.service.status();
    const result = await fixture.service.install();
    const uninstall = await fixture.service.uninstall();

    // Then
    expect(status.state).toBe("modified");
    expect(result.outcome).toBe("refused");
    expect(uninstall.outcome).toBe("refused");
    expect(await readFile(fixture.service.targetPath, "utf8")).toBe(
      "local edit",
    );
  });

  it("Scenario: a malformed manifest is a conflict", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await fixture.service.install();
    await writeFile(fixture.service.manifestPath, "not-json");

    // When
    const status = await fixture.service.status();
    const result = await fixture.service.install();

    // Then
    expect(status.state).toBe("conflict");
    expect(status.reason).toContain("malformed");
    expect(result.outcome).toBe("refused");
  });

  it("Scenario: safe uninstall removes only Diffler-owned files", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await fixture.service.install();

    // When
    const result = await fixture.service.uninstall();

    // Then
    expect(result.outcome).toBe("removed");
    expect((await fixture.service.status()).state).toBe("missing");
    await expect(readFile(fixture.service.targetPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("Scenario: uninstall preserves unrelated sidecars and agent directories", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await fixture.service.install();
    const sidecar = path.join(
      path.dirname(fixture.service.targetPath),
      "notes.md",
    );
    await writeFile(sidecar, "keep me");

    // When
    const result = await fixture.service.uninstall();

    // Then
    expect(result.outcome).toBe("removed");
    expect(await readFile(sidecar, "utf8")).toBe("keep me");
    expect(await realpath(path.dirname(fixture.service.targetPath))).toBe(
      path.dirname(fixture.service.targetPath),
    );
  });

  it("Scenario: uninstalling a missing installation is a successful no-op", async () => {
    // Given
    const fixture = await createFixture("packaged");

    // When
    const result = await fixture.service.uninstall();

    // Then
    expect(result.outcome).toBe("missing");
    expect(result.status.state).toBe("missing");
  });

  it("Scenario: force uninstall preserves an unowned skill", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await mkdir(path.dirname(fixture.service.targetPath), { recursive: true });
    await writeFile(fixture.service.targetPath, "user-owned");

    // When
    const result = await fixture.service.uninstall({ force: true });

    // Then
    expect(result.outcome).toBe("refused");
    expect(await readFile(fixture.service.targetPath, "utf8")).toBe(
      "user-owned",
    );
  });

  it("Scenario: symlink destinations are refused where supported", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await mkdir(path.dirname(fixture.service.targetPath), { recursive: true });
    const external = path.join(fixture.root, "external.md");
    await writeFile(external, "external");
    try {
      await symlink(external, fixture.service.targetPath);
    } catch (error) {
      if (isNodeError(error, "EPERM") || isNodeError(error, "EACCES")) {
        return;
      }
      throw error;
    }

    // When
    const result = await fixture.service.install({ force: true });

    // Then
    expect(result.outcome).toBe("refused");
    expect(result.status.reason).toContain("symbolic link");
    expect(await readFile(external, "utf8")).toBe("external");
  });

  it("Scenario: symlink path components are refused where supported", async () => {
    // Given
    const fixture = await createFixture("packaged");
    const externalDirectory = path.join(fixture.root, "external-directory");
    const agentPath = path.join(fixture.root, "project", ".claude");
    await mkdir(externalDirectory);
    await mkdir(path.dirname(agentPath), { recursive: true });
    try {
      await symlink(externalDirectory, agentPath, "dir");
    } catch (error) {
      if (isNodeError(error, "EPERM") || isNodeError(error, "EACCES")) {
        return;
      }
      throw error;
    }

    // When
    const result = await fixture.service.install({ force: true });

    // Then
    expect(result.outcome).toBe("refused");
    expect(result.status.reason).toContain("symbolic link");
    await expect(
      readFile(path.join(externalDirectory, "skills", "diffler", "SKILL.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("Scenario: hard-linked destinations are refused even with force", async () => {
    // Given
    const fixture = await createFixture("packaged");
    await mkdir(path.dirname(fixture.service.targetPath), { recursive: true });
    const external = path.join(fixture.root, "external.md");
    await writeFile(external, "external");
    await link(external, fixture.service.targetPath);

    // When
    const result = await fixture.service.install({ force: true });

    // Then
    expect(result.outcome).toBe("refused");
    expect(result.status.reason).toContain("hard-linked");
    expect(await readFile(external, "utf8")).toBe("external");
  });

  it("Scenario: a non-directory parent is refused", async () => {
    // Given
    const fixture = await createFixture("packaged");
    const agentDirectory = path.join(fixture.root, "project", ".claude");
    await mkdir(path.dirname(agentDirectory), { recursive: true });
    await writeFile(agentDirectory, "not a directory");

    // When
    const result = await fixture.service.install({ force: true });

    // Then
    expect(result.outcome).toBe("refused");
    expect(result.status.reason).toContain("not a directory");
  });
});

async function createFixture(packagedBytes: string): Promise<{
  root: string;
  packagedSkillPath: string;
  service: SkillInstallationService;
}> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "diffler-skill-"));
  const root = await realpath(temporaryRoot);
  const packagedSkillPath = path.join(root, "packaged-SKILL.md");
  await writeFile(packagedSkillPath, packagedBytes);
  return {
    root,
    packagedSkillPath,
    service: new SkillInstallationService({
      agent: "claude",
      scope: "project",
      cwd: path.join(root, "project"),
      home: path.join(root, "home"),
      packagedSkillPath,
    }),
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
