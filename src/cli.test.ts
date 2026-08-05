import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AuthService } from "./auth.js";
import { HELP_TEXT, run } from "./cli.js";
import { collectDiffContext } from "./diff-context.js";
import type { DoctorService } from "./doctor.js";
import type { PublishedForm, QuizPublisher } from "./google-forms.js";
import type { QuizDocument } from "./quiz.js";
import type { SkillStatus, SkillStatusState } from "./skill-installation.js";

describe("Feature: CLI invocation", () => {
  it("Scenario: a user invokes Diffler without arguments", async () => {
    // Given
    const output: string[] = [];

    // When
    const exitCode = await run([], (message) => output.push(message));

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual([HELP_TEXT]);
  });

  it("Scenario: a user supplies an unknown argument", async () => {
    // Given
    const output: string[] = [];
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["--unknown"],
      (message) => output.push(message),
      (message) => errors.push(message),
    );

    // Then
    expect(exitCode).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toEqual(["Unknown command: --unknown"]);
  });

  it("Scenario: a user logs in with a credentials file", async () => {
    // Given
    const output: string[] = [];
    const auth = new StubAuthService();

    // When
    const exitCode = await run(
      ["auth", "login", "--credentials", "private/client.json"],
      (message) => output.push(message),
      console.error,
      "/workspace",
      auth,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(auth.credentialsPath).toBe("/workspace/private/client.json");
    expect(output).toEqual([
      "Authenticated with Google; refresh credentials stored in the OS keychain",
    ]);
  });

  it("Scenario: a user logs in with Diffler's first-party client", async () => {
    // Given
    const output: string[] = [];
    const auth = new StubAuthService();

    // When
    const exitCode = await run(
      ["auth", "login"],
      (message) => output.push(message),
      console.error,
      "/workspace",
      auth,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(auth.credentialsPath).toBeUndefined();
    expect(auth.loginCalled).toBe(true);
    expect(output).toEqual([
      "Authenticated with Google; refresh credentials stored in the OS keychain",
    ]);
  });

  it("Scenario: a user checks status before logging in", async () => {
    // Given
    const errors: string[] = [];
    const auth = new StubAuthService();

    // When
    const exitCode = await run(
      ["auth", "status"],
      console.log,
      (message) => errors.push(message),
      process.cwd(),
      auth,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "Not authenticated with Google; run diffler auth login",
    ]);
  });

  it("Scenario: a user logs out", async () => {
    // Given
    const output: string[] = [];
    const auth = new StubAuthService();
    auth.authenticated = true;

    // When
    const exitCode = await run(
      ["auth", "logout"],
      (message) => output.push(message),
      console.error,
      process.cwd(),
      auth,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "Removed Google authorization from the OS keychain",
    ]);
  });

  it("Scenario: a user publishes a validated quiz document", async () => {
    // Given
    const output: string[] = [];
    const publisher = new StubQuizPublisher();
    const repository = contextBoundQuizRepository();

    // When
    const exitCode = await run(
      ["publish", "quiz.json", "--context", "context.json"],
      (message) => output.push(message),
      console.error,
      repository,
      new StubAuthService(),
      publisher,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(publisher.document?.title).toBe("Context-bound quiz");
    expect(output).toEqual([
      "Published Google Form form-123",
      "Responder: https://docs.google.com/forms/d/e/responder/viewform",
      "Editor: https://docs.google.com/forms/d/form-123/edit",
    ]);
  });

  it("Scenario: an invalid quiz is rejected before publication", async () => {
    // Given
    const errors: string[] = [];
    const publisher = new StubQuizPublisher();
    const repository = contextBoundQuizRepository();
    writeFileSync(join(repository, "quiz.json"), "{}");

    // When
    const exitCode = await run(
      ["publish", "quiz.json", "--context", "context.json"],
      console.log,
      (message) => errors.push(message),
      repository,
      new StubAuthService(),
      publisher,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors[0]).toContain("Invalid quiz document");
    expect(publisher.document).toBeNull();
  });

  it("Scenario: a user asks for publish help", async () => {
    // Given
    const output: string[] = [];

    // When
    const exitCode = await run(["publish", "--help"], (message) =>
      output.push(message),
    );

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual([HELP_TEXT]);
  });

  it("Scenario: a user validates a quiz without publishing it", async () => {
    // Given
    const output: string[] = [];
    const publisher = new StubQuizPublisher();

    // When
    const exitCode = await run(
      ["validate", "examples/quiz.json"],
      (message) => output.push(message),
      console.error,
      new URL("..", import.meta.url).pathname,
      new StubAuthService(),
      publisher,
    );

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual(["Quiz document is valid: 4 questions"]);
    expect(publisher.document).toBeNull();
  });

  it("Scenario: context becomes stale before publication", async () => {
    // Given
    const repository = contextBoundQuizRepository();
    const publisher = new StubQuizPublisher();
    writeFileSync(join(repository, "source.ts"), "export const value = 3;\n");
    git(repository, "add", "source.ts");
    git(repository, "commit", "-m", "later change");
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["publish", "quiz.json", "--context", "context.json"],
      console.log,
      (message) => errors.push(message),
      repository,
      new StubAuthService(),
      publisher,
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "Diff context is stale; collect context again before validating or publishing",
    ]);
    expect(publisher.document).toBeNull();
  });

  it("Scenario: a user installs the Claude skill for an explicit project scope", async () => {
    // Given
    const output: string[] = [];
    let received: unknown;

    // When
    const exitCode = await run(
      ["skill", "install", "claude", "--scope", "project", "--force"],
      (message) => output.push(message),
      console.error,
      "/workspace",
      new StubAuthService(),
      new StubQuizPublisher(),
      {
        createSkillService: (agent, scope) => ({
          status: async () => skillStatus("current"),
          install: async (options) => {
            received = { agent, scope, options };
            return {
              outcome: "replaced",
              targetPath: "/workspace/.claude/skills/diffler/SKILL.md",
              status: skillStatus("current"),
            };
          },
          uninstall: async () => ({
            outcome: "missing",
            targetPath: "unused",
            status: skillStatus("missing"),
          }),
        }),
      },
    );

    // Then
    expect(exitCode).toBe(0);
    expect(received).toEqual({
      agent: "claude",
      scope: "project",
      options: { force: true },
    });
    expect(output).toContain("Diffler skill replaced for claude project scope");
    expect(output).toContain(
      "If Claude Code does not discover the skill, restart it once",
    );
  });

  it("Scenario: a user checks a conflicting OpenCode skill", async () => {
    // Given
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["skill", "status", "opencode", "--scope", "user"],
      console.log,
      (message) => errors.push(message),
      "/workspace",
      new StubAuthService(),
      new StubQuizPublisher(),
      {
        createSkillService: () => ({
          status: async () => skillStatus("conflict"),
          install: async () => ({
            outcome: "refused",
            targetPath: "unused",
            status: skillStatus("conflict"),
          }),
          uninstall: async () => ({
            outcome: "refused",
            targetPath: "unused",
            status: skillStatus("conflict"),
          }),
        }),
      },
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "A conflicting skill exists for opencode user scope; review it before using --force",
    ]);
  });

  it("Scenario: uninstall refuses a conflicting unowned skill", async () => {
    // Given
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["skill", "uninstall", "claude", "--scope", "project", "--force"],
      console.log,
      (message) => errors.push(message),
      "/workspace",
      new StubAuthService(),
      new StubQuizPublisher(),
      {
        createSkillService: () => ({
          status: async () => skillStatus("conflict"),
          install: async () => ({
            outcome: "refused",
            targetPath: "unused",
            status: skillStatus("conflict"),
          }),
          uninstall: async () => ({
            outcome: "refused",
            targetPath: "unused",
            status: skillStatus("conflict"),
          }),
        }),
      },
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "A conflicting unowned skill exists for claude project scope; Diffler will not remove it",
    ]);
  });

  it("Scenario: a skill command omits its required scope", async () => {
    // Given
    const errors: string[] = [];

    // When
    const exitCode = await run(
      ["skill", "install", "claude"],
      console.log,
      (message) => errors.push(message),
    );

    // Then
    expect(exitCode).toBe(1);
    expect(errors).toEqual([
      "Usage: diffler skill <install|status|uninstall> <claude|opencode> --scope <project|user> [--force]",
    ]);
  });

  it("Scenario: doctor reports warnings without failing", async () => {
    // Given
    const output: string[] = [];
    const doctor = stubDoctor([
      {
        id: "auth.google",
        status: "warn",
        state: "missing",
        message: "Google authorization is missing; run diffler auth login.",
      },
    ]);

    // When
    const exitCode = await run(
      ["doctor"],
      (message) => output.push(message),
      console.error,
      "/workspace",
      new StubAuthService(),
      new StubQuizPublisher(),
      { doctor },
    );

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual([
      "[WARN] Google authorization is missing; run diffler auth login.",
    ]);
  });

  it("Scenario: doctor fails when a prerequisite is unhealthy", async () => {
    // Given
    const output: string[] = [];
    const doctor = stubDoctor([
      {
        id: "git.executable",
        status: "fail",
        state: "unavailable",
        message: "Git is unavailable; install Git and ensure it is on PATH.",
      },
    ]);

    // When
    const exitCode = await run(
      ["doctor"],
      (message) => output.push(message),
      console.error,
      "/workspace",
      new StubAuthService(),
      new StubQuizPublisher(),
      { doctor },
    );

    // Then
    expect(exitCode).toBe(1);
    expect(output).toEqual([
      "[FAIL] Git is unavailable; install Git and ensure it is on PATH.",
    ]);
  });
});

class StubAuthService implements AuthService {
  credentialsPath: string | undefined;
  authenticated = false;
  loginCalled = false;

  async login(credentialsPath?: string): Promise<void> {
    this.credentialsPath = credentialsPath;
    this.authenticated = true;
    this.loginCalled = true;
  }

  async status(): Promise<boolean> {
    return this.authenticated;
  }

  async logout(): Promise<boolean> {
    const removed = this.authenticated;
    this.authenticated = false;
    return removed;
  }
}

class StubQuizPublisher implements QuizPublisher {
  document: QuizDocument | null = null;

  async publish(document: QuizDocument): Promise<PublishedForm> {
    this.document = document;
    return {
      formId: "form-123",
      responderUrl: "https://docs.google.com/forms/d/e/responder/viewform",
      editUrl: "https://docs.google.com/forms/d/form-123/edit",
    };
  }
}

function contextBoundQuizRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "diffler-cli-context-"));
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "diffler@example.com");
  git(repository, "config", "user.name", "Diffler Tests");
  writeFileSync(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, "add", "source.ts");
  git(repository, "commit", "-m", "baseline");
  git(repository, "switch", "-c", "feature");
  writeFileSync(join(repository, "source.ts"), "export const value = 2;\n");
  git(repository, "add", "source.ts");
  git(repository, "commit", "-m", "feature");
  const context = collectDiffContext({ cwd: repository, baseRef: "main" });
  writeFileSync(join(repository, "context.json"), JSON.stringify(context));
  writeFileSync(
    join(repository, "quiz.json"),
    JSON.stringify({
      schemaVersion: 1,
      repository: context.repository,
      baseRef: context.comparison.baseRef,
      headSha: context.comparison.headSha,
      diffHash: context.diffHash,
      title: "Context-bound quiz",
      questions: [
        {
          type: "short_answer",
          id: "changed-value",
          prompt: "What is the changed value?",
          required: true,
          points: 1,
          sources: [{ path: "source.ts", startLine: 1, endLine: 1 }],
          correctAnswers: ["2"],
          feedback: { general: "The feature changed the exported value." },
        },
      ],
    }),
  );
  return repository;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function skillStatus(state: SkillStatusState): SkillStatus {
  return {
    state,
    targetPath: "/private/target/SKILL.md",
    manifestPath: "/private/target/.diffler-install.json",
    discoverable: state === "current",
  };
}

function stubDoctor(
  diagnostics: Awaited<ReturnType<DoctorService["diagnose"]>>,
): DoctorService {
  return { diagnose: async () => [...diagnostics] };
}
