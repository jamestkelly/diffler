import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { z } from "zod";

const projectSchema = z
  .object({
    projectId: z.string().min(1),
    projectNumber: z.string().regex(/^\d+$/),
    lifecycleState: z.string().min(1),
  })
  .passthrough();

const billingSchema = z
  .object({
    billingEnabled: z.boolean(),
  })
  .passthrough();

const credentialsSchema = z
  .object({
    installed: z
      .object({
        client_id: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export interface CloudEnvironment {
  name: string;
  projectId: string;
  projectNumber: string;
  requiredApis: readonly string[];
}

export interface CloudCheckOptions {
  credentialsPaths?: Readonly<Record<string, string>>;
}

export interface CloudCheckResult {
  status: "pass" | "warn" | "fail";
  environment?: string;
  message: string;
}

export type RunGcloud = (args: readonly string[]) => string;

export class GcloudUnavailableError extends Error {
  override readonly name = "GcloudUnavailableError";
}

export class GcloudCommandError extends Error {
  override readonly name = "GcloudCommandError";
}

export function runGcloud(args: readonly string[]): string {
  try {
    return execFileSync("gcloud", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new GcloudUnavailableError(
        "gcloud is not installed or is not available on PATH",
      );
    }
    throw new GcloudCommandError("gcloud command failed");
  }
}

export function checkCloudReadiness(
  environments: readonly CloudEnvironment[],
  options: CloudCheckOptions = {},
  execute: RunGcloud = runGcloud,
): CloudCheckResult[] {
  const results: CloudCheckResult[] = [];
  let account: string;

  try {
    account = execute([
      "auth",
      "list",
      "--filter=status:ACTIVE",
      "--format=value(account)",
    ]).trim();
  } catch (error) {
    if (error instanceof GcloudUnavailableError) {
      return [{ status: "fail", message: error.message }];
    }
    return [
      {
        status: "fail",
        message:
          "Unable to inspect gcloud authentication; run gcloud auth login",
      },
    ];
  }

  if (account.length === 0) {
    return [
      {
        status: "fail",
        message: "No active gcloud account; run gcloud auth login",
      },
    ];
  }
  results.push({
    status: "pass",
    message: `Active gcloud account: ${account}`,
  });

  for (const environment of environments) {
    checkProject(environment, execute, results);
    checkApis(environment, execute, results);
    checkBilling(environment, execute, results);

    const credentialsPath = options.credentialsPaths?.[environment.name];
    if (credentialsPath !== undefined) {
      checkCredentials(environment, credentialsPath, results);
    }
  }

  return results;
}

function checkProject(
  environment: CloudEnvironment,
  execute: RunGcloud,
  results: CloudCheckResult[],
): void {
  let project: z.infer<typeof projectSchema>;
  try {
    project = projectSchema.parse(
      JSON.parse(
        execute([
          "projects",
          "describe",
          environment.projectId,
          `--project=${environment.projectId}`,
          "--format=json(projectId,projectNumber,lifecycleState)",
        ]),
      ),
    );
  } catch {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Cannot inspect project ${environment.projectId}; confirm it exists and the active account has resourcemanager.projects.get`,
    });
    return;
  }

  if (project.projectId !== environment.projectId) {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Expected project ID ${environment.projectId}, received ${project.projectId}`,
    });
  } else if (project.projectNumber !== environment.projectNumber) {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Project number mismatch: expected ${environment.projectNumber}, received ${project.projectNumber}`,
    });
  } else if (project.lifecycleState !== "ACTIVE") {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Project lifecycle is ${project.lifecycleState}, not ACTIVE`,
    });
  } else {
    results.push({
      status: "pass",
      environment: environment.name,
      message: `Project ${environment.projectId} is ACTIVE with number ${environment.projectNumber}`,
    });
  }
}

function checkApis(
  environment: CloudEnvironment,
  execute: RunGcloud,
  results: CloudCheckResult[],
): void {
  for (const api of environment.requiredApis) {
    try {
      const enabledServices = execute([
        "services",
        "list",
        "--enabled",
        `--project=${environment.projectId}`,
        `--filter=name:${api}`,
        "--format=value(name)",
      ]).split("\n");
      const enabled = enabledServices.some(
        (name) => name === api || name.endsWith(`/services/${api}`),
      );
      results.push({
        status: enabled ? "pass" : "fail",
        environment: environment.name,
        message: enabled
          ? `${api} is enabled`
          : `${api} is disabled; enable it explicitly in Google Cloud Console`,
      });
    } catch {
      results.push({
        status: "fail",
        environment: environment.name,
        message: `Cannot inspect APIs for ${environment.projectId}; confirm serviceusage.services.list access`,
      });
    }
  }
}

function checkBilling(
  environment: CloudEnvironment,
  execute: RunGcloud,
  results: CloudCheckResult[],
): void {
  try {
    const billing = billingSchema.parse(
      JSON.parse(
        execute([
          "billing",
          "projects",
          "describe",
          environment.projectId,
          `--project=${environment.projectId}`,
          "--format=json(billingEnabled)",
        ]),
      ),
    );
    results.push({
      status: "warn",
      environment: environment.name,
      message: billing.billingEnabled
        ? "Billing is enabled (not required for the current Forms API workflow)"
        : "Billing is disabled (acceptable for the current Forms API workflow)",
    });
  } catch {
    results.push({
      status: "warn",
      environment: environment.name,
      message: "Billing state could not be inspected and is not required",
    });
  }
}

function checkCredentials(
  environment: CloudEnvironment,
  credentialsPath: string,
  results: CloudCheckResult[],
): void {
  let input: string;
  try {
    input = readFileSync(credentialsPath, "utf8");
  } catch {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Unable to read Desktop OAuth credentials at ${credentialsPath}`,
    });
    return;
  }

  try {
    const credentials = credentialsSchema.parse(JSON.parse(input));
    const expectedPrefix = `${environment.projectNumber}-`;
    if (!credentials.installed.client_id.startsWith(expectedPrefix)) {
      results.push({
        status: "fail",
        environment: environment.name,
        message: `Desktop OAuth client belongs to a different project; expected client ID prefix ${expectedPrefix}`,
      });
      return;
    }
    results.push({
      status: "pass",
      environment: environment.name,
      message: `Desktop OAuth client matches project number ${environment.projectNumber}`,
    });
  } catch {
    results.push({
      status: "fail",
      environment: environment.name,
      message: `Desktop OAuth credentials must contain installed.client_id: ${credentialsPath}`,
    });
  }
}
