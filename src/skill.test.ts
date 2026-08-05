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

  it("Scenario: the user explicitly chooses delivery after validation", () => {
    // Given
    const validate = skill.indexOf("### 5. Validate Before Delivery");
    const delivery = skill.indexOf("### 6. Choose Delivery");
    const local = skill.indexOf("#### Local Terminal");
    const forms = skill.indexOf("#### Google Forms");

    // When / Then
    expect(validate).toBeGreaterThan(0);
    expect(delivery).toBeGreaterThan(validate);
    expect(local).toBeGreaterThan(delivery);
    expect(forms).toBeGreaterThan(local);
    expect(skill).toContain(
      "If the user already requested local terminal or Google Forms delivery",
    );
    expect(skill).toContain("explicitly ask them to\nchoose a delivery mode");
  });

  it("Scenario: local delivery runs only in the user's interactive terminal", () => {
    // Given / When / Then
    expect(skill).toContain(
      "diffler quiz .diffler/quiz.json --context .diffler/context.json",
    );
    expect(skill).toContain(
      "user runs the quiz command in their own interactive terminal",
    );
    expect(skill).toContain(
      "do not invoke it through a noninteractive agent shell",
    );
    expect(skill).toContain("requires no Google authentication or network");
    expect(skill).toContain(
      "Never ask the user to submit quiz responses through agent chat",
    );
  });

  it("Scenario: Google authentication is confined to Forms delivery", () => {
    // Given
    const local = skill.slice(
      skill.indexOf("#### Local Terminal"),
      skill.indexOf("#### Google Forms"),
    );
    const forms = skill.slice(skill.indexOf("#### Google Forms"));

    // When / Then
    expect(local).not.toContain("diffler auth status");
    expect(forms).toContain("diffler auth status");
    expect(skill).toContain("For Google Forms delivery only");
  });

  it("Scenario: credentials remain outside model context", () => {
    // Given / When / Then
    expect(skill).toContain("Never run `diffler auth login`");
    expect(skill).toContain(
      "Never read, print, request, or deliberately place OAuth client",
    );
    expect(skill).toContain("Never stage or commit them");
    expect(skill).toContain("chmod 600 .diffler/quiz.json");
    expect(skill).toContain("necessarily contains the grading key");
    expect(skill).toContain("Never\n  reveal or summarize");
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

  it("Scenario: the agent adds optional whimsy without exposing answers", () => {
    // Given / When / Then
    expect(skill).toContain("Optionally add `closingRiddle`");
    expect(skill).toContain("Do not include its answer, secrets");
    expect(skill).toContain("original one- or two-line poem");
  });
});
