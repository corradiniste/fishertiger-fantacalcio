# Data Sources

The project ships structured, versioned input files in `data/raw/` so a fresh
clone can generate a dataset locally. The files cover the player list, Serie A
calendar, historical statistics, club priors, likely starters, set-piece order,
and auction tiers.

The private fantasy-league calendar is deliberately not committed. Upload it
from **Impostazioni** after cloning the project. Its participating teams must
match the profile participants before generation can proceed.

The application treats the files as input data, not as a remote scraping layer.
If you replace them for another season, update the profile source declarations
and retain attribution required by the data license.

## Understat (optional)

Serie A season aggregates (xG, xA, npxG, shots, key passes, xGChain, …) enrich
each player as informative context. They do not feed the Monte Carlo model.

- Endpoint: warm-up `GET https://understat.com/league/Serie_A/{season}`, then
  `GET https://understat.com/getLeagueData/Serie_A/{season}` with
  `X-Requested-With: XMLHttpRequest`.
- Season label: start year (`2026` = 2026/27). Available from 2014.
- Persist with `python -m advisor.understat --seasons 2026,2025,2024,2023,2022 --out-dir data/raw`
  or `POST /api/sources/refresh` with `{"seasons":[2026,2025], "force": false}`.
- Profile declares optional `understat_sources` (`required: false`). Missing
  files leave `player.understat` as `{}`.
- Match is fuzzy name+team plus `id_understat` overrides in
  `config/identity_overrides.json`. Review unmatched rows in
  `matching_review.csv`.
- Personal / private-league use only; refresh occasionally, never poll.

## Understat per-player (optional, lazy)

Radar ratings, shot map, and match history load on demand when a player detail
panel opens — not during generate, and not into Monte Carlo.

- Endpoints (after warm-up `GET /player/{id}`):
  - `GET /getRadarData/{id}`
  - `GET /getShotData/{id}/{season}`
  - `GET /getMatchesData/{id}`
  All with `X-Requested-With: XMLHttpRequest`.
- Local API: `GET /api/players/{fantacalcio_id}/understat?profile_id=...&seasons=2026,2025&force=0`
  resolves `understat_id` from `auction_data.json`, then fetches/caches.
- Cache: `data/raw/understat_players/{understat_id}/radar.json`,
  `shots_{season}.json`, `matches.json` — TTL 24h unless `force=1`.
- Rate-limit ~1s between Understat requests; one in-flight lock per player id.
- Missing match → UI empty state. Radar failure does not abort shots/matches.
