import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { injectGoogleOAuthClient } from "./inject-google-oauth-client.js";

describe("Feature: release-time Google OAuth client injection", () => {
  it("Scenario: release configuration is written atomically", async () => {
    // Given
    const output = temporaryOutput();

    // When
    await injectGoogleOAuthClient(
      {
        DIFFLER_GOOGLE_CLIENT_ID:
          "543831196078-synthetic.apps.googleusercontent.com",
        DIFFLER_GOOGLE_CLIENT_SECRET: "synthetic-public-client-value",
      },
      output,
    );

    // Then
    expect(readFileSync(output, "utf8")).toBe(
      'export const generatedFirstPartyGoogleClient = Object.freeze({"clientId":"543831196078-synthetic.apps.googleusercontent.com","clientSecret":"synthetic-public-client-value"});\n',
    );
    expect(existsSync(`${output}.${process.pid}.tmp`)).toBe(false);
  });

  it("Scenario: invalid release configuration removes stale output", async () => {
    // Given
    const secret = "do-not-print-this-client-value";
    const output = temporaryOutput();
    writeFileSync(output, "stale-client-configuration");

    // When
    const inject = () =>
      injectGoogleOAuthClient(
        {
          DIFFLER_GOOGLE_CLIENT_ID: "test-project-client",
          DIFFLER_GOOGLE_CLIENT_SECRET: secret,
        },
        output,
      );

    // Then
    await expect(inject).rejects.toThrowError(
      "Production Google Desktop client ID has an unexpected format",
    );
    expect(existsSync(output)).toBe(false);
    await expect(inject).rejects.not.toThrowError(secret);
  });
});

function temporaryOutput(): string {
  const directory = mkdtempSync(join(tmpdir(), "diffler-oauth-injection-"));
  return join(directory, "google-oauth-client.generated.js");
}
