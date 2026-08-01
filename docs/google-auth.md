# Google Authentication

Diffler uses Google's OAuth 2.0 Desktop app flow to create and manage Forms as
your Google account. It stores the refresh credential and OAuth client details
in the operating-system keychain, never in the repository. Access tokens remain
in memory only.

## Google Cloud Setup

1. Create or select a project in the
   [Google Cloud console](https://console.cloud.google.com/).
2. Enable the [Google Forms API](https://console.cloud.google.com/apis/library/forms.googleapis.com).
3. Configure the OAuth consent screen. For an External app in testing, add your
   Google account as a test user.
4. Open **Google Auth Platform > Clients**, create an OAuth client with the
   **Desktop app** application type, and download its JSON file.
5. Keep the downloaded file outside your repository. Do not commit it.

Maintainers use these canonical environments:

| Environment | Project ID | Project number | OAuth state |
| --- | --- | --- | --- |
| Test | `diffler-testing` | `641575763044` | External, testing |
| Production | `diffler` | `543831196078` | External, published; verification pending |

The non-secret source of truth is
[`config/google-cloud-projects.json`](../config/google-cloud-projects.json).

Diffler requests only the
`https://www.googleapis.com/auth/forms.body` scope. This scope permits creating
and updating Forms without granting general access to Google Drive.

## Commands

Authorize Diffler. This opens your system browser and waits for Google to return
to a temporary server bound to `127.0.0.1` on a random port. If the browser does
not open, use the authorization URL printed in the terminal:

```sh
diffler auth login --credentials ~/Downloads/client_secret.json
```

Confirm that the stored refresh credential can obtain an access token:

```sh
diffler auth status
```

Remove the authorization from the local keychain:

```sh
diffler auth logout
```

Logout removes Diffler's local credential. To revoke the Google Cloud project's
grant as well, remove it from your
[Google Account connections](https://myaccount.google.com/connections).

## Keychain Support

Diffler uses Keychain on macOS, Credential Manager on Windows, and the Secret
Service on Linux. A Linux desktop or headless environment must provide a running
Secret Service-compatible keyring. Diffler fails closed if no supported keychain
is available; it does not fall back to storing refresh credentials in a file.

OAuth errors are intentionally summarized so credentials and tokens are not
included in terminal output. If authorization expires or is revoked, run
`diffler auth login` again.

## Maintainer Readiness Check

Authenticate `gcloud` interactively if needed, then confirm which account is
active. The readiness command does not change the active account or global
project:

```sh
gcloud auth login
gcloud auth list
pnpm cloud:check
```

Optionally verify that downloaded Desktop clients belong to the intended
projects. The checker reads the files without printing or persisting their
client secrets:

```sh
pnpm cloud:check -- \
  --test-credentials ~/Downloads/diffler-testing-client.json \
  --production-credentials ~/Downloads/diffler-production-client.json
```

Every project query includes an explicit `--project` flag. The command is
read-only: it does not create projects, enable APIs, alter IAM or billing, or
replace OAuth clients. Failures must be corrected deliberately in Google Cloud
Console or with a separately reviewed mutation command.

## Console-Only OAuth Checklist

The general `gcloud` CLI cannot reliably inspect the complete Google Auth
Platform configuration. For each environment, record dated evidence from
Google Cloud Console without copying client secrets or user tokens:

- Branding identifies Diffler and lists current support and developer contacts.
- Audience is External.
- Test remains in Testing and lists only intended test users.
- Production is published before public use.
- Data Access requests only
  `https://www.googleapis.com/auth/forms.body` unless a reviewed change requires
  another scope.
- The OAuth client application type is Desktop app.
- Production OAuth verification status and any requested remediation are
  recorded in the tracking issue.
- The downloaded client ID begins with the expected project number from the
  manifest.

Production public onboarding remains blocked while Google displays the
unverified-app warning. Verification evidence must not include credentials,
authorization codes, access tokens, or refresh tokens.
