import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyRulesStartingCredits,
  auctionStorageKey,
  legalMaxBid,
  mergeAuctionPlayers,
  playerIdKey,
  rehydrateAuction,
  slotsLeft,
} from "./auction-state.js";
import { celebrationFromAssignment, subscribeLiveState } from "./auction-live-sync.js";
import { LiveCelebration } from "./live-celebration.jsx";
import {
  apiUrl,
  auctionDatasetPath,
  loadDatasetUrl,
  loadProfile,
  rulesFor,
} from "./profile-client.js";

const ROLE_ORDER = ["P", "D", "C", "A"];
const ROLE_LABELS = { P: "Por", D: "Dif", C: "Cen", A: "Att" };

const apiBase =
  import.meta.env.VITE_LOCAL_API_BASE || "http://127.0.0.1:8000";

const readStoredAuction = (profileId) => {
  try {
    return JSON.parse(localStorage.getItem(auctionStorageKey(profileId)) || "null");
  } catch {
    return null;
  }
};

const creditRatio = (team) => {
  const start = Math.max(1, Number(team.startingCredits) || 1);
  return Math.max(0, Math.min(1, Number(team.credits) / start));
};

function LiveHeader({ lotPlayer, nominatorName, syncAge }) {
  return (
    <header className="live-header">
      <div className="live-header__brand">
        <span className="live-header__kicker">Asta LIVE</span>
        {syncAge != null && (
          <span className="live-header__sync" aria-live="polite">
            sync {syncAge}
          </span>
        )}
      </div>
      <div className="live-header__split">
        <section className="live-header__panel live-header__panel--lot" aria-label="Giocatore in trattamento">
          <span className="live-header__label">GIOCATORE CHIAMATO</span>
          {lotPlayer ? (
            <div className="live-header__lot">
              <span className={`role ${lotPlayer.ruolo}`}>{lotPlayer.ruolo}</span>
              <div>
                <h1>{lotPlayer.nome}</h1>
                <p>{lotPlayer.squadra}</p>
              </div>
            </div>
          ) : (
            <div className="live-header__lot live-header__lot--empty">
              <h1>Nessun giocatore</h1>
              <p>Seleziona un nome in Asta live per mostrarlo qui.</p>
            </div>
          )}
        </section>
        <section className="live-header__panel live-header__panel--call" aria-label="Squadra di turno">
          <span className="live-header__label">Chi chiama</span>
          <strong className="is-call">{nominatorName || "—"}</strong>
        </section>
      </div>
    </header>
  );
}

function TeamCard({ team, rules, assigned, isNominator }) {
  const left = slotsLeft(team, rules);
  const max = legalMaxBid(team, rules);
  const ratio = creditRatio(team);
  const totalSlots = Object.values(rules.rosterSlots).reduce((a, b) => a + b, 0);
  const className = ["live-team", isNominator ? "is-nominator" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={className} aria-label={team.name}>
      <div className="live-team__head">
        <h2>{team.name}</h2>
        <div className="live-team__badges">
          {isNominator && <span className="live-badge live-badge--call">Chiama</span>}
        </div>
      </div>
      <div className="live-team__credits">
        <div className="live-team__credits-row">
          <strong>{team.credits}</strong>
          <span> / {team.startingCredits} cr</span>
        </div>
        <div
          className="live-team__bar"
          role="meter"
          aria-valuenow={team.credits}
          aria-valuemin={0}
          aria-valuemax={team.startingCredits}
          aria-label={`Crediti residui ${team.credits}`}
        >
          <i style={{ transform: `scaleX(${ratio})` }} />
        </div>
        <p>
          Max bid {max} · {team.roster.length}/{totalSlots} presi
        </p>
      </div>
      <ul className="live-team__slots" aria-label="Slot rimanenti">
        {ROLE_ORDER.map((role) => {
          const open = left[role] ?? 0;
          const total = rules.rosterSlots[role] ?? 0;
          const filled = total - open;
          return (
            <li
              key={role}
              className={open > 0 ? "is-open" : "is-full"}
              title={`${ROLE_LABELS[role]}: ${filled}/${total}`}
            >
              <b className={`role ${role}`}>{role}</b>
              <span>
                {filled}/{total}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="live-team__roster">
        {team.roster.length ? (
          team.roster.map((player) => (
            <div key={player.id} className="live-roster-row">
              <i className={`role ${player.ruolo}`}>{player.ruolo}</i>
              <span>{player.nome}</span>
              <em>{assigned[playerIdKey(player.id)]?.price ?? "—"}</em>
            </div>
          ))
        ) : (
          <span className="live-team__empty">Rosa vuota</span>
        )}
      </div>
    </article>
  );
}

export function LiveBoard({ profileId }) {
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [players, setPlayers] = useState([]);
  const [rules, setRules] = useState(null);
  const [liveState, setLiveState] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [celebration, setCelebration] = useState(null);
  const historyLenRef = useRef(null);
  const seenCelebrateIds = useRef(new Set());

  const triggerCelebration = (payload) => {
    if (!payload?.id) return;
    if (seenCelebrateIds.current.has(payload.id)) return;
    seenCelebrateIds.current.add(payload.id);
    setCelebration(payload);
  };

  useEffect(() => {
    if (!profileId) {
      setStatus("error");
      setError("Manca il parametro profile nell'URL (?profile=…).");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        setStatus("loading");
        const profile = await loadProfile(profileId, { apiBase });
        const datasetPath = auctionDatasetPath(profile);
        const data = await loadDatasetUrl(
          apiUrl(`/api/datasets/${datasetPath}`, apiBase),
          { profile },
        );
        if (cancelled) return;
        const nextRules = rulesFor(profile, data);
        setPlayers(data.players || []);
        setRules(nextRules);
        const stored = readStoredAuction(profileId);
        const hydrated = stored
          ? applyRulesStartingCredits(
              rehydrateAuction(stored, data.players || [], nextRules),
              nextRules,
            )
          : null;
        historyLenRef.current = hydrated?.history?.length ?? 0;
        setLiveState(hydrated);
        setUpdatedAt(Date.now());
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(err?.message || "Impossibile caricare profilo o dataset.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    if (!profileId || !rules) return undefined;
    return subscribeLiveState(
      profileId,
      (saved) => {
        const hydrated = applyRulesStartingCredits(
          rehydrateAuction(saved, players, rules),
          rules,
        );
        if (!hydrated) return;
        const prevLen = historyLenRef.current;
        const nextLen = hydrated.history?.length ?? 0;
        historyLenRef.current = nextLen;
        setLiveState(hydrated);
        setUpdatedAt(Date.now());
        // Fallback if celebrate message missed: history grew by one.
        if (
          prevLen != null &&
          nextLen === prevLen + 1 &&
          hydrated.history?.length
        ) {
          const last = hydrated.history.at(-1);
          const pool = mergeAuctionPlayers(players, hydrated.customPlayers);
          const player = pool.find(
            (item) => playerIdKey(item.id) === playerIdKey(last.playerId),
          );
          if (player) {
            triggerCelebration(
              celebrationFromAssignment({
                player,
                teamName: hydrated.teams[last.owner]?.name,
                owner: last.owner,
                price: last.price,
                seq: nextLen,
              }),
            );
          }
        }
      },
      (payload) => triggerCelebration(payload),
    );
  }, [profileId, rules, players]);

  useEffect(() => {
    if (!rules) return;
    setLiveState((current) =>
      current ? applyRulesStartingCredits(current, rules) : current,
    );
  }, [rules?.startingCredits]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const playersById = useMemo(() => {
    const pool = mergeAuctionPlayers(players, liveState?.customPlayers);
    return new Map(pool.map((player) => [playerIdKey(player.id), player]));
  }, [players, liveState?.customPlayers]);

  const lotPlayer = liveState?.lot?.playerId != null
    ? playersById.get(playerIdKey(liveState.lot.playerId))
    : null;

  const syncAge = (() => {
    if (updatedAt == null) return null;
    const seconds = Math.max(0, Math.round((now - updatedAt) / 1000));
    if (seconds < 3) return "ora";
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m`;
  })();

  if (status === "loading") {
    return (
      <main className="live-board live-board--status">
        <p>Caricamento tabellone…</p>
      </main>
    );
  }

  if (status === "error") {
    return (
      <main className="live-board live-board--status" role="alert">
        <h1>Tabellone non disponibile</h1>
        <p>{error}</p>
      </main>
    );
  }

  if (!liveState || !rules) {
    return (
      <main className="live-board live-board--status">
        <h1>Nessuna asta in corso</h1>
        <p>Apri Asta live nell&apos;app principale e seleziona questo profilo.</p>
      </main>
    );
  }

  const nominatorName = liveState.teams[liveState.nominator]?.name;

  return (
    <main className="live-board">
      <LiveHeader
        lotPlayer={lotPlayer}
        nominatorName={nominatorName}
        syncAge={syncAge}
      />
      <section className="live-teams" aria-label="Rose in asta">
        {liveState.teams.map((team, index) => (
          <TeamCard
            key={`${team.name}-${index}`}
            team={team}
            rules={rules}
            assigned={liveState.assigned}
            isNominator={index === liveState.nominator}
          />
        ))}
      </section>
      <LiveCelebration
        assignment={celebration}
        onDone={() => setCelebration(null)}
      />
    </main>
  );
}
