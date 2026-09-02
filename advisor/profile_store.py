"""Profile persistence backends: local JSON files or Supabase Postgres."""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Mapping, Protocol


PROFILE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")


class ProfileStoreError(OSError):
    """Profile storage is unavailable or returned an invalid payload."""


class ProfileStore(Protocol):
    """Minimal list/get/put/delete interface used by the local HTTP API."""

    def list_ids(self) -> list[str]:
        """Return sorted saved profile identifiers."""

    def get(self, profile_id: str) -> dict[str, Any] | None:
        """Return the stored JSON object, or None when missing."""

    def put(self, profile_id: str, payload: dict[str, Any]) -> None:
        """Persist a validated profile payload under profile_id."""

    def delete(self, profile_id: str) -> bool:
        """Remove a profile. Return True when something was deleted."""


class LocalProfileStore:
    """Filesystem store under config/profiles (or a test temporary directory)."""

    def __init__(self, profiles_dir: Path | str) -> None:
        self.profiles_dir = Path(profiles_dir)

    def list_ids(self) -> list[str]:
        directory = self.profiles_dir
        if not directory.exists():
            return []
        if not directory.is_dir():
            raise ProfileStoreError("Profile storage is unavailable.")
        return sorted(
            path.stem
            for path in directory.glob("*.json")
            if path.is_file() and PROFILE_ID.fullmatch(path.stem)
        )

    def get(self, profile_id: str) -> dict[str, Any] | None:
        path = self._path(profile_id)
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as error:
            raise ProfileStoreError("The stored profile is invalid or unreadable.") from error
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise ProfileStoreError("The stored profile is invalid or unreadable.") from error
        if not isinstance(value, dict):
            raise ProfileStoreError("The saved profile must be a JSON object.")
        return value

    def put(self, profile_id: str, payload: dict[str, Any]) -> None:
        path = self._path(profile_id)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=path.parent,
                delete=False,
            ) as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                temporary_path = Path(handle.name)
            temporary_path.replace(path)
        except (OSError, TypeError, ValueError) as error:
            raise ProfileStoreError("The profile could not be saved.") from error

    def delete(self, profile_id: str) -> bool:
        path = self._path(profile_id)
        try:
            path.unlink()
            return True
        except FileNotFoundError:
            return False
        except OSError as error:
            raise ProfileStoreError("The profile could not be deleted.") from error

    def _path(self, profile_id: str) -> Path:
        if not PROFILE_ID.fullmatch(profile_id):
            raise ValueError("invalid profile id")
        return self.profiles_dir / f"{profile_id}.json"


class SupabaseProfileStore:
    """Postgres-backed store via psycopg (direct DB URL; server-side only)."""

    def __init__(self, db_url: str) -> None:
        if not db_url.strip():
            raise ValueError("SUPABASE_DB_URL must be a non-empty connection string.")
        self.db_url = db_url.strip()

    def list_ids(self) -> list[str]:
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT id FROM public.profiles ORDER BY id")
                    rows = cursor.fetchall()
        except Exception as error:
            raise ProfileStoreError("Profile storage is unavailable.") from error
        return [row[0] for row in rows if isinstance(row[0], str) and PROFILE_ID.fullmatch(row[0])]

    def get(self, profile_id: str) -> dict[str, Any] | None:
        if not PROFILE_ID.fullmatch(profile_id):
            raise ValueError("invalid profile id")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT payload FROM public.profiles WHERE id = %s",
                        (profile_id,),
                    )
                    row = cursor.fetchone()
        except Exception as error:
            raise ProfileStoreError("The stored profile is invalid or unreadable.") from error
        if row is None:
            return None
        value = row[0]
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError as error:
                raise ProfileStoreError("The stored profile is invalid or unreadable.") from error
        if not isinstance(value, dict):
            raise ProfileStoreError("The saved profile must be a JSON object.")
        return value

    def put(self, profile_id: str, payload: dict[str, Any]) -> None:
        if not PROFILE_ID.fullmatch(profile_id):
            raise ValueError("invalid profile id")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO public.profiles (id, payload, updated_at)
                        VALUES (%s, %s::jsonb, now())
                        ON CONFLICT (id) DO UPDATE
                        SET payload = EXCLUDED.payload,
                            updated_at = now()
                        """,
                        (profile_id, json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)),
                    )
                connection.commit()
        except (TypeError, ValueError) as error:
            raise ProfileStoreError("The profile could not be saved.") from error
        except Exception as error:
            raise ProfileStoreError("The profile could not be saved.") from error

    def delete(self, profile_id: str) -> bool:
        if not PROFILE_ID.fullmatch(profile_id):
            raise ValueError("invalid profile id")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("DELETE FROM public.profiles WHERE id = %s", (profile_id,))
                    deleted = cursor.rowcount > 0
                connection.commit()
        except Exception as error:
            raise ProfileStoreError("The profile could not be deleted.") from error
        return deleted

    def _connect(self) -> Any:
        import psycopg

        return psycopg.connect(self.db_url, connect_timeout=15)


def load_dotenv_file(path: Path | str = Path(".env")) -> None:
    """Load KEY=VALUE pairs from a local .env into os.environ when unset."""
    env_path = Path(path)
    if not env_path.is_file():
        return
    try:
        lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
            value = value[1:-1]
        os.environ[key] = value


def create_profile_store(
    *,
    profiles_dir: Path | str = Path("config/profiles"),
    env: Mapping[str, str] | None = None,
) -> ProfileStore:
    """Build the configured store. Default and tests: local filesystem."""
    environ = os.environ if env is None else env
    mode = str(environ.get("DATA_STORE") or environ.get("PROFILE_STORE", "local") or "local").strip().lower()
    if mode in {"", "local"}:
        return LocalProfileStore(profiles_dir)
    if mode == "supabase":
        db_url = str(environ.get("SUPABASE_DB_URL", "") or "").strip()
        if not db_url:
            raise ValueError("SUPABASE_DB_URL is required when DATA_STORE/PROFILE_STORE=supabase")
        return SupabaseProfileStore(db_url)
    raise ValueError(f"Unknown DATA_STORE/PROFILE_STORE value: {mode}")
