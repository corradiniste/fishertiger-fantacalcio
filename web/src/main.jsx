import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import RandomAuctionView from "./random-auction.jsx";
import { LeagueSettings } from "./league-settings.jsx";
import { ProfilePicker, ProfileSwitcher } from "./profile-picker.jsx";
import { normalizeRules } from "./league-rules.js";
import { activeNominationRole } from "./auction-nomination.js";
import {
  auctionStorageKey,
  emptyAuction,
  isValidBid,
  legalMaxBid,
  playerIdKey,
  rehydrateAuction,
  serializeAuction,
  slotsLeft,
} from "./auction-state.js";
import {
  buildExportPayload,
  requestAuctionExport,
  triggerBlobDownload,
} from "./auction-export.js";
import {
  apiUrl,
  auctionDatasetPath,
  fetchPlayerUnderstat,
  generateProfile,
  listProfiles,
  loadDatasetUrl,
  loadProfile,
  refreshUnderstatSources,
  rulesFor,
  saveProfile,
  seasonSimulationPath,
  waitForUnderstatRefresh,
} from "./profile-client.js";
import { createRoleValuation, sourceFvm } from "./player-valuation.js";
import {
  METRIC_DEFS,
  PANEL_METRICS,
  SHOT_RESULTS,
  SHOT_RESULT_COLORS,
  SHOT_SITUATIONS,
  filterShots,
  flattenShots,
  formatMatchRow,
  formatMetric,
  hasUnderstat,
  listXg90,
  matchHistoryRows,
  overperformanceTone,
  pickUnderstatSeason,
  projectShot,
  radarPolygon,
  sparklinePoints,
  understatIdFor,
  understatSeasons,
} from "./understat-panel.js";

const ACTIVE_PROFILE_KEY = "fanta.activeProfileId";

const ROLE_LABELS = {
  P: "Portieri",
  D: "Difensori",
  C: "Centrocampisti",
  A: "Attaccanti",
};
const formatTier = (tier) =>
  tier ? tier.replaceAll("_", " ") : "NON CLASSIFICATO";
const statusClass = (status) =>
  ({ TITOLARE: "good", BALLOTTAGGIO: "caution", RISERVA: "muted" })[status] ||
  "muted";

const RECOMMENDATION_LABELS = {
  STRONG_BUY: "Compra",
  BID: "Conviene",
  VALUE_ONLY: "Solo al prezzo giusto",
  PASS: "Lascia andare",
  INELIGIBLE: "Non acquistabile",
};

function App() {
  const [data, setData] = useState(null);
  const [season, setSeason] = useState(null);
  const [profile, setProfile] = useState(null);
  const [defaultProfile, setDefaultProfile] = useState(null);
  const [profileEntries, setProfileEntries] = useState([]);
  const [bootPhase, setBootPhase] = useState("loading");
  const [suggestedProfileId, setSuggestedProfileId] = useState("");
  const [pickerBusyId, setPickerBusyId] = useState("");
  const [profileError, setProfileError] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSyncingUnderstat, setIsSyncingUnderstat] = useState(false);
  const [generationStatus, setGenerationStatus] = useState("");
  const [isSimulating, setIsSimulating] = useState(false);
  const [simulationStatus, setSimulationStatus] = useState("");
  const apiBase =
    import.meta.env.VITE_LOCAL_API_BASE || "http://127.0.0.1:8000";
  const [view, setView] = useState("overview");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [viewHistory, setViewHistory] = useState([
    { view: "overview", player: null, team: null },
  ]);
  const [historyIndex, setHistoryIndex] = useState(0);

  const refreshProfileCatalog = async () => {
    const names = await listProfiles({ apiBase }).catch(() => []);
    const entries = await Promise.all(
      names.map(async (id) => {
        try {
          const saved = await loadProfile(id, { apiBase });
          return { id, name: saved?.name || id };
        } catch {
          return { id, name: id };
        }
      }),
    );
    setProfileEntries(entries);
    return entries;
  };

  const activateProfile = async (nextProfile, { skipPicker = true } = {}) => {
    setProfile(nextProfile);
    setData(null);
    setSeason(null);
    setSelectedPlayer(null);
    setView("overview");
    setViewHistory([{ view: "overview", player: null, team: null }]);
    setHistoryIndex(0);
    if (nextProfile?.profile_id) {
      try {
        localStorage.setItem(ACTIVE_PROFILE_KEY, nextProfile.profile_id);
      } catch {
        /* ignore quota / private mode */
      }
      setSuggestedProfileId(nextProfile.profile_id);
    }
    if (skipPicker) setBootPhase("ready");
  };

  const selectSavedProfile = async (id) => {
    setProfileError("");
    setPickerBusyId(id);
    try {
      const saved = await loadProfile(id, { apiBase });
      await activateProfile(saved);
    } catch (error) {
      setProfileError(error?.message || "Impossibile aprire il profilo.");
    } finally {
      setPickerBusyId("");
    }
  };

  const createNewProfile = () => {
    if (!defaultProfile) return;
    const draft = {
      ...defaultProfile,
      profile_id: "",
      name: "",
    };
    setBootPhase("ready");
    setProfile(draft);
    setData(null);
    setSeason(null);
    setView("settings");
    setProfileError("");
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const defaultResponse = await fetch(
          apiUrl("/api/default-profile", apiBase),
        );
        const nextDefault = defaultResponse.ok
          ? await defaultResponse.json()
          : null;
        if (!nextDefault) {
          if (!cancelled) {
            setProfile(null);
            setBootPhase("ready");
          }
          return;
        }
        if (cancelled) return;
        setDefaultProfile(nextDefault);
        const names = await listProfiles({ apiBase }).catch(() => []);
        if (cancelled) return;
        const entries = await Promise.all(
          names.map(async (id) => {
            try {
              const saved = await loadProfile(id, { apiBase });
              return { id, name: saved?.name || id };
            } catch {
              return { id, name: id };
            }
          }),
        );
        if (cancelled) return;
        setProfileEntries(entries);
        let remembered = "";
        try {
          remembered = localStorage.getItem(ACTIVE_PROFILE_KEY) || "";
        } catch {
          remembered = "";
        }
        const suggested = entries.some((entry) => entry.id === remembered)
          ? remembered
          : entries[0]?.id || "";
        setSuggestedProfileId(suggested);
        if (entries.length === 0) {
          await activateProfile(nextDefault);
          return;
        }
        setBootPhase("pick");
      } catch {
        if (!cancelled) {
          setProfile(null);
          setBootPhase("ready");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase]);
  useEffect(() => {
    if (!profile?.profile_id) return;
    const datasetPath = auctionDatasetPath(profile);
    loadDatasetUrl(apiUrl(`/api/datasets/${datasetPath}`, apiBase), { profile })
      .then((nextData) => {
        setData(nextData);
        setSelectedTeam((team) => team || nextData.teams[0]?.squadra || null);
      })
      .catch(() => setData(null));
    fetch(apiUrl(`/api/datasets/${seasonSimulationPath(profile)}`, apiBase))
      .then((response) => (response.ok ? response.json() : null))
      .then(setSeason)
      .catch(() => setSeason(null));
  }, [apiBase, profile]);
  useEffect(() => {
    const initialRoute = { view: "overview", player: null, team: null };
    window.history.replaceState(
      { fantaRoute: initialRoute, fantaIndex: 0 },
      "",
    );
    const restoreRoute = (event) => {
      const route = event.state?.fantaRoute;
      if (!route) return;
      setHistoryIndex(event.state.fantaIndex ?? 0);
      applyRoute(route);
    };
    window.addEventListener("popstate", restoreRoute);
    return () => window.removeEventListener("popstate", restoreRoute);
  }, []);
  const applyRoute = (route) => {
    setView(route.view);
    setSelectedPlayer(route.player);
    setSelectedTeam(route.team);
  };
  const navigate = (
    nextView,
    { player = selectedPlayer, team = selectedTeam } = {},
  ) => {
    const route = { view: nextView, player, team };
    setViewHistory((routes) => [...routes.slice(0, historyIndex + 1), route]);
    setHistoryIndex((index) => index + 1);
    window.history.pushState(
      { fantaRoute: route, fantaIndex: historyIndex + 1 },
      "",
    );
    applyRoute(route);
  };
  const moveThroughHistory = (direction) => {
    const nextIndex = historyIndex + direction;
    if (!viewHistory[nextIndex]) return;
    window.history.go(direction);
  };
  const openPlayer = (player) => navigate("players", { player });
  const activeRules = rulesFor(profile, data || {});
  const activeProfileId =
    profile?.profile_id || data?.meta?.profile?.profile_id || "default";
  const updateProfile = async (nextProfile, generate = false) => {
    setProfileError("");
    try {
      const saved = await saveProfile(nextProfile, { apiBase });
      await activateProfile(saved);
      await refreshProfileCatalog();
      if (!generate) return;
      const payload = await generateProfile(saved, { apiBase });
      if (!payload.dataset_path)
        throw new Error("Generazione non completata.");
      setData(
        await loadDatasetUrl(
          apiUrl(`/api/datasets/${payload.dataset_path}`, apiBase),
          { profile: saved },
        ),
      );
      setSeason(null);
      navigate("overview");
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : generate
            ? "Impossibile generare il dataset del profilo."
            : "Impossibile salvare il profilo.",
      );
      throw error;
    }
  };
  const regenerateData = async () => {
    if (!profile || isGenerating) return;
    setIsGenerating(true);
    setGenerationStatus("Rigenerazione in corso...");
    try {
      await updateProfile(profile, true);
      setGenerationStatus("Dati rigenerati.");
    } catch (error) {
      setGenerationStatus("Rigenerazione non riuscita.");
    } finally {
      setIsGenerating(false);
    }
  };
  const syncUnderstat = async () => {
    if (!profile || isSyncingUnderstat || isGenerating) return;
    const seasons = (profile.understat_sources || [])
      .map((source) => Number(source.season))
      .filter((season) => Number.isInteger(season) && season >= 2014);
    const targetSeasons = seasons.length ? seasons : [2026, 2025, 2024, 2023, 2022];
    setIsSyncingUnderstat(true);
    setGenerationStatus(`Understat: download ${targetSeasons.join(", ")}...`);
    try {
      const job = await refreshUnderstatSources(
        { seasons: targetSeasons, force: false, autoGenerate: false, profile },
        { apiBase },
      );
      const done = await waitForUnderstatRefresh(job.job_id, { apiBase });
      if (done.status === "failed") {
        throw new Error(done.error || "Refresh Understat non riuscito.");
      }
      setGenerationStatus("Understat ok. Rigenerazione dataset...");
      await updateProfile(profile, true);
      setGenerationStatus("Understat sincronizzato.");
    } catch (error) {
      setGenerationStatus(
        `Understat: ${error instanceof Error ? error.message : "sync fallita"}.`,
      );
    } finally {
      setIsSyncingUnderstat(false);
    }
  };
  const rerunSimulation = async () => {
    if (isSimulating) return;
    setIsSimulating(true);
    setSimulationStatus("Simulazione in corso...");
    try {
      const response = await fetch(`${apiBase}/api/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, iterations: 1000, seed: 202627 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || "Simulazione non completata.");
      setSeason(result);
      setSimulationStatus("Simulazione aggiornata.");
    } catch (error) {
      setSimulationStatus("Simulazione non riuscita.");
    } finally {
      setIsSimulating(false);
    }
  };
  const nav = [
    ["overview", "Sintesi"],
    ["players", "Giocatori"],
    ["teams", "Squadre"],
    ["setpieces", "Piazzati"],
    ["simulation", "Simulazione"],
    ["auction", "Asta live"],
    ["settings", "Impostazioni"],
  ];
  if (bootPhase === "loading")
    return <main className="loading">Caricamento profili...</main>;
  if (bootPhase === "pick")
    return (
      <ProfilePicker
        entries={profileEntries}
        suggestedId={suggestedProfileId}
        busyId={pickerBusyId}
        error={profileError}
        onSelect={selectSavedProfile}
        onCreateNew={createNewProfile}
      />
    );
  if (!profile)
    return <main className="loading">Caricamento profilo locale...</main>;
  if (!data)
    return (
      <main className="app-shell">
        <section className="data-view">
          <div className="view-heading">
            <span className="eyebrow">CONFIGURAZIONE INIZIALE</span>
            <h1>Genera il tuo dataset</h1>
            <p>
              Imposta un <strong>ID profilo unico</strong> per ogni fantacalcio
              (es. fantagobbo, amici-di-ley), carica le fonti e genera i dati.
            </p>
          </div>
          {profileEntries.length > 0 && profile.profile_id ? (
            <ProfileSwitcher
              entries={profileEntries}
              activeId={profile.profile_id}
              onChange={selectSavedProfile}
              onOpenPicker={() => {
                setBootPhase("pick");
                setProfileError("");
              }}
            />
          ) : null}
          <LeagueSettings
            initialProfile={profile}
            leagueCalendar={null}
            apiBase={apiBase}
            onSave={(nextProfile) => updateProfile(nextProfile)}
            onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
          />
          {profileError && <p className="profile-error" role="alert">{profileError}</p>}
        </section>
      </main>
    );
  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="app-header-identity">
            <button className="brand" onClick={() => navigate("overview")}>
              <span>{profile?.season?.season || "FANTACALCIO"}</span>
              <strong title={profile?.name || profile?.profile_id || "Control room"}>
                {profile?.name || profile?.profile_id || "Control room"}
              </strong>
            </button>
            <ProfileSwitcher
              entries={profileEntries}
              activeId={activeProfileId}
              disabled={Boolean(pickerBusyId) || isGenerating}
              onChange={selectSavedProfile}
              onOpenPicker={() => {
                setBootPhase("pick");
                setProfileError("");
              }}
            />
          </div>
          <nav aria-label="Sezioni">
            {nav.map(([id, label]) => (
              <button
                key={id}
                className={view === id ? "active" : ""}
                onClick={() => navigate(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="app-header-tools">
            <div
              className="history-controls"
              aria-label="Cronologia di navigazione"
            >
              <button
                onClick={() => moveThroughHistory(-1)}
                disabled={historyIndex === 0}
                aria-label="Vista precedente"
                title="Indietro"
              >
                &larr;
              </button>
              <button
                onClick={() => moveThroughHistory(1)}
                disabled={historyIndex === viewHistory.length - 1}
                aria-label="Vista successiva"
                title="Avanti"
              >
                &rarr;
              </button>
            </div>
            <div className="data-status">
              <i />
              Dati aggiornati
              <br />
              <small>
                {generationStatus ||
                  data.meta?.generato_il?.slice(0, 10) ||
                  "profilo locale"}
              </small>
              <button
                className="regenerate-data"
                onClick={regenerateData}
                disabled={!profile || isGenerating || isSyncingUnderstat}
              >
                {isGenerating ? "Rigenerazione..." : "Rigenera dati"}
              </button>
              <button
                className="regenerate-data understat-sync"
                onClick={syncUnderstat}
                disabled={!profile || isGenerating || isSyncingUnderstat}
                title="Scarica aggregati Understat e rigenera il dataset"
              >
                {isSyncingUnderstat ? "Understat..." : "Sync Understat"}
              </button>
            </div>
          </div>
        </div>
      </header>
      <main className="app-shell">
      {view === "overview" && (
        <Overview
          data={data}
          openPlayer={openPlayer}
          openTeam={(team) => navigate("teams", { team })}
        />
      )}
      {view === "players" && (
        <PlayersView
          data={data}
          rules={activeRules}
          selected={selectedPlayer}
          setSelected={setSelectedPlayer}
          apiBase={apiBase}
          profileId={activeProfileId}
          profileSeasons={(profile?.understat_sources || [])
            .map((source) => Number(source.season))
            .filter((value) => Number.isFinite(value))}
        />
      )}
      {view === "teams" && (
        <TeamsView
          data={data}
          selectedTeam={selectedTeam}
          setSelectedTeam={setSelectedTeam}
          openPlayer={openPlayer}
        />
      )}
      {view === "setpieces" && (
        <SetPiecesView data={data} openPlayer={openPlayer} />
      )}
      {view === "simulation" && (
          <SeasonView
            season={season}
            data={data}
            openPlayer={openPlayer}
            rules={activeRules}
            profileId={activeProfileId}
            onRerun={rerunSimulation}
            isSimulating={isSimulating}
            simulationStatus={simulationStatus}
        />
      )}
      {view === "auction" && (
        <Auction
          data={data}
          openPlayer={openPlayer}
          rules={activeRules}
          profileId={activeProfileId}
          apiBase={apiBase}
        />
      )}
      {view === "settings" && (
        <>
          <LeagueSettings
            initialProfile={profile}
            leagueCalendar={data.calendario_lega || data.calendar}
            apiBase={apiBase}
            onSave={(nextProfile) => updateProfile(nextProfile)}
            onGenerate={(nextProfile) => updateProfile(nextProfile, true)}
          />
          {profileError && (
            <p className="profile-error" role="alert">
              {profileError}
            </p>
          )}
        </>
      )}
      </main>
    </>
  );
}

function SeasonView({ season, data, openPlayer, rules, profileId, onRerun, isSimulating, simulationStatus }) {
  const [mode, setMode] = useState("report");
  return (
    <>
      <div
        className="simulation-mode"
        role="group"
        aria-label="Modalita simulazione"
      >
        <button
          className={mode === "report" ? "active" : ""}
          onClick={() => setMode("report")}
          aria-pressed={mode === "report"}
        >
          Report rose
        </button>
        <button
          className={mode === "auction" ? "active" : ""}
          onClick={() => setMode("auction")}
          aria-pressed={mode === "auction"}
        >
          Asta casuale
        </button>
      </div>
      {mode === "auction" ? (
        <RandomAuctionView data={data} rules={rules} profileId={profileId} />
      ) : (
        <SeasonReport season={season} data={data} openPlayer={openPlayer} onRerun={onRerun} isSimulating={isSimulating} simulationStatus={simulationStatus} />
      )}
    </>
  );
}

function SeasonReport({ season, data, openPlayer, onRerun, isSimulating, simulationStatus }) {
  const [selected, setSelected] = useState(null);
  if (!data.calendario_lega)
    return (
      <section className="data-view">
        <div className="view-heading">
          <span className="eyebrow">MONTE CARLO OFFLINE</span>
          <h1>Calendario della lega richiesto</h1>
          <p>Puoi usare dashboard, proiezioni e asta. Carica il calendario della lega nelle Impostazioni per simulare la stagione.</p>
        </div>
      </section>
    );
  if (!season)
    return (
      <section className="data-view">
        <div className="view-heading">
          <span className="eyebrow">MONTE CARLO OFFLINE</span>
          <h1>Simulazione non generata</h1>
          <p>Avvia una simulazione per costruire il report pre-asta sulle rose esempio.</p>
          <SimulationRunButton onRerun={onRerun} isSimulating={isSimulating} status={simulationStatus} />
        </div>
      </section>
    );
  const rows = Object.entries(season.teams).sort(
    ([, a], [, b]) => b.expected_utility - a.expected_utility,
  );
  const activeTeam = selected || rows[0][0];
  const roster = (season.rosters[activeTeam] || [])
    .map((id) => data.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const scenario = season.scenarios?.[activeTeam];
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">MONTE CARLO OFFLINE</span>
        <h1>Esiti delle rose esempio</h1>
        <p>
          {season.iterations.toLocaleString("it-IT")} stagioni simulate · seed{" "}
          {season.diagnostics.seed} · {data.calendario_lega?.matchdays?.length || "n/d"} giornate di lega
        </p>
        <SimulationRunButton onRerun={onRerun} isSimulating={isSimulating} status={simulationStatus} />
      </div>
      <section className="panel simulation-report">
        <div className="sim-header">
          <span>Rosa esempio</span>
          <span>Utilità attesa</span>
          <span>Top 3</span>
          <span>Punti attesi</span>
          <span>Punteggio stagionale</span>
        </div>
        {rows.map(([team, result], index) => (
          <button
            className={activeTeam === team ? "selected" : ""}
            onClick={() => setSelected(team)}
            key={team}
          >
            <b>{index + 1}</b>
            <strong>{team}</strong>
            <span className={result.expected_utility >= 0 ? "up" : "down"}>
              {result.expected_utility >= 0 ? "+" : ""}
              {result.expected_utility.toFixed(0)} EUR
            </span>
            <span>{(result.top3_probability * 100).toFixed(1)}%</span>
            <span>{result.expected_points.toFixed(1)}</span>
            <span>
              {result.expected_score.toFixed(0)}{" "}
              <small>
                P05 {result.score_p05.toFixed(0)} · P95{" "}
                {result.score_p95.toFixed(0)}
              </small>
            </span>
          </button>
        ))}
      </section>
      <section className="scenario-grid">
        <div className="panel simulated-roster">
          <div className="panel-title">
            <div>
              <span className="eyebrow">ROSA SELEZIONATA</span>
              <h2>{activeTeam}</h2>
            </div>
            <span className="count">{roster.length} giocatori</span>
          </div>
          <div>
            {roster.map((player) => (
              <button key={player.id} onClick={() => openPlayer(player)}>
                <i className={"role " + player.ruolo}>{player.ruolo}</i>
                <span>
                  <b>{player.nome}</b>
                  <small>
                    {player.squadra} · {formatTier(player.guida_asta_fascia)}
                  </small>
                </span>
                <em>{player.fvm_scaled}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="panel extremes">
          <span className="eyebrow">ESTREMI OSSERVATI</span>
          <h2>Range della stessa rosa</h2>
          <div className="best">
            <span>Migliore stagione estratta</span>
            <strong>{scenario?.best_score}</strong>
            <p>
              {scenario?.best_points} punti · {scenario?.best_rank}° posto
            </p>
          </div>
          <div className="worst">
            <span>Peggiore stagione estratta</span>
            <strong>{scenario?.worst_score}</strong>
            <p>
              {scenario?.worst_points} punti · {scenario?.worst_rank}° posto
            </p>
          </div>
          <p className="micro">
            Sono gli estremi realizzati nelle{" "}
            {season.iterations.toLocaleString("it-IT")} simulazioni: mostrano la
            variabilità, non una previsione puntuale.
          </p>
        </div>
      </section>
      <section className="panel simulation-note">
        <b>Come leggere questo report</b>
        <p>
          Le rose sono generate automaticamente con snake draft bilanciato sui
          valori FVM. Ora puoi ispezionare ogni rosa e capire quali profili
          producono i risultati migliori e peggiori; non rappresentano ancora le
          rose della tua lega reale.
        </p>
      </section>
    </section>
  );
}

function SimulationRunButton({ onRerun, isSimulating, status }) {
  return (
    <div className="simulation-run">
      <button onClick={onRerun} disabled={isSimulating}>
        {isSimulating ? "Simulazione in corso..." : "Riesegui Monte Carlo"}
      </button>
      {status && <small role="status">{status}</small>}
    </div>
  );
}

function Overview({ data, openPlayer, openTeam }) {
  const roleCounts = Object.keys(ROLE_LABELS).map((role) => ({
    role,
    count: data.players.filter((p) => p.ruolo === role).length,
  }));
  const top = data.players
    .filter((p) =>
      ["SUPER TOP", "TOP", "SEMITOP"].includes(formatTier(p.guida_asta_fascia)),
    )
    .sort((a, b) => b.fvm_scaled - a.fvm_scaled)
    .slice(0, 8);
  const injury = data.players.filter(
    (p) => p.guida_asta_fascia === "INFORTUNATO",
  );
  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">DATABASE OFFLINE</span>
          <h1>
            Tutto il tuo fanta,
            <br />
            in una sola vista.
          </h1>
          <p>
            Proiezioni, storico, guide editoriali, calendario e gerarchie sui
            piazzati. Nessuna connessione richiesta durante l’asta.
          </p>
        </div>
        <div className="hero-card">
          <span>Copertura dati</span>
          <strong>
            {data.players.length}
            <small> giocatori</small>
          </strong>
          <p>{data.teams.length} squadre Serie A · {data.calendario_serie_a?.length / 10 || "n/d"} giornate · {data.set_pieces.length} gerarchie piazzati</p>
        </div>
      </section>
      <section className="metric-grid">
        {roleCounts.map((item) => (
          <button
            className="metric"
            key={item.role}
            onClick={() =>
              openPlayer(data.players.find((p) => p.ruolo === item.role))
            }
          >
            <span className={"role " + item.role}>{item.role}</span>
            <strong>{item.count}</strong>
            <small>{ROLE_LABELS[item.role]}</small>
          </button>
        ))}
        <div className="metric accent">
          <span>Fasce SOS</span>
          <strong>
            {data.players.filter((p) => p.guida_asta_fascia).length}
          </strong>
          <small>profili classificati</small>
        </div>
      </section>
      <section className="split-layout">
        <div className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">PRIME SCELTE</span>
              <h2>Valore e proiezione</h2>
            </div>
            <button onClick={() => openPlayer(top[0])}>
              Tutti i giocatori
            </button>
          </div>
          <div className="rank-list">
            {top.map((player, index) => (
              <button key={player.id} onClick={() => openPlayer(player)}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <span className={"role " + player.ruolo}>{player.ruolo}</span>
                <div>
                  <strong>{player.nome}</strong>
                  <small>
                    {player.squadra} · {formatTier(player.guida_asta_fascia)}
                  </small>
                </div>
                <em>{player.fvm_scaled}</em>
              </button>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-title">
            <div>
              <span className="eyebrow">DA MONITORARE</span>
              <h2>Infortunati</h2>
            </div>
            <span className="count">{injury.length}</span>
          </div>
          <div className="watch-list">
            {injury.length ? (
              injury.map((player) => (
                <button key={player.id} onClick={() => openPlayer(player)}>
                  <span className={"role " + player.ruolo}>{player.ruolo}</span>
                  <div>
                    <strong>{player.nome}</strong>
                    <small>{player.squadra}</small>
                  </div>
                  <span className="status muted">RECUPERO</span>
                </button>
              ))
            ) : (
              <p>Nessun infortunato classificato.</p>
            )}
          </div>
        </div>
      </section>
      <section className="panel team-directory">
        <div className="panel-title">
          <div>
            <span className="eyebrow">SERIE A</span>
            <h2>Esplora le squadre</h2>
          </div>
          <button onClick={() => openTeam(data.teams[0]?.squadra)}>Calendari e rose</button>
        </div>
        <div>
          {data.teams.map((team) => (
            <button key={team.squadra} onClick={() => openTeam(team.squadra)}>
              <strong>{team.squadra}</strong>
              <small>
                ATT {team.rating_att}/10 · DIF {team.rating_dif}/10
              </small>
              {team.coppa_europea && <span>{team.coppa_europea}</span>}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function PlayersView({ data, rules, selected, setSelected, apiBase, profileId, profileSeasons }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("TUTTI");
  const [team, setTeam] = useState("TUTTE");
  const [sortBy, setSortBy] = useState("valore");
  const [sortDir, setSortDir] = useState("desc");
  const valuation = createRoleValuation(data.players, rules);
  const toggleSort = (key) => {
    if (sortBy === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
      return;
    }
    setSortBy(key);
    setSortDir("desc");
  };
  const sortValue = (player) =>
    sortBy === "fantavoto"
      ? player.proiezione.fantavoto
      : valuation.normalizedFvm(player);
  const rows = data.players
    .filter(
      (p) =>
        (role === "TUTTI" || p.ruolo === role) &&
        (team === "TUTTE" || p.squadra === team) &&
        p.nome.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      const delta = sortValue(a) - sortValue(b);
      if (delta !== 0) return sortDir === "asc" ? delta : -delta;
      return a.nome.localeCompare(b.nome, "it");
    });
  const player = selected || rows[0];
  const sortLabel = (key) =>
    sortBy === key ? (sortDir === "asc" ? "A-Z" : "Z-A") : "";
  const ariaSort = (key) =>
    sortBy === key
      ? sortDir === "asc"
        ? "ascending"
        : "descending"
      : "none";
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">DATABASE GIOCATORI</span>
        <h1>Profili, storico e proiezioni</h1>
      </div>
      <div className="filters">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cerca un giocatore"
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option>TUTTI</option>
          {Object.keys(ROLE_LABELS).map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option>TUTTE</option>
          {data.teams.map((t) => (
            <option key={t.squadra}>{t.squadra}</option>
          ))}
        </select>
        <span>{rows.length} risultati</span>
      </div>
      <div className="player-layout">
        <div className="player-table">
          <div className="table-head">
            <span>Giocatore</span>
            <span>Disponibilita</span>
            <span>
              <button
                type="button"
                className={`sort-head${sortBy === "valore" ? " active" : ""}`}
                aria-sort={ariaSort("valore")}
                onClick={() => toggleSort("valore")}
              >
                Valore ruolo
                <i aria-hidden="true">{sortLabel("valore") || "↕"}</i>
              </button>
            </span>
            <span>
              <button
                type="button"
                className={`sort-head${sortBy === "fantavoto" ? " active" : ""}`}
                aria-sort={ariaSort("fantavoto")}
                onClick={() => toggleSort("fantavoto")}
              >
                Proiezione FV
                <i aria-hidden="true">{sortLabel("fantavoto") || "↕"}</i>
              </button>
            </span>
          </div>
          {rows.map((p) => {
            const xg90 = listXg90(p);
            return (
            <button
              className={player?.id === p.id ? "selected" : ""}
              key={p.id}
              onClick={() => setSelected(p)}
            >
              <span>
                <i className={"role " + p.ruolo}>{p.ruolo}</i>
                <b>{p.nome}</b>
                <small>
                  {p.squadra} · {formatTier(p.guida_asta_fascia)}
                </small>
              </span>
              <span className={"status " + statusClass(p.disponibilita.status)}>
                {p.disponibilita.status.replace("_", " ")}
              </span>
              <strong>{valuation.normalizedFvm(p).toFixed(1)}</strong>
              <span className="fv-cell">
                <em>{p.proiezione.fantavoto.toFixed(2)}</em>
                {xg90 != null && (
                  <small className="xg90-badge" title="xG per 90 (Understat)">
                    xG90 {xg90.toFixed(2)}
                    <i style={{ width: `${Math.min(100, xg90 * 80)}%` }} aria-hidden="true" />
                  </small>
                )}
              </span>
            </button>
            );
          })}
        </div>
        {player && (
          <PlayerDetail
            player={player}
            valuation={valuation}
            apiBase={apiBase}
            profileId={profileId}
            profileSeasons={profileSeasons}
          />
        )}
      </div>
    </section>
  );
}

function UnderstatPanel({ player, apiBase, profileId, profileSeasons }) {
  const seasons = understatSeasons(player);
  const [season, setSeason] = useState(() => pickUnderstatSeason(player));
  const [detail, setDetail] = useState(null);
  const [detailStatus, setDetailStatus] = useState("idle");
  const [detailError, setDetailError] = useState("");
  const [situations, setSituations] = useState(() => [...SHOT_SITUATIONS]);
  const [results, setResults] = useState(() => [...SHOT_RESULTS]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historySort, setHistorySort] = useState("date_desc");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    setSeason(pickUnderstatSeason(player, season));
  }, [player.id]);

  useEffect(() => {
    if (!hasUnderstat(player) || understatIdFor(player) == null || !profileId) {
      setDetail(null);
      setDetailStatus("idle");
      return undefined;
    }
    const controller = new AbortController();
    let cancelled = false;
    setDetailStatus("loading");
    setDetailError("");
    const timer = window.setTimeout(async () => {
      try {
        const seasonsArg =
          Array.isArray(profileSeasons) && profileSeasons.length
            ? profileSeasons
            : seasons.map(Number).filter((value) => Number.isFinite(value));
        const payload = await fetchPlayerUnderstat(player.id, {
          seasons: seasonsArg,
          profileId,
          apiBase,
          signal: controller.signal,
        });
        if (cancelled) return;
        setDetail(payload);
        setDetailStatus("ready");
        setHistoryPage(0);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        if (error?.cause?.name === "AbortError" || error?.name === "AbortError") return;
        setDetail(null);
        setDetailStatus("error");
        setDetailError(error?.message || "Dettagli Understat non disponibili.");
      }
    }, 200);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [player.id, profileId, apiBase, reloadToken]);

  if (!hasUnderstat(player)) {
    return (
      <section className="understat-panel empty" aria-label="Understat">
        <div className="understat-head">
          <h3>Understat</h3>
        </div>
        <p>
          Dati Understat non disponibili per questo giocatore. In{" "}
          <strong>Impostazioni</strong> usa{" "}
          <em>Sincronizza Understat e rigenera</em>, poi ricontrolla qui.
        </p>
      </section>
    );
  }
  const activeSeason = season && player.understat[season] ? season : seasons[0];
  const stats = player.understat[activeSeason];
  const delta = stats.overperformance;
  const tone = overperformanceTone(delta);
  const xgSpark = sparklinePoints(player, "xG");
  const xaSpark = sparklinePoints(player, "xA");
  const barMax = Math.max(Math.abs(Number(delta) || 0), Number(stats.xG) || 0, Number(stats.goals) || 0, 1);
  const barPct = Math.min(50, (Math.abs(Number(delta) || 0) / barMax) * 50);

  const radar = detail?.radar;
  const poly = radar ? radarPolygon(radar, activeSeason) : null;
  const flatShots = flattenShots(detail?.shots);
  const seasonShots = filterShots(flatShots, {
    seasons: [activeSeason],
    situations,
    results,
  });
  const projected = seasonShots.map((shot) => ({ shot, ...projectShot(shot) }));
  const historyRows = matchHistoryRows(detail?.matches || [], { sort: historySort });
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(historyRows.length / pageSize));
  const pageRows = historyRows.slice(historyPage * pageSize, historyPage * pageSize + pageSize);

  const toggleChip = (value, list, setList) => {
    setList((current) =>
      current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    );
  };

  return (
    <section className="understat-panel" aria-label="Understat">
      <div className="understat-head">
        <div>
          <h3>Understat</h3>
          <p>Aggregati stagione · xG su minuti giocati</p>
        </div>
        <label>
          Stagione
          <select
            value={activeSeason}
            onChange={(event) => setSeason(event.target.value)}
            aria-label="Stagione Understat"
          >
            {seasons.map((value) => (
              <option key={value} value={value}>
                {value}/{String(Number(value) + 1).slice(-2)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={`overperf-bar ${tone}`} role="img" aria-label={`Overperformance ${formatMetric(delta, "overperformance")}`}>
        <span>Gol {stats.goals}</span>
        <div className="overperf-track">
          <i
            className={tone === "under" ? "neg" : "pos"}
            style={
              tone === "under"
                ? { width: `${barPct}%`, marginLeft: `${50 - barPct}%` }
                : { width: `${barPct}%`, marginLeft: "50%" }
            }
          />
          <b>{delta >= 0 ? "+" : ""}{formatMetric(delta, "overperformance")}</b>
        </div>
        <span>xG {formatMetric(stats.xG, "xG")}</span>
      </div>
      <div className="understat-metrics">
        {PANEL_METRICS.map((key) => (
          <div key={key} title={METRIC_DEFS[key] || key}>
            <span>{key}</span>
            <b>{formatMetric(stats[key], key)}</b>
          </div>
        ))}
      </div>
      {(xgSpark.points || xaSpark.points) && (
        <div className="understat-sparklines" aria-hidden="true">
          <figure>
            <figcaption>xG</figcaption>
            <svg viewBox="0 0 120 28" width="120" height="28">
              <polyline className="spark xg" points={xgSpark.points} />
            </svg>
          </figure>
          <figure>
            <figcaption>xA</figcaption>
            <svg viewBox="0 0 120 28" width="120" height="28">
              <polyline className="spark xa" points={xaSpark.points} />
            </svg>
          </figure>
        </div>
      )}

      <div className="understat-detail" aria-busy={detailStatus === "loading"}>
        <div className="understat-detail-head">
          <h4>Dettagli Understat</h4>
          <p>Radar · mappa tiri · partite (lazy)</p>
        </div>

        {detailStatus === "loading" && (
          <div className="understat-skeleton" role="status">
            <span />
            <span />
            <span />
          </div>
        )}

        {detailStatus === "error" && (
          <div className="understat-detail-error" role="alert">
            <p>{detailError || "Dettagli non disponibili"}</p>
            <button type="button" onClick={() => setReloadToken((value) => value + 1)}>
              Riprova
            </button>
          </div>
        )}

        {detailStatus === "ready" && !radar && !projected.length && !historyRows.length && (
          <p className="understat-detail-empty">Dettagli non disponibili per questo giocatore.</p>
        )}

        {detailStatus === "ready" && radar && poly && (
          <figure className="understat-radar">
            <figcaption>Radar {activeSeason}/{String(Number(activeSeason) + 1).slice(-2)}</figcaption>
            <svg viewBox={`0 0 ${poly.size} ${poly.size}`} width="200" height="200" role="img" aria-label="Radar ratings Understat">
              {[0.25, 0.5, 0.75, 1].map((scale) => (
                <circle
                  key={scale}
                  className="radar-ring"
                  cx={poly.cx}
                  cy={poly.cy}
                  r={poly.radius * scale}
                />
              ))}
              {poly.axes.map((axis) => (
                <g key={axis.label}>
                  <line className="radar-axis" x1={poly.cx} y1={poly.cy} x2={axis.x} y2={axis.y} />
                  <text className="radar-label" x={axis.lx} y={axis.ly} textAnchor="middle" dominantBaseline="middle">
                    {axis.label}
                  </text>
                </g>
              ))}
              <polygon className="radar-poly" points={poly.points} />
            </svg>
          </figure>
        )}

        {detailStatus === "ready" && (
          <div className="understat-shotmap">
            <div className="understat-shotmap-head">
              <h5>Shot map</h5>
              <span>{projected.length} tiri · {activeSeason}</span>
            </div>
            <div className="understat-chips" role="group" aria-label="Filtro situazione">
              {SHOT_SITUATIONS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={situations.includes(value) ? "active" : ""}
                  aria-pressed={situations.includes(value)}
                  onClick={() => toggleChip(value, situations, setSituations)}
                >
                  {value}
                </button>
              ))}
            </div>
            <div className="understat-chips" role="group" aria-label="Filtro risultato">
              {SHOT_RESULTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={results.includes(value) ? "active" : ""}
                  aria-pressed={results.includes(value)}
                  onClick={() => toggleChip(value, results, setResults)}
                  style={{ ["--chip-accent"]: SHOT_RESULT_COLORS[value] }}
                >
                  {value}
                </button>
              ))}
            </div>
            <svg className="shotmap-pitch" viewBox="0 0 100 65" role="img" aria-label="Mappa tiri">
              <rect className="pitch-bg" x="0" y="0" width="100" height="65" rx="1.5" />
              <line className="pitch-line" x1="0" y1="32.5" x2="100" y2="32.5" />
              <rect className="pitch-box" x="18" y="0" width="64" height="16" />
              <rect className="pitch-box" x="36" y="0" width="28" height="6" />
              {projected.map((item, index) => (
                <circle
                  key={`${item.shot.id || index}-${item.shot.minute || index}`}
                  cx={item.cx}
                  cy={item.cy}
                  r={item.r}
                  fill={item.fill}
                  opacity={0.35 + Math.min(0.55, item.xg * 1.2)}
                >
                  <title>
                    {item.result} · xG {item.xg.toFixed(2)} · {item.situation} · min {item.shot.minute ?? "—"}
                  </title>
                </circle>
              ))}
            </svg>
            {!projected.length && (
              <p className="understat-detail-empty">Nessun tiro per i filtri selezionati.</p>
            )}
          </div>
        )}

        {detailStatus === "ready" && (
          <div className="understat-history">
            <div className="understat-history-head">
              <h5>Match history</h5>
              <button
                type="button"
                className="history-sort"
                onClick={() => {
                  setHistorySort((value) => (value === "date_desc" ? "date_asc" : "date_desc"));
                  setHistoryPage(0);
                }}
              >
                Data {historySort === "date_desc" ? "↓" : "↑"}
              </button>
            </div>
            <div className="understat-history-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Home</th>
                    <th>Score</th>
                    <th>Away</th>
                    <th>Pos</th>
                    <th>Min</th>
                    <th>Sh</th>
                    <th>G</th>
                    <th>KP</th>
                    <th>A</th>
                    <th>xG</th>
                    <th>xA</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((row) => {
                    const cells = formatMatchRow(row);
                    return (
                      <tr key={row.id || `${row.date}-${row.home}-${row.away}`}>
                        <td>{cells.date}</td>
                        <td>{cells.home}</td>
                        <td className="num">{cells.score}</td>
                        <td>{cells.away}</td>
                        <td>{cells.position}</td>
                        <td className="num">{cells.time}</td>
                        <td className="num">{cells.shots}</td>
                        <td className="num">{cells.goals}</td>
                        <td className="num">{cells.kp}</td>
                        <td className="num">{cells.assists}</td>
                        <td className="num" title={cells.xGDelta != null ? `Δ ${cells.xGDelta >= 0 ? "+" : ""}${cells.xGDelta.toFixed(2)}` : undefined}>
                          {cells.xG}
                        </td>
                        <td className="num" title={cells.xADelta != null ? `Δ ${cells.xADelta >= 0 ? "+" : ""}${cells.xADelta.toFixed(2)}` : undefined}>
                          {cells.xA}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!historyRows.length && (
              <p className="understat-detail-empty">Nessuna partita in cache Understat.</p>
            )}
            {historyRows.length > pageSize && (
              <div className="understat-history-pager">
                <button
                  type="button"
                  disabled={historyPage <= 0}
                  onClick={() => setHistoryPage((value) => Math.max(0, value - 1))}
                >
                  Prev
                </button>
                <span>
                  {historyPage + 1}/{pageCount}
                </span>
                <button
                  type="button"
                  disabled={historyPage >= pageCount - 1}
                  onClick={() => setHistoryPage((value) => Math.min(pageCount - 1, value + 1))}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function PlayerDetail({ player, valuation, apiBase, profileId, profileSeasons }) {
  const history = Object.entries(player.storico);
  const outliers = valuation.outliersFor(player);
  return (
    <aside className="player-detail">
      <div className="detail-top">
        <span className={"role " + player.ruolo}>{player.ruolo}</span>
        <span className="tier">{formatTier(player.guida_asta_fascia)}</span>
      </div>
      <h2>{player.nome}</h2>
      <p>
        {player.squadra} · Mantra {player.ruoli_mantra || "n/d"}
      </p>
      <div className="projection">
        <div>
          <span>FVM fonte</span>
          <b>{sourceFvm(player).toFixed(2)}</b>
        </div>
        <div>
          <span>Valore ruolo</span>
          <b>{valuation.normalizedFvm(player).toFixed(2)}</b>
        </div>
        <div>
          <span>Prob. voto</span>
          <b>{Math.round(player.proiezione.p_gioca * 100)}%</b>
        </div>
        <div>
          <span>Fanta voto</span>
          <b>{player.proiezione.fantavoto.toFixed(2)}</b>
        </div>
      </div>
      <p className="valuation-source-note">
        FVM fonte: colonna FVM del listone Fantacalcio su base 1000. Il valore
        ruolo lo normalizza sul budget configurato per il reparto.
      </p>
      {outliers.length > 0 && (
        <div className="valuation-warning" role="note">
          <b>Valore da verificare</b>
          {outliers.map((outlier) => (
            <span key={outlier.code}>{outlier.label}</span>
          ))}
        </div>
      )}
      <div className="quote-row">
        <span>
          Qt. attuale <b>{player.quotazioni.attuale}</b>
        </span>
        <span>
          Iniziale <b>{player.quotazioni.iniziale}</b>
        </span>
        <span className={player.quotazioni.differenza >= 0 ? "up" : "down"}>
          {player.quotazioni.differenza >= 0 ? "+" : ""}
          {player.quotazioni.differenza}
        </span>
      </div>
      <h3>Storico</h3>
      <div className="history">
        {history.length ? (
          history.map(([season, stat]) => (
            <div key={season}>
              <b>{season}</b>
              <span>
                PV {stat.Pv} · MV {stat.Mv ?? "—"} · FM {stat.Fm ?? "—"}
              </span>
              <small>
                G {stat.Gf} · A {stat.Ass} · Amm {stat.Amm}
              </small>
            </div>
          ))
        ) : (
          <p>Nessuno storico nel listone.</p>
        )}
      </div>
      <UnderstatPanel
        player={player}
        apiBase={apiBase}
        profileId={profileId}
        profileSeasons={profileSeasons}
      />
      <div className="note">
        <b>{player.disponibilita.status.replace("_", " ")}</b>
        <p>{player.disponibilita.nota || "Stima ricavata dallo storico."}</p>
      </div>
    </aside>
  );
}

function TeamsView({ data, selectedTeam, setSelectedTeam, openPlayer }) {
  const team =
    data.teams.find((t) => t.squadra === selectedTeam) || data.teams[0];
  const players = team.player_ids
    .map((id) => data.players.find((p) => p.id === id))
    .filter(Boolean)
    .sort(
      (a, b) => a.ruolo.localeCompare(b.ruolo) || b.fvm_scaled - a.fvm_scaled,
    );
  const pieces = data.set_pieces.filter((p) => p.squadra === team.squadra);
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">SQUADRE SERIE A</span>
        <h1>Calendario, rosa e piazzati</h1>
      </div>
      <div className="team-picker">
        {data.teams.map((t) => (
          <button
            className={t.squadra === team.squadra ? "active" : ""}
            key={t.squadra}
            onClick={() => setSelectedTeam(t.squadra)}
          >
            {t.squadra}
          </button>
        ))}
      </div>
      <section className="team-hero">
        <div>
          <span className="eyebrow">
            {team.coppa_europea || "NESSUNA COPPA"}
          </span>
          <h2>{team.squadra}</h2>
          <p>
            {team.promossa ? "Neopromossa" : "Serie A"} · Rating attacco{" "}
            {team.rating_att}/10 · difesa {team.rating_dif}/10
          </p>
        </div>
        <div className="team-stats">
          <span>
            Punti prec.<b>{team.punti_prec}</b>
          </span>
          <span>
            GF / GS
            <b>
              {team.gf_prec} / {team.gs_prec}
            </b>
          </span>
          <span>
            xG / xGA
            <b>
              {team.xg_prec ?? "—"} / {team.xga_prec ?? "—"}
            </b>
            {team.understat_xg != null && (
              <small className="understat-team-note">
                Understat xG {Number(team.understat_xg).toFixed(1)}
              </small>
            )}
          </span>
        </div>
      </section>
      <div className="team-grid">
        <section className="panel fixtures">
          <div className="panel-title">
            <div>
              <span className="eyebrow">CALENDARIO</span>
              <h2>Alternanza casa / trasferta</h2>
            </div>
            <span className="legend">
              <i className="home" />
              Casa <i className="away" />
              Trasferta
            </span>
          </div>
          <div className="fixture-grid">
            {team.fixtures.map((f) => (
              <div
                className={f.venue === "CASA" ? "home" : "away"}
                key={f.matchday}
              >
                <small>G{f.matchday}</small>
                <b>
                  {f.venue === "CASA" ? "vs" : "@"} {f.opponent}
                </b>
              </div>
            ))}
          </div>
        </section>
        <section className="panel setpiece-mini">
          <div className="panel-title">
            <div>
              <span className="eyebrow">PIAZZATI</span>
              <h2>Gerarchie</h2>
            </div>
          </div>
          {pieces.map((piece) => (
            <div key={piece.tipo}>
              <b>{piece.tipo}</b>
              {piece.takers.map((taker) => (
                <button
                  onClick={() =>
                    openPlayer(
                      data.players.find((p) => p.id === taker.player_id),
                    )
                  }
                  key={taker.player_id}
                >
                  {taker.nome}
                  <span>P{taker.priorita}</span>
                </button>
              ))}
            </div>
          ))}
        </section>
      </div>
      <section className="panel roster">
        <div className="panel-title">
          <div>
            <span className="eyebrow">ROSA LISTONE</span>
            <h2>{players.length} giocatori</h2>
          </div>
        </div>
        <div>
          {players.map((player) => (
            <button key={player.id} onClick={() => openPlayer(player)}>
              <i className={"role " + player.ruolo}>{player.ruolo}</i>
              <b>{player.nome}</b>
              <span
                className={"status " + statusClass(player.disponibilita.status)}
              >
                {player.disponibilita.status.replace("_", " ")}
              </span>
              <em>{player.fvm_scaled}</em>
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}

function SetPiecesView({ data, openPlayer }) {
  const types = ["RIGORI", "PUNIZIONI", "CORNER"];
  return (
    <section className="data-view">
      <div className="view-heading">
        <span className="eyebrow">SPECIALISTI</span>
        <h1>Rigoristi, punizioni e corner</h1>
        <p>
          Le gerarchie aperte non hanno un primo designato: il modello evita di
          assegnare loro un bonus artificiale.
        </p>
      </div>
      <div className="setpiece-board">
        {data.teams.map((team) => (
          <article key={team.squadra}>
            <h2>{team.squadra}</h2>
            {types.map((type) => {
              const item = data.set_pieces.find(
                (p) => p.squadra === team.squadra && p.tipo === type,
              );
              return (
                <div key={type}>
                  <span>{type}</span>
                  {item?.takers.length ? (
                    item.takers.map((taker) => (
                      <button
                        key={taker.player_id}
                        onClick={() =>
                          openPlayer(
                            data.players.find((p) => p.id === taker.player_id),
                          )
                        }
                      >
                        {taker.nome}
                        <b>P{taker.priorita}</b>
                      </button>
                    ))
                  ) : (
                    <em>Da definire</em>
                  )}
                </div>
              );
            })}
          </article>
        ))}
      </div>
    </section>
  );
}

function AuctionStrategy({ advice }) {
  const recommendation =
    RECOMMENDATION_LABELS[advice.recommendation] || "Valuta";
  return (
    <section
      className={`strategy-panel ${advice.recommendation.toLowerCase()}`}
      aria-label="Consiglio strategico per la mia squadra"
    >
      <div className="strategy-verdict">
        <span className="strategy-kicker">CONSIGLIO PER LA MIA SQUADRA</span>
        <strong>{recommendation}</strong>
        <small>Confidenza {Math.round(advice.confidence * 100)}%</small>
      </div>
      <div className="strategy-prices">
        <div>
          <span>Fascia ideale</span>
          <strong>
            {advice.idealMin}-{advice.idealMax}
          </strong>
          <small>crediti</small>
        </div>
        <div>
          <span>Non superare</span>
          <strong>{advice.maxBid}</strong>
          <small>limite di valore</small>
        </div>
        <div>
          <span>Mercato stimato</span>
          <strong>{advice.summary.estimatedMarketPrice ?? "-"}</strong>
          <small>
            FVM {advice.summary.sourceFvm ?? "-"} · normalizzato{" "}
            {advice.summary.normalizedFvm ?? "-"}
          </small>
        </div>
      </div>
      <div className="strategy-explanation">
        <div>
          <h3>Perche</h3>
          {advice.reasons.slice(0, 3).map((reason) => (
            <p key={reason}>{reason}</p>
          ))}
        </div>
        <div>
          <h3>Attenzione</h3>
          {advice.risks.length ? (
            advice.risks.slice(0, 3).map((risk) => <p key={risk}>{risk}</p>)
          ) : (
            <p>Nessun rischio specifico rilevato.</p>
          )}
        </div>
      </div>
      <div className="strategy-bottom">
        <div className="role-plan">
          <h3>Piano rosa</h3>
          {Object.entries(advice.rolePlan).map(([role, plan]) => (
            <div key={role}>
              <span className={`role ${role}`}>{role}</span>
              <b>{plan.open ? `${plan.open} posti` : "Completo"}</b>
              <small>
                {plan.open
                  ? `Target ${plan.budgetTarget} · residuo ${plan.budgetRemaining}`
                  : `${plan.owned} acquistati`}
              </small>
            </div>
          ))}
        </div>
        <div className="strategy-alternatives">
          <h3>Alternative</h3>
          {advice.alternatives.length ? (
            advice.alternatives.map((alternative) => (
              <div key={alternative.id}>
                <b>{alternative.name}</b>
                <span>stima {alternative.estimatedCost} cr.</span>
              </div>
            ))
          ) : (
            <p>Nessuna alternativa comparabile disponibile.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function AuctionOverview({ overview }) {
  if (!overview) return null;
  return (
    <section
      className="strategy-overview"
      aria-label="Piano strategico della mia squadra"
    >
      <div className="overview-heading">
        <div>
          <span className="eyebrow">PIANO AGGIORNATO</span>
          <h2>Prossime mosse</h2>
        </div>
        <div className="spendable">
          <span>Budget spendibile</span>
          <strong>{overview.summary.spendableCredits}</strong>
          <small>
            + {overview.summary.reservedCredits} riservati agli slot
          </small>
        </div>
      </div>
      <div className="priority-grid">
        {overview.priorities.map((priority) => {
          const plan = overview.rolePlan[priority.role];
          return (
            <article
              className={`priority ${priority.urgency.toLowerCase()}`}
              key={priority.role}
            >
              <div>
                <span className={`role ${priority.role}`}>{priority.role}</span>
                <b>{ROLE_LABELS[priority.role]}</b>
                <em>{priority.urgency}</em>
              </div>
              <strong>
                {plan.budgetTarget}
                <small> crediti obiettivo</small>
              </strong>
              <p>{priority.reason}</p>
            </article>
          );
        })}
      </div>
      <p className="market-line">
        Mercato rilevato: <b>{overview.summary.marketInflation.toFixed(2)}x</b>{" "}
        rispetto ai valori base. Il piano si aggiorna dopo ogni assegnazione.
      </p>
    </section>
  );
}

function Auction({ data, openPlayer, rules, profileId, apiBase = "" }) {
  const activeRules = normalizeRules(
    rules ?? data.league_rules ?? { startingCredits: 750 },
  );
  const activeProfileId = String(
    profileId ?? data.profileId ?? data.profile_id ?? "default",
  );
  const storageKey = auctionStorageKey(activeProfileId);
  const rulesSignature = JSON.stringify(activeRules);
  const configuredUserIndex = Number(activeRules.userTeam);
  const defaultUserTeamIndex = Math.max(
    0,
    Number.isInteger(configuredUserIndex) &&
      configuredUserIndex >= 0 &&
      configuredUserIndex < activeRules.participants
      ? configuredUserIndex
      : (activeRules.teamNames?.indexOf(activeRules.userTeam) ?? -1),
  );
  const loadAuction = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      const legacy =
        !saved && activeProfileId === "default"
          ? JSON.parse(localStorage.getItem("fanta-auction-v1") || "null")
          : null;
      return (
        rehydrateAuction(saved || legacy, data.players, activeRules) ||
        emptyAuction(activeRules)
      );
    } catch {
      return emptyAuction(activeRules);
    }
  };
  const [state, setState] = useState(() => {
    return loadAuction();
  });
  const [userTeamIndex, setUserTeamIndex] = useState(defaultUserTeamIndex);
  const [query, setQuery] = useState("");
  const [player, setPlayer] = useState(null);
  const [owner, setOwner] = useState(userTeamIndex);
  const [price, setPrice] = useState("");
  const [advice, setAdvice] = useState(null);
  const [overviewAdvice, setOverviewAdvice] = useState(null);
  const [message, setMessage] = useState(
    "Cerca un giocatore e assegna il suo prezzo.",
  );
  const [messageType, setMessageType] = useState("info");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const worker = useRef();
  const skipPersist = useRef(false);
  const workerHistory = state.history.flatMap((transaction) => {
    const transactionPlayer = data.players.find(
      (candidate) =>
        playerIdKey(candidate.id) === playerIdKey(transaction.playerId),
    );
    return transactionPlayer
      ? [{ ...transaction, player: transactionPlayer }]
      : [];
  });
  useEffect(() => {
    skipPersist.current = true;
    setState(loadAuction());
    setUserTeamIndex(defaultUserTeamIndex);
    setOwner(defaultUserTeamIndex);
    setPlayer(null);
    setQuery("");
    setPrice("");
  }, [storageKey, rulesSignature, defaultUserTeamIndex]);
  useEffect(() => {
    if (skipPersist.current) {
      skipPersist.current = false;
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(serializeAuction(state)));
  }, [state, storageKey]);
  useEffect(() => {
    worker.current = new Worker(
      new URL("./simulation.worker.js", import.meta.url),
      { type: "module" },
    );
    worker.current.onmessage = (e) =>
      e.data.kind === "overview"
        ? setOverviewAdvice(e.data)
        : setAdvice(e.data);
    return () => worker.current.terminate();
  }, []);
  useEffect(() => {
    if (!player) return setAdvice(null);
    worker.current.postMessage({
      player,
      owner: userTeamIndex,
      mine: state.teams[userTeamIndex],
      teams: state.teams,
      remaining: data.players.filter((p) => !state.assigned[playerIdKey(p.id)]),
      assigned: state.assigned,
      history: workerHistory,
      rules: activeRules,
    });
  }, [player, state, data, rulesSignature, userTeamIndex]);
  useEffect(() => {
    worker.current.postMessage({
      mode: "overview",
      owner: userTeamIndex,
      mine: state.teams[userTeamIndex],
      teams: state.teams,
      remaining: data.players.filter((p) => !state.assigned[playerIdKey(p.id)]),
      assigned: state.assigned,
      history: workerHistory,
      rules: activeRules,
    });
  }, [state, data, rulesSignature, userTeamIndex]);
  const activeRole = activeNominationRole(state.teams, activeRules);
  const choices = data.players
    .filter(
      (p) =>
        !state.assigned[playerIdKey(p.id)] &&
        (!activeRole || p.ruolo === activeRole) &&
        query.length >= 2 &&
        p.nome.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 7);
  const selectPlayer = (candidate) => {
    if (activeRole && candidate.ruolo !== activeRole) {
      setMessage(`In questa fase puoi chiamare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`);
      return setMessageType("error");
    }
    setPlayer(candidate);
    setQuery(candidate.nome);
    setPrice("");
    setSuggestionsOpen(false);
    setMessage(`Hai selezionato ${candidate.nome}. Scegli squadra e prezzo.`);
    setMessageType("info");
  };
  const assign = () => {
    const value = Number(price),
      team = state.teams[owner];
    if (!player) return;
    if (state.assigned[playerIdKey(player.id)]) {
      setMessage(`${player.nome} risulta gia assegnato.`);
      return setMessageType("error");
    }
    if (activeRole && player.ruolo !== activeRole) {
      setMessage(`In questa fase puoi assegnare solo ${ROLE_LABELS[activeRole].toLowerCase()}.`);
      return setMessageType("error");
    }
    if (!Number.isInteger(value) || value < activeRules.auction.minPrice) {
      setMessage(
        `Inserisci un prezzo intero di almeno ${activeRules.auction.minPrice} crediti.`,
      );
      return setMessageType("error");
    }
    if (
      (value - activeRules.auction.minPrice) %
      activeRules.auction.increment
    ) {
      setMessage(
        `Il prezzo deve salire di ${activeRules.auction.increment} crediti a partire da ${activeRules.auction.minPrice}.`,
      );
      return setMessageType("error");
    }
    const legalMax = legalMaxBid(team, activeRules);
    if (value > legalMax) {
      setMessage(
        `${team.name} puo spendere al massimo ${legalMax} crediti: deve conservarne ${Math.max(0, Object.values(slotsLeft(team, activeRules)).reduce((sum, count) => sum + count, 0) - 1) * activeRules.auction.reserve} per completare la rosa.`,
      );
      return setMessageType("error");
    }
    if (slotsLeft(team, activeRules)[player.ruolo] < 1) {
      setMessage(
        `${team.name} non ha piu posti per ${(ROLE_LABELS[player.ruolo] || player.ruolo).toLowerCase()}.`,
      );
      return setMessageType("error");
    }
    setState((s) => ({
      ...s,
      teams: s.teams.map((t, i) =>
        i === owner
          ? { ...t, credits: t.credits - value, roster: [...t.roster, player] }
          : t,
      ),
      assigned: {
        ...s.assigned,
        [playerIdKey(player.id)]: { owner, price: value },
      },
      history: [...s.history, { playerId: player.id, owner, price: value }],
      undone: [],
    }));
    setMessage(`${player.nome} assegnato a ${team.name} per ${value} crediti.`);
    setMessageType("success");
    setPlayer(null);
    setQuery("");
    setPrice("");
  };
  const undo = () => {
    const last = state.history.at(-1);
    if (!last) return;
    setState((s) => {
      const assigned = { ...s.assigned };
      delete assigned[playerIdKey(last.playerId)];
      return {
        ...s,
        assigned,
        history: s.history.slice(0, -1),
        undone: [...(s.undone || []), last],
        teams: s.teams.map((t, i) =>
          i === last.owner
            ? {
                ...t,
                credits: t.credits + last.price,
                roster: t.roster.filter(
                  (p) => playerIdKey(p.id) !== playerIdKey(last.playerId),
                ),
              }
            : t,
        ),
      };
    });
    setMessage(
      `Annullata l'assegnazione di ${data.players.find((p) => playerIdKey(p.id) === playerIdKey(last.playerId))?.nome || "giocatore"}.`,
    );
    setMessageType("info");
  };
  const redo = () => {
    const last = state.undone?.at(-1);
    if (!last) return;
    const team = state.teams[last.owner];
    const restoredPlayer = data.players.find(
      (p) => playerIdKey(p.id) === playerIdKey(last.playerId),
    );
    if (
      !restoredPlayer ||
      state.assigned[playerIdKey(last.playerId)] ||
      slotsLeft(team, activeRules)[restoredPlayer.ruolo] < 1 ||
      !isValidBid(last.price, team, activeRules)
    ) {
      setMessage(
        "Non posso ripristinare l'operazione: budget o slot sono cambiati.",
      );
      return setMessageType("error");
    }
    setState((s) => ({
      ...s,
      teams: s.teams.map((t, i) =>
        i === last.owner
          ? {
              ...t,
              credits: t.credits - last.price,
              roster: [...t.roster, restoredPlayer],
            }
          : t,
      ),
      assigned: {
        ...s.assigned,
        [playerIdKey(last.playerId)]: { owner: last.owner, price: last.price },
      },
      history: [...s.history, last],
      undone: s.undone.slice(0, -1),
    }));
    setMessage(`Ripristinata l'assegnazione di ${restoredPlayer.nome}.`);
    setMessageType("success");
  };
  const flushAuction = () => {
    if (
      !window.confirm(
        "Vuoi cancellare tutta l'asta salvata? L'operazione non puo essere annullata.",
      )
    )
      return;
    setState(emptyAuction(activeRules));
    setPlayer(null);
    setQuery("");
    setPrice("");
    setSuggestionsOpen(false);
    setMessage("Asta azzerata. Puoi impostare di nuovo i crediti iniziali.");
    setMessageType("success");
  };
  const exportXls = async () => {
    if (!state.history.length || isExporting) return;
    const season =
      data.meta?.profile?.season ||
      data.meta?.season ||
      activeRules.season ||
      "";
    const payload = buildExportPayload(state, {
      profileId: activeProfileId,
      season,
      roleBudgetPercentages: activeRules.auction?.roleBudgetPercentages,
    });
    if (!payload.season) {
      setMessage("Stagione profilo mancante: impossibile esportare.");
      setMessageType("error");
      return;
    }
    setIsExporting(true);
    setMessage("Preparazione export XLS...");
    setMessageType("info");
    try {
      const { blob, filename } = await requestAuctionExport(payload, { apiBase });
      triggerBlobDownload(blob, filename);
      setMessage(`Export pronto: ${filename}`);
      setMessageType("success");
    } catch (error) {
      setMessage(error?.message || "Export XLS non riuscito.");
      setMessageType("error");
    } finally {
      setIsExporting(false);
    }
  };
  const canSetStartingCredits =
    state.history.length === 0 && !state.undone?.length;
  const selectedLegalMax = legalMaxBid(state.teams[owner], activeRules);
  const updateStartingCredits = (teamIndex, value) => {
    const credits = Number(value);
    if (!Number.isInteger(credits) || credits < 25) return;
    setState((s) => ({
      ...s,
      teams: s.teams.map((team, index) =>
        index === teamIndex
          ? { ...team, startingCredits: credits, credits }
          : team,
      ),
    }));
  };
  return (
    <section className="data-view auction">
      <div className="view-heading">
        <span className="eyebrow">MODALITA OPERATIVA</span>
        <h1>Asta live</h1>
        <p>
          Un passaggio alla volta: scegli il giocatore, indica chi lo compra e
          conferma il prezzo.
        </p>
      </div>
      <div className="auction-owner">
        <label htmlFor="auction-user-team">La mia squadra</label>
        <select
          id="auction-user-team"
          value={userTeamIndex}
          onChange={(e) => {
            const nextIndex = Number(e.target.value);
            setUserTeamIndex(nextIndex);
            setOwner(nextIndex);
          }}
        >
          {state.teams.map((team, index) => (
            <option value={index} key={index}>
              {team.name}
            </option>
          ))}
        </select>
        <small>Usata per consigli, budget e riepilogo.</small>
      </div>
      <section className="auction-summary" aria-label="Stato della mia squadra">
        <div>
          <span>Crediti rimasti</span>
          <strong>{state.teams[userTeamIndex].credits}</strong>
          <small>per la tua squadra</small>
        </div>
        <div>
          <span>Giocatori presi</span>
          <strong>
            {state.teams[userTeamIndex].roster.length} /{" "}
            {Object.values(activeRules.rosterSlots).reduce(
              (sum, count) => sum + count,
              0,
            )}
          </strong>
          <small>
            {Object.entries(slotsLeft(state.teams[userTeamIndex], activeRules))
              .map(([role, count]) => `${role}${count}`)
              .join(" ")}{" "}
            posti
          </small>
        </div>
        <div>
          <span>Ultima azione</span>
          <strong>
            {state.history.length
              ? data.players.find(
                  (p) =>
                    playerIdKey(p.id) ===
                    playerIdKey(state.history.at(-1).playerId),
                )?.nome || "Giocatore"
              : "Nessuna"}
          </strong>
          <small>
            {state.history.length
              ? `${state.history.at(-1).price} crediti`
              : "Pronto per iniziare"}
          </small>
        </div>
      </section>
      <AuctionOverview overview={overviewAdvice} />
      <p
        className={`auction-status ${messageType}`}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
      {activeRole && (
        <p className="auction-status info" role="status">
          Fase attiva: {ROLE_LABELS[activeRole]}. Completa i posti di questo ruolo in tutte le rose per passare al successivo.
        </p>
      )}
      <div className="auction-bar">
        <div
          className="auction-search"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget))
              setSuggestionsOpen(false);
          }}
        >
          <label htmlFor="auction-player">Giocatore in asta</label>
          <input
            id="auction-player"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (player && activeRole && player.ruolo !== activeRole) setPlayer(null);
              setSuggestionsOpen(true);
            }}
            onFocus={() => setSuggestionsOpen(true)}
            onKeyDown={(e) => e.key === "Escape" && setSuggestionsOpen(false)}
            placeholder="Scrivi almeno 2 lettere"
            autoComplete="off"
            aria-describedby="auction-results"
          />
          {suggestionsOpen && query.length >= 2 && (
            <div className="auction-results" id="auction-results">
              <span>
                {choices.length
                  ? `${choices.length} giocatori trovati`
                  : "Nessun giocatore disponibile"}
              </span>
              {choices.map((p) => (
                <button
                  key={p.id}
                  onClick={() => selectPlayer(p)}
                  aria-label={`Seleziona ${p.nome}, ${p.ruolo}, ${p.squadra}`}
                >
                  <i className={"role " + p.ruolo}>{p.ruolo}</i>
                  <b>{p.nome}</b>
                  <small>
                    {p.squadra} · {p.fvm_scaled}
                  </small>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="auction-history">
          <button onClick={undo} disabled={!state.history.length}>
            Annulla ultima
          </button>
          <button onClick={redo} disabled={!state.undone?.length}>
            Ripristina
          </button>
          {state.history.length > 0 && (
            <button
              type="button"
              className="export-xls"
              onClick={exportXls}
              disabled={isExporting}
              aria-busy={isExporting || undefined}
            >
              {isExporting ? "Export in corso..." : "Esporta XLS"}
            </button>
          )}
          <button className="flush" onClick={flushAuction}>
            Flush asta
          </button>
        </div>
      </div>
      {player && (
        <section className="auction-advice">
          <div>
            <span className={"role " + player.ruolo}>{player.ruolo}</span>
            <h2>{player.nome}</h2>
            <p>
              {player.squadra} · {formatTier(player.guida_asta_fascia)}
            </p>
          </div>
          <div>
            <span>Prezzo max consigliato</span>
            <strong>{advice?.maxBid ?? "..."}</strong>
            <small>{advice?.utility || "Calcolo in corso"}</small>
          </div>
          <label className="auction-field auction-field--reserved-help">
            Squadra acquirente
            <select value={owner} onChange={(e) => setOwner(+e.target.value)}>
              {state.teams.map((t, i) => (
                <option value={i} key={i}>
                  {t.name} · {t.credits} cr.
                </option>
              ))}
            </select>
          </label>
          <label className="auction-field">
            Prezzo di acquisto (crediti)
            <input
              value={price}
              type="number"
              min={activeRules.auction.minPrice}
              max={selectedLegalMax}
              step={activeRules.auction.increment}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && assign()}
              placeholder="Prezzo"
              inputMode="numeric"
            />
            <small className="field-help">
              Massimo consentito: {selectedLegalMax}
            </small>
          </label>
          <div className="auction-actions">
            <button onClick={assign}>Conferma assegnazione</button>
            <button className="secondary" onClick={() => openPlayer(player)}>
              Vedi scheda
            </button>
            <button
              className="secondary"
              onClick={() => {
                setPlayer(null);
                setQuery("");
                setPrice("");
                setSuggestionsOpen(false);
                setMessage("Selezione annullata.");
                setMessageType("info");
              }}
            >
              Annulla
            </button>
          </div>
        </section>
      )}
      {player && advice && <AuctionStrategy advice={advice} />}
      <div className="auction-teams">
        {state.teams.map((team, i) => {
          const left = slotsLeft(team, activeRules),
            max = legalMaxBid(team, activeRules);
          return (
            <article key={i}>
              <label>
                Nome squadra
                <input
                  aria-label={`Nome squadra ${i + 1}`}
                  value={team.name}
                  onChange={(e) =>
                    setState((s) => ({
                      ...s,
                      teams: s.teams.map((t, j) =>
                        j === i ? { ...t, name: e.target.value } : t,
                      ),
                    }))
                  }
                />
              </label>
              {canSetStartingCredits ? (
                <label className="starting-credits">
                  Crediti iniziali
                  <input
                    type="number"
                    min="25"
                    step="1"
                    value={team.credits}
                    onChange={(e) => updateStartingCredits(i, e.target.value)}
                  />
                </label>
              ) : (
                <strong>
                  {team.credits}
                  <small> crediti rimasti</small>
                </strong>
              )}
              <p>
                Max bid {max} · P{left.P} D{left.D} C{left.C} A{left.A}
              </p>
              {team.roster.length ? (
                team.roster.map((p) => (
                  <button key={p.id} onClick={() => openPlayer(p)}>
                    <i className={"role " + p.ruolo}>{p.ruolo}</i>
                    {p.nome}
                    <em>{state.assigned[playerIdKey(p.id)]?.price}</em>
                  </button>
                ))
              ) : (
                <span className="empty-roster">Nessun giocatore</span>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
