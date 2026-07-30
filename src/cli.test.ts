import { describe, expect, it } from "vitest";

import { HELP_TEXT, run } from "./cli.js";

describe("Feature: CLI invocation", () => {
  it("Scenario: a user invokes Diffler without arguments", () => {
    // Given
    const output: string[] = [];

    // When
    const exitCode = run([], (message) => output.push(message));

    // Then
    expect(exitCode).toBe(0);
    expect(output).toEqual([HELP_TEXT]);
  });

  it("Scenario: a user supplies an unknown argument", () => {
    // Given
    const output: string[] = [];

    // When
    const exitCode = run(["--unknown"], (message) => output.push(message));

    // Then
    expect(exitCode).toBe(1);
    expect(output).toEqual(["Unknown argument: --unknown"]);
  });
});
