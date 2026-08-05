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
`diffler validate`, `diffler context`, and an installed local quiz through the
installed binary. The quiz smoke injects prompt dependencies so it remains
deterministic and does not require an interactive package-test terminal.

The package includes compiled JavaScript, declarations and source maps, the quiz
schema, the Diffler skill, documentation, the README, license, and package
metadata. It excludes source files, tests, examples, repository configuration,
generated Diffler documents, downloadable OAuth JSON, and user credentials. The
release artifact contains Google's shared Desktop client configuration, which is
public native-application configuration and is covered by the threat model in
[Google Authentication](google-auth.md#production-operations).

## Automated Releases

The dedicated `Release` workflow runs only after the `Review` workflow succeeds
for a push to `main`. It verifies that `Review Gate` passed for the exact SHA and
skips the run if a newer `main` commit superseded it. Release runs are serialized
and never cancel an in-progress publication.

Releases remain disabled unless the repository variable
`NPM_RELEASE_ENABLED` is exactly `true`. Keep it disabled through the bootstrap
publish and trusted-publisher setup.

The `npm` GitHub environment supplies `DIFFLER_GOOGLE_CLIENT_ID` and
`DIFFLER_GOOGLE_CLIENT_SECRET` to prepack. npm authentication uses GitHub OIDC;
do not configure `NPM_TOKEN`. Trusted publishing automatically records npm
provenance for this public repository and package.

semantic-release applies these Conventional Commit rules:

- Breaking changes release a major version.
- `feat` releases a minor version.
- `fix`, `perf`, and `revert` release a patch version.
- `build`, `chore`, `ci`, `docs`, `refactor`, `style`, and `test` do not release.

Each release restores the previous GitHub release's cumulative `CHANGELOG.md`,
prepends the new release, includes it in the npm package, and uploads it to the
matching GitHub release. This avoids a privileged release commit to protected
`main`.

## Bootstrap

After the release workflow exists on `main`:

1. Keep `NPM_RELEASE_ENABLED` set to `false`.
2. Publish version `0.0.0` once with the `bootstrap` dist-tag and npm 2FA. The
   bootstrap package must be built with the production OAuth injection values.
3. Tag that exact reviewed `main` SHA as `v0.0.0` and push the tag. This baseline
   prevents semantic-release from treating the Public Alpha as `1.0.0`.
4. On npmjs.com, configure `@diffler/cli` trusted publishing for GitHub owner
   `jamestkelly`, repository `diffler`, workflow `release.yml`, environment
   `npm`, and the `npm publish` action.
5. Set npm publishing access to require 2FA and disallow traditional tokens.
6. Set repository variable `NPM_RELEASE_ENABLED` to `true`.

The next `feat` commit on `main` creates version `0.1.0`; a patch-triggering
commit creates `0.0.1`. Do not assign the `latest` tag to the bootstrap package.

## Recovery

semantic-release is idempotent once the Git tag and npm version exist. Before
rerunning a failed release, inspect npm, Git tags, and GitHub Releases to find
the last completed step:

- If nothing was published, rerun the failed workflow after correcting the
  configuration only after confirming no version tag was created.
- If a version tag exists but neither npm nor GitHub published, confirm the npm
  version is absent, delete the local and remote tag, and rerun from the same
  reviewed SHA. Never delete a tag for a version present in npm.
- If npm published but the GitHub release failed, never overwrite or republish
  that npm version. Recreate the matching tag/release from the reviewed SHA, or
  merge a patch fix so semantic-release publishes the next version.
- With the configured plugin order, GitHub publication occurs after npm. If a
  GitHub release exists, treat npm as authoritative and repair whichever GitHub
  metadata or changelog asset is incomplete without another npm publish.
- If a cumulative changelog asset is missing, reconstruct it from prior release
  notes and attach it before the next automated release.

Never paste npm authentication responses, OIDC tokens, OAuth configuration,
or user credentials into logs or recovery issues.
