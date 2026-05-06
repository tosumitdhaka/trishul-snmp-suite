# MIB Manager Guide

The MIB Manager is the operational home for loading, validating, reloading, and cleaning up MIB files.

## What It Covers

- MIB upload
- automatic validation on file selection
- dependency detection
- optional trusted-source dependency fetch
- reload behavior
- MIB library overview
- trap library overview

## Supported File Types

- `.mib`
- `.txt`
- `.my`

## Validation Behavior

Validation runs automatically when files are selected in the upload modal.

Important rules:

- validation is read-only
- validation never fetches remote dependencies
- uploaded filenames are sanitized before save

If validation fails, review the detailed error text before uploading.

## Dependency Handling

When dependencies are missing, the UI can show:

- per-file missing dependencies
- a global missing dependency list
- a manual fetch action

Remote fetch is restricted to the approved source list from Settings.

Auto-fetch is:

- off by default
- optional
- only used during upload or reload when enabled

## Upload And Reload

After a successful upload:

- files are saved into the MIB data directory
- the MIB service reloads
- simulator and trap receiver are restarted if they were already running
- counts and trap availability are refreshed

## MIB Library

The left-side library shows:

- loaded MIB count
- failed MIB count
- trap count
- loaded module details
- delete actions for saved MIB files

Failed MIBs are listed separately with their error details.

## Trap Library

The right-side trap library provides:

- a consolidated list of available notifications
- search
- trap details
- direct jump into Trap Sender

Built-in system traps are clearly marked when they come from bundled system MIBs rather than user-uploaded files.

## Recommended Usage Pattern

1. Upload the MIB file.
2. Review validation results.
3. Resolve or fetch missing dependencies.
4. Upload and reload.
5. Check the trap library and MIB Browser for the newly loaded content.

## Related Docs

- [MIB Browser Guide](mib_browser_guide.md)
- [Trap Manager Guide](trap_manager_guide.md)
- [API Reference](api_reference.md)
- [Troubleshooting](troubleshooting.md)
