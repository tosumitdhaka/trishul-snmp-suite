#!/bin/bash
# Legacy compatibility wrapper. Canonical entrypoint: install-trishul-snmp-suite.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT="$SCRIPT_DIR/install-trishul-snmp-suite.sh"

if [ ! -x "$TARGET_SCRIPT" ]; then
    echo "Error: $TARGET_SCRIPT is missing or not executable."
    exit 1
fi

echo "install-trishul-snmp.sh is now a compatibility wrapper."
echo "Use install-trishul-snmp-suite.sh for the canonical 1.4.1 workflow."
exec "$TARGET_SCRIPT" "$@"
