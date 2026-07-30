import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const skill = readFileSync(
  new URL("../skills/diffler/SKILL.md", import.meta.url),
  "utf8",
);

describe("Feature: portable Diffler skill", () => {
  it("Scenario: Claude Code or OpenCode discovers the skill", () => {
    // Given
    const frontmatter = skill.slice(0, skill.indexOf("\n---", 4));

    // When / Then
    expect(frontmatter).toMatch(/^---\nname: diffler$/m);
    expect(frontmatter).toMatch(
      /^description: .*branch diff.*Use when .*understanding/m,
    );
  });

  it("Scenario: the workflow delegates each boundary to the CLI", () => {
    // Given
    const context = skill.indexOf("diffler context");
    const validate = skill.indexOf("diffler validate");
    const publish = skill.indexOf("diffler publish");

    // When / Then
    expect(context).toBeGreaterThan(0);
    expect(validate).toBeGreaterThan(context);
    expect(publish).toBeGreaterThan(validate);
    expect(skill).toContain("Do not reimplement those operations");
    expect(skill).toContain(
      "diffler validate .diffler/quiz.json --context .diffler/context.json",
    );
    expect(skill).toContain(
      "diffler publish .diffler/quiz.json --context .diffler/context.json",
    );
  });

  it("Scenario: credentials remain outside model context", () => {
    // Given / When / Then
    expect(skill).toContain("Never run `diffler auth login`");
    expect(skill).toContain(
      "Never read, print, request, or deliberately place OAuth client",
    );
    expect(skill).toContain("Never stage or commit them");
    expect(skill).toContain("chmod 600 .diffler/quiz.json");
  });

  it("Scenario: context cannot support a sound quiz", () => {
    // Given / When / Then
    expect(skill).toContain("If `summary.totalFiles` is `0`");
    expect(skill).toContain("cosmetic or trivial changes");
    expect(skill).toContain("omission has reason `budget`");
    expect(skill).toContain("Never infer details from omitted content");
    expect(skill).toMatch(/no\s+greater than `1000000` bytes/);
  });

  it("Scenario: questions test comprehension rather than recall", () => {
    // Given / When / Then
    expect(skill).toContain(
      "test changed behavior, rationale, risk, failure modes, or an invariant",
    );
    expect(skill).toContain(
      "require reasoning rather than line-number, symbol-name, or syntax recall",
    );
    expect(skill).toContain("cite at least one changed repository-relative");
  });
});
