"""Understat Serie A season aggregates: fetch, persist, and load for the pipeline."""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from collections.abc import Callable
from typing import Any

import requests

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RAW = PROJECT_ROOT / "data" / "raw"
BASE_URL = "https://understat.com"
LEAGUE = "Serie_A"
MIN_SEASON = 2014
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
REQUEST_TIMEOUT = 30
MAX_RETRIES = 3
RETRY_STATUSES = {429, 500, 502, 503, 504}
DEFAULT_RATE_LIMIT_S = 1.5

PLAYER_NUMERIC_FIELDS = (
    "gamess",
    "time",
    "goals",
    "xG",
    "xGA",
    "assists",
    "xA",
    "npxG",
    "npxA",
    "npg",
    "shots",
    "key_passes",
    "yellow",
    "red",
    "xGChain",
    "xGBuildup",
)


def current_understat_season(reference: time.struct_time | None = None) -> int:
    """Understat season label is the calendar year the season starts (Aug+)."""
    now = reference or time.localtime()
    return now.tm_year if now.tm_mon >= 8 else now.tm_year - 1


def validate_seasons(seasons: list[int], *, max_count: int = 8) -> list[int]:
    if not seasons:
        raise ValueError("at least one season is required")
    if len(seasons) > max_count:
        raise ValueError(f"at most {max_count} seasons allowed per refresh")
    upper = current_understat_season()
    cleaned: list[int] = []
    seen: set[int] = set()
    for season in seasons:
        if not isinstance(season, int) or isinstance(season, bool):
            raise ValueError(f"season must be an integer: {season!r}")
        if season < MIN_SEASON or season > upper:
            raise ValueError(f"season must be between {MIN_SEASON} and {upper}: {season}")
        if season not in seen:
            cleaned.append(season)
            seen.add(season)
    return cleaned


def understat_path(out_dir: Path, season: int) -> Path:
    return Path(out_dir) / f"understat_{season}.json"


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Accept-Language": "en-US,en;q=0.9,it;q=0.8",
    })
    return session


def _request_with_retry(
    session: requests.Session,
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: int = REQUEST_TIMEOUT,
) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES):
        try:
            response = session.request(method, url, headers=headers, timeout=timeout)
            if response.status_code in RETRY_STATUSES:
                wait = 1.5 * (2 ** attempt)
                logger.warning("Understat %s %s -> %s; retry in %.1fs", method, url, response.status_code, wait)
                time.sleep(wait)
                continue
            response.raise_for_status()
            return response
        except requests.RequestException as error:
            last_error = error
            wait = 1.5 * (2 ** attempt)
            logger.warning("Understat request failed (%s); retry in %.1fs", error, wait)
            time.sleep(wait)
    assert last_error is not None
    raise last_error


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _to_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def normalize_player(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize one Understat player aggregate to a stable schema."""
    player_id = raw.get("id")
    return {
        "id": _to_int(player_id) if player_id is not None else None,
        "player_name": str(raw.get("player_name") or "").strip(),
        "position": str(raw.get("position") or "").strip(),
        "team_title": str(raw.get("team_title") or "").strip(),
        "games": _to_int(raw.get("games")),
        "time": _to_int(raw.get("time")),
        "goals": _to_int(raw.get("goals")),
        "xG": round(_to_float(raw.get("xG")), 4),
        "xGA": round(_to_float(raw.get("xGA")), 4),
        "assists": _to_int(raw.get("assists")),
        "xA": round(_to_float(raw.get("xA")), 4),
        "npxG": round(_to_float(raw.get("npxG")), 4),
        "npxA": round(_to_float(raw.get("npxA")), 4),
        "npg": _to_int(raw.get("npg")),
        "shots": _to_int(raw.get("shots")),
        "key_passes": _to_int(raw.get("key_passes")),
        "yellow": _to_int(raw.get("yellow")),
        "red": _to_int(raw.get("red")),
        "xGChain": round(_to_float(raw.get("xGChain")), 4),
        "xGBuildup": round(_to_float(raw.get("xGBuildup")), 4),
    }


def normalize_payload(payload: dict[str, Any], season: int) -> dict[str, Any]:
    players_raw = payload.get("players") or []
    if not isinstance(players_raw, list):
        raise ValueError(f"Understat season {season}: players must be a list")
    players = [normalize_player(item) for item in players_raw if isinstance(item, dict)]
    return {
        "source": "understat",
        "league": LEAGUE,
        "season": season,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "players": players,
        "teams": payload.get("teams") if isinstance(payload.get("teams"), dict) else {},
        "dates": payload.get("dates") if isinstance(payload.get("dates"), list) else [],
    }


def fetch_season(
    season: int,
    *,
    session: requests.Session | None = None,
    rate_limit_s: float = 0.0,
) -> dict[str, Any]:
    """Fetch and normalize one Serie A season from Understat AJAX endpoints."""
    season = validate_seasons([season])[0]
    own_session = session is None
    session = session or _session()
    try:
        warm_url = f"{BASE_URL}/league/{LEAGUE}/{season}"
        _request_with_retry(session, "GET", warm_url)
        if rate_limit_s > 0:
            time.sleep(rate_limit_s)
        data_url = f"{BASE_URL}/getLeagueData/{LEAGUE}/{season}"
        response = _request_with_retry(
            session,
            "GET",
            data_url,
            headers={"X-Requested-With": "XMLHttpRequest", "Referer": warm_url},
        )
        try:
            payload = response.json()
        except ValueError as error:
            raise ValueError(f"Understat season {season}: invalid JSON payload") from error
        if not isinstance(payload, dict):
            raise ValueError(f"Understat season {season}: expected object payload")
        return normalize_payload(payload, season)
    finally:
        if own_session:
            session.close()


def fetch_seasons(
    seasons: list[int],
    out_dir: Path,
    *,
    force: bool = False,
    rate_limit_s: float = DEFAULT_RATE_LIMIT_S,
    session: requests.Session | None = None,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> list[Path]:
    """Fetch multiple seasons to ``understat_{year}.json``. Skip existing unless force."""
    seasons = validate_seasons(seasons)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    own_session = session is None
    session = session or _session()
    written: list[Path] = []
    try:
        for index, season in enumerate(seasons):
            path = understat_path(out_dir, season)
            if path.exists() and not force:
                logger.info("skip existing %s", path)
                if progress:
                    progress({"season": season, "path": str(path), "status": "skipped"})
                written.append(path)
                continue
            if index > 0 and rate_limit_s > 0:
                time.sleep(rate_limit_s)
            try:
                payload = fetch_season(season, session=session, rate_limit_s=0.0)
            except Exception as error:
                logger.warning("Understat season %s failed: %s", season, error)
                if progress:
                    progress({"season": season, "path": str(path), "status": "error", "error": str(error)})
                continue
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if progress:
                progress({"season": season, "path": str(path), "status": "written", "players": len(payload["players"])})
            written.append(path)
    finally:
        if own_session:
            session.close()
    return written


def load_understat(raw_dir: Path, seasons: list[int]) -> dict[int, list[dict[str, Any]]]:
    """Load persisted season files. Missing seasons are omitted with a warning."""
    result: dict[int, list[dict[str, Any]]] = {}
    for season in seasons:
        path = understat_path(raw_dir, int(season))
        if not path.exists():
            # Also accept project-relative paths under data/raw when raw_dir is absolute elsewhere.
            alt = PROJECT_ROOT / "data" / "raw" / path.name
            path = alt if alt.exists() else path
        if not path.exists():
            logger.warning("Understat file missing for season %s: %s", season, path)
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            logger.warning("Understat file invalid for season %s: %s", season, error)
            continue
        players = payload.get("players") if isinstance(payload, dict) else None
        if not isinstance(players, list):
            logger.warning("Understat file for season %s has no players list", season)
            continue
        result[int(season)] = [normalize_player(item) if isinstance(item, dict) else item for item in players]
    return result


def per90(value: float, minutes: int) -> float | None:
    if minutes is None or minutes <= 0:
        return None
    return round(float(value) * 90.0 / float(minutes), 4)


def derive_season_metrics(stats: dict[str, Any]) -> dict[str, Any]:
    """Attach xG90 / xA90 / npxG90 / overperformance derived from minutes played."""
    minutes = _to_int(stats.get("time"))
    xg = _to_float(stats.get("xG"))
    xa = _to_float(stats.get("xA"))
    npxg = _to_float(stats.get("npxG"))
    goals = _to_int(stats.get("goals"))
    return {
        **stats,
        "xg90": per90(xg, minutes),
        "xa90": per90(xa, minutes),
        "npxg90": per90(npxg, minutes),
        "overperformance": round(goals - xg, 4),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fetch Understat Serie A season aggregates.")
    parser.add_argument(
        "--seasons",
        required=True,
        help="Comma-separated Understat seasons (start year), e.g. 2026,2025,2024",
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--force", action="store_true", help="Re-download even if file exists")
    parser.add_argument("--rate-limit", type=float, default=DEFAULT_RATE_LIMIT_S)
    args = parser.parse_args(argv)
    seasons = [int(part.strip()) for part in args.seasons.split(",") if part.strip()]
    paths = fetch_seasons(seasons, args.out_dir, force=args.force, rate_limit_s=args.rate_limit)
    print(json.dumps({"written": [str(path) for path in paths]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
