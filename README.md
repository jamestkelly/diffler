# Diffler

Prove you understand the diff.

Diffler generates comprehension quizzes from Git branch diffs for Claude Code,
OpenCode, and pull-request workflows. Its first milestone is an agent skill that
collects focused branch context, generates graded questions, and publishes them
to Google Forms.

## Status

Diffler is in early development. The current repository contains only the
TypeScript project foundation; diff collection, quiz validation, Google Forms
publication, and skill packaging are tracked in the
[MVP milestone](https://github.com/jamestkelly/diffler/milestone/1).

## Requirements

- Node.js 22 or newer
- npm

## Development

Install dependencies and run all checks:

```sh
npm ci
npm run check
npm run build
```

Run the development CLI:

```sh
npm start -- --help
```

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
