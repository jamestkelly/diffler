# npm Publication

Diffler is packaged as the public scoped package `@diffler/cli`.
Issue #25 prepared and tested the artifact but did not publish a release.

## Ownership

The `@diffler/cli` name returned `404 Not Found` from the public npm registry on
August 1, 2026, so no published package currently claims it. The `diffler` npm
organization is owned by the `jamestkelly` maintainer account. Before the first
release, a maintainer must:

1. Own or join the `diffler` npm organization.
2. Enable two-factor authentication on the publishing account.
3. Confirm `npm whoami` returns the intended maintainer account.
4. Configure trusted publishing in the release workflow tracked by issue #26.

Do not run `npm publish` manually while validating this issue.

## Artifact Verification

Run the same clean pack-and-install test used by CI:

```sh
pnpm package:smoke
```

The command runs the prepack checks, removes stale build output, builds the CLI,
creates a tarball, and rejects any file outside the reviewed allowlist. It then
installs the tarball into a temporary project and exercises `diffler --help`,
`diffler validate`, and `diffler context` through the installed binary.

The package includes compiled JavaScript, declarations and source maps, the quiz
schema, the Diffler skill, documentation, the README, license, and package
metadata. It excludes source files, tests, examples, repository configuration,
generated Diffler documents, downloadable OAuth JSON, and user credentials. The
release artifact contains Google's shared Desktop client configuration, which is
public native-application configuration and is covered by the threat model in
[Google Authentication](google-auth.md#production-operations).
