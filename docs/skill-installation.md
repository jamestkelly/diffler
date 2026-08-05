# Skill Installation

The Diffler skill is a single portable
[`SKILL.md`](../skills/diffler/SKILL.md) used by Claude Code and OpenCode. It
expects the `diffler` executable on `PATH` and Google authentication to be
configured before an agent invokes it.

## Install The CLI

Install the public CLI:

```sh
npm install --global @diffler/cli
diffler --help
```

Complete [Google authentication](google-auth.md) directly in a terminal. Do not
ask an agent to read the downloaded OAuth client file or perform login inside a
skill session.

## Claude Code

Install for the current project:

```sh
diffler skill install claude --scope project
```

Install for all projects:

```sh
diffler skill install claude --scope user
```

Check or remove either installation by using the same agent and scope:

```sh
diffler skill status claude --scope project
diffler skill uninstall claude --scope project
```

Claude Code normally detects changes under an existing skills directory. If the
skills directory was created after Claude Code started and the skill is not
discovered, restart Claude Code once.

## OpenCode

Install for the current project:

```sh
diffler skill install opencode --scope project
```

Install for all projects:

```sh
diffler skill install opencode --scope user
```

OpenCode user installation honors `OPENCODE_CONFIG_DIR`, then
`XDG_CONFIG_HOME`, before falling back to `~/.config/opencode`. Check or remove
an installation with `skill status` or `skill uninstall` and the same scope.
Restart OpenCode after installation or removal because configuration-time files
are not hot reloaded.

## Safety And Diagnostics

Diffler records a digest beside each skill it installs. Repeating installation
is safe and updates an unmodified Diffler-owned skill. A different or locally
modified skill is preserved unless `--force` is explicitly supplied after
reviewing the conflict. Uninstall removes only files owned by Diffler and leaves
unrelated agent configuration in place.

Run the local readiness checks after authentication and skill installation:

```sh
diffler doctor
```

Doctor checks Node.js, Git and repository state, the installed CLI and packaged
assets, operating-system keychain access, Google authorization, and project and
user skill discovery. It reports fixed, secret-safe messages and exits nonzero
when a required prerequisite is unhealthy.

## Use The Skill

Invoke it from a feature-branch checkout with a request such as:

```text
Use Diffler to test my understanding of this branch against main.
```

The skill collects bounded context, generates a context-bound quiz document,
validates it against the current branch, publishes it, and returns the responder
and editor URLs. It stops rather than publishing when the diff is empty, trivial,
sensitive, stale, or incomplete because of the context budget.
