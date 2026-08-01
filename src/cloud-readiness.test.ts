import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkCloudReadiness,
  type CloudEnvironment,
  GcloudCommandError,
  GcloudUnavailableError,
  type RunGcloud,
} from "./cloud-readiness.js";

const environments: readonly CloudEnvironment[] = [
  {
    name: "test",
    projectId: "diffler-testing",
    projectNumber: "641575763044",
    requiredApis: ["forms.googleapis.com"],
  },
  {
    name: "production",
    projectId: "diffler",
    projectNumber: "543831196078",
    requiredApis: ["forms.googleapis.com"],
  },
];

describe("Feature: Google Cloud project readiness", () => {
  it("Scenario: both canonical projects are ready", () => {
    // Given
    const commands: string[][] = [];
    const execute = readyGcloud(commands);

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
    expect(results).toContainEqual({
      status: "pass",
      environment: "test",
      message: "Project diffler-testing is ACTIVE with number 641575763044",
    });
    expect(results).toContainEqual({
      status: "pass",
      environment: "production",
      message: "forms.googleapis.com is enabled",
    });
    expect(commands.slice(1).every(hasExplicitProject)).toBe(true);
  });

  it("Scenario: a secret-redacted client is checked against each environment", () => {
    // Given
    const credentialsPath = writeCredentials("641575763044-client");

    // When
    const results = checkCloudReadiness(
      environments,
      {
        credentialsPaths: {
          test: credentialsPath,
          production: credentialsPath,
        },
      },
      readyGcloud(),
    );

    // Then
    expect(results).toContainEqual({
      status: "pass",
      environment: "test",
      message: "Desktop OAuth client matches project number 641575763044",
    });
    expect(results).toContainEqual({
      status: "fail",
      environment: "production",
      message:
        "Desktop OAuth client belongs to a different project; expected client ID prefix 543831196078-",
    });
  });

  it("Scenario: gcloud is missing", () => {
    // Given
    const execute: RunGcloud = () => {
      throw new GcloudUnavailableError("gcloud is unavailable");
    };

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results).toEqual([
      { status: "fail", message: "gcloud is unavailable" },
    ]);
  });

  it("Scenario: no gcloud account is active", () => {
    // Given
    const execute: RunGcloud = () => "";

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results).toEqual([
      {
        status: "fail",
        message: "No active gcloud account; run gcloud auth login",
      },
    ]);
  });

  it("Scenario: the active account cannot inspect a project", () => {
    // Given
    const execute = readyGcloud([], (args) => {
      if (args[0] === "projects" && args[2] === "diffler-testing") {
        throw new GcloudCommandError("permission denied");
      }
    });

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results).toContainEqual({
      status: "fail",
      environment: "test",
      message:
        "Cannot inspect project diffler-testing; confirm it exists and the active account has resourcemanager.projects.get",
    });
  });

  it("Scenario: the Forms API is disabled", () => {
    // Given
    const execute = readyGcloud([], (args) => {
      if (args[0] === "services" && args.includes("--project=diffler")) {
        return "";
      }
    });

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results).toContainEqual({
      status: "fail",
      environment: "production",
      message:
        "forms.googleapis.com is disabled; enable it explicitly in Google Cloud Console",
    });
  });

  it("Scenario: a project number does not match the manifest", () => {
    // Given
    const execute = readyGcloud([], (args) => {
      if (args[0] === "projects" && args[2] === "diffler") {
        return JSON.stringify({
          projectId: "diffler",
          projectNumber: "111111111111",
          lifecycleState: "ACTIVE",
        });
      }
    });

    // When
    const results = checkCloudReadiness(environments, {}, execute);

    // Then
    expect(results).toContainEqual({
      status: "fail",
      environment: "production",
      message:
        "Project number mismatch: expected 543831196078, received 111111111111",
    });
  });

  it("Scenario: a malformed credentials file is provided", () => {
    // Given
    const directory = mkdtempSync(join(tmpdir(), "diffler-cloud-"));
    const credentialsPath = join(directory, "client.json");
    writeFileSync(credentialsPath, '{"installed":{"client_secret":"secret"}}');

    // When
    const results = checkCloudReadiness(
      [testEnvironment],
      { credentialsPaths: { test: credentialsPath } },
      readyGcloud(),
    );

    // Then
    expect(results).toContainEqual({
      status: "fail",
      environment: "test",
      message: `Desktop OAuth credentials must contain installed.client_id: ${credentialsPath}`,
    });
    expect(JSON.stringify(results)).not.toContain("secret");
  });
});

function readyGcloud(
  commands: string[][] = [],
  override: (args: readonly string[]) => string | undefined = () => undefined,
): RunGcloud {
  return (args) => {
    commands.push([...args]);
    const overridden = override(args);
    if (overridden !== undefined) {
      return overridden;
    }
    if (args[0] === "auth") {
      return "maintainer@example.com";
    }
    if (args[0] === "projects") {
      const projectId = args[2];
      const environment = environments.find(
        (candidate) => candidate.projectId === projectId,
      );
      return JSON.stringify({
        projectId,
        projectNumber: environment?.projectNumber,
        lifecycleState: "ACTIVE",
      });
    }
    if (args[0] === "services") {
      const projectNumber = args.includes("--project=diffler")
        ? "543831196078"
        : "641575763044";
      return `projects/${projectNumber}/services/forms.googleapis.com`;
    }
    if (args[0] === "billing") {
      return JSON.stringify({ billingEnabled: false });
    }
    throw new Error(`Unexpected gcloud command: ${args.join(" ")}`);
  };
}

function hasExplicitProject(args: readonly string[]): boolean {
  return args.some((argument) => argument.startsWith("--project="));
}

function writeCredentials(clientId: string): string {
  const directory = mkdtempSync(join(tmpdir(), "diffler-cloud-"));
  const path = join(directory, "client.json");
  writeFileSync(
    path,
    JSON.stringify({
      installed: {
        client_id: `${clientId}.apps.googleusercontent.com`,
      },
    }),
  );
  return path;
}

const testEnvironment: CloudEnvironment = {
  name: "test",
  projectId: "diffler-testing",
  projectNumber: "641575763044",
  requiredApis: ["forms.googleapis.com"],
};
