# Diffler

Prove you understand the diff.

Diffler generates comprehension quizzes from Git branch diffs for Claude Code,
OpenCode, and pull-request workflows. Its agent skill collects focused branch
context, generates graded questions, and delivers them either as an offline quiz
in your local terminal or as a published Google Form.

## Status

Diffler is in early development. The repository contains the TypeScript project
foundation, versioned quiz-document contract, local branch-context collection,
interactive local quiz delivery, Google Forms authentication and publication,
and a portable Claude Code and OpenCode skill.

## Requirements

- Node.js 24 or newer
- pnpm 11.18.0
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
pnpm start --help
pnpm start context --base main
pnpm start quiz .diffler/quiz.json --context .diffler/context.json
pnpm start publish .diffler/quiz.json --context .diffler/context.json
```

Run an installed quiz locally, without Google authentication or network access:

```sh
diffler quiz .diffler/quiz.json --context .diffler/context.json
```

Google authentication is optional and needed only for Forms delivery. To
authorize publication, follow the
[Google authentication setup](docs/google-auth.md), then run
`diffler auth login`. Maintainers can still select a bring-your-own Desktop
client with `--credentials <path>`.
Install the packaged agent skill and check local readiness with:

```sh
diffler skill install claude --scope user
diffler doctor
```

See [Google Forms publishing](docs/google-forms-publishing.md) for the optional
publication flow and manual verification steps.
Install the agent workflow using the [skill installation guide](docs/skill-installation.md).
Maintainers can inspect and install the exact npm tarball by following the
[npm publication guide](docs/npm-publication.md).

The aggregate `check` command verifies formatting, linting, types, and tests.
CI runs the same checks on pull requests and pushes to `main`.
The stable `Review Gate` check and recommended branch protection are documented
in [Repository Settings](docs/repository-settings.md).
Maintainers can verify both canonical Google Cloud environments without making
changes by running `pnpm cloud:check`; see
[Google Authentication](docs/google-auth.md#maintainer-readiness-check).

## Intended Workflow

1. Compare the current branch with its merge base.
2. Exclude generated and low-value changes.
3. Ask questions about behavior, rationale, risks, and changed invariants.
4. Validate the quiz document.
5. Choose an interactive local quiz or an automatically graded Google Form.

## Repository Layout

```text
src/                 TypeScript CLI and domain implementation
docs/                Context and quiz contracts
skills/diffler/      Packaged Claude Code and OpenCode skill
.github/workflows/   Continuous integration
```

## Design Principles

- Prefer a small, verifiable implementation over speculative flexibility.
- Keep Git, quiz-domain, and Google API responsibilities separate.
- Treat diffs, generated questions, credentials, and OAuth tokens as sensitive.
- Make local commands and CI enforce the same checks.

## License

MIT. See [LICENSE](LICENSE).
