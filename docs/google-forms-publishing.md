# Google Forms Publishing

Diffler converts a validated quiz document into an automatically graded Google
Form. Complete the [Google authentication setup](google-auth.md) before
publishing.

## Publish A Quiz

```sh
diffler publish examples/quiz.json
```

Diffler validates the entire input before making an API request. It then:

1. Creates an explicitly unpublished form.
2. Atomically enables quiz mode and adds every graded question.
3. Explicitly publishes the form and enables responses.
4. Prints the form ID, responder URL, and editor URL.

Explicit publication is required for Forms created by the API after June 30,
2026. Diffler does not rely on the legacy publish-on-create behavior.

The supported mappings are:

| Quiz document type | Google Forms type | Grading |
| --- | --- | --- |
| `multiple_choice` | `RADIO` | Any listed answer is accepted |
| `checkbox` | `CHECKBOX` | The selected set must exactly match the answer key |
| `dropdown` | `DROP_DOWN` | Any listed answer is accepted |
| `short_answer` | Short text | Exact text matches the answer key |

## Partial Failures

Creating a Form and configuring or publishing it are separate API operations. If
configuration or publication fails after creation, Diffler prints the existing
form ID and editor URL. Recover or delete that form in Google Forms; do not rerun
the command unless you intentionally want another form.

Diffler does not include Google error bodies in terminal output because they can
contain credentials or request details.

## Manual Verification

After authenticating a test account, publish `examples/quiz.json`, open the
printed responder URL in a private browser window, submit answers, and confirm:

- all four question types are present and required;
- the form accepts the submission;
- correct answers receive the configured points;
- answer feedback appears as configured;
- the editor URL opens the same quiz in the authenticated test account.
