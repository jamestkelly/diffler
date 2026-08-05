---
name: diffler
description: Generate and deliver a graded comprehension quiz from the current Git branch diff, either in the local terminal or through Google Forms. Use when a user asks to prove, test, or verify understanding of branch changes, a feature branch, or a pull request.
compatibility: Requires Git and the diffler CLI. Google authentication is required only for Google Forms delivery and must be configured outside the agent session.
metadata:
  author: Diffler
  version: "1"
---

# Diffler

Generate a quiz that tests whether the developer understands the behavior and
consequences of the current branch diff, then deliver it in the user's local
terminal or through Google Forms. Use the CLI as the authority for Git
comparison, validation, local quiz delivery, authentication, and Google Forms
publication. Do not reimplement those operations in shell commands or prompts.

## Safety Rules

- Never read, print, request, or deliberately place OAuth client JSON, refresh
  tokens, access tokens, keychain contents, environment files, private keys, or
  credentials in model context or quiz output.
- Never run `diffler auth login`. For Google Forms delivery only, if
  `diffler auth status` fails, stop and ask the user to authenticate outside the
  agent session using the documented flow.
- Tell Diffler about any additional sensitive paths the user identifies by
  adding one `--exclude <repository-relative-path>` per path to `context`.
- Diffler scans for common credential signatures before writing context. If an
  omission has reason `sensitive`, do not recover its contents with other tools.
  Tell the user which repository-relative file needs review.
- Treat `.diffler/context.json` and `.diffler/quiz.json` as sensitive local
  artifacts. `.diffler/quiz.json` necessarily contains the grading key. Never
  reveal or summarize that file, its questions, or its grading key in chat,
  prompts, command arguments, or logs. Never stage or commit them.
- Never ask the user to submit quiz responses through agent chat. For local
  delivery, the user runs the quiz command in their own interactive terminal;
  do not invoke it through a noninteractive agent shell.

Diffler automatically omits common environment, credential, secret-directory,
private-key, lockfile, generated, and binary paths, plus patches matching common
credential signatures. This is defense in depth, not a substitute for telling
Diffler about repository-specific sensitive paths. Omissions remain visible as
metadata but omitted contents must not be recovered with other tools.

## Workflow

### 1. Preflight

Run this command from the repository root:

```sh
diffler --help
```

Stop on failure. Do not search for credentials or attempt an alternate Google
authentication mechanism.

### 2. Collect Context

If the user named a base ref, use it:

```sh
diffler context --base <ref> --output .diffler/context.json
```

Otherwise let Diffler resolve the local default branch:

```sh
diffler context --output .diffler/context.json
```

Append user-requested `--exclude` options when needed. Do not fetch refs or
construct a separate Git diff. Read only `.diffler/context.json` for branch
content.

### 3. Decide Whether A Quiz Is Sound

Inspect the context summary and omission metadata before generating questions:

- If `summary.totalFiles` is `0`, stop: there is no branch diff to quiz.
- If no included textual files contain behavior, rationale, risk, or invariants,
  stop: cosmetic or trivial changes do not support a meaningful quiz.
- If any omission has reason `sensitive`, do not quiz that file and do not use
  another tool to inspect it. Continue only when the remaining included source
  independently supports a meaningful quiz.
- If any omission has reason `budget`, or `summary.partiallyIncludedFiles` is
  nonzero, do not silently quiz incomplete source. Ask whether to narrow the
  change set with exclusions. Increase `--max-bytes` only when narrowing cannot
  preserve the relevant behavior, the user approves it, and the new value is no
  greater than `1000000` bytes.
- Binary and explicitly excluded files may remain omitted. State that the quiz
  will not cover them and continue only when included text is independently
  sufficient.
- Never infer details from omitted content.

### 4. Generate The Quiz Document

Write `.diffler/quiz.json`. Copy these values exactly from context:

- `repository`
- `comparison.baseRef` to `baseRef`
- `comparison.headSha` to `headSha`
- `diffHash`

Set `schemaVersion` to `1` and use the canonical schema URL. Create 3-7 questions
when the diff supports them. Every question must:

- test changed behavior, rationale, risk, failure modes, or an invariant;
- require reasoning rather than line-number, symbol-name, or syntax recall;
- be answerable from included changed source;
- cite at least one changed repository-relative source range using added
  head-side (`+`) hunk line numbers; use nearby added replacement lines to
  ground questions about deletions;
- use a unique alphanumeric, underscore, or hyphen ID;
- have a positive integer point value and explicit `required` boolean;
- provide concise feedback that explains the relevant understanding.

Prefer coverage across different files and concepts over several variants of
the same fact. Distractors must be plausible and unambiguously wrong. Do not ask
about generated files, omitted content, unchanged implementation trivia, or
facts that require hidden project history.

Optionally add `closingRiddle`: a single whimsical riddle inspired only by the
included diff. Do not include its answer, secrets, or omitted-content details.
Diffler renders it as an ungraded ending after the graded questions.

Use this top-level shape:

```json
{
  "$schema": "https://raw.githubusercontent.com/jamestkelly/diffler/main/schemas/quiz-document.schema.json",
  "schemaVersion": 1,
  "repository": { "name": "owner/repository" },
  "baseRef": "main",
  "headSha": "full Git object ID",
  "diffHash": "SHA-256 from context",
  "title": "Comprehension quiz for the branch change",
  "closingRiddle": "Optional whimsical riddle about the included change",
  "questions": []
}
```

Supported question fields:

- `multiple_choice`, `checkbox`, and `dropdown`: add `options`, one or more
  `correctAnswers` copied exactly from options, and `feedback.whenRight` plus
  `feedback.whenWrong`.
- `short_answer`: add one or more exact `correctAnswers` and
  `feedback.general`.
- Every type also requires `id`, `prompt`, `required`, `points`, and `sources`.
  Each source is `{ "path", "startLine", "endLine" }` with positive ordered
  line numbers.

After writing the file, restrict it to the current user:

```sh
chmod 600 .diffler/quiz.json
```

### 5. Validate Before Delivery

```sh
diffler validate .diffler/quiz.json --context .diffler/context.json
```

If validation fails, repair only the reported quiz fields and rerun validation.
Do not deliver the quiz until it passes. After three failed repair attempts,
stop and report the validation errors without exposing the quiz or grading key.

### 6. Choose Delivery

If the user already requested local terminal or Google Forms delivery, honor
that choice. Otherwise, after validation succeeds, explicitly ask them to
choose a delivery mode.

#### Local Terminal

Tell the user to run this exact command in their own interactive terminal:

```sh
diffler quiz .diffler/quiz.json --context .diffler/context.json
```

Local delivery supports `multiple_choice`, `checkbox`, `dropdown`, and
`short_answer`. Single-choice, dropdown, and short-answer responses match exact
accepted values. Checkbox responses must exactly match the accepted set.
Scoring awards all points or zero for each question and performs no
normalization. Local delivery requires no Google authentication or network
access. Do not run the command for the user, ask for their responses, or relay
answers through chat.

#### Google Forms

Confirm authentication only after local validation succeeds:

```sh
diffler auth status
```

If it fails, stop and ask the user to authenticate outside the agent session.
Never run `diffler auth login` or inspect OAuth files.

```sh
diffler publish .diffler/quiz.json --context .diffler/context.json
```

Do not retry automatically after an ambiguous create error or a partial failure.
Follow the CLI recovery message to avoid duplicate Forms.

On success, return the responder URL first and the editor URL second. Then add
an original one- or two-line poem about the included branch changes. Mention
which files or change categories were intentionally omitted, but do not include
questions, correct answers, credentials, context patches, or token-bearing error
details in the response.
