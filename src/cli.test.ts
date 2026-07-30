import { describe, expect, it } from "vitest";

import type { AuthService } from "./auth.js";
import { HELP_TEXT, run } from "./cli.js";

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
});

class StubAuthService implements AuthService {
  credentialsPath: string | null = null;
  authenticated = false;

  async login(credentialsPath: string): Promise<void> {
    this.credentialsPath = credentialsPath;
    this.authenticated = true;
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
