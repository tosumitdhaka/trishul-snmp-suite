# Documentation

This directory is the canonical documentation home for Trishul SNMP Suite.
The GitHub wiki is being retired in favor of versioned docs that live in the repo with the code.

## Start Here

- [Installation Guide](installation_guide.md)
- [First Steps](first_steps.md)
- [FAQ](faq.md)

## Feature Guides

- [SNMP Simulator Guide](snmp_simulator_guide.md)
- [Walker Guide](walker_guide.md)
- [Trap Manager Guide](trap_manager_guide.md)
- [MIB Manager Guide](mib_manager_guide.md)
- [MIB Browser Guide](mib_browser_guide.md)

## Reference

- [Architecture Overview](architecture_overview.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)

## Project and Operations Docs

- [Development Setup](development_setup.md)
- [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md)
- [Release Process](release_process.md)
- [Changelog](changelog.md)
- [Roadmap](roadmap.md)
- [Issue Tracker](issue_tracker.md)
- [GitHub Workflow](github_workflow.md)

## Common Workflows

1. Install the application with the published image or a local build.
2. Log in with the default credentials and change them in Settings.
3. Start the simulator and load sample custom OID values.
4. Run a walk against `127.0.0.1:1061`.
5. Start the trap receiver and send a test trap to `127.0.0.1:1162`.
6. Upload a custom MIB, review missing dependencies, and reload.
7. Explore objects and notifications in the MIB Browser.

If you are upgrading from the old split frontend/backend runtime, read [Migration To Trishul SNMP Suite](migration_to_trishul_snmp_suite.md) before changing deployment commands.
