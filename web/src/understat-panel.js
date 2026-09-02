/** Pure helpers for Understat player panel / list badge (schema 1.1). */

export const METRIC_DEFS = {
  xG: "Expected Goals: gol attesi dai tiri effettuati.",
  xA: "Expected Assists: assist attesi dai passaggi chiave.",
  npxG: "Non-penalty xG: xG escludendo i rigori.",
  npxA: "Non-penalty xA: xA escludendo i rigori.",
  xg90: "xG per 90 minuti giocati.",
  xa90: "xA per 90 minuti giocati.",
  npxg90: "npxG per 90 minuti giocati.",
  key_passes: "Passaggi chiave che creano un tiro.",
  shots: "Tiri totali nella stagione.",
  xGChain: "xG della sequenza di possesso a cui il giocatore partecipa.",
  xGBuildup: "xGChain escludendo tiri e passaggi chiave finali.",
  games: "Partite giocate.",
  time: "Minuti giocati.",
  goals: "Gol segnati.",
  assists: "Assist realizzati.",
  yellow: "Cartellini gialli.",
  red: "Cartellini rossi.",
  overperformance: "Gol meno xG: positivo = sopra le attese.",
};

export const PANEL_METRICS = [
  "xG",
  "xA",
  "npxG",
  "npxA",
  "xg90",
  "xa90",
  "key_passes",
  "shots",
  "xGChain",
  "xGBuildup",
  "games",
  "time",
];

export const hasUnderstat = (player) =>
  Boolean(player && player.understat && Object.keys(player.understat).length > 0);

export const understatSeasons = (player) =>
  hasUnderstat(player)
    ? Object.keys(player.understat).sort((a, b) => Number(b) - Number(a))
    : [];

export const pickUnderstatSeason = (player, preferred) => {
  const seasons = understatSeasons(player);
  if (!seasons.length) return null;
  if (preferred && player.understat[preferred]) return preferred;
  if (player.understat_current?.id != null) {
    const match = seasons.find((season) => player.understat[season]?.id === player.understat_current.id);
    if (match) return match;
  }
  return seasons[0];
};

export const formatMetric = (value, key) => {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  if (key === "games" || key === "time" || key === "shots" || key === "key_passes" || key === "goals" || key === "assists" || key === "yellow" || key === "red") {
    return String(Math.round(number));
  }
  return number.toFixed(2);
};

export const overperformanceTone = (delta) => {
  if (delta == null || Number.isNaN(Number(delta))) return "neutral";
  if (Number(delta) > 0.15) return "over";
  if (Number(delta) < -0.15) return "under";
  return "neutral";
};

export const sparklinePoints = (player, metric = "xG", width = 120, height = 28, pad = 2) => {
  const seasons = understatSeasons(player).slice().reverse();
  if (seasons.length < 2) return { points: "", seasons, values: [] };
  const values = seasons.map((season) => Number(player.understat[season]?.[metric] ?? 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = (width - pad * 2) / (values.length - 1);
  const points = values
    .map((value, index) => {
      const x = pad + index * step;
      const y = height - pad - ((value - min) / span) * (height - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return { points, seasons, values };
};

export const listXg90 = (player) => {
  const value = player?.xg90 ?? player?.understat_current?.xg90;
  if (value == null || Number.isNaN(Number(value))) return null;
  return Number(value);
};

/** Shot result → fill color (Operate palette). */
export const SHOT_RESULT_COLORS = {
  Goal: "#1f7a45",
  ShotOnPost: "#c9a227",
  SavedShot: "#2f5f9a",
  BlockedShot: "#6b7280",
  MissedShots: "#9d331d",
};

export const SHOT_SITUATIONS = [
  "OpenPlay",
  "SetPiece",
  "FromCorner",
  "DirectFreekick",
  "Penalty",
];

export const SHOT_RESULTS = Object.keys(SHOT_RESULT_COLORS);

/**
 * Project radar metrics (0–100) into an SVG polygon.
 * @returns {{ points: string, axes: Array<{label:string,x:number,y:number,lx:number,ly:number}>, max: number }}
 */
export const radarPolygon = (radar, season, size = 200, pad = 28) => {
  const stats = Array.isArray(radar?.stats) && radar.stats.length
    ? radar.stats
    : ["xG", "xA", "Sh", "KP", "xGChain", "xGBuildup"];
  const bucket = radar?.seasons?.[String(season)] || {};
  const n = stats.length;
  const cx = size / 2;
  const cy = size / 2;
  const radius = Math.max(8, (size - pad * 2) / 2);
  const max = 100;
  const axes = stats.map((label, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const lx = cx + Math.cos(angle) * (radius + 14);
    const ly = cy + Math.sin(angle) * (radius + 14);
    return { label, x, y, lx, ly, angle };
  });
  const points = stats
    .map((label, index) => {
      const value = Math.max(0, Math.min(max, Number(bucket[label]) || 0));
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
      const r = (value / max) * radius;
      return `${(cx + Math.cos(angle) * r).toFixed(2)},${(cy + Math.sin(angle) * r).toFixed(2)}`;
    })
    .join(" ");
  return { points, axes, max, size, cx, cy, radius };
};

/**
 * Map Understat pitch coords (0–100, attack toward high X / left in viz) to SVG circle.
 * viewBox assumed 0 0 100 65 (vertical half-pitch, attack up).
 */
export const projectShot = (shot) => {
  const x = Number(shot?.x);
  const y = Number(shot?.y);
  const xg = Math.max(0, Number(shot?.xg) || 0);
  const result = String(shot?.result || "");
  // Attack toward top: cy shrinks as x→100; cx from y across pitch.
  const cx = Number.isFinite(y) ? y : 50;
  const cy = Number.isFinite(x) ? 65 - x * 0.65 : 32.5;
  const r = Math.max(1.2, Math.min(4.5, 1.1 + xg * 6));
  const fill = SHOT_RESULT_COLORS[result] || "#405046";
  return { cx, cy, r, fill, result, xg, situation: shot?.situation || "" };
};

export const filterShots = (shots, { seasons, situations, results } = {}) => {
  const list = Array.isArray(shots) ? shots : [];
  const seasonSet = seasons?.length ? new Set(seasons.map(String)) : null;
  const situationSet = situations?.length ? new Set(situations) : null;
  const resultSet = results?.length ? new Set(results) : null;
  return list.filter((shot) => {
    if (seasonSet && shot.season != null && !seasonSet.has(String(shot.season))) return false;
    if (situationSet && !situationSet.has(shot.situation)) return false;
    if (resultSet && !resultSet.has(shot.result)) return false;
    return true;
  });
};

/** Flatten shots:{season:[...]} → list with season tag. */
export const flattenShots = (shotsBySeason) => {
  if (!shotsBySeason || typeof shotsBySeason !== "object") return [];
  return Object.entries(shotsBySeason).flatMap(([season, rows]) =>
    (Array.isArray(rows) ? rows : []).map((shot) => ({ ...shot, season: String(season) })),
  );
};

export const matchHistoryRows = (matches, { sort = "date_desc" } = {}) => {
  const rows = (Array.isArray(matches) ? matches : []).map((row) => ({ ...row }));
  const dir = sort === "date_asc" ? 1 : -1;
  rows.sort((a, b) => {
    const left = String(a.date || "");
    const right = String(b.date || "");
    if (left === right) return (Number(a.id) || 0) - (Number(b.id) || 0);
    return left < right ? -dir : left > right ? dir : 0;
  });
  return rows;
};

const dateFmt = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "short",
  year: "2-digit",
});

export const formatMatchRow = (row) => {
  const goals = Number(row?.goals);
  const xG = Number(row?.xG);
  const assists = Number(row?.assists);
  const xA = Number(row?.xA);
  let dateLabel = "—";
  if (row?.date) {
    const parsed = new Date(row.date);
    dateLabel = Number.isNaN(parsed.getTime()) ? String(row.date) : dateFmt.format(parsed);
  }
  const score =
    row?.goals_h != null && row?.goals_a != null
      ? `${row.goals_h}-${row.goals_a}`
      : "—";
  return {
    date: dateLabel,
    home: row?.home || "—",
    away: row?.away || "—",
    score,
    position: row?.position || "—",
    time: row?.time != null ? String(row.time) : "—",
    shots: row?.shots != null ? String(row.shots) : "—",
    goals: row?.goals != null ? String(row.goals) : "—",
    kp: row?.kp != null ? String(row.kp) : "—",
    assists: row?.assists != null ? String(row.assists) : "—",
    xG: Number.isFinite(xG) ? xG.toFixed(2) : "—",
    xA: Number.isFinite(xA) ? xA.toFixed(2) : "—",
    xGDelta: Number.isFinite(goals) && Number.isFinite(xG) ? goals - xG : null,
    xADelta: Number.isFinite(assists) && Number.isFinite(xA) ? assists - xA : null,
  };
};

export const understatIdFor = (player) => {
  if (player?.understat_current?.id != null) return Number(player.understat_current.id);
  const seasons = understatSeasons(player);
  for (const season of seasons) {
    const id = player.understat[season]?.id;
    if (id != null) return Number(id);
  }
  return null;
};
