# Skill Installation

The Diffler skill is a single portable
[`SKILL.md`](../skills/diffler/SKILL.md) used by Claude Code and OpenCode. It
expects the `diffler` executable on `PATH` and Google authentication to be
configured before an agent invokes it.

## Install The CLI

From a Diffler checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm link --global
diffler --help
```

Complete [Google authentication](google-auth.md) directly in a terminal. Do not
ask an agent to read the downloaded OAuth client file or perform login inside a
skill session.

## Claude Code

Install for the current project:

```sh
mkdir -p .claude/skills
cp -R /path/to/diffler/skills/diffler .claude/skills/diffler
```

Install for all projects:

```sh
mkdir -p ~/.claude/skills
cp -R /path/to/diffler/skills/diffler ~/.claude/skills/diffler
```

Restart Claude Code after installation.

## OpenCode

Install for the current project:

```sh
mkdir -p .opencode/skills
cp -R /path/to/diffler/skills/diffler .opencode/skills/diffler
```

Install for all projects:

```sh
mkdir -p ~/.config/opencode/skills
cp -R /path/to/diffler/skills/diffler ~/.config/opencode/skills/diffler
```

OpenCode also discovers skills installed under `~/.claude/skills`. Restart
OpenCode after installation because configuration-time files are not hot
reloaded.

## Use The Skill

Invoke it from a feature-branch checkout with a request such as:

```text
Use Diffler to test my understanding of this branch against main.
```

The skill collects bounded context, generates a context-bound quiz document,
validates it against the current branch, publishes it, and returns the responder
and editor URLs. It stops rather than publishing when the diff is empty, trivial,
sensitive, stale, or incomplete because of the context budget.
