# Repository Settings

## Branch Protection

Protect `main` with the `Review Gate` status check from
`.github/workflows/review.yml`. This is the only review-workflow check that
branch protection should require.

`Review Gate` runs after every validation prerequisite and succeeds only when
all required work succeeds. Keeping branch protection attached to this stable
terminal job allows internal validation steps to be split, renamed, or skipped
intentionally without repeatedly changing repository settings.

Recommended `main` settings:

- Require a pull request before merging.
- Require the branch to be up to date before merging.
- Require the `Review Gate` status check.
- Do not require internal jobs such as `Validate` separately.
- Do not allow administrators or automation to bypass the check routinely.

The review workflow also runs after a push to `main` to validate the exact merged
result. It has read-only repository permissions, makes no Google API calls, and
does not publish releases.

## Review Concurrency

Review runs share a concurrency group per pull request or Git ref. A new commit
cancels obsolete work for the same change so only the latest SHA can produce a
successful gate. Release workflows use a separate concurrency group and must not
reuse or depend on review cancellation behavior.
