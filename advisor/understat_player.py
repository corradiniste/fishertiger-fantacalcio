"""Understat per-player detail: radar ratings, shots, and match history.

Lazy on-demand fetch with on-disk cache. Informative UI only — never feeds MC.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import requests

from .understat import (
    BASE_URL,
    PROJECT_ROOT,
    _request_with_retry,
    _session,
    _to_float,
    _to_int,
    validate_seasons,
)

logger = logging.getLogger(__name__)

PLAYER_CACHE_DIR = PROJECT_ROOT / "data" / "raw" / "understat_players"
CACHE_TTL_S = 24 * 3600
DEFAULT_RATE_LIMIT_S = 1.0
XHR = {"X-Requested-With": "XMLHttpRequest"}

RADAR_METRICS_DEFAULT = ("xG", "xA", "Sh", "KP", "xGChain", "xGBuildup")


def validate_player_id(player_id: Any) -> int:
    if isinstance(player_id, bool) or not isinstance(player_id, int):
        try:
            player_id = int(player_id)
        except (TypeError, ValueError) as error:
            raise ValueError(f"player_id must be a positive integer: {player_id!r}") from error
    if player_id <= 0:
        raise ValueError(f"player_id must be a positive integer: {player_id!r}")
    return player_id


def player_cache_dir(cache_dir: Path, player_id: int) -> Path:
    return Path(cache_dir) / str(player_id)


def _cache_fresh(path: Path, *, ttl_s: float = CACHE_TTL_S) -> bool:
    if not path.is_file():
        return False
    try:
        age = time.time() - path.stat().st_mtime
    except OSError:
        return False
    return age < ttl_s


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _warm_player(session: requests.Session, player_id: int) -> str:
    warm_url = f"{BASE_URL}/player/{player_id}"
    _request_with_retry(session, "GET", warm_url)
    return warm_url


def _xhr_get(session: requests.Session, url: str, *, referer: str) -> Any:
    response = _request_with_retry(
        session,
        "GET",
        url,
        headers={**XHR, "Referer": referer},
    )
    try:
        payload = response.json()
    except ValueError as error:
        raise ValueError(f"Understat invalid JSON for {url}") from error
    return payload


def _coord_0_100(value: Any) -> float:
    """Normalize Understat pitch coords (0–1 or 0–100) to 0–100."""
    number = _to_float(value, 0.0)
    if 0.0 <= number <= 1.0:
        return round(number * 100.0, 4)
    return round(max(0.0, min(100.0, number)), 4)


def normalize_radar(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("radar payload must be an object")
    stats_raw = payload.get("radarStats") or payload.get("stats") or list(RADAR_METRICS_DEFAULT)
    if not isinstance(stats_raw, list) or not stats_raw:
        stats_raw = list(RADAR_METRICS_DEFAULT)
    stats = [str(item) for item in stats_raw]

    seasons: dict[str, dict[str, float]] = {}
    points = payload.get("radarPoints") or payload.get("points") or []
    if isinstance(points, dict):
        # season → metric map
        for season_key, metrics in points.items():
            if not isinstance(metrics, dict):
                continue
            seasons[str(season_key)] = {
                str(metric): round(_to_float(value), 4) for metric, value in metrics.items()
            }
    elif isinstance(points, list):
        for entry in points:
            if not isinstance(entry, dict):
                continue
            season_key = entry.get("season")
            if season_key is None:
                continue
            metrics = {
                str(metric): round(_to_float(entry.get(metric)), 4)
                for metric in stats
                if metric in entry
            }
            # also pick any numeric fields beyond listed stats
            for key, value in entry.items():
                if key in {"season", "id", "player_id"}:
                    continue
                if key not in metrics:
                    try:
                        metrics[str(key)] = round(_to_float(value), 4)
                    except Exception:
                        continue
            seasons[str(season_key)] = metrics
    return {"stats": stats, "seasons": seasons}


def normalize_shot(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _to_int(raw.get("id")) if raw.get("id") is not None else None,
        "minute": _to_int(raw.get("minute")),
        "result": str(raw.get("result") or "").strip(),
        "x": _coord_0_100(raw.get("X", raw.get("x"))),
        "y": _coord_0_100(raw.get("Y", raw.get("y"))),
        "xg": round(_to_float(raw.get("xG", raw.get("xg"))), 4),
        "situation": str(raw.get("situation") or "").strip(),
        "shot_type": str(raw.get("shotType") or raw.get("shot_type") or "").strip(),
        "h_a": str(raw.get("h_a") or "").strip(),
        "match_id": _to_int(raw.get("match_id")) if raw.get("match_id") is not None else None,
    }


def normalize_shots(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        shots_raw = payload
    elif isinstance(payload, dict):
        shots_raw = payload.get("shots") or []
    else:
        raise ValueError("shots payload must be object or list")
    if not isinstance(shots_raw, list):
        raise ValueError("shots must be a list")
    return [normalize_shot(item) for item in shots_raw if isinstance(item, dict)]


def _parse_score(score: Any) -> tuple[int | None, int | None]:
    if score is None:
        return None, None
    text = str(score).strip()
    if "-" not in text:
        return None, None
    left, right = text.split("-", 1)
    try:
        return int(left.strip()), int(right.strip())
    except ValueError:
        return None, None


def normalize_match(raw: dict[str, Any]) -> dict[str, Any]:
    goals_h = raw.get("goals_h")
    goals_a = raw.get("goals_a")
    if goals_h is None or goals_a is None:
        parsed_h, parsed_a = _parse_score(raw.get("score"))
        if goals_h is None:
            goals_h = parsed_h
        if goals_a is None:
            goals_a = parsed_a
    return {
        "id": _to_int(raw.get("id")) if raw.get("id") is not None else None,
        "date": str(raw.get("date") or "").strip(),
        "home": str(raw.get("home") or "").strip(),
        "away": str(raw.get("away") or "").strip(),
        "goals_h": _to_int(goals_h) if goals_h is not None else None,
        "goals_a": _to_int(goals_a) if goals_a is not None else None,
        "position": str(raw.get("position") or "").strip(),
        "time": _to_int(raw.get("time")),
        "shots": _to_int(raw.get("shots")),
        "goals": _to_int(raw.get("goals")),
        "npg": _to_int(raw.get("npg")),
        "kp": _to_int(raw.get("kp") if raw.get("kp") is not None else raw.get("key_passes")),
        "assists": _to_int(raw.get("assists")),
        "xG": round(_to_float(raw.get("xG")), 4),
        "NPxG": round(_to_float(raw.get("NPxG", raw.get("npxG"))), 4),
        "xA": round(_to_float(raw.get("xA")), 4),
        "NPxA": round(_to_float(raw.get("NPxA", raw.get("npxA"))), 4),
        "xGChain": round(_to_float(raw.get("xGChain")), 4),
        "xGBuildup": round(_to_float(raw.get("xGBuildup")), 4),
    }


def normalize_matches(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        matches_raw = payload
    elif isinstance(payload, dict):
        matches_raw = payload.get("matches") or []
    else:
        raise ValueError("matches payload must be object or list")
    if isinstance(matches_raw, dict):
        matches_raw = list(matches_raw.values())
    if not isinstance(matches_raw, list):
        raise ValueError("matches must be a list")
    return [normalize_match(item) for item in matches_raw if isinstance(item, dict)]


def fetch_radar(player_id: int, *, session: requests.Session, referer: str | None = None) -> dict[str, Any]:
    player_id = validate_player_id(player_id)
    warm = referer or _warm_player(session, player_id)
    payload = _xhr_get(session, f"{BASE_URL}/getRadarData/{player_id}", referer=warm)
    return normalize_radar(payload)


def fetch_shots(
    player_id: int,
    season: int,
    *,
    session: requests.Session,
    referer: str | None = None,
) -> list[dict[str, Any]]:
    player_id = validate_player_id(player_id)
    season = validate_seasons([int(season)])[0]
    warm = referer or _warm_player(session, player_id)
    payload = _xhr_get(session, f"{BASE_URL}/getShotData/{player_id}/{season}", referer=warm)
    return normalize_shots(payload)


def fetch_matches(player_id: int, *, session: requests.Session, referer: str | None = None) -> list[dict[str, Any]]:
    player_id = validate_player_id(player_id)
    warm = referer or _warm_player(session, player_id)
    payload = _xhr_get(session, f"{BASE_URL}/getMatchesData/{player_id}", referer=warm)
    return normalize_matches(payload)


def _load_or_fetch(
    path: Path,
    *,
    force: bool,
    fetcher: Any,
) -> tuple[Any, bool]:
    """Return (payload, from_cache)."""
    if not force and _cache_fresh(path):
        try:
            return _read_json(path), True
        except (OSError, json.JSONDecodeError) as error:
            logger.warning("cache read failed %s: %s", path, error)
    payload = fetcher()
    try:
        _write_json(path, payload)
    except OSError as error:
        logger.warning("cache write failed %s: %s", path, error)
    return payload, False


def fetch_player_detail(
    player_id: int,
    seasons: list[int],
    *,
    cache_dir: Path | str = PLAYER_CACHE_DIR,
    force: bool = False,
    rate_limit_s: float = DEFAULT_RATE_LIMIT_S,
    session: requests.Session | None = None,
) -> dict[str, Any]:
    """Fetch radar + shots (per season) + matches with disk cache and graceful degradation."""
    player_id = validate_player_id(player_id)
    seasons = validate_seasons([int(s) for s in seasons])
    cache_root = player_cache_dir(Path(cache_dir), player_id)
    cache_root.mkdir(parents=True, exist_ok=True)

    own_session = session is None
    session = session or _session()
    fetched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cached_parts: list[str] = []
    fetched_parts: list[str] = []

    try:
        referer = f"{BASE_URL}/player/{player_id}"
        try:
            _request_with_retry(session, "GET", referer)
        except Exception as error:
            logger.warning("Understat warm-up failed for player %s: %s", player_id, error)

        radar: dict[str, Any] | None
        try:
            radar, from_cache = _load_or_fetch(
                cache_root / "radar.json",
                force=force,
                fetcher=lambda: fetch_radar(player_id, session=session, referer=referer),
            )
            (cached_parts if from_cache else fetched_parts).append("radar")
        except Exception as error:
            logger.warning("radar fetch failed for %s: %s", player_id, error)
            radar = None

        shots: dict[str, list[dict[str, Any]]] = {}
        for index, season in enumerate(seasons):
            if rate_limit_s > 0 and (index > 0 or "radar" in fetched_parts):
                time.sleep(rate_limit_s)
            season_key = str(season)
            path = cache_root / f"shots_{season}.json"
            try:
                season_shots, from_cache = _load_or_fetch(
                    path,
                    force=force,
                    fetcher=lambda s=season: fetch_shots(
                        player_id, s, session=session, referer=referer
                    ),
                )
                if not isinstance(season_shots, list):
                    season_shots = normalize_shots(season_shots)
                shots[season_key] = season_shots
                (cached_parts if from_cache else fetched_parts).append(f"shots_{season}")
            except Exception as error:
                logger.warning("shots fetch failed for %s season %s: %s", player_id, season, error)
                shots[season_key] = []

        if rate_limit_s > 0 and fetched_parts:
            time.sleep(rate_limit_s)

        matches: list[dict[str, Any]]
        try:
            matches, from_cache = _load_or_fetch(
                cache_root / "matches.json",
                force=force,
                fetcher=lambda: fetch_matches(player_id, session=session, referer=referer),
            )
            if not isinstance(matches, list):
                matches = normalize_matches(matches)
            (cached_parts if from_cache else fetched_parts).append("matches")
        except Exception as error:
            logger.warning("matches fetch failed for %s: %s", player_id, error)
            matches = []

        return {
            "player_id": player_id,
            "radar": radar,
            "shots": shots,
            "matches": matches,
            "cached_at": cached_parts,
            "fetched_at": fetched_at,
            "fetched_parts": fetched_parts,
        }
    finally:
        if own_session:
            session.close()


def resolve_understat_id(player: dict[str, Any]) -> int | None:
    """Pick any non-null understat id from player.understat season buckets."""
    understat = player.get("understat")
    if not isinstance(understat, dict):
        return None
    current = player.get("understat_current")
    if isinstance(current, dict) and current.get("id") is not None:
        try:
            return validate_player_id(current["id"])
        except ValueError:
            pass
    for season in sorted(understat.keys(), key=lambda value: int(value) if str(value).isdigit() else 0, reverse=True):
        bucket = understat.get(season)
        if isinstance(bucket, dict) and bucket.get("id") is not None:
            try:
                return validate_player_id(bucket["id"])
            except ValueError:
                continue
    return None
