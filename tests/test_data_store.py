"""Unit tests for dataset/blob persistence helpers."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from advisor.data_store import (
    LocalBlobStore,
    LocalDatasetStore,
    SupabaseBlobStore,
    SupabaseDatasetStore,
    assert_safe_path,
    create_persistence,
    push_json_tree,
)


def test_assert_safe_path_rejects_traversal() -> None:
    with pytest.raises(ValueError):
        assert_safe_path("../secret.json")
    with pytest.raises(ValueError):
        assert_safe_path("/abs.json")
    assert assert_safe_path("team/2026-27/auction_data.json") == "team/2026-27/auction_data.json"


def test_local_dataset_and_blob_round_trip(tmp_path: Path) -> None:
    datasets = LocalDatasetStore(tmp_path / "processed")
    blobs = LocalBlobStore(tmp_path)
    payload = {"schema_version": "1.0", "players": []}
    datasets.put("a/2026-27/auction_data.json", payload)
    assert datasets.get("a/2026-27/auction_data.json") == payload
    assert datasets.list_paths() == ["a/2026-27/auction_data.json"]
    assert datasets.manifest()["datasets"][0]["path"] == "a/2026-27/auction_data.json"

    blobs.put("raw/listone.xlsx", b"xlsx-bytes", content_type="application/vnd.ms-excel")
    assert blobs.get("raw/listone.xlsx") == b"xlsx-bytes"
    assert blobs.list_paths("raw/") == ["raw/listone.xlsx"]


def test_create_persistence_local_default(tmp_path: Path) -> None:
    bundle = create_persistence(
        profiles_dir=tmp_path / "profiles",
        datasets_dir=tmp_path / "processed",
        blob_root=tmp_path,
        env={},
    )
    assert bundle.mode == "local"


def test_create_persistence_requires_url_for_supabase() -> None:
    with pytest.raises(ValueError, match="SUPABASE_DB_URL"):
        create_persistence(env={"DATA_STORE": "supabase"})


def test_push_json_tree(tmp_path: Path) -> None:
    processed = tmp_path / "processed"
    target = processed / "p" / "2026-27" / "auction_data.json"
    target.parent.mkdir(parents=True)
    target.write_text(json.dumps({"ok": True}), encoding="utf-8")
    store = LocalDatasetStore(processed)
    assert push_json_tree(processed / "p", store, relative_root=processed) == ["p/2026-27/auction_data.json"]
    assert store.get("p/2026-27/auction_data.json") == {"ok": True}


class _FakeCursor:
    def __init__(self, fetchone_row: tuple[Any, ...] | None = None, rows: list[tuple[Any, ...]] | None = None) -> None:
        self.fetchone_row = fetchone_row
        self.rows = rows or []
        self.executed: list[tuple[str, tuple[Any, ...] | None]] = []

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def execute(self, query: str, params: tuple[Any, ...] | None = None) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> list[tuple[Any, ...]]:
        return self.rows

    def fetchone(self) -> tuple[Any, ...] | None:
        return self.fetchone_row


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor
        self.committed = False

    def __enter__(self) -> _FakeConnection:
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def cursor(self) -> _FakeCursor:
        return self._cursor

    def commit(self) -> None:
        self.committed = True


def test_supabase_dataset_put_get_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    get_cursor = _FakeCursor(fetchone_row=({"players": []},))
    put_cursor = _FakeCursor()
    connections = [_FakeConnection(get_cursor), _FakeConnection(put_cursor)]

    def connect(*_args: Any, **_kwargs: Any) -> _FakeConnection:
        return connections.pop(0)

    store = SupabaseDatasetStore("postgresql://example")
    monkeypatch.setattr(store, "_connect", connect)
    assert store.get("a/x.json") == {"players": []}
    store.put("a/x.json", {"players": [1]})
    assert "ON CONFLICT" in put_cursor.executed[0][0]


def test_supabase_blob_put_get_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    get_cursor = _FakeCursor(fetchone_row=(b"abc",))
    put_cursor = _FakeCursor()
    connections = [_FakeConnection(get_cursor), _FakeConnection(put_cursor)]

    def connect(*_args: Any, **_kwargs: Any) -> _FakeConnection:
        return connections.pop(0)

    store = SupabaseBlobStore("postgresql://example")
    monkeypatch.setattr(store, "_connect", connect)
    assert store.get("raw/a.csv") == b"abc"
    store.put("raw/a.csv", b"xyz", content_type="text/csv")
    assert put_cursor.executed[0][1][0] == "raw/a.csv"
    assert put_cursor.executed[0][1][1] == b"xyz"
