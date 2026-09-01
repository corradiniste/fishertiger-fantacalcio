/** Startup / switch UI for multiple saved league profiles. */

export function ProfilePicker({
  entries,
  suggestedId,
  busyId,
  error,
  onSelect,
  onCreateNew,
}) {
  return (
    <main className="app-shell profile-picker-shell">
      <section className="profile-picker" aria-labelledby="profile-picker-title">
        <p className="profile-picker-kicker">I tuoi fantacalci</p>
        <h1 id="profile-picker-title">Con quale lega lavori?</h1>
        <p className="profile-picker-lead">
          Ogni profilo ha regole, calendario, dataset e asta separati. Puoi
          cambiare lega in qualsiasi momento dall&apos;header.
        </p>
        {error ? (
          <p className="profile-error" role="alert">
            {error}
          </p>
        ) : null}
        {entries.length === 0 ? (
          <p className="profile-picker-empty">
            Nessun profilo salvato. Creane uno nuovo per iniziare.
          </p>
        ) : (
          <ul className="profile-picker-list">
            {entries.map((entry) => {
              const active = entry.id === suggestedId;
              const loading = busyId === entry.id;
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={
                      active
                        ? "profile-picker-item is-suggested"
                        : "profile-picker-item"
                    }
                    onClick={() => onSelect(entry.id)}
                    disabled={Boolean(busyId)}
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="profile-picker-item-name">
                      {entry.name || entry.id}
                    </span>
                    <span className="profile-picker-item-id">{entry.id}</span>
                    <span className="profile-picker-item-action">
                      {loading ? "Apertura…" : active ? "Continua" : "Apri"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button
          type="button"
          className="profile-picker-create"
          onClick={onCreateNew}
          disabled={Boolean(busyId)}
        >
          Nuovo fantacalcio
        </button>
      </section>
    </main>
  );
}

export function ProfileSwitcher({
  entries,
  activeId,
  disabled,
  onChange,
  onOpenPicker,
}) {
  if (!entries.length) return null;
  return (
    <label className="profile-switcher">
      <span className="profile-switcher-label">Lega</span>
      <select
        value={activeId || ""}
        disabled={disabled}
        aria-label="Cambia fantacalcio attivo"
        onChange={(event) => {
          const next = event.target.value;
          if (next === "__picker__") {
            onOpenPicker?.();
            return;
          }
          if (next && next !== activeId) onChange(next);
        }}
      >
        {entries.map((entry) => (
          <option key={entry.id} value={entry.id} title={entry.id}>
            {entry.name || entry.id}
          </option>
        ))}
        <option value="__picker__">Tutte le leghe…</option>
      </select>
    </label>
  );
}
