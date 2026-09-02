"""Unit tests for local and Supabase-shaped profile stores."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from advisor.profile_store import (
    LocalProfileStore,
    ProfileStoreError,
    SupabaseProfileStore,
    create_profile_store,
)


def test_local_store_round_trip(tmp_path: Path) -> None:
    store = LocalProfileStore(tmp_path / "profiles")
    assert store.list_ids() == []
    assert store.get("missing") is None

    payload = {"profile_id": "alpha", "name": "Alpha"}
    store.put("alpha", payload)
    assert store.list_ids() == ["alpha"]
    assert store.get("alpha") == payload

    store.put("alpha", {"profile_id": "alpha", "name": "Updated"})
    assert store.get("alpha")["name"] == "Updated"

    assert store.delete("alpha") is True
    assert store.get("alpha") is None
    assert store.list_ids() == []
    assert store.delete("alpha") is False


def test_local_store_rejects_invalid_json_object(tmp_path: Path) -> None:
    directory = tmp_path / "profiles"
    directory.mkdir()
    (directory / "broken.json").write_text("[1,2,3]", encoding="utf-8")
    store = LocalProfileStore(directory)
    with pytest.raises(ProfileStoreError):
        store.get("broken")


def test_create_profile_store_defaults_to_local(tmp_path: Path) -> None:
    store = create_profile_store(profiles_dir=tmp_path, env={})
    assert isinstance(store, LocalProfileStore)
    store = create_profile_store(profiles_dir=tmp_path, env={"PROFILE_STORE": "local"})
    assert isinstance(store, LocalProfileStore)


def test_create_profile_store_requires_supabase_url() -> None:
    with pytest.raises(ValueError, match="SUPABASE_DB_URL"):
        create_profile_store(env={"PROFILE_STORE": "supabase"})
    with pytest.raises(ValueError, match="SUPABASE_DB_URL"):
        create_profile_store(env={"DATA_STORE": "supabase"})


def test_create_profile_store_rejects_unknown_mode() -> None:
    with pytest.raises(ValueError, match="Unknown DATA_STORE/PROFILE_STORE"):
        create_profile_store(env={"PROFILE_STORE": "s3"})


class _FakeCursor:
    def __init__(self, rows: list[tuple[Any, ...]] | None = None, fetchone_row: tuple[Any, ...] | None = None) -> None:
        self.rows = rows or []
        self.fetchone_row = fetchone_row
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


def test_supabase_store_list_get_put_with_fake_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    list_cursor = _FakeCursor(rows=[("zeta",), ("alpha",), ("bad id!",)])
    get_cursor = _FakeCursor(fetchone_row=({"profile_id": "alpha", "name": "A"},))
    put_cursor = _FakeCursor()
    connections = [
        _FakeConnection(list_cursor),
        _FakeConnection(get_cursor),
        _FakeConnection(put_cursor),
    ]

    def connect(*_args: Any, **_kwargs: Any) -> _FakeConnection:
        return connections.pop(0)

    store = SupabaseProfileStore("postgresql://example")
    monkeypatch.setattr(store, "_connect", connect)

    assert store.list_ids() == ["zeta", "alpha"]
    assert store.get("alpha") == {"profile_id": "alpha", "name": "A"}

    payload = {"profile_id": "alpha", "name": "Saved"}
    store.put("alpha", payload)
    assert put_cursor.executed
    query, params = put_cursor.executed[0]
    assert "ON CONFLICT" in query
    assert params is not None
    assert params[0] == "alpha"
    assert json.loads(params[1]) == payload
    assert connections == []


@pytest.mark.skipif(
    not __import__("os").environ.get("SUPABASE_DB_URL"),
    reason="SUPABASE_DB_URL not set; skip live smoke",
)
def test_supabase_live_smoke_round_trip() -> None:
    import os
    import uuid

    store = create_profile_store(
        env={"PROFILE_STORE": "supabase", "SUPABASE_DB_URL": os.environ["SUPABASE_DB_URL"]},
    )
    profile_id = f"smoke-{uuid.uuid4().hex[:12]}"
    payload = {"profile_id": profile_id, "name": "smoke"}
    store.put(profile_id, payload)
    assert store.get(profile_id) == payload
    assert profile_id in store.list_ids()
