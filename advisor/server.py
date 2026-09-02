"""Small local HTTP API for editing profiles and triggering data generation.

Generator integration is deliberately injected: this module has no dependency on
the data pipeline and does not select a generator implementation itself.
"""
from __future__ import annotations

import argparse
import json
import re
import tempfile
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

from .generate import (
    PipelineGenerator,
    ProfileRequestError,
    generate_dataset,
    load_profile,
    resolve_profile,
)
from .data_store import (
    DataStoreError,
    PersistenceBundle,
    create_persistence,
    guess_content_type,
    hydrate_profile_sources,
    push_json_tree,
)
from .profile_store import (
    ProfileStore,
    ProfileStoreError,
    load_dotenv_file,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
MAX_BODY_BYTES = 1_000_000
MAX_UPLOAD_BYTES = 50_000_000
PROFILE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SOURCE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
SOURCE_GROUPS = {"current_sources", "history_sources", "understat_sources"}
FIXED_SOURCE_SUFFIXES = {
    "current_sources": {
        "player_list": ".xlsx",
        "serie_a_calendar": ".xlsx",
        "teams": ".csv",
        "starters": ".csv",
        "set_pieces": ".csv",
        "auction_guide": ".csv",
        "league_calendar": ".xlsx",
    },
    "history_sources": {
        "stats_2025_26": ".xlsx",
        "stats_2024_25": ".xlsx",
        "stats_2023_24": ".xlsx",
    },
    "understat_sources": {
        "understat_2026": ".json",
        "understat_2025": ".json",
        "understat_2024": ".json",
        "understat_2023": ".json",
        "understat_2022": ".json",
        "understat_2021": ".json",
        "understat_2020": ".json",
        "understat_2019": ".json",
        "understat_2018": ".json",
        "understat_2017": ".json",
        "understat_2016": ".json",
        "understat_2015": ".json",
        "understat_2014": ".json",
    },
}
VITE_ORIGIN = re.compile(r"https?://(?:localhost|127\.0\.0\.1)(?::\d+)?\Z")
PLAYER_UNDERSTAT_PATH = re.compile(r"/api/players/(\d+)/understat\Z")
ProfileLoader = Callable[[dict[str, Any]], Any]
SimulationRunner = Callable[[Any, Path, int, int], dict[str, Any]]
UnderstatFetcher = Callable[..., list[Path]]
UnderstatPlayerFetcher = Callable[..., dict[str, Any]]


class LocalApiServer(ThreadingHTTPServer):
    """HTTP server state with filesystem locations and an optional generator."""

    def __init__(
        self,
        address: tuple[str, int] = ("127.0.0.1", 8000),
        *,
        profiles_dir: Path | str = Path("config/profiles"),
        datasets_dir: Path | str = Path("data/processed"),
        uploads_dir: Path | str = Path("data/uploads"),
        default_profile_path: Path | str = Path("config/default_profile.json"),
        generator: PipelineGenerator | None = None,
        simulator: SimulationRunner | None = None,
        profile_loader: ProfileLoader = load_profile,
        profile_store: ProfileStore | None = None,
        persistence: PersistenceBundle | None = None,
        understat_fetcher: UnderstatFetcher | None = None,
        understat_player_fetcher: UnderstatPlayerFetcher | None = None,
        raw_dir: Path | str = Path("data/raw"),
    ) -> None:
        self.profiles_dir = Path(profiles_dir)
        self.datasets_dir = Path(datasets_dir)
        self.uploads_dir = Path(uploads_dir)
        self.default_profile_path = Path(default_profile_path)
        self.raw_dir = Path(raw_dir)
        self.generator = generator
        self.simulator = simulator or _simulate_current_dataset
        self.profile_loader = profile_loader
        self.understat_fetcher = understat_fetcher
        self.understat_player_fetcher = understat_player_fetcher
        self.persistence = persistence or create_persistence(
            profiles_dir=self.profiles_dir,
            datasets_dir=self.datasets_dir,
            blob_root=self.uploads_dir.parent,
        )
        self.profile_store = profile_store or self.persistence.profiles
        self.dataset_store = self.persistence.datasets
        self.blob_store = self.persistence.blobs
        self.refresh_jobs: dict[str, dict[str, Any]] = {}
        self.refresh_lock = threading.Lock()
        self.refresh_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="understat-refresh")
        self.player_detail_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="understat-player")
        self.player_detail_locks: dict[int, threading.Lock] = {}
        self.player_detail_locks_guard = threading.Lock()
        super().__init__(address, LocalApiHandler)


class LocalApiHandler(BaseHTTPRequestHandler):
    server: LocalApiServer

    def do_OPTIONS(self) -> None:
        self._send_json(HTTPStatus.NO_CONTENT, None)

    def do_GET(self) -> None:
        path = self._path()
        player_match = PLAYER_UNDERSTAT_PATH.fullmatch(path)
        if path == "/api/profiles":
            self._profile_index()
        elif path == "/api/default-profile":
            self._default_profile()
        elif path.startswith("/api/profiles/"):
            self._get_profile(path.removeprefix("/api/profiles/"))
        elif path == "/api/datasets/manifest":
            self._dataset_manifest()
        elif path.startswith("/api/datasets/"):
            self._get_dataset(path.removeprefix("/api/datasets/"))
        elif path == "/api/sources/refresh/status":
            self._refresh_status()
        elif player_match:
            self._player_understat(int(player_match.group(1)))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")

    def do_PUT(self) -> None:
        path = self._path()
        if path.startswith("/api/uploads/"):
            self._put_upload(path.removeprefix("/api/uploads/"))
        elif path.startswith("/api/profiles/"):
            self._put_profile(path.removeprefix("/api/profiles/"))
        else:
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")

    def do_POST(self) -> None:
        path = self._path()
        if path == "/api/sources/status":
            self._source_status()
            return
        if path == "/api/sources/refresh":
            self._refresh_sources()
            return
        if path == "/api/simulate":
            self._simulate()
            return
        if path == "/api/auction/export":
            self._auction_export()
            return
        if path != "/api/generate":
            self._error(HTTPStatus.NOT_FOUND, "not_found", "The requested endpoint does not exist.")
            return
        request = self._read_json_object()
        if request is None:
            return
        try:
            profile = resolve_profile(
                request,
                self.server.profiles_dir,
                profile_store=self.server.profile_store,
                profile_loader=self.server.profile_loader,
            )
            profile = self._derive_calendar_participants(profile)
        except ProfileRequestError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        try:
            hydrate_profile_sources(profile, self.server.blob_store, project_root=PROJECT_ROOT)
            result = generate_dataset(profile, self.server.datasets_dir, generator=self.server.generator)
            self._persist_season_outputs(profile)
            result["dataset_manifest"] = self.server.dataset_store.manifest()
        except (FileNotFoundError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        except DataStoreError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Generated data could not be persisted.")
            return
        except Exception:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "generation_failed", "Generation failed.")
            return
        else:
            self._send_json(HTTPStatus.OK, result)

    def _auction_export(self) -> None:
        request = self._read_json_object()
        if request is None:
            return
        profile_id = request.get("profile_id")
        season = request.get("season")
        teams = request.get("teams")
        history = request.get("history")
        if not isinstance(profile_id, str) or not PROFILE_NAME.fullmatch(profile_id):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile_id", "profile_id must be a safe profile name.")
            return
        if not isinstance(season, str) or not re.fullmatch(r"\d{4}-\d{2}", season):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_season", "season must use YYYY-ZZ format.")
            return
        if not isinstance(teams, list) or not teams:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_teams", "teams must be a non-empty array.")
            return
        if not isinstance(history, list):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_history", "history must be an array.")
            return

        relative = f"{profile_id}/{season}/auction_data.json"
        output_dir = self.server.datasets_dir / profile_id / season
        auction_path = output_dir / "auction_data.json"
        try:
            if not auction_path.is_file():
                payload = self.server.dataset_store.get(relative)
                if payload is not None:
                    auction_path.parent.mkdir(parents=True, exist_ok=True)
                    auction_path.write_text(
                        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                        encoding="utf-8",
                    )
        except DataStoreError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json is unreadable.")
            return
        if not auction_path.is_file():
            self._error(
                HTTPStatus.CONFLICT,
                "auction_data_missing",
                "Genera i dati prima di esportare i colpi.",
            )
            return
        try:
            auction = json.loads(auction_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json is unreadable.")
            return
        if not isinstance(auction, dict):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json is invalid.")
            return
        players = auction.get("players")
        if not isinstance(players, list):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json has no players list.")
            return
        rules = auction.get("league_rules") if isinstance(auction.get("league_rules"), dict) else {}
        try:
            from .auction_export import build_workbook

            workbook = build_workbook(request, players, rules)
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_export_payload", str(error))
            return
        except Exception:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "export_failed", "Could not build the auction export.")
            return
        self._send_bytes(
            HTTPStatus.OK,
            workbook,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=f"colpi_asta_{profile_id}.xlsx",
        )

    def _simulate(self) -> None:
        request = self._read_json_object()
        if request is None:
            return
        try:
            profile = resolve_profile(
                request,
                self.server.profiles_dir,
                profile_store=self.server.profile_store,
                profile_loader=self.server.profile_loader,
            )
            profile = self._derive_calendar_participants(profile)
        except ProfileRequestError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        iterations = request.get("iterations", 1000)
        seed = request.get("seed", 202627)
        if isinstance(iterations, bool) or not isinstance(iterations, int) or not 100 <= iterations <= 50000:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_iterations", "Iterations must be an integer between 100 and 50000.")
            return
        if isinstance(seed, bool) or not isinstance(seed, int):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seed", "Seed must be an integer.")
            return
        try:
            output_dir = self.server.datasets_dir / profile.profile_id / profile.season.season.replace("/", "-")
            self._ensure_auction_dataset(output_dir, profile)
            result = self.server.simulator(profile, output_dir, iterations, seed)
            self._persist_season_outputs(profile)
        except ValueError as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))
            return
        except DataStoreError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Simulation data could not be persisted.")
            return
        except Exception:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "simulation_failed", "Simulation failed.")
            return
        self._send_json(HTTPStatus.OK, result)

    def _default_profile(self) -> None:
        try:
            value = json.loads(self.server.default_profile_path.read_text(encoding="utf-8"))
            profile = self.server.profile_loader(value)
            profile = self._derive_calendar_participants(profile)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "default_profile_unavailable", "The default profile is unavailable.")
            return
        self._send_json(HTTPStatus.OK, profile.to_dict())

    def _profile_index(self) -> None:
        try:
            profiles = self.server.profile_store.list_ids()
        except ProfileStoreError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Profile storage is unavailable.")
            return
        self._send_json(HTTPStatus.OK, {"profiles": profiles})

    def _get_profile(self, name: str) -> None:
        if not self._valid_profile_name(name):
            return
        try:
            profile = resolve_profile(
                {"profile_id": name},
                self.server.profiles_dir,
                profile_store=self.server.profile_store,
                profile_loader=self.server.profile_loader,
            )
        except ProfileRequestError as error:
            message = str(error)
            if message == "The saved profile does not exist.":
                self._error(HTTPStatus.NOT_FOUND, "profile_not_found", "The profile does not exist.")
            else:
                self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", message)
            return
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The stored profile is invalid or unreadable.")
            return
        try:
            self._send_json(HTTPStatus.OK, self._derive_calendar_participants(profile).to_dict())
        except (OSError, ValueError) as error:
            self._error(HTTPStatus.UNPROCESSABLE_ENTITY, "invalid_source_data", str(error))

    def _put_profile(self, name: str) -> None:
        if not self._valid_profile_name(name):
            return
        value = self._read_json_object()
        if value is None:
            return
        try:
            profile = self.server.profile_loader(value)
            if profile.profile_id != name:
                raise ValueError("profile_id must match the saved profile name")
        except (AttributeError, TypeError, ValueError, KeyError) as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
            return
        try:
            self.server.profile_store.put(name, profile.to_dict())
        except ProfileStoreError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The profile could not be saved.")
            return
        self._send_json(HTTPStatus.OK, profile.to_dict())

    def _put_upload(self, relative_path: str) -> None:
        parts = relative_path.split("/")
        if (
            len(parts) != 3
            or not PROFILE_NAME.fullmatch(parts[0])
            or parts[1] not in SOURCE_GROUPS
            or not SOURCE_NAME.fullmatch(parts[2])
            or parts[2] not in FIXED_SOURCE_SUFFIXES.get(parts[1], {})
        ):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_upload_path", "Upload paths must identify a profile, source group, and source name.")
            return
        filename = self.headers.get("X-Filename", "")
        suffix = Path(filename).suffix.lower()
        expected_suffix = FIXED_SOURCE_SUFFIXES[parts[1]][parts[2]]
        if suffix != expected_suffix:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_upload_type", f"This source requires a {expected_suffix} file.")
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            content_length = -1
        if content_length < 1 or content_length > MAX_UPLOAD_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "invalid_upload_size", "Upload size must be between 1 byte and 50 MB.")
            return
        profile_id, group, source_name = parts
        target = self.server.uploads_dir / profile_id / group / f"{source_name}{suffix}"
        try:
            content = self.rfile.read(content_length)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("wb", dir=target.parent, delete=False) as handle:
                handle.write(content)
                temporary_path = Path(handle.name)
            temporary_path.replace(target)
            blob_key = f"uploads/{profile_id}/{group}/{source_name}{suffix}"
            self.server.blob_store.put(blob_key, content, content_type=guess_content_type(blob_key))
        except (OSError, DataStoreError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "upload_failed", "The source file could not be stored.")
            return
        self._send_json(HTTPStatus.OK, {"path": str(target), "filename": Path(filename).name, "size": content_length})

    def _source_status(self) -> None:
        value = self._read_json_object()
        if value is None:
            return
        # Status checks should work on incomplete drafts (empty id/name while typing).
        # Full LeagueProfile validation is only required for save/generate.
        try:
            profile = self.server.profile_loader(value)
        except (AttributeError, TypeError, ValueError, KeyError):
            profile = None
        if profile is not None:
            try:
                hydrate_profile_sources(profile, self.server.blob_store, project_root=PROJECT_ROOT)
            except DataStoreError:
                pass
        statuses = []
        for group in SOURCE_GROUPS:
            raw_sources = getattr(profile, group, None) if profile is not None else value.get(group)
            if raw_sources is None:
                raw_sources = ()
            for source in raw_sources:
                if profile is not None:
                    name = source.name
                    path = source.path
                else:
                    if not isinstance(source, dict):
                        continue
                    name = source.get("name")
                    path = source.get("path")
                    if not isinstance(name, str) or not isinstance(path, str) or not name.strip() or not path.strip():
                        continue
                declared = Path(path)
                candidates = [declared] if declared.is_absolute() else [declared, Path.cwd() / declared, PROJECT_ROOT / declared]
                existing_path = next((candidate for candidate in candidates if candidate.is_file()), None)
                statuses.append({
                    "group": group,
                    "name": name,
                    "path": path,
                    "exists": existing_path is not None,
                })
        self._send_json(HTTPStatus.OK, {"sources": statuses})

    def _active_refresh_job(self) -> dict[str, Any] | None:
        with self.server.refresh_lock:
            for job in self.server.refresh_jobs.values():
                if job.get("status") in {"queued", "running"}:
                    return dict(job)
        return None

    def _refresh_status(self) -> None:
        job_id = None
        query = urlparse(self.path).query
        for part in query.split("&"):
            if part.startswith("job_id="):
                job_id = unquote(part.removeprefix("job_id="))
                break
        with self.server.refresh_lock:
            if job_id:
                job = self.server.refresh_jobs.get(job_id)
                if job is None:
                    self._error(HTTPStatus.NOT_FOUND, "refresh_job_not_found", "No refresh job matches that id.")
                    return
                self._send_json(HTTPStatus.OK, dict(job))
                return
            active = None
            for candidate in self.server.refresh_jobs.values():
                if candidate.get("status") in {"queued", "running"}:
                    active = dict(candidate)
                    break
            if active is None and self.server.refresh_jobs:
                # Most recent completed job when nothing is active.
                active = dict(max(self.server.refresh_jobs.values(), key=lambda item: item.get("updated_at", "")))
            self._send_json(HTTPStatus.OK, active or {"status": "idle"})

    def _refresh_sources(self) -> None:
        request = self._read_json_object()
        if request is None:
            return
        seasons_raw = request.get("seasons")
        if not isinstance(seasons_raw, list) or not seasons_raw:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seasons", "Provide a non-empty seasons array.")
            return
        try:
            seasons = [int(value) for value in seasons_raw]
        except (TypeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seasons", "Seasons must be integers.")
            return
        try:
            from .understat import validate_seasons

            seasons = validate_seasons(seasons, max_count=8)
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seasons", str(error))
            return
        auto_generate = bool(request.get("auto_generate", False))
        force = bool(request.get("force", False))
        profile = None
        if auto_generate or request.get("profile_id") or "profile" in request:
            try:
                profile = resolve_profile(
                    request,
                    self.server.profiles_dir,
                    profile_store=self.server.profile_store,
                    profile_loader=self.server.profile_loader,
                )
            except ProfileRequestError as error:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", str(error))
                return
        active = self._active_refresh_job()
        if active is not None:
            self._error(HTTPStatus.CONFLICT, "refresh_in_progress", "An Understat refresh job is already running.", details=active)
            return
        job_id = uuid.uuid4().hex
        job = {
            "job_id": job_id,
            "status": "queued",
            "seasons": seasons,
            "force": force,
            "auto_generate": auto_generate,
            "profile_id": getattr(profile, "profile_id", None),
            "progress": [],
            "paths": [],
            "error": None,
            "updated_at": _utc_now(),
        }
        with self.server.refresh_lock:
            self.server.refresh_jobs[job_id] = job
        self.server.refresh_executor.submit(self._run_refresh_job, job_id, seasons, force, auto_generate, profile)
        self._send_json(HTTPStatus.ACCEPTED, dict(job))

    def _run_refresh_job(
        self,
        job_id: str,
        seasons: list[int],
        force: bool,
        auto_generate: bool,
        profile: Any | None,
    ) -> None:
        def progress(event: dict[str, Any]) -> None:
            with self.server.refresh_lock:
                job = self.server.refresh_jobs[job_id]
                job["progress"] = [*job.get("progress", []), event]
                job["updated_at"] = _utc_now()

        with self.server.refresh_lock:
            self.server.refresh_jobs[job_id]["status"] = "running"
            self.server.refresh_jobs[job_id]["updated_at"] = _utc_now()
        try:
            fetcher = self.server.understat_fetcher
            if fetcher is None:
                from .understat import fetch_seasons as fetcher
            paths = fetcher(seasons, self.server.raw_dir, force=force, progress=progress)
            result: dict[str, Any] = {"paths": [str(path) for path in paths]}
            if auto_generate and profile is not None:
                hydrate_profile_sources(profile, self.server.blob_store, project_root=PROJECT_ROOT)
                generated = generate_dataset(profile, self.server.datasets_dir, generator=self.server.generator)
                self._persist_season_outputs(profile)
                result["generate"] = generated
            with self.server.refresh_lock:
                job = self.server.refresh_jobs[job_id]
                job["status"] = "completed"
                job["paths"] = result["paths"]
                job["result"] = result
                job["updated_at"] = _utc_now()
        except Exception as error:
            with self.server.refresh_lock:
                job = self.server.refresh_jobs[job_id]
                job["status"] = "failed"
                job["error"] = str(error)
                job["updated_at"] = _utc_now()

    def _query_params(self) -> dict[str, list[str]]:
        return parse_qs(urlparse(self.path).query, keep_blank_values=False)

    def _player_lock(self, understat_id: int) -> threading.Lock:
        with self.server.player_detail_locks_guard:
            lock = self.server.player_detail_locks.get(understat_id)
            if lock is None:
                lock = threading.Lock()
                self.server.player_detail_locks[understat_id] = lock
            return lock

    def _player_understat(self, fantacalcio_id: int) -> None:
        params = self._query_params()
        profile_id = (params.get("profile_id") or [None])[0]
        force = (params.get("force") or ["0"])[0].lower() in {"1", "true", "yes"}
        seasons_raw = (params.get("seasons") or [""])[0]

        if not profile_id:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_profile", "Query profile_id is required.")
            return
        try:
            profile = resolve_profile(
                {"profile_id": profile_id},
                self.server.profiles_dir,
                profile_store=self.server.profile_store,
                profile_loader=self.server.profile_loader,
            )
        except ProfileRequestError as error:
            message = str(error)
            code = "profile_not_found" if "does not exist" in message else "invalid_profile"
            status = HTTPStatus.NOT_FOUND if code == "profile_not_found" else HTTPStatus.BAD_REQUEST
            self._error(status, code, message)
            return

        if seasons_raw.strip():
            try:
                seasons = [int(part.strip()) for part in seasons_raw.split(",") if part.strip()]
            except ValueError:
                self._error(HTTPStatus.BAD_REQUEST, "invalid_seasons", "Seasons must be integers.")
                return
        else:
            try:
                seasons = list(profile.understat_seasons())
            except (TypeError, ValueError, AttributeError):
                seasons = [
                    int(str(source.season).split("-")[0].split("/")[0])
                    for source in getattr(profile, "understat_sources", ())
                    if getattr(source, "season", None) not in (None, "")
                ]
            if not seasons:
                seasons = [int(str(profile.season.season).split("/", 1)[0])]
        try:
            from .understat import validate_seasons

            seasons = validate_seasons(seasons, max_count=8)
        except ValueError as error:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_seasons", str(error))
            return

        output_dir = self.server.datasets_dir / profile.profile_id / profile.season.season.replace("/", "-")
        try:
            self._ensure_auction_dataset(output_dir, profile)
        except Exception:
            pass
        auction_path = output_dir / "auction_data.json"
        if not auction_path.is_file():
            self._error(HTTPStatus.NOT_FOUND, "dataset_not_found", "auction_data.json is missing for this profile.")
            return
        try:
            auction = json.loads(auction_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json is unreadable.")
            return
        players = auction.get("players") if isinstance(auction, dict) else None
        if not isinstance(players, list):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "auction_data.json has no players list.")
            return
        player = None
        for item in players:
            if not isinstance(item, dict):
                continue
            try:
                if int(item.get("id")) == fantacalcio_id:
                    player = item
                    break
            except (TypeError, ValueError):
                continue
        if player is None:
            self._error(HTTPStatus.NOT_FOUND, "player_not_found", "No player matches that fantacalcio id.")
            return

        from .understat_player import resolve_understat_id

        understat_id = resolve_understat_id(player)
        if understat_id is None:
            self._error(
                HTTPStatus.NOT_FOUND,
                "no_understat_id",
                "This player has no matched Understat id.",
            )
            return

        fetcher = self.server.understat_player_fetcher
        if fetcher is None:
            from .understat_player import PLAYER_CACHE_DIR, fetch_player_detail as fetcher

            cache_dir = PLAYER_CACHE_DIR
        else:
            cache_dir = self.server.raw_dir / "understat_players"

        lock = self._player_lock(understat_id)

        def run() -> dict[str, Any]:
            with lock:
                return fetcher(
                    understat_id,
                    seasons,
                    cache_dir=cache_dir,
                    force=force,
                )

        future = self.server.player_detail_executor.submit(run)
        try:
            detail = future.result(timeout=60)
        except TimeoutError:
            self._error(HTTPStatus.GATEWAY_TIMEOUT, "understat_timeout", "Understat player detail timed out.")
            return
        except Exception as error:
            self._error(HTTPStatus.BAD_GATEWAY, "understat_fetch_failed", str(error) or "Understat fetch failed.")
            return

        self._send_json(
            HTTPStatus.OK,
            {
                "fantacalcio_id": fantacalcio_id,
                "understat_id": understat_id,
                "radar": detail.get("radar"),
                "shots": detail.get("shots") or {},
                "matches": detail.get("matches") or [],
                "fetched_at": detail.get("fetched_at"),
                "cached_at": detail.get("cached_at"),
            },
        )

    def _derive_calendar_participants(self, profile: Any) -> Any:
        """Use the league calendar as the authoritative participant roster when available."""
        source = next((item for item in profile.current_sources if item.name == "league_calendar"), None)
        if source is None:
            return profile
        declared = Path(source.path)
        candidates = [declared] if declared.is_absolute() else [declared, Path.cwd() / declared, Path(__file__).resolve().parents[1] / declared]
        calendar_path = next((candidate for candidate in candidates if candidate.is_file()), None)
        if calendar_path is None:
            return profile
        if calendar_path.suffix.lower() == ".json":
            from .league_calendar import validate_calendar

            calendar = json.loads(calendar_path.read_text(encoding="utf-8"))
            validate_calendar(calendar)
        else:
            from .league_calendar import preprocess_legacy_calendar

            calendar = preprocess_legacy_calendar(calendar_path, profile.profile_id)
        value = profile.to_dict()
        teams = calendar["teams"]
        value["participants"] = {
            "team_names": teams,
            "user_team": profile.participants.user_team if profile.participants.user_team in teams else teams[0],
        }
        return self.server.profile_loader(value)

    def _dataset_manifest(self) -> None:
        try:
            self._send_json(HTTPStatus.OK, self.server.dataset_store.manifest())
        except (OSError, DataStoreError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "Dataset storage is unavailable.")

    def _get_dataset(self, relative_path: str) -> None:
        dataset_path = self._safe_dataset_path(relative_path)
        if dataset_path is None:
            return
        try:
            if not dataset_path.is_file():
                payload = self.server.dataset_store.get(relative_path)
                if payload is None:
                    self._error(HTTPStatus.NOT_FOUND, "dataset_not_found", "The dataset does not exist.")
                    return
                dataset_path.parent.mkdir(parents=True, exist_ok=True)
                dataset_path.write_text(
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
                    encoding="utf-8",
                )
                self._send_json(HTTPStatus.OK, payload)
                return
            with dataset_path.open(encoding="utf-8") as handle:
                value = json.load(handle)
        except FileNotFoundError:
            self._error(HTTPStatus.NOT_FOUND, "dataset_not_found", "The dataset does not exist.")
            return
        except (OSError, json.JSONDecodeError, DataStoreError):
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage_error", "The dataset is invalid or unreadable.")
            return
        self._send_json(HTTPStatus.OK, value)

    def _persist_season_outputs(self, profile: Any) -> None:
        """Push season JSON (+ non-JSON artifacts) to the configured durable stores."""
        season_dir = self.server.datasets_dir / profile.profile_id / profile.season.season.replace("/", "-")
        push_json_tree(season_dir, self.server.dataset_store, relative_root=self.server.datasets_dir)
        if not season_dir.exists():
            return
        for path in sorted(season_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() == ".json":
                continue
            relative = path.relative_to(self.server.datasets_dir).as_posix()
            self.server.blob_store.put(
                f"processed/{relative}",
                path.read_bytes(),
                content_type=guess_content_type(relative),
            )

    def _ensure_auction_dataset(self, output_dir: Path, profile: Any) -> None:
        auction_path = output_dir / "auction_data.json"
        if auction_path.is_file():
            return
        relative = (Path(profile.profile_id) / profile.season.season.replace("/", "-") / "auction_data.json").as_posix()
        payload = self.server.dataset_store.get(relative)
        if payload is None:
            return
        auction_path.parent.mkdir(parents=True, exist_ok=True)
        auction_path.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False),
            encoding="utf-8",
        )

    def _safe_dataset_path(self, relative_path: str) -> Path | None:
        if not relative_path or "\\" in relative_path or not relative_path.endswith(".json"):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_dataset_path", "Dataset paths must be relative JSON paths.")
            return None
        root = self.server.datasets_dir.resolve()
        candidate = (root / relative_path).resolve()
        if not candidate.is_relative_to(root):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_dataset_path", "Dataset paths must stay within dataset storage.")
            return None
        return candidate

    def _valid_profile_name(self, name: str) -> bool:
        if PROFILE_NAME.fullmatch(name):
            return True
        self._error(
            HTTPStatus.BAD_REQUEST,
            "invalid_profile_name",
            "Profile names must use letters, numbers, underscores, or hyphens.",
        )
        return False

    def _profile_path(self, name: str) -> Path | None:
        if not self._valid_profile_name(name):
            return None
        return self.server.profiles_dir / f"{name}.json"

    def _read_json_object(self) -> dict[str, Any] | None:
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._error(HTTPStatus.BAD_REQUEST, "invalid_request", "Content-Length must be an integer.")
            return None
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request_too_large", "Request body exceeds the size limit.")
            return None
        if self.headers.get("Content-Type", "").split(";", 1)[0].lower() != "application/json":
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "invalid_content_type", "Content-Type must be application/json.")
            return None
        try:
            value = json.loads(
                self.rfile.read(content_length).decode("utf-8"),
                parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)),
            )
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be valid UTF-8 JSON.")
            return None
        if not isinstance(value, dict):
            self._error(HTTPStatus.BAD_REQUEST, "invalid_json", "Request body must be a JSON object.")
            return None
        return value

    def _path(self) -> str:
        return unquote(urlparse(self.path).path)

    def _error(self, status: HTTPStatus, code: str, message: str, *, details: Any | None = None) -> None:
        error: dict[str, Any] = {"code": code, "message": message}
        if details is not None:
            error["details"] = details
        self._send_json(status, {"error": error})

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and VITE_ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Filename")

    def _send_json(self, status: HTTPStatus, value: Any) -> None:
        body = b"" if value is None else json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_bytes(
        self,
        status: HTTPStatus,
        body: bytes,
        *,
        content_type: str,
        filename: str | None = None,
    ) -> None:
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", content_type)
        if filename:
            safe_name = re.sub(r'["\\\r\n]', "_", filename)
            self.send_header("Content-Disposition", f'attachment; filename="{safe_name}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the local API quiet; callers receive structured HTTP errors."""


def create_server(
    address: tuple[str, int] = ("127.0.0.1", 8000),
    *,
    profiles_dir: Path | str = Path("config/profiles"),
    datasets_dir: Path | str = Path("data/processed"),
    uploads_dir: Path | str = Path("data/uploads"),
    default_profile_path: Path | str = Path("config/default_profile.json"),
    generator: PipelineGenerator | None = None,
    simulator: SimulationRunner | None = None,
    profile_loader: ProfileLoader = load_profile,
    profile_store: ProfileStore | None = None,
    persistence: PersistenceBundle | None = None,
    understat_fetcher: UnderstatFetcher | None = None,
    understat_player_fetcher: UnderstatPlayerFetcher | None = None,
    raw_dir: Path | str = Path("data/raw"),
) -> LocalApiServer:
    """Create a local API server; inject a pipeline generator for tests or embedding."""
    return LocalApiServer(
        address,
        profiles_dir=profiles_dir,
        datasets_dir=datasets_dir,
        uploads_dir=uploads_dir,
        default_profile_path=default_profile_path,
        generator=generator,
        simulator=simulator,
        profile_loader=profile_loader,
        profile_store=profile_store,
        persistence=persistence,
        understat_fetcher=understat_fetcher,
        understat_player_fetcher=understat_player_fetcher,
        raw_dir=raw_dir,
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _simulate_current_dataset(profile: Any, output_dir: Path, iterations: int, seed: int) -> dict[str, Any]:
    from .simulate import run_simulation
    from .config import LeagueConfig

    return run_simulation(output_dir, iterations=iterations, seed=seed, league=LeagueConfig.from_profile(profile))


def main(argv: list[str] | None = None) -> None:
    """Run the local API without creating a server during module import."""
    load_dotenv_file()
    parser = argparse.ArgumentParser(description="Run the local fantasy advisor API.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--profiles-dir", type=Path, default=Path("config/profiles"))
    parser.add_argument("--datasets-dir", type=Path, default=Path("data/processed"))
    parser.add_argument("--uploads-dir", type=Path, default=Path("data/uploads"))
    args = parser.parse_args(argv)
    persistence = create_persistence(
        profiles_dir=args.profiles_dir,
        datasets_dir=args.datasets_dir,
        blob_root=PROJECT_ROOT / "data",
    )
    server = create_server(
        (args.host, args.port),
        profiles_dir=args.profiles_dir,
        datasets_dir=args.datasets_dir,
        uploads_dir=args.uploads_dir,
        persistence=persistence,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
