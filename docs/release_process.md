# Release Process

This checklist is the repo source of truth for cutting a release after the `1.4.0` runtime merge and product rename.

## 1. Lock Scope

Before bumping versions:

1. Update [issue_tracker.md](issue_tracker.md) so each included ID is `Done` and each deferred item is clearly marked.
2. Update [roadmap.md](roadmap.md) so the release scope and deferred scope match the tracker.
3. Check `README.md` for user-facing setup and scope summaries that mention the release.
4. Confirm the matching GitHub milestone and labels follow [github_workflow.md](github_workflow.md).

Release-blocking bugs stay release gates.
Do not cut a release while any release-blocking `BUG-*` item is still open.

## 2. Bump Version Markers

For `1.4.0` and later, the version markers that must stay aligned are:

- `.env`
- `backend/core/config.py`
- `backend/app/core/config.py`
- `docker-compose.yml`
- `docs/changelog.md`

If the release changes public setup or packaging behavior, also review:

- `README.md`
- `docs/development_setup.md`
- `docs/migration_to_trishul_snmp_suite.md`
- `docs/github_workflow.md`

## 3. Update Release Notes

Add a new section to [changelog.md](changelog.md) with:

- Release date
- Architecture or packaging changes
- New features
- Behavior changes
- Fixes and migration notes

Also add the compare link at the bottom, for example:

```text
[1.4.0]: https://github.com/tosumitdhaka/trishul-snmp-suite/compare/v1.3.0...v1.4.0
```

## 4. Verify The Tree

Run the repo verification commands from the repo root:

```bash
python3 -m compileall backend
python3 -m pytest
```

For release-facing changes, also verify these flows manually in a merged Docker runtime built from the release candidate:

- Login and logout
- Simulator start, stop, and restart
- Trap receiver start and trap send/receive
- Walk execution
- MIB upload, validation, reload, and dependency fetch behavior
- Browser export in JSON and CSV
- Settings metadata shows the expected version
- Root UI, module partials, `/api/meta`, and `/docs` all load from the single app container

## 5. Publish Images

Merging to `main` triggers `.github/workflows/ghcr-publish.yml`.

That workflow publishes:

- `ghcr.io/<owner>/trishul-snmp-suite:latest`
- `ghcr.io/<owner>/trishul-snmp-suite:${APP_VERSION}`

The workflow builds for both:

- `linux/amd64`
- `linux/arm64`

## 6. Migration and Rename Checks

For the `1.4.0` cutover:

1. Verify `install-trishul-snmp-suite.sh up` on a clean host.
2. Verify `install-trishul-snmp.sh up` still works as a compatibility wrapper.
3. Verify automatic migration from `trishul-snmp-data` to `trishul-snmp-suite-data`.
4. Verify old `trishul-snmp-backend` and `trishul-snmp-frontend` containers are stopped and replaced.
5. Follow [migration_to_trishul_snmp_suite.md](migration_to_trishul_snmp_suite.md) for operator-facing guidance.

## 7. Post-Release Checks

After publish:

1. Pull the new image or run `docker compose up -d`.
2. Confirm `/api/meta` and `/api/health` report the expected version.
3. Confirm the Settings "About" card shows the same version.
4. Re-check the changelog compare link and migration notes.
5. Rename the GitHub repo to `trishul-snmp-suite` if the code patch landed before the external cutover.

If any of those markers disagree, fix the repo first, then republish.
