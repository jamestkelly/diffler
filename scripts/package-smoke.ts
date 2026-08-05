import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const changelogPath = join(repository, "CHANGELOG.md");

if (existsSync(changelogPath)) {
  throw new Error("Package smoke requires a clean release-only changelog");
}
const temporaryRoot = mkdtempSync(join(tmpdir(), "diffler-package-"));
writeFileSync(changelogPath, "# Changelog\n\nPackage smoke fixture.\n");

try {
  const packDirectory = join(temporaryRoot, "pack");
  mkdirSync(packDirectory);
  runCommandShim(
    pnpm,
    ["pack", "--pack-destination", packDirectory],
    repository,
    {
      ...process.env,
      DIFFLER_GOOGLE_CLIENT_ID:
        "543831196078-synthetic.apps.googleusercontent.com",
      DIFFLER_GOOGLE_CLIENT_SECRET: "synthetic-public-client-value",
    },
  );

  const archives = readdirSync(packDirectory).filter((file) =>
    file.endsWith(".tgz"),
  );
  if (archives.length !== 1 || archives[0] === undefined) {
    throw new Error("Expected pnpm pack to create exactly one tarball");
  }
  const archive = join(packDirectory, archives[0]);
  assertPackageContents(archive);

  const installation = join(temporaryRoot, "installation");
  mkdirSync(installation);
  writeFileSync(
    join(installation, "package.json"),
    '{"name":"diffler-package-smoke","private":true}',
  );
  runCommandShim(
    npm,
    ["install", "--no-audit", "--no-fund", archive],
    installation,
  );

  const binary = join(
    installation,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "diffler.cmd" : "diffler",
  );
  const help = runBinary(binary, ["--help"], installation);
  if (!help.includes("Diffler")) {
    throw new Error("Installed diffler --help returned unexpected output");
  }
  runBinary(
    binary,
    ["validate", join(repository, "examples", "quiz.json")],
    installation,
  );
  await smokeLocalQuiz(installation);
  smokeContext(binary, temporaryRoot);
  smokeSkillLifecycle(binary, installation);

  console.log(`Package smoke test passed: ${basename(archive)}`);
} finally {
  rmSync(changelogPath, { force: true });
  rmSync(join(repository, "dist", "google-oauth-client.generated.js"), {
    force: true,
  });
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function assertPackageContents(archive: string): void {
  const actual = run("tar", ["-tzf", archive], repository)
    .split(/\r?\n/)
    .filter((path) => path.startsWith("package/") && !path.endsWith("/"))
    .map((path) => path.slice("package/".length))
    .sort();
  const expected = [
    "LICENSE",
    "README.md",
    "CHANGELOG.md",
    "package.json",
    "docs/diff-context.md",
    "docs/google-auth.md",
    "docs/google-forms-publishing.md",
    "docs/npm-publication.md",
    "docs/quiz-document.md",
    "docs/repository-settings.md",
    "docs/skill-installation.md",
    "schemas/quiz-document.schema.json",
    "skills/diffler/SKILL.md",
    "dist/google-oauth-client.generated.js",
    ...[
      "auth",
      "cli",
      "diff-context",
      "doctor",
      "google-forms",
      "google-oauth-client",
      "local-quiz",
      "quiz",
      "quiz-context",
      "skill-installation",
      "terminal-quiz-prompt",
    ]
      .flatMap((module) => [
        `dist/${module}.d.ts`,
        `dist/${module}.d.ts.map`,
        `dist/${module}.js`,
        `dist/${module}.js.map`,
      ])
      .sort(),
  ].sort();

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected package contents\nExpected: ${expected.join(", ")}\nActual: ${actual.join(", ")}`,
    );
  }
}

async function smokeLocalQuiz(installation: string): Promise<void> {
  const installationContents = readdirSync(installation).sort();
  const { run } = await import(
    pathToFileURL(
      join(installation, "node_modules", "@diffler", "cli", "dist", "cli.js"),
    ).href
  );
  const answers = [
    ["To support explicit contract evolution"],
    ["options", "correctAnswers", "points"],
    ["SHA-256"],
    ["unknown"],
  ];
  const expectedKinds = ["select", "multiselect", "select", "text"];
  const output: string[] = [];
  const errors: string[] = [];
  let closeCalls = 0;
  let promptCalls = 0;
  const unavailable = async (): Promise<never> => {
    throw new Error("Local quiz unexpectedly used an external dependency");
  };

  const exitCode = await run(
    ["quiz", join(repository, "examples", "quiz.json")],
    (message: string) => output.push(message),
    (message: string) => errors.push(message),
    installation,
    { login: unavailable, status: unavailable, logout: unavailable },
    { publish: unavailable },
    {
      createQuizPrompt: () => ({
        ask: async (request: { kind: string }) => {
          const answer = answers[promptCalls];
          if (
            answer === undefined ||
            request.kind !== expectedKinds[promptCalls]
          ) {
            throw new Error(
              "Installed CLI requested an unexpected quiz prompt",
            );
          }
          promptCalls += 1;
          return { kind: "answer", values: answer };
        },
        close: () => {
          closeCalls += 1;
        },
      }),
    },
  );

  if (exitCode !== 0) {
    throw new Error(`Installed local quiz exited with ${exitCode}`);
  }
  if (promptCalls !== answers.length || closeCalls !== 1) {
    throw new Error(
      "Installed local quiz did not complete and close its prompt",
    );
  }
  if (!output.includes("Score: 6/6 points (4/4 correct).")) {
    throw new Error("Installed local quiz returned an unexpected final score");
  }
  if (errors.length !== 0) {
    throw new Error(
      `Installed local quiz returned errors: ${errors.join(", ")}`,
    );
  }
  if (
    existsSync(join(installation, ".diffler")) ||
    JSON.stringify(readdirSync(installation).sort()) !==
      JSON.stringify(installationContents)
  ) {
    throw new Error("Installed local quiz persisted attempt or answer data");
  }
}

function smokeSkillLifecycle(binary: string, installation: string): void {
  const skillPath = join(
    installation,
    ".claude",
    "skills",
    "diffler",
    "SKILL.md",
  );
  runBinary(
    binary,
    ["skill", "install", "claude", "--scope", "project"],
    installation,
  );
  if (!existsSync(skillPath)) {
    throw new Error("Installed CLI did not install the packaged Diffler skill");
  }
  runBinary(
    binary,
    ["skill", "status", "claude", "--scope", "project"],
    installation,
  );
  runBinary(
    binary,
    ["skill", "uninstall", "claude", "--scope", "project"],
    installation,
  );
  if (existsSync(skillPath)) {
    throw new Error("Installed CLI did not remove its Diffler skill");
  }
}

function smokeContext(binary: string, temporaryRoot: string): void {
  const repositoryPath = join(temporaryRoot, "context-repository");
  mkdirSync(repositoryPath);
  run("git", ["init", "--initial-branch=main"], repositoryPath);
  run("git", ["config", "user.name", "Diffler Package Test"], repositoryPath);
  run(
    "git",
    ["config", "user.email", "diffler-package@example.invalid"],
    repositoryPath,
  );
  writeFileSync(join(repositoryPath, "value.ts"), "export const value = 1;\n");
  run("git", ["add", "value.ts"], repositoryPath);
  run("git", ["commit", "-m", "initial"], repositoryPath);
  run("git", ["switch", "-c", "feature"], repositoryPath);
  writeFileSync(join(repositoryPath, "value.ts"), "export const value = 2;\n");
  runBinary(binary, ["context", "--base", "main"], repositoryPath);

  const context = JSON.parse(
    readFileSync(join(repositoryPath, ".diffler", "context.json"), "utf8"),
  ) as unknown;
  if (typeof context !== "object" || context === null) {
    throw new Error("Installed diffler context did not write a JSON document");
  }
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runCommandShim(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runBinary(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
}
