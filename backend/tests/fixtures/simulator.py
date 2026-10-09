import pytest


@pytest.fixture()
def zero_length_simulator_bundle(isolated_db):
    """Compile bridge-style SIZE (0 | 6) addresses with ordinary defaults."""
    from app.services.bundle_state import set_bundle
    from app.services.bundles import BundleCompileRequest, BundleService
    from trishul_snmp.mib import load_bundle

    settings = isolated_db["settings"]
    source_dir = settings.data_dir / "mibs" / "default"
    source_dir.mkdir(parents=True, exist_ok=True)
    (source_dir / "ZERO-LENGTH-MIB.mib").write_text('''ZERO-LENGTH-MIB DEFINITIONS ::= BEGIN
IMPORTS
    OBJECT-TYPE, enterprises FROM SNMPv2-SMI
    PhysAddress, MacAddress FROM SNMPv2-TC;

zeroLengthRoot OBJECT IDENTIFIER ::= { enterprises 53864 }

bridgeAddress OBJECT-TYPE
    SYNTAX PhysAddress (SIZE (0 | 6))
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "An empty or six-octet address, as used in bridge MIBs."
    ::= { zeroLengthRoot 1 }

requiredAddress OBJECT-TYPE
    SYNTAX MacAddress (SIZE (6))
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "An address requiring exactly six octets."
    ::= { zeroLengthRoot 2 }

statusBits OBJECT-TYPE
    SYNTAX BITS { enabled(0), active(1) }
    MAX-ACCESS read-only
    STATUS current
    DESCRIPTION "Bits default to an empty octet string."
    ::= { zeroLengthRoot 3 }
END
''')
    result = BundleService(settings).compile_bundle(
        BundleCompileRequest(
            mib_names=["ZERO-LENGTH-MIB", "SNMPv2-MIB"],
            mib_dirs=[str(source_dir), str(settings.bundled_mibs_dir)],
            activate=True,
        )
    )
    bundle = load_bundle(result["activation"]["bundle"]["storage_path"])
    set_bundle(bundle)
    return bundle
