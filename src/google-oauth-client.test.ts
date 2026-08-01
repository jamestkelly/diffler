import { describe, expect, it } from "vitest";

import { loadFirstPartyGoogleClient } from "./google-oauth-client.js";

describe("Feature: injected first-party Google client", () => {
  it("Scenario: a development build has no injected release client", async () => {
    // Given / When
    const load = () => loadFirstPartyGoogleClient();

    // Then
    await expect(load).rejects.toThrowError(
      "Diffler's first-party Google client is unavailable; use --credentials with your own Desktop client or contact the maintainer",
    );
  });
});
