# Documentation

This directory is the canonical documentation set for Trishul SNMP Suite `2.1.0`.
The shipped operator surface is the restored page-based shell in `frontend/`:
`Dashboard`, `Simulator`, `Walk & Parse`, `Traps`, `MIB Browser`,
`MIB Manager`, and `Settings`.

## Start Here

- [Installation Guide](installation_guide.md)
- [First Steps](first_steps.md)
- [Workspaces](workspaces.md)
- [FAQ](faq.md)

## Operator And Platform Reference

- [Architecture Overview](architecture_overview.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)

`Changelog` intentionally contains historical `1.x` references. It is still a
current doc, but not steady-state operator guidance.

The temporary `2.0.0` planning and document-review notes were removed from the
active repo tree during the release cleanup. Use
[Architecture Overview](architecture_overview.md), [Roadmap](roadmap.md), and
[Issue Tracker](issue_tracker.md) for the maintained architecture and release
status references.

## Operator Guides

These topic guides describe the current `2.1.0` release UI.

- [MIB Manager Guide](mib_manager_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)
- [Simulator Guide](snmp_simulator_guide.md)
- [Walk & Parse Guide](walker_guide.md)
- [Traps Guide](trap_manager_guide.md)

## Development And Release

- [Development Setup](development_setup.md)
- [Release Process](release_process.md)
- [Changelog](changelog.md)
- [Roadmap](roadmap.md)
- [MIB Schema Integration Plan](mib_schema_integration_plan.md)
- [E2E Review Findings](e2e_review_findings.md)
- [Issue Tracker](issue_tracker.md)
- [GitHub Workflow](github_workflow.md)

## 2.0 Planning And Design

These are historical planning artifacts for the `2.0.0` delivery path, not the
operator source of truth for the shipped UI.

The temporary planning workspace was removed from the active repo tree after
the `2.0.0` cleanup. Use [Architecture Overview](architecture_overview.md),
[Roadmap](roadmap.md), [Issue Tracker](issue_tracker.md), and
[Changelog](changelog.md) for the maintained release record.

## 2.1 Follow-Up Planning

`2.1.0` follow-up planning is tracked directly in [Roadmap](roadmap.md) and
[Issue Tracker](issue_tracker.md). No separate follow-up planning directory is
kept in the live docs tree.

## Common 2.0 Flow

1. Install the suite with the published image or a local build.
2. Log in with `admin` / `admin123` and rotate credentials in `Settings`.
3. Load or verify MIBs in `MIB Manager`.
4. Use `MIB Browser` to inspect symbols and jump into other pages.
5. Use `Simulator` and `Walk & Parse` for local responder validation.
6. Use `Traps` for listener and trap-send testing.
7. Use `Dashboard` and `Settings` for health, stats, and metadata.
