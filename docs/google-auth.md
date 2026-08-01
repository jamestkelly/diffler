# Google Authentication

Diffler uses Google's OAuth 2.0 Desktop app flow to create and manage Forms as
your Google account. It stores refresh credentials in the operating-system
keychain. Access tokens remain in memory only.

The production Desktop client ID and Google's required Desktop client secret are
public application configuration. Native OAuth applications cannot keep a
shared secret, and Google must not treat this shared value as proof of Diffler's
identity. Authorization security comes from a fresh PKCE verifier, high-entropy
state, the system browser, a temporary callback bound to `127.0.0.1`, user
consent, and keychain storage.

First-party values are injected only into compiled release artifacts. They are
absent from source control and CI output, but anyone using a release can extract
them. A source checkout without injected values must use `--credentials`.

## First-Party Login

Authorize Diffler without creating a Google Cloud project or downloading a
credentials file:

```sh
diffler auth login
```

This opens your system browser and waits for Google to return to a temporary
server bound to `127.0.0.1` on a random port. If the browser does not open, use
the authorization URL printed in the terminal.

Google currently shows an unverified-app warning while production verification
is pending. Continue through **Advanced** only if you trust this Diffler release.
A Workspace administrator may need to allow the Diffler OAuth client before a
managed account can authorize it.

## Bring Your Own Client

Maintainers and developers can explicitly use another Google Desktop client:

```sh
diffler auth login --credentials ~/Downloads/client_secret.json
```

Keep downloaded credentials outside the repository. Diffler stores the client
details with the resulting refresh credential in the keychain so later refreshes
continue to use the same client.

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

Common failures are handled without printing Google's response payload:

- An unverified-app warning requires an explicit user decision while verification
  is pending.
- A Workspace policy block requires an administrator to allow the Diffler OAuth
  client; Diffler cannot bypass organization policy.
- A revoked or expired grant requires `diffler auth login` again.
- A deleted or unavailable first-party client can be bypassed temporarily with
  `--credentials <path>`.
- Exhausted project quota requires waiting or contacting the maintainer through
  the repository issue tracker.

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

## Production Operations

The owner of the `jamestkelly/diffler` repository is the operational owner of
the production Google Cloud project and OAuth client. As of August 1, 2026, the
consent screen is External and published, requests only `forms.body`, and awaits
Google verification. Branding, support contact, privacy-policy URL, authorized
domains, and verification correspondence remain console-managed evidence and
must be reviewed before certification in issue #29.

Monitor Forms API traffic, errors, and quotas in the production project's
**APIs & Services > Metrics and Quotas** pages. Investigate unexpected client
traffic, consent reports, or quota growth as a possible client-impersonation
incident.

The public client ID and shared Desktop client secret identify Diffler but do not
authenticate it. Anyone can extract and reuse them from a release. PKCE protects
authorization codes but cannot prevent another program from initiating its own
consent flow or consuming project quota.

The release workflow tracked by issue #26 must store
`DIFFLER_GOOGLE_CLIENT_ID` and `DIFFLER_GOOGLE_CLIENT_SECRET` as protected values.
It must run `pnpm oauth:inject` only after a clean build and never print the
generated module or upload it except inside the reviewed npm artifact. Rotate
both values if either release injection or project ownership is compromised.

For planned rotation:

1. Create and readiness-check a replacement production Desktop client.
2. Update the public client ID and release a new Diffler version.
3. Tell upgraded users to run `diffler auth login` again. First-party keychain
   records intentionally do not retain old shared client configuration, so an
   existing refresh grant cannot migrate to a replacement client.
4. Keep the old client available only for a short, announced window for users on
   the previous release, then delete it.

For suspected abuse, disable or delete the affected client immediately, record
the incident without tokens or secrets, publish a replacement release, review
quota and consent configuration, and direct users to reauthorize. Local
`diffler auth logout` removes only the keychain record; users revoke the entire
Google project grant from
[Google Account connections](https://myaccount.google.com/connections).
