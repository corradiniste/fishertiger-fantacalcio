"""Unit tests for Understat ↔ Fantacalcio matching."""
from __future__ import annotations

import json

from advisor.understat_match import (
    fantacalcio_name_aliases,
    load_team_aliases,
    load_understat_id_overrides,
    match_understat,
    normalize_name,
    normalize_team,
    understat_name_aliases,
    _name_score,
)


def _fc(player_id: int, nome: str, squadra: str) -> dict:
    return {"id": player_id, "nome": nome, "squadra": squadra}


def _us(understat_id: int, name: str, team: str, **extra) -> dict:
    base = {
        "id": understat_id,
        "player_name": name,
        "position": "F",
        "team_title": team,
        "games": 20,
        "time": 1800,
        "goals": 10,
        "xG": 8.0,
        "xA": 2.0,
        "npxG": 7.0,
        "npxA": 2.0,
        "npg": 9,
        "shots": 40,
        "key_passes": 15,
        "yellow": 1,
        "red": 0,
        "xGChain": 12.0,
        "xGBuildup": 2.0,
    }
    base.update(extra)
    return base


def test_normalize_strips_accents_and_suffixes():
    assert normalize_name("Lautaro Martínez Jr.") == "lautaro martinez"
    assert normalize_name("Dybala") == "dybala"


def test_fantacalcio_surname_initial_aliases():
    assert "l martinez" in fantacalcio_name_aliases("Martinez L.")
    assert "martinez l" in understat_name_aliases("Lautaro Martínez") or "l martinez" in [
        a for a in understat_name_aliases("Lautaro Martínez")
    ]
    assert _name_score("Lautaro Martínez", "Martinez L.") >= 88


def test_team_aliases_map_hellas_verona():
    aliases = load_team_aliases()
    assert normalize_team("Hellas Verona", aliases) == normalize_team("Verona", aliases)
    assert normalize_team("FC Internazionale", aliases) == normalize_team("Inter", aliases)


def test_exact_name_and_team_match():
    matched, review = match_understat(
        [_fc(1, "Lautaro Martinez", "Inter")],
        {2025: [_us(99, "Lautaro Martínez", "Inter")]},
        aliases=load_team_aliases(),
        overrides={},
    )
    assert "2025" in matched[1]
    assert matched[1]["2025"]["xG"] == 8.0
    assert matched[1]["2025"]["xg90"] is not None
    assert review == []


def test_fantacalcio_surname_initial_matches_understat_fullname_name():
    matched, review = match_understat(
        [_fc(2764, "Martinez L.", "Inter"), _fc(5116, "Martinez Jo.", "Inter")],
        {2025: [_us(7006, "Lautaro Martínez", "Inter")]},
        aliases=load_team_aliases(),
        overrides={},
    )
    assert "2025" in matched[2764]
    assert "2025" not in matched[5116]
    assert review == []


def test_fuzzy_fallback_within_same_team():
    matched, review = match_understat(
        [_fc(2, "Khvicha Kvaratskhelia", "Napoli")],
        {2025: [_us(50, "Khvicha Kvaratskheliaa", "Napoli")]},
        aliases=load_team_aliases(),
        overrides={},
        threshold=88,
    )
    assert "2025" in matched[2]
    assert review == []


def test_override_wins_over_name():
    overrides = {7: 555}
    matched, review = match_understat(
        [_fc(7, "Canonical Name", "Roma"), _fc(8, "Other", "Roma")],
        {2024: [_us(555, "Totally Different", "Roma")]},
        aliases=load_team_aliases(),
        overrides=overrides,
    )
    assert matched[7]["2024"]["id"] == 555
    assert "2024" not in matched[8]


def test_unmatched_goes_to_review():
    matched, review = match_understat(
        [_fc(1, "Player A", "Milan")],
        {2023: [_us(9, "Nobody Here", "Milan")]},
        aliases=load_team_aliases(),
        overrides={},
    )
    assert matched[1] == {}
    assert review[0]["metodo"] == "nessuno"


def test_load_understat_id_overrides(tmp_path):
    archive = tmp_path / "overrides.json"
    archive.write_text(
        json.dumps({
            "overrides": [
                {"source": "titolari", "name": "X", "team": "Y", "id_fantacalcio": 1, "confirmed": True},
                {"id_fantacalcio": 42, "id_understat": 99},
            ]
        }),
        encoding="utf-8",
    )
    assert load_understat_id_overrides(archive) == {42: 99}
