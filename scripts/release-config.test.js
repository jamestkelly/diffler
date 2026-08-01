import { readFileSync } from "node:fs";

import { analyzeCommits } from "@semantic-release/commit-analyzer";
import { describe, expect, it } from "vitest";

const releaseConfig = JSON.parse(
  readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8"),
);
const analyzerOptions = releaseConfig.plugins[0][1];
const logger = { log: () => undefined };

describe("Feature: semantic release classification", () => {
  it.each([
    ["feat: add first-party login", "minor"],
    ["fix: preserve the callback state", "patch"],
    ["perf: scan each hunk once", "patch"],
    ["revert: remove first-party login", "patch"],
    ["feat!: replace the quiz contract", "major"],
    ["docs: explain npm recovery", null],
    ["test: cover a release rule", null],
    ["refactor: simplify the publisher", null],
    ["ci: pin the release workflow", null],
    ["chore: update repository metadata", null],
  ])("Scenario: %s calculates %s", async (message, expected) => {
    // Given
    const context = { commits: [{ message }], cwd: process.cwd(), logger };

    // When
    const release = await analyzeCommits(analyzerOptions, context);

    // Then
    expect(release).toBe(expected);
  });
});
