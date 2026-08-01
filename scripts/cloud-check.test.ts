import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunGcloud } from "../src/cloud-readiness.js";
import { run } from "./cloud-check.js";

describe("Feature: cloud readiness command", () => {
  it("Scenario: pnpm forwards a credentials separator", () => {
    // Given
    const output: string[] = [];
    const errors: string[] = [];
    const credentialsPath = writeCredentials("641575763044-client");

    // When
    const exitCode = run(
      ["--", "--test-credentials", credentialsPath],
      readyGcloud,
      (message) => output.push(message),
      (message) => errors.push(message),
    );

    // Then
    expect(exitCode).toBe(0);
    expect(errors).toEqual([]);
    expect(output).toContain(
      "[PASS] [test] Desktop OAuth client matches project number 641575763044",
    );
    expect(output).toContain(
      "[PASS] [production] Project diffler is ACTIVE with number 543831196078",
    );
  });

  it("Scenario: a credential belongs to the wrong environment", () => {
    // Given
    const secret = "do-not-print-this-secret";
    const output: string[] = [];
    const credentialsPath = writeCredentials("641575763044-client", secret);

    // When
    const exitCode = run(
      ["--production-credentials", credentialsPath],
      readyGcloud,
      (message) => output.push(message),
    );

    // Then
    expect(exitCode).toBe(1);
    expect(output).toContain(
      "[FAIL] [production] Desktop OAuth client belongs to a different project; expected client ID prefix 543831196078-",
    );
    expect(output.join("\n")).not.toContain(secret);
  });
});

const readyGcloud: RunGcloud = (args) => {
  if (args[0] === "auth") {
    return "maintainer@example.com";
  }
  if (args[0] === "projects") {
    const projectId = args[2];
    return JSON.stringify({
      projectId,
      projectNumber:
        projectId === "diffler-testing" ? "641575763044" : "543831196078",
      lifecycleState: "ACTIVE",
    });
  }
  if (args[0] === "services") {
    return "forms.googleapis.com";
  }
  if (args[0] === "billing") {
    return JSON.stringify({ billingEnabled: false });
  }
  throw new Error(`Unexpected gcloud command: ${args.join(" ")}`);
};

function writeCredentials(clientId: string, clientSecret?: string): string {
  const directory = mkdtempSync(join(tmpdir(), "diffler-cloud-command-"));
  const path = join(directory, "client.json");
  writeFileSync(
    path,
    JSON.stringify({
      installed: {
        client_id: `${clientId}.apps.googleusercontent.com`,
        ...(clientSecret === undefined ? {} : { client_secret: clientSecret }),
      },
    }),
  );
  return path;
}
