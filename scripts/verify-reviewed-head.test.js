import { describe, expect, it } from "vitest";

import { assertReviewedHead } from "./verify-reviewed-head.js";

describe("Feature: release head verification", () => {
  it("Scenario: main still points to the reviewed commit", () => {
    // Given / When / Then
    expect(() =>
      assertReviewedHead("reviewed-sha", "reviewed-sha"),
    ).not.toThrow();
  });

  it("Scenario: main advances before publication", () => {
    // Given / When / Then
    expect(() =>
      assertReviewedHead("reviewed-sha", "new-main-sha"),
    ).toThrowError("Reviewed commit was superseded before publication");
  });
});
