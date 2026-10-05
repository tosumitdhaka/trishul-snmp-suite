"""Add content_hash to bundle_sets.

Records a SHA-256 over the sorted manifest-declared module files so identical
recompiles are recognizable as such.
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20261001_0002"
down_revision = "20260522_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bundle_sets",
        sa.Column("content_hash", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("bundle_sets", "content_hash")