import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { run } from "./cli.js";
import { collectDiffContext, DiffContextError } from "./diff-context.js";

const repositories: string[] = [];

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("Feature: branch diff context", () => {
  it("Scenario: a branch adds, modifies, renames, and deletes files", () => {
    // Given
    const repository = createRepository();
    write(repository, "modified.ts", "export const value = 1;\n");
    write(repository, "deleted.ts", "export const deleted = true;\n");
    write(repository, "old-name.ts", "export const renamed = true;\n");
    write(repository, "old-two.ts", "export const renamedTwice = true;\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "modified.ts", "export const value = 2;\n");
    write(repository, "added.ts", "export const added = true;\n");
    rmSync(join(repository, "deleted.ts"));
    renameSync(
      join(repository, "old-name.ts"),
      join(repository, "new-name.ts"),
    );
    renameSync(join(repository, "old-two.ts"), join(repository, "new-two.ts"));
    git(repository, "add", "-A");
    commit(repository, "feature changes");
    git(repository, "config", "diff.renameLimit", "1");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(
      context.files.map((file) => ({
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
      })),
    ).toEqual([
      { path: "added.ts", previousPath: undefined, status: "added" },
      { path: "deleted.ts", previousPath: undefined, status: "deleted" },
      { path: "modified.ts", previousPath: undefined, status: "modified" },
      {
        path: "new-name.ts",
        previousPath: "old-name.ts",
        status: "renamed",
      },
      {
        path: "new-two.ts",
        previousPath: "old-two.ts",
        status: "renamed",
      },
    ]);
    expect(context.files.every((file) => file.chunks.length > 0)).toBe(true);
    expect(context.comparison.baseRef).toBe("main");
    expect(context.comparison.mergeBaseSha).toBe(context.comparison.baseSha);
  });

  it("Scenario: the same committed branch is collected twice", () => {
    // Given
    const repository = createRepository();
    write(repository, "café.ts", "export const café = false;\n");
    write(repository, "spaced.txt", `${numberedLines("same", 12)}\n`);
    write(repository, "blank.txt", "one\n\nthree\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "café.ts", "export const café = true;\n");
    write(repository, "blank.txt", "ONE\n\nthree\n");
    const spacedLines = numberedLines("same", 12).split("\n");
    spacedLines[0] = "changed first";
    spacedLines[11] = "changed last";
    write(repository, "spaced.txt", `${spacedLines.join("\n")}\n`);
    commit(repository, "feature changes");

    // When
    const first = collectDiffContext({ cwd: repository, baseRef: "main" });
    git(repository, "config", "diff.noprefix", "true");
    git(repository, "config", "diff.algorithm", "histogram");
    git(repository, "config", "diff.indentHeuristic", "true");
    git(repository, "config", "diff.interHunkContext", "100");
    git(repository, "config", "diff.renameLimit", "1");
    git(repository, "config", "diff.suppressBlankEmpty", "true");
    git(repository, "config", "core.quotePath", "true");
    write(repository, ".gitattributes", "*.ts -diff\n");
    write(repository, ".git/info/attributes", "*.ts diff=custom\n");
    git(repository, "config", "diff.custom.xfuncname", "^MARKER");
    const second = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(second.diffHash).toBe(first.diffHash);
    expect(second).toEqual(first);
  });

  it("Scenario: generated, configured, and binary changes are omitted", () => {
    // Given
    const repository = createRepository();
    write(repository, "source.ts", "export const baseline = true;\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "source.ts", "export const baseline = false;\n");
    write(repository, "package-lock.json", "{}\n");
    write(repository, "dist/output.js", "generated();\n");
    write(repository, "private/notes.md", "internal\n");
    writeFileSync(join(repository, "image.bin"), Buffer.from([0, 1, 2, 3]));
    git(repository, "add", "-A");
    commit(repository, "mixed changes");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      excludePaths: ["private"],
    });

    // Then
    expect(context.files.map((file) => file.path)).toEqual(["source.ts"]);
    expect(
      context.omissions.map((omission) => [omission.path, omission.reason]),
    ).toEqual([
      ["dist/output.js", "excluded"],
      ["image.bin", "binary"],
      ["package-lock.json", "excluded"],
      ["private/notes.md", "excluded"],
    ]);
    expect(context.summary.totalFiles).toBe(5);
    expect(context.limits.excludePaths).toEqual(["private"]);
  });

  it("Scenario: a file is renamed out of an excluded path", () => {
    // Given
    const repository = createRepository();
    write(repository, "private/config.txt", "SECRET=old\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    mkdirSync(join(repository, "public"), { recursive: true });
    renameSync(
      join(repository, "private/config.txt"),
      join(repository, "public/config.txt"),
    );
    commit(repository, "move config");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      excludePaths: ["private"],
    });

    // Then
    expect(context.files).toEqual([]);
    expect(context.omissions).toEqual([
      {
        path: "public/config.txt",
        previousPath: "private/config.txt",
        status: "renamed",
        reason: "excluded",
      },
    ]);
  });

  it("Scenario: common credential files are omitted by default", () => {
    // Given
    const repository = createRepository();
    write(repository, "source.ts", "export const baseline = true;\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "source.ts", "export const baseline = false;\n");
    write(repository, ".env.production", "API_TOKEN=secret\n");
    write(repository, "credentials/service.json", '{"private_key":"secret"}\n');
    write(repository, "client_secret_local.json", '{"secret":true}\n');
    write(repository, "signing.key", "secret\n");
    commit(repository, "mixed source and credentials");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files.map((file) => file.path)).toEqual(["source.ts"]);
    expect(context.omissions).toEqual([
      {
        path: ".env.production",
        status: "added",
        reason: "sensitive",
      },
      {
        path: "client_secret_local.json",
        status: "added",
        reason: "sensitive",
      },
      {
        path: "credentials/service.json",
        status: "added",
        reason: "sensitive",
      },
      { path: "signing.key", status: "added", reason: "sensitive" },
    ]);
  });

  it("Scenario: a credential is added to an ordinary source file", () => {
    // Given
    const repository = createRepository();
    write(repository, "config.ts", "export const enabled = false;\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(
      repository,
      "config.ts",
      'export const access_token = "ya29.this-is-a-sensitive-access-token";\n',
    );
    commit(repository, "accidental credential");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files).toEqual([]);
    expect(context.omissions).toEqual([
      { path: "config.ts", status: "modified", reason: "sensitive" },
    ]);
  });

  it("Scenario: a credential is removed from an ordinary source file", () => {
    // Given
    const repository = createRepository();
    write(repository, "config.txt", "API_TOKEN=removed-sensitive-token\n");
    commit(repository, "baseline credential");
    git(repository, "switch", "-c", "feature");
    write(repository, "config.txt", "credential removed\n");
    commit(repository, "remove credential");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files).toEqual([]);
    expect(context.omissions).toEqual([
      { path: "config.txt", status: "modified", reason: "sensitive" },
    ]);
  });

  it("Scenario: a credential path uses uppercase characters", () => {
    // Given
    const repository = createRepository();
    write(repository, "source.ts", "export const baseline = true;\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "Credentials/SIGNING.PEM", "not model context\n");
    commit(repository, "credential file");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files).toEqual([]);
    expect(context.omissions[0]?.reason).toBe("sensitive");
  });

  it("Scenario: a literal filename contains Git pathspec metacharacters", () => {
    // Given
    const repository = createRepository();
    write(repository, "a*.txt", "visible old\n");
    write(repository, "abc.txt", "SECRET=old\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "a*.txt", "visible new\n");
    write(repository, "abc.txt", "SECRET=new\n");
    commit(repository, "change matching names");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      excludePaths: ["abc.txt"],
    });

    // Then
    expect(context.files.map((file) => file.path)).toEqual(["a*.txt"]);
    const visiblePatch = context.files[0]?.chunks
      .map((chunk) => chunk.text)
      .join("");
    expect(visiblePatch).toContain("visible new");
    expect(visiblePatch).not.toContain("SECRET");
    expect(visiblePatch).not.toContain("abc.txt");
  });

  it("Scenario: a literal filename begins with Git pathspec magic", () => {
    // Given
    const repository = createRepository();
    write(repository, ":(glob)*.txt", "old\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, ":(glob)*.txt", "new\n");
    commit(repository, "change magic path");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files).toHaveLength(1);
    expect(context.files[0]).toMatchObject({
      path: ":(glob)*.txt",
      status: "modified",
    });
  });

  it("Scenario: a changed file exceeds the context budget", () => {
    // Given
    const repository = createRepository();
    write(repository, "large.txt", `${numberedLines("before", 80)}\n`);
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "large.txt", `${numberedLines("after", 80)}\n`);
    commit(repository, "large change");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      maxPatchBytes: 500,
      maxChunkBytes: 120,
    });

    // Then
    expect(context.files[0]?.path).toBe("large.txt");
    expect(context.files[0]?.chunks.length).toBeGreaterThan(1);
    expect(context.files[0]?.chunks.every((chunk) => chunk.bytes <= 120)).toBe(
      true,
    );
    expect(context.limits.includedPatchBytes).toBeLessThanOrEqual(500);
    expect(
      context.omissions.some((omission) => omission.reason === "budget"),
    ).toBe(true);
    expect(
      context.omissions.find((omission) => omission.reason === "budget")
        ?.omittedChunks?.count,
    ).toBeGreaterThan(0);
    expect(
      context.omissions.filter((omission) => omission.reason === "budget"),
    ).toHaveLength(1);
    expect(context.summary.partiallyIncludedFiles).toBe(1);
    expect(context.summary.omittedFiles).toBe(0);
  });

  it("Scenario: a file contains many isolated hunks", () => {
    // Given
    const repository = createRepository();
    write(repository, "many-hunks.txt", `${numberedLines("before", 201)}\n`);
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    const lines = numberedLines("before", 201).split("\n");
    for (let index = 0; index < lines.length; index += 8) {
      lines[index] = `after line ${index}`;
    }
    write(repository, "many-hunks.txt", `${lines.join("\n")}\n`);
    commit(repository, "many isolated changes");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      maxChunkBytes: 10_000,
    });

    // Then
    const hunks = context.files[0]?.chunks.filter(
      (chunk) => chunk.kind === "hunk",
    );
    expect(hunks).toHaveLength(26);
    expect(hunks?.map((chunk) => chunk.section)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );
    expect(hunks?.map((chunk) => chunk.text).join("")).toContain(
      "after line 200",
    );
  });

  it("Scenario: a user selects a small chunk ceiling for Unicode changes", () => {
    // Given
    const repository = createRepository();
    write(repository, "unicode.txt", "before\n");
    commit(repository, "baseline");
    git(repository, "switch", "-c", "feature");
    write(repository, "unicode.txt", "😀😀😀 after\n");
    commit(repository, "unicode change");

    // When
    const context = collectDiffContext({
      cwd: repository,
      baseRef: "main",
      maxPatchBytes: 10_000,
      maxChunkBytes: 8,
    });

    // Then
    expect(context.files[0]?.chunks.length).toBeGreaterThan(1);
    expect(context.files[0]?.chunks.every((chunk) => chunk.bytes <= 8)).toBe(
      true,
    );
  });

  it("Scenario: no base is supplied and the repository has a local main branch", () => {
    // Given
    const repository = repositoryWithSingleChange();
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://token:secret@invalid.example/repo.git",
    );

    // When
    const context = collectDiffContext({ cwd: repository });

    // Then
    expect(context.comparison.baseRef).toBe("main");
    expect(context.repository.remote).toBe("https://invalid.example/repo.git");
  });

  it("Scenario: a malformed credential-bearing remote cannot be sanitized", () => {
    // Given
    const repository = repositoryWithSingleChange();
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://token:secret@[invalid/repo.git",
    );

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.repository.remote).toBeUndefined();
  });

  it("Scenario: a remote carries credentials in its query string", () => {
    // Given
    const repository = repositoryWithSingleChange();
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://invalid.example/repo.git?access_token=secret",
    );

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.repository.remote).toBeUndefined();
  });

  it("Scenario: a remote carries credentials in its fragment", () => {
    // Given
    const repository = repositoryWithSingleChange();
    git(
      repository,
      "remote",
      "add",
      "origin",
      "https://invalid.example/repo.git#access_token=secret",
    );

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.repository.remote).toBeUndefined();
  });

  it("Scenario: the base branch advances after the feature branch diverges", () => {
    // Given
    const repository = repositoryWithSingleChange();
    const featureSha = git(repository, "rev-parse", "HEAD");
    git(repository, "switch", "main");
    write(repository, "main-only.ts", "export const mainOnly = true;\n");
    commit(repository, "main advances");
    git(repository, "switch", "feature");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.comparison.headSha).toBe(featureSha);
    expect(context.comparison.mergeBaseSha).not.toBe(
      context.comparison.baseSha,
    );
    expect(context.files.map((file) => file.path)).toEqual(["source.ts"]);
  });

  it("Scenario: a branch updates a local submodule", () => {
    // Given
    const child = createRepository();
    write(child, "child.txt", "one\n");
    commit(child, "child baseline");
    const repository = createRepository();
    git(
      repository,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      child,
      "sub",
    );
    commit(repository, "add submodule");
    git(repository, "switch", "-c", "feature");
    git(join(repository, "sub"), "config", "user.email", "diffler@example.com");
    git(join(repository, "sub"), "config", "user.name", "Diffler Tests");
    write(join(repository, "sub"), "child.txt", "two\n");
    commit(join(repository, "sub"), "child update");
    git(repository, "add", "sub");
    commit(repository, "update submodule");

    // When
    const context = collectDiffContext({ cwd: repository, baseRef: "main" });

    // Then
    expect(context.files).toHaveLength(1);
    expect(context.files[0]).toMatchObject({ path: "sub", status: "modified" });
    expect(
      context.files[0]?.chunks.map((chunk) => chunk.text).join(""),
    ).toContain("Subproject commit");
  });

  it("Scenario: collection runs outside a Git repository", () => {
    // Given
    const directory = temporaryDirectory();

    // When
    const collect = () =>
      collectDiffContext({ cwd: directory, baseRef: "main" });

    // Then
    expect(collect).toThrowError(DiffContextError);
    expect(collect).toThrowError(/Not a Git repository/);
  });

  it("Scenario: an explicit base ref does not exist locally", () => {
    // Given
    const repository = repositoryWithSingleChange();

    // When
    const collect = () =>
      collectDiffContext({ cwd: repository, baseRef: "origin/missing" });

    // Then
    expect(collect).toThrowError(/Unable to resolve base ref: origin\/missing/);
  });
});

describe("Feature: diff context CLI", () => {
  it("Scenario: a user writes context to a chosen path", async () => {
    // Given
    const repository = repositoryWithSingleChange();
    const output: string[] = [];
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["context", "--base", "main", "--output", "artifacts/context.json"],
      (message) => output.push(message),
      (message) => errors.push(message),
      repository,
    );
    const context = JSON.parse(
      readFileSync(join(repository, "artifacts/context.json"), "utf8"),
    );

    // Then
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toEqual(["Wrote diff context to artifacts/context.json"]);
    expect(context).toMatchObject({
      schemaVersion: 1,
      comparison: { baseRef: "main" },
      summary: { totalFiles: 1 },
    });
    expect(
      statSync(join(repository, "artifacts/context.json")).mode & 0o777,
    ).toBe(0o600);
  });

  it("Scenario: the output path is a symbolic link", async () => {
    // Given
    const repository = repositoryWithSingleChange();
    const output: string[] = [];
    const errors: string[] = [];
    write(repository, "victim.txt", "unchanged\n");
    mkdirSync(join(repository, ".diffler"), { recursive: true });
    symlinkSync("../victim.txt", join(repository, ".diffler/context.json"));

    // When
    const exitCode = await run(
      ["context", "--base", "main"],
      (message) => output.push(message),
      (message) => errors.push(message),
      repository,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors[0]).toContain("Unsafe output file");
    expect(readFileSync(join(repository, "victim.txt"), "utf8")).toBe(
      "unchanged\n",
    );
  });
});

function repositoryWithSingleChange(): string {
  const repository = createRepository();
  write(repository, "source.ts", "export const value = 1;\n");
  commit(repository, "baseline");
  git(repository, "switch", "-c", "feature");
  write(repository, "source.ts", "export const value = 2;\n");
  commit(repository, "feature change");
  return repository;
}

function createRepository(): string {
  const repository = temporaryDirectory();
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "diffler@example.com");
  git(repository, "config", "user.name", "Diffler Tests");
  return repository;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "diffler-"));
  repositories.push(directory);
  return directory;
}

function write(repository: string, path: string, contents: string): void {
  const destination = join(repository, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commit(repository: string, message: string): void {
  git(repository, "add", "-A");
  git(repository, "commit", "--message", message);
}

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function numberedLines(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${prefix} line ${index}`,
  ).join("\n");
}
