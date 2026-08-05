# Quiz Document

The quiz document is the stable boundary between agent-generated questions and
local terminal or Google Forms delivery. Diffler validates this untrusted JSON
before starting a local attempt or making any Forms API request.

The document necessarily contains the grading key. Treat `.diffler/quiz.json` as
a sensitive local artifact: do not commit it or reveal or summarize its contents
in chat, prompts, command arguments, or logs.

The machine-readable structural contract is
[`schemas/quiz-document.schema.json`](../schemas/quiz-document.schema.json). A
representative document containing every supported question type is available
at [`examples/quiz.json`](../examples/quiz.json).

Some cross-field rules cannot be expressed by JSON Schema, including answer
membership, ordered source ranges, and question-ID uniqueness. The JSON Schema
lists these under `x-diffler-runtime-validations`; `parseQuizDocument` is the
authoritative validation boundary before either delivery mode.

## Top-Level Fields

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Identifies the quiz contract version. The current value is `1`. |
| `repository` | Names the repository and optionally records its remote. |
| `baseRef` | Records the branch or ref used as the comparison base. |
| `headSha` | Binds the quiz to a full Git object ID. |
| `diffHash` | Binds the quiz to the SHA-256 hash of the collected diff. |
| `title` | Supplies the local quiz or Google Form title. |
| `questions` | Contains one or more graded questions. |
| `closingRiddle` | Optionally supplies a whimsical ungraded ending. |

## Question Types

Diffler supports four question types in both delivery modes:

- `multiple_choice` requires at least two unique options and one or more accepted answers.
- `checkbox` requires at least two unique options and one or more answers.
- `dropdown` requires at least two unique options and one or more accepted answers.
- `short_answer` requires one or more exact text answers.

Every question has a unique `id`, a non-empty `prompt`, a positive 32-bit integer
point value, an explicit `required` state, and at least one repository-relative
source reference. Choice answers must exactly match an option. For single-valued
questions, any listed answer is accepted; checkbox responses must match the full
answer set.

Local scoring mirrors Google Forms: single-choice, dropdown, and short-answer
responses match exact accepted values; checkbox responses must match the exact
accepted set. Diffler performs no case, whitespace, or other normalization and
awards either all configured points or zero for each question.

Choice questions provide `whenRight` and `whenWrong` feedback. Google Forms only
supports general feedback for automatically graded short answers, so
`short_answer` uses a single `general` feedback message.

Local attempts and responses remain in memory for the life of the interactive
command. Diffler does not create an attempt or response file.

## Regenerating The Schema

The Zod definition in `src/quiz.ts` is the runtime source of truth. Regenerate
the committed JSON Schema after changing it:

```sh
pnpm schema:write
```

Tests compare the generated value with the committed file so schema drift fails
CI.
