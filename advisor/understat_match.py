"""Match Understat players to Fantacalcio IDs (fuzzy name+team + overrides)."""
from __future__ import annotations

import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any

from rapidfuzz import fuzz

from .understat import derive_season_metrics

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALIASES_PATH = PROJECT_ROOT / "config" / "understat_team_aliases.json"
DEFAULT_OVERRIDES_PATH = PROJECT_ROOT / "config" / "identity_overrides.json"
# Fantacalcio listone uses "Surname F."; Understat uses "First Last".
FUZZY_THRESHOLD = 88.0
SUFFIX_RE = re.compile(r"\b(jr|sr|ii|iii|iv)\b\.?", re.IGNORECASE)

UNDERSTAT_KEEP = (
    "id",
    "player_name",
    "position",
    "team_title",
    "games",
    "time",
    "goals",
    "xG",
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


def normalize_name(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value).lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = SUFFIX_RE.sub("", text)
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    return " ".join(text.split())


def load_team_aliases(path: Path | None = None) -> dict[str, str]:
    """Map any known alias -> canonical team key."""
    path = path or DEFAULT_ALIASES_PATH
    if not path.exists():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    aliases = payload.get("aliases", payload) if isinstance(payload, dict) else {}
    reverse: dict[str, str] = {}
    for canonical, names in aliases.items():
        canon = normalize_name(canonical)
        reverse[canon] = canon
        for name in names if isinstance(names, list) else [names]:
            reverse[normalize_name(name)] = canon
    return reverse


def normalize_team(value: object, aliases: dict[str, str] | None = None) -> str:
    key = normalize_name(value)
    if not aliases:
        return key
    return aliases.get(key, key)


def load_understat_id_overrides(path: Path | None = None) -> dict[int, int]:
    """Return fantacalcio_id -> understat_id from identity_overrides entries."""
    path = path or DEFAULT_OVERRIDES_PATH
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid identity override archive {path}: {error}") from error
    entries = payload.get("overrides", []) if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        raise ValueError("identity override archive must be a list or contain an overrides list")
    mapping: dict[int, int] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if "id_understat" not in entry or "id_fantacalcio" not in entry:
            continue
        try:
            fantacalcio_id = int(entry["id_fantacalcio"])
            understat_id = int(entry["id_understat"])
        except (TypeError, ValueError) as error:
            raise ValueError(f"invalid understat identity override: {entry!r}") from error
        mapping[fantacalcio_id] = understat_id
    return mapping


def fantacalcio_name_aliases(name: str, *, unique_surname: bool = False) -> list[str]:
    """Expand Fantacalcio ``Surname F.`` forms toward Understat-style names."""
    query = normalize_name(name)
    if not query:
        return []
    aliases = [query]
    parts = query.split()
    # "martinez l" / "martinez l." → "l martinez", optional bare surname.
    if len(parts) == 2 and len(parts[1]) == 1:
        aliases.append(f"{parts[1]} {parts[0]}")
        if unique_surname:
            aliases.append(parts[0])
    elif len(parts) >= 2 and len(parts[-1]) == 1:
        aliases.append(f"{parts[-1]} {' '.join(parts[:-1])}")
        if unique_surname:
            aliases.append(" ".join(parts[:-1]))
    return aliases


def understat_name_aliases(name: str) -> list[str]:
    """Expand Understat ``First Last`` forms toward Fantacalcio ``Surname F.``."""
    query = normalize_name(name)
    if not query:
        return []
    aliases = [query]
    parts = query.split()
    if len(parts) >= 2:
        first, *middle, last = parts
        aliases.append(f"{last} {first[0]}")
        aliases.append(f"{first} {last}")
        aliases.append(last)
        if middle:
            aliases.append(f"{last} {middle[-1][0]}")
    return aliases


def _name_score(understat_name: str, fantacalcio_name: str, *, unique_surname: bool = False) -> float:
    left = understat_name_aliases(understat_name)
    right = fantacalcio_name_aliases(fantacalcio_name, unique_surname=unique_surname)
    if not left or not right:
        return 0.0
    return float(max(fuzz.token_sort_ratio(a, b) for a in left for b in right))


def _slim(player: dict[str, Any]) -> dict[str, Any]:
    slim = {key: player.get(key) for key in UNDERSTAT_KEEP}
    return derive_season_metrics(slim)


def match_understat(
    fantacalcio_players: list[dict[str, Any]],
    understat_by_season: dict[int, list[dict[str, Any]]],
    *,
    aliases: dict[str, str] | None = None,
    overrides: dict[int, int] | None = None,
    threshold: float = FUZZY_THRESHOLD,
) -> tuple[dict[int, dict[str, dict[str, Any]]], list[dict[str, Any]]]:
    """Join Understat seasons onto Fantacalcio players.

    Returns ``(matched[id_fantacalcio][season_str], unmatched_review_rows)``.
    """
    aliases = aliases if aliases is not None else load_team_aliases()
    overrides = overrides if overrides is not None else load_understat_id_overrides()
    reverse_override = {understat_id: fantacalcio_id for fantacalcio_id, understat_id in overrides.items()}

    by_id: dict[int, dict[str, Any]] = {}
    by_team: dict[str, list[dict[str, Any]]] = {}
    for player in fantacalcio_players:
        player_id = int(player["id"])
        by_id[player_id] = player
        team = normalize_team(player["squadra"], aliases)
        by_team.setdefault(team, []).append(player)

    # Surname uniqueness within each team (for "Surname F." short aliases).
    unique_surname_by_team: dict[str, set[str]] = {}
    for team, members in by_team.items():
        counts: dict[str, int] = {}
        for player in members:
            parts = normalize_name(player["nome"]).split()
            if not parts:
                continue
            surname = parts[0] if len(parts[-1]) == 1 else parts[-1]
            counts[surname] = counts.get(surname, 0) + 1
        unique_surname_by_team[team] = {surname for surname, count in counts.items() if count == 1}

    matched: dict[int, dict[str, dict[str, Any]]] = {player_id: {} for player_id in by_id}
    review: list[dict[str, Any]] = []

    for season, players in understat_by_season.items():
        season_key = str(season)
        claimed: set[int] = set()

        for understat_player in players:
            understat_id = understat_player.get("id")
            if understat_id is not None:
                fantacalcio_id = reverse_override.get(int(understat_id))
                if fantacalcio_id is not None and fantacalcio_id in by_id and fantacalcio_id not in claimed:
                    matched[fantacalcio_id][season_key] = _slim(understat_player)
                    claimed.add(fantacalcio_id)

        for understat_player in players:
            understat_id = understat_player.get("id")
            if understat_id is not None and int(understat_id) in reverse_override:
                fantacalcio_id = reverse_override[int(understat_id)]
                if fantacalcio_id in claimed and season_key in matched.get(fantacalcio_id, {}):
                    continue

            name = normalize_name(understat_player.get("player_name"))
            team = normalize_team(understat_player.get("team_title"), aliases)
            if not name:
                review.append({
                    "source": "understat",
                    "season": season_key,
                    "nome_originale": understat_player.get("player_name"),
                    "squadra": understat_player.get("team_title"),
                    "id_understat": understat_id,
                    "metodo": "nessuno",
                    "diagnostic": "empty understat name",
                    "score": 0.0,
                })
                continue

            team_candidates = [
                player
                for player in by_team.get(team, [])
                if int(player["id"]) not in claimed
            ]
            if not team_candidates:
                # Team alias miss: try global fuzzy with lower confidence later via review.
                review.append({
                    "source": "understat",
                    "season": season_key,
                    "nome_originale": understat_player.get("player_name"),
                    "squadra": understat_player.get("team_title"),
                    "id_understat": understat_id,
                    "metodo": "nessuno",
                    "diagnostic": "no team candidates",
                    "score": 0.0,
                })
                continue

            unique_surnames = unique_surname_by_team.get(team, set())
            best: list[tuple[float, dict[str, Any]]] = []
            for player in team_candidates:
                parts = normalize_name(player["nome"]).split()
                surname = parts[0] if parts and len(parts[-1]) == 1 else (parts[-1] if parts else "")
                ratio = _name_score(
                    name,
                    player["nome"],
                    unique_surname=surname in unique_surnames,
                )
                if ratio >= threshold:
                    best.append((ratio, player))
            best.sort(key=lambda item: item[0], reverse=True)

            if not best:
                review.append({
                    "source": "understat",
                    "season": season_key,
                    "nome_originale": understat_player.get("player_name"),
                    "squadra": understat_player.get("team_title"),
                    "id_understat": understat_id,
                    "metodo": "nessuno",
                    "diagnostic": "no confident candidate",
                    "score": 0.0,
                })
                continue

            score = best[0][0]
            top = [item for item in best if item[0] >= score - 2.0]
            if len(top) > 1:
                review.append({
                    "source": "understat",
                    "season": season_key,
                    "nome_originale": understat_player.get("player_name"),
                    "squadra": understat_player.get("team_title"),
                    "id_understat": understat_id,
                    "metodo": "ambiguo",
                    "diagnostic": "multiple equally scored candidates",
                    "score": round(score, 1),
                })
                continue

            chosen = best[0][1]
            fantacalcio_id = int(chosen["id"])
            matched[fantacalcio_id][season_key] = _slim(understat_player)
            claimed.add(fantacalcio_id)
            method = "exact" if score >= 99.5 else "fuzzy"
            if method == "fuzzy":
                logger.debug(
                    "understat fuzzy match season=%s %s -> %s (%.1f)",
                    season_key,
                    understat_player.get("player_name"),
                    chosen["nome"],
                    score,
                )

    return matched, review
