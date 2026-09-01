"""Dataset JSON and binary blob persistence (local disk or Supabase Postgres)."""
from __future__ import annotations

import json
import mimetypes
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Protocol

from .profile_store import (
    LocalProfileStore,
    ProfileStore,
    ProfileStoreError,
    SupabaseProfileStore,
    create_profile_store,
)


SAFE_PATH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,511}\Z")


class DataStoreError(OSError):
    """Dataset or blob storage is unavailable or returned invalid data."""


def assert_safe_path(path: str) -> str:
    """Reject empty, absolute, or traversal-prone relative paths."""
    value = path.strip().replace("\\", "/")
    if (
        not value
        or value.startswith("/")
        or ".." in value.split("/")
        or not SAFE_PATH.fullmatch(value)
    ):
        raise ValueError(f"Unsafe storage path: {path!r}")
    return value


def guess_content_type(path: str) -> str:
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


class DatasetStore(Protocol):
    def list_paths(self) -> list[str]:
        """Return sorted dataset relative paths."""

    def get(self, path: str) -> dict[str, Any] | None:
        """Return JSON payload or None when missing."""

    def put(self, path: str, payload: dict[str, Any]) -> None:
        """Upsert a JSON dataset payload."""

    def manifest(self) -> dict[str, list[dict[str, Any]]]:
        """Return API-shaped dataset manifest metadata."""


class BlobStore(Protocol):
    def list_paths(self, prefix: str = "") -> list[str]:
        """Return sorted blob paths, optionally filtered by prefix."""

    def get(self, path: str) -> bytes | None:
        """Return raw bytes or None when missing."""

    def put(self, path: str, content: bytes, *, content_type: str | None = None) -> None:
        """Upsert binary content."""


class LocalDatasetStore:
    """Filesystem store under data/processed."""

    def __init__(self, datasets_dir: Path | str) -> None:
        self.datasets_dir = Path(datasets_dir)

    def list_paths(self) -> list[str]:
        root = self.datasets_dir
        if not root.exists():
            return []
        if not root.is_dir():
            raise DataStoreError("Dataset storage is unavailable.")
        paths = []
        for path in sorted(root.rglob("*.json")):
            if path.is_file():
                paths.append(path.relative_to(root).as_posix())
        return paths

    def get(self, path: str) -> dict[str, Any] | None:
        target = self._resolve(path)
        try:
            text = target.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        except OSError as error:
            raise DataStoreError("The dataset is invalid or unreadable.") from error
        try:
            value = json.loads(text)
        except json.JSONDecodeError as error:
            raise DataStoreError("The dataset is invalid or unreadable.") from error
        if not isinstance(value, dict):
            raise DataStoreError("The dataset must be a JSON object.")
        return value

    def put(self, path: str, payload: dict[str, Any]) -> None:
        target = self._resolve(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=target.parent, delete=False) as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
                temporary = Path(handle.name)
            temporary.replace(target)
        except (OSError, TypeError, ValueError) as error:
            raise DataStoreError("The dataset could not be saved.") from error

    def manifest(self) -> dict[str, list[dict[str, Any]]]:
        root = self.datasets_dir
        if not root.exists():
            return {"datasets": []}
        if not root.is_dir():
            raise DataStoreError("Dataset storage is unavailable.")
        datasets = []
        for path in sorted(root.rglob("*.json")):
            if not path.is_file():
                continue
            stat = path.stat()
            datasets.append({
                "path": path.relative_to(root).as_posix(),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
            })
        return {"datasets": datasets}

    def _resolve(self, path: str) -> Path:
        relative = assert_safe_path(path)
        if not relative.endswith(".json"):
            raise ValueError("Dataset paths must end with .json")
        root = self.datasets_dir.resolve()
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            raise ValueError("Dataset paths must stay within dataset storage.")
        return candidate


class SupabaseDatasetStore:
    """Postgres-backed JSON datasets."""

    def __init__(self, db_url: str) -> None:
        if not db_url.strip():
            raise ValueError("SUPABASE_DB_URL must be a non-empty connection string.")
        self.db_url = db_url.strip()

    def list_paths(self) -> list[str]:
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT path FROM public.datasets ORDER BY path")
                    rows = cursor.fetchall()
        except Exception as error:
            raise DataStoreError("Dataset storage is unavailable.") from error
        return [row[0] for row in rows if isinstance(row[0], str)]

    def get(self, path: str) -> dict[str, Any] | None:
        relative = assert_safe_path(path)
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT payload FROM public.datasets WHERE path = %s", (relative,))
                    row = cursor.fetchone()
        except Exception as error:
            raise DataStoreError("The dataset is invalid or unreadable.") from error
        if row is None:
            return None
        value = row[0]
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except json.JSONDecodeError as error:
                raise DataStoreError("The dataset is invalid or unreadable.") from error
        if not isinstance(value, dict):
            raise DataStoreError("The dataset must be a JSON object.")
        return value

    def put(self, path: str, payload: dict[str, Any]) -> None:
        relative = assert_safe_path(path)
        try:
            encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO public.datasets (path, payload, updated_at)
                        VALUES (%s, %s::jsonb, now())
                        ON CONFLICT (path) DO UPDATE
                        SET payload = EXCLUDED.payload,
                            updated_at = now()
                        """,
                        (relative, encoded),
                    )
                connection.commit()
        except (TypeError, ValueError) as error:
            raise DataStoreError("The dataset could not be saved.") from error
        except Exception as error:
            raise DataStoreError("The dataset could not be saved.") from error

    def manifest(self) -> dict[str, list[dict[str, Any]]]:
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT path,
                               pg_column_size(payload) AS size_bytes,
                               updated_at
                        FROM public.datasets
                        ORDER BY path
                        """
                    )
                    rows = cursor.fetchall()
        except Exception as error:
            raise DataStoreError("Dataset storage is unavailable.") from error
        datasets = []
        for path, size_bytes, updated_at in rows:
            if not isinstance(path, str):
                continue
            if hasattr(updated_at, "isoformat"):
                modified = updated_at.astimezone(timezone.utc).isoformat()
            else:
                modified = str(updated_at)
            datasets.append({
                "path": path,
                "size_bytes": int(size_bytes or 0),
                "modified_at": modified,
            })
        return {"datasets": datasets}

    def _connect(self) -> Any:
        import psycopg

        return psycopg.connect(self.db_url, connect_timeout=15)


class LocalBlobStore:
    """Filesystem blob store rooted at a directory (uploads or project root for raw)."""

    def __init__(self, root_dir: Path | str) -> None:
        self.root_dir = Path(root_dir)

    def list_paths(self, prefix: str = "") -> list[str]:
        root = self.root_dir
        if not root.exists():
            return []
        if not root.is_dir():
            raise DataStoreError("Blob storage is unavailable.")
        prefix = prefix.strip().replace("\\", "/")
        paths = []
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if prefix and not relative.startswith(prefix):
                continue
            paths.append(relative)
        return paths

    def get(self, path: str) -> bytes | None:
        target = self._resolve(path)
        try:
            return target.read_bytes()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise DataStoreError("The stored file is invalid or unreadable.") from error

    def put(self, path: str, content: bytes, *, content_type: str | None = None) -> None:
        del content_type  # filesystem ignores MIME; retained for Protocol parity
        target = self._resolve(path)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("wb", dir=target.parent, delete=False) as handle:
                handle.write(content)
                temporary = Path(handle.name)
            temporary.replace(target)
        except OSError as error:
            raise DataStoreError("The file could not be saved.") from error

    def _resolve(self, path: str) -> Path:
        relative = assert_safe_path(path)
        root = self.root_dir.resolve()
        candidate = (root / relative).resolve()
        if not candidate.is_relative_to(root):
            raise ValueError("Blob paths must stay within blob storage.")
        return candidate


class SupabaseBlobStore:
    """Postgres-backed binary blobs (raw sources, uploads, non-JSON artifacts)."""

    def __init__(self, db_url: str) -> None:
        if not db_url.strip():
            raise ValueError("SUPABASE_DB_URL must be a non-empty connection string.")
        self.db_url = db_url.strip()

    def list_paths(self, prefix: str = "") -> list[str]:
        prefix = prefix.strip().replace("\\", "/")
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    if prefix:
                        cursor.execute(
                            "SELECT path FROM public.blobs WHERE path LIKE %s ORDER BY path",
                            (f"{prefix}%",),
                        )
                    else:
                        cursor.execute("SELECT path FROM public.blobs ORDER BY path")
                    rows = cursor.fetchall()
        except Exception as error:
            raise DataStoreError("Blob storage is unavailable.") from error
        return [row[0] for row in rows if isinstance(row[0], str)]

    def get(self, path: str) -> bytes | None:
        relative = assert_safe_path(path)
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT content FROM public.blobs WHERE path = %s", (relative,))
                    row = cursor.fetchone()
        except Exception as error:
            raise DataStoreError("The stored file is invalid or unreadable.") from error
        if row is None:
            return None
        value = row[0]
        if isinstance(value, memoryview):
            return value.tobytes()
        if isinstance(value, bytes):
            return value
        raise DataStoreError("The stored file is invalid or unreadable.")

    def put(self, path: str, content: bytes, *, content_type: str | None = None) -> None:
        relative = assert_safe_path(path)
        mime = content_type or guess_content_type(relative)
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO public.blobs (path, content, content_type, byte_size, updated_at)
                        VALUES (%s, %s, %s, %s, now())
                        ON CONFLICT (path) DO UPDATE
                        SET content = EXCLUDED.content,
                            content_type = EXCLUDED.content_type,
                            byte_size = EXCLUDED.byte_size,
                            updated_at = now()
                        """,
                        (relative, content, mime, len(content)),
                    )
                connection.commit()
        except Exception as error:
            raise DataStoreError("The file could not be saved.") from error

    def _connect(self) -> Any:
        import psycopg

        return psycopg.connect(self.db_url, connect_timeout=15)


@dataclass(frozen=True)
class PersistenceBundle:
    """All durable stores used by the local API."""

    profiles: ProfileStore
    datasets: DatasetStore
    blobs: BlobStore
    mode: str


def store_mode(env: Mapping[str, str] | None = None) -> str:
    """Resolve persistence backend. DATA_STORE wins; else PROFILE_STORE; else local."""
    environ = os.environ if env is None else env
    for key in ("DATA_STORE", "PROFILE_STORE"):
        value = str(environ.get(key, "") or "").strip().lower()
        if value:
            return value
    return "local"


def create_persistence(
    *,
    profiles_dir: Path | str = Path("config/profiles"),
    datasets_dir: Path | str = Path("data/processed"),
    blob_root: Path | str = Path("data"),
    env: Mapping[str, str] | None = None,
) -> PersistenceBundle:
    """Build profile/dataset/blob stores for local disk or Supabase Postgres."""
    environ = os.environ if env is None else env
    mode = store_mode(environ)
    if mode in {"", "local"}:
        return PersistenceBundle(
            profiles=LocalProfileStore(profiles_dir),
            datasets=LocalDatasetStore(datasets_dir),
            blobs=LocalBlobStore(blob_root),
            mode="local",
        )
    if mode == "supabase":
        db_url = str(environ.get("SUPABASE_DB_URL", "") or "").strip()
        if not db_url:
            raise ValueError("SUPABASE_DB_URL is required when DATA_STORE/PROFILE_STORE=supabase")
        return PersistenceBundle(
            profiles=SupabaseProfileStore(db_url),
            datasets=SupabaseDatasetStore(db_url),
            blobs=SupabaseBlobStore(db_url),
            mode="supabase",
        )
    raise ValueError(f"Unknown DATA_STORE/PROFILE_STORE value: {mode}")


def push_json_tree(local_dir: Path, dataset_store: DatasetStore, *, relative_root: Path | None = None) -> list[str]:
    """Upload every *.json under local_dir into the dataset store."""
    root = local_dir if relative_root is None else relative_root
    uploaded: list[str] = []
    if not local_dir.exists():
        return uploaded
    for path in sorted(local_dir.rglob("*.json")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            continue
        dataset_store.put(relative, payload)
        uploaded.append(relative)
    return uploaded


def push_blob_tree(local_dir: Path, blob_store: BlobStore, *, prefix: str = "") -> list[str]:
    """Upload every file under local_dir into the blob store with an optional prefix."""
    uploaded: list[str] = []
    if not local_dir.exists():
        return uploaded
    prefix = prefix.strip().replace("\\", "/").strip("/")
    for path in sorted(local_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() == ".json" and prefix in {"", "processed"}:
            # JSON datasets belong in datasets table when under processed/
            continue
        relative = path.relative_to(local_dir).as_posix()
        key = f"{prefix}/{relative}" if prefix else relative
        blob_store.put(key, path.read_bytes(), content_type=guess_content_type(relative))
        uploaded.append(key)
    return uploaded


def hydrate_blob(blob_store: BlobStore, path: str, destination: Path) -> bool:
    """Materialize a remote blob onto disk when missing. Returns True if written."""
    if destination.is_file():
        return False
    content = blob_store.get(path)
    if content is None:
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", dir=destination.parent, delete=False) as handle:
        handle.write(content)
        temporary = Path(handle.name)
    temporary.replace(destination)
    return True


def hydrate_profile_sources(
    profile: Any,
    blob_store: BlobStore,
    *,
    project_root: Path,
) -> None:
    """Pull declared profile source files from blob storage into local paths when absent."""
    for group in ("current_sources", "history_sources"):
        for source in getattr(profile, group, []):
            declared = Path(source.path)
            if declared.is_file():
                continue
            candidates = []
            if not declared.is_absolute():
                candidates.extend([declared, project_root / declared])
            else:
                candidates.append(declared)
            if any(candidate.is_file() for candidate in candidates):
                continue
            # Prefer blob keys: raw/... and uploads/...
            posix = declared.as_posix().lstrip("./")
            keys = [posix]
            if posix.startswith("data/"):
                keys.append(posix.removeprefix("data/"))
            elif not posix.startswith(("raw/", "uploads/")):
                keys.append(f"raw/{declared.name}")
            for key in keys:
                try:
                    assert_safe_path(key)
                except ValueError:
                    continue
                target = candidates[0] if candidates else project_root / key
                if not target.is_absolute():
                    target = project_root / target
                if hydrate_blob(blob_store, key, target):
                    break


# Keep create_profile_store importable from this module for callers that only need profiles.
__all__ = [
    "BlobStore",
    "DataStoreError",
    "DatasetStore",
    "LocalBlobStore",
    "LocalDatasetStore",
    "PersistenceBundle",
    "SupabaseBlobStore",
    "SupabaseDatasetStore",
    "assert_safe_path",
    "create_persistence",
    "create_profile_store",
    "hydrate_blob",
    "hydrate_profile_sources",
    "push_blob_tree",
    "push_json_tree",
    "store_mode",
]
