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
