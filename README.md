# Diffler

Prove you understand the diff.

Diffler generates comprehension quizzes from Git branch diffs for Claude Code,
OpenCode, and pull-request workflows. Its first milestone is an agent skill that
collects focused branch context, generates graded questions, and publishes them
to Google Forms.

## Status

Diffler is in early development. The repository contains the TypeScript project
foundation, versioned quiz-document contract, local branch-context collection,
Google Forms authentication and publication, and a portable Claude Code and
OpenCode skill.

## Requirements

- Node.js 22 or newer
- pnpm 10.33.4
- Git 2.42 or newer

## Development

Install dependencies and run all checks:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Run the development CLI:

```sh
pnpm start -- --help
pnpm start -- context --base main
pnpm start -- publish .diffler/quiz.json --context .diffler/context.json
```

To authorize Google Forms publication, follow the
[Google authentication setup](docs/google-auth.md), then run
`diffler auth login --credentials <path>`.
See [Google Forms publishing](docs/google-forms-publishing.md) for the publication
flow and manual verification steps.
Install the agent workflow using the [skill installation guide](docs/skill-installation.md).

The aggregate `check` command verifies formatting, linting, types, and tests.
CI runs the same command on pull requests and pushes to `main`.

## Intended Workflow

1. Compare the current branch with its merge base.
2. Exclude generated and low-value changes.
3. Ask questions about behavior, rationale, risks, and changed invariants.
4. Validate the quiz document.
5. Create and publish an automatically graded Google Form.

## Repository Layout

```text
src/                 TypeScript CLI and domain implementation
docs/                Context and quiz contracts
skills/diffler/      Claude Code and OpenCode skill (planned)
.github/workflows/   Continuous integration
```

## Design Principles

- Prefer a small, verifiable implementation over speculative flexibility.
- Keep Git, quiz-domain, and Google API responsibilities separate.
- Treat diffs, generated questions, credentials, and OAuth tokens as sensitive.
- Make local commands and CI enforce the same checks.

## License

MIT. See [LICENSE](LICENSE).
