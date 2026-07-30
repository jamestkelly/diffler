# Diff Context

The `context` command compares the current `HEAD` with the merge base of a local
base ref and writes deterministic JSON for an agent to inspect:

```sh
diffler context --base main --output .diffler/context.json
```

When `--base` is omitted, Diffler tries the local `origin/HEAD`, `main`, and
`master` refs in that order. It never fetches a missing ref.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `--base <ref>` | Local default branch | Selects the comparison ref. |
| `--output <path>` | `.diffler/context.json` | Selects an output inside the working directory. |
| `--max-bytes <bytes>` | `200000` | Limits included patch bytes. |
| `--chunk-bytes <bytes>` | `32000` | Limits each patch chunk; minimum `4`. |
| `--exclude <path>` | None | Excludes a repository-relative path prefix; repeatable. |

Common lockfiles and files beneath `.diffler`, `build`, `coverage`, and `dist`
are excluded by default. Binary files are not placed in model context.

## Output

The context document contains:

- `repository`: repository name and optional origin URL.
- `comparison`: base ref, base tip, merge base, and current `HEAD` SHAs.
- `diffHash`: SHA-256 of a versioned pair of merge-base and `HEAD` tree IDs. It
  binds every committed path and byte, including files omitted from context,
  without depending on local Git diff configuration.
- `files`: textual changes with status, paths, patch size, and hunk-aware chunks.
- `omissions`: binary, excluded, and over-budget files or chunks with reasons.
- `limits`: configured and consumed byte limits.
- `summary`: changed-file and chunk counts. `includedFiles` includes partial files,
  `partiallyIncludedFiles` identifies that subset, and `omittedFiles` counts only
  fully omitted files.

Large textual patches are split at unified-diff hunk and line boundaries. If a
single line exceeds the chunk limit, Diffler splits it at Unicode code-point
boundaries. Chunks that do not fit the total budget are aggregated by file in
`omissions`; content is never silently truncated.

URL userinfo and SCP-style usernames are removed from origin metadata. Remotes
with query strings, fragments, or malformed credential-bearing URLs are omitted.
Context files are written with owner-only permissions and refuse symbolic links
because they can contain deleted or otherwise sensitive source.

The output has no timestamp or absolute checkout path. The `diffHash` is stable
for the same compared trees even when local Git diff configuration changes.
Repository name and sanitized remote remain checkout metadata and may differ
between clones.
