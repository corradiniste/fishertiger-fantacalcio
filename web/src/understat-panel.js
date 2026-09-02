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
