# GitHub Workflow

This repo uses stable tracker IDs from [issue_tracker.md](issue_tracker.md) to keep GitHub issues, milestones, and pull requests tied to the roadmap.

## Tracker ID Rules

- Every scoped issue or PR should reference at least one stable tracker ID such as `BUG-005` or `FEAT-001`.
- Use the ID in the GitHub issue title when the work maps directly to one tracker item.
- If a PR covers multiple IDs, choose one primary ID and list the rest in the PR body.

Recommended title format:

- Issue: `[BUG-005] Verify simulator startup before reporting healthy`
- PR: `[BUG-005] Wait for simulator readiness before returning started`

## Branch Naming

Recommended branch names:

- `fix/bug-005-startup-readiness`
- `feat/feat-001-mib-dependency-fetch`
- `docs/gap-003-release-process`

## Labels

Apply labels from three groups:

- Type: `type:bug`, `type:gap`, `type:improvement`, `type:feature`
- Priority: `priority:P0`, `priority:P1`, `priority:P2`, `priority:P3`
- Release: `release:1.4.1` or later milestones

For the primary tracker item, also apply a stable tracker label:

- `tracker:BUG-005`
- `tracker:FEAT-001`

If creating one label per tracker ID becomes noisy, keep the release, type, and priority labels mandatory and keep the stable ID in the issue title and PR body at minimum.

## Milestones

Use release milestones that match the roadmap:

- `v1.4.1`
- `v1.5.0`

Each release-scoped issue should belong to exactly one milestone.

## Pull Requests

Pull requests should:

1. Reference the tracker ID in the title and body.
2. List the verification steps that were actually run.
3. Call out docs or changelog updates when behavior changed.
4. Use `.github/pull_request_template.md`.

Do not mark a tracker item `Done` in the repo docs until code, docs, and verification have all landed together.
