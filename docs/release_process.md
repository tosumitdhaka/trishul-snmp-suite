# Release Process

This checklist is the repo source of truth for cutting a release after the `1.3.0` doc reorganization.

## 1. Lock Scope

Before bumping versions:

1. Update [issue_tracker.md](issue_tracker.md) so each included ID is `Done` and each deferred item is clearly marked.
2. Update [roadmap.md](roadmap.md) so the release scope and deferred scope match the tracker.
3. Check `README.md` for user-facing scope summaries that mention the release.
4. Confirm the matching GitHub milestone and labels follow [github_workflow.md](github_workflow.md).

Hardening items are release gates.
Do not cut a release while any release-blocking `BUG-*` item is still open.

## 2. Bump Version Markers

For `1.3.0`, the version markers that must stay aligned are:

- `.env`
- `backend/core/config.py`
- `backend/app/core/config.py`
- `docker-compose.yml`
- `docs/changelog.md`

If the release changes public scope or setup behavior, also review:

- `README.md`
- `docs/development_setup.md`
- `docs/github_workflow.md`

## 3. Update Release Notes

Add a new section to [changelog.md](changelog.md) with:

- Release date
- Security fixes
- New features
- Behavior changes
- Bug fixes

Also add the compare link at the bottom, for example:

```text
[1.3.0]: https://github.com/tosumitdhaka/trishul-snmp/compare/v1.2.5...v1.3.0
```

## 4. Verify The Tree

Run the backend verification commands from the repo root:

```bash
python3 -m compileall backend
python3 -m pytest
```

For release-facing changes, also verify these flows manually in a Docker stack built from the release candidate:

- Login and logout
- Simulator start, stop, and restart
- Trap receiver start and trap send/receive
- Walk execution
- MIB upload, validation, reload, and dependency fetch behavior
- Browser export in JSON and CSV
- Settings metadata shows the expected version

## 5. Publish Images

Merging to `main` triggers `.github/workflows/ghcr-publish.yml`.

That workflow publishes:

- `ghcr.io/<owner>/trishul-snmp-backend:latest`
- `ghcr.io/<owner>/trishul-snmp-backend:${APP_VERSION}`
- `ghcr.io/<owner>/trishul-snmp-frontend:latest`
- `ghcr.io/<owner>/trishul-snmp-frontend:${APP_VERSION}`

The workflow builds for both:

- `linux/amd64`
- `linux/arm64`

## 6. Post-Release Checks

After publish:

1. Pull the new images or run `docker compose up -d`.
2. Confirm `/api/meta` and `/api/health` report the expected version.
3. Confirm the Settings "About" card shows the same version.
4. Re-check the changelog compare link and release notes.

If any of those markers disagree, fix the repo first, then republish.
