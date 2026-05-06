# MIB Browser Guide

The MIB Browser is the exploration tool for loaded and system MIB content.

## Main Views

The browser supports two navigation modes:

- **By Module** for module-oriented exploration
- **By OID** for hierarchy-oriented exploration

Both modes share the same detail panel and export actions.

## Search And Filters

The left-side search and filter area lets you:

- search by object name
- search by numeric OID
- search by description text
- filter by module
- filter by object type

Examples:

- `ifDescr`
- `1.3.6.1.2.1.1.1`
- `interface`

## Tree Navigation

The tree supports:

- lazy expansion
- depth control
- expand and collapse controls
- module filtering

The current tree state is intended to be usable on both desktop and reduced-zoom layouts.

## Details Panel

The right-side panel shows metadata for the selected node, including:

- name
- OID
- module
- type
- description
- related trap objects when the node is a notification

## Export

The browser can export the **current view only**:

- current search results
- or the currently loaded tree with the active view mode and filters

Formats:

- JSON
- CSV

## Integration Shortcuts

The browser is connected to the rest of the app:

- send a notification into Trap Sender
- jump into Walker with the selected OID

## Recommended Workflow

1. Load or upload the MIBs you care about.
2. Search for the object or notification.
3. Review details on the right.
4. Export the current result set if needed.
5. Jump into Walker or Trap Sender for the next step.

## Related Docs

- [MIB Manager Guide](mib_manager_guide.md)
- [Walker Guide](walker_guide.md)
- [Trap Manager Guide](trap_manager_guide.md)
- [API Reference](api_reference.md)
