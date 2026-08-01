import { execFileSync } from "node:child_process";

export function assertReviewedHead(reviewedSha, currentMainSha) {
  if (reviewedSha === undefined || reviewedSha.length === 0) {
    throw new Error("REVIEWED_SHA is required for release publication");
  }
  if (currentMainSha !== reviewedSha) {
    throw new Error(
      "Reviewed commit was superseded before publication; a newer main review will release the accumulated changes",
    );
  }
}

export async function prepare(_pluginConfig, context) {
  execFileSync("git", ["fetch", "origin", "main", "--force"], {
    cwd: context.cwd,
    stdio: "ignore",
  });
  const currentMainSha = execFileSync("git", ["rev-parse", "origin/main"], {
    cwd: context.cwd,
    encoding: "utf8",
  }).trim();
  assertReviewedHead(context.env.REVIEWED_SHA, currentMainSha);
}
