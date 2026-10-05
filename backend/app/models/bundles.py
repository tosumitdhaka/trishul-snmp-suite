from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class BundleSet(Base):
    __tablename__ = "bundle_sets"
    __table_args__ = (
        UniqueConstraint("bundle_key", name="uq_bundle_sets_bundle_key"),
        UniqueConstraint("storage_path", name="uq_bundle_sets_storage_path"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bundle_key: Mapped[str] = mapped_column(String(120), nullable=False)
    label: Mapped[str | None] = mapped_column(String(255), nullable=True)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    manifest_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    oid_index_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_hash: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="draft",
        server_default=text("'draft'"),
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default=text("0"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    modules: Mapped[list["BundleModule"]] = relationship(
        back_populates="bundle_set",
        cascade="all, delete-orphan",
    )
    compile_runs: Mapped[list["CompileRun"]] = relationship(back_populates="bundle_set")


class BundleModule(Base):
    __tablename__ = "bundle_modules"
    __table_args__ = (
        UniqueConstraint(
            "bundle_set_id",
            "module_name",
            name="uq_bundle_modules_bundle_set_module_name",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    bundle_set_id: Mapped[int] = mapped_column(
        ForeignKey("bundle_sets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    module_name: Mapped[str] = mapped_column(String(255), nullable=False)
    source_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    compiled_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    module_identity_oid: Mapped[str | None] = mapped_column(String(255), nullable=True)
    object_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    notification_count: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        default=0,
        server_default=text("0"),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    bundle_set: Mapped[BundleSet] = relationship(back_populates="modules")


class CompileRun(Base):
    __tablename__ = "compile_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    requested_mib_names_json: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    source_dirs_json: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    command_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    bundle_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    output_dir: Mapped[str | None] = mapped_column(Text, nullable=True)
    manifest_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    oid_index_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    bundle_set_id: Mapped[int | None] = mapped_column(
        ForeignKey("bundle_sets.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        nullable=False,
        default="pending",
        server_default=text("'pending'"),
    )
    stdout_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    stderr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    bundle_set: Mapped[BundleSet | None] = relationship(back_populates="compile_runs")
