import { describe, expect, it } from "vitest";

import { HELP_TEXT, run } from "./cli.js";

describe("run", () => {
  it("prints help when no arguments are provided", () => {
    const output: string[] = [];

    const exitCode = run([], (message) => output.push(message));

    expect(exitCode).toBe(0);
    expect(output).toEqual([HELP_TEXT]);
  });

  it("rejects unknown arguments", () => {
    const output: string[] = [];

    const exitCode = run(["--unknown"], (message) => output.push(message));

    expect(exitCode).toBe(1);
    expect(output).toEqual(["Unknown argument: --unknown"]);
  });
});
