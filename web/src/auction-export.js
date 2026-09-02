import { serializeAuction } from "./auction-state.js";
import { apiUrl } from "./profile-client.js";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Normalize season tokens like 2026/27 → 2026-27 for dataset paths. */
export const normalizeExportSeason = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace("/", "-");
};

/**
 * Build the POST /api/auction/export JSON body from live auction state.
 * Normalizes camelCase auction storage into the snake_case API contract.
 */
export const buildExportPayload = (state, { profileId, season, roleBudgetPercentages } = {}) => {
  const serialized = serializeAuction(state);
  const budgets = isObject(roleBudgetPercentages) ? roleBudgetPercentages : undefined;
  return {
    profile_id: String(profileId ?? "default"),
    season: normalizeExportSeason(season),
    teams: serialized.teams.map((team) => ({
      name: team.name,
      starting_credits: team.startingCredits,
    })),
    history: serialized.history.map((item) => ({
      player_id: item.playerId,
      owner: item.owner,
      price: item.price,
    })),
    ...(budgets ? { role_budget_percentages: budgets } : {}),
  };
};

export const parseExportError = async (response) => {
  const fallback = "Export XLS non riuscito.";
  try {
    const body = await response.json();
    if (typeof body?.error === "string") return body.detail || body.error || fallback;
    if (isObject(body?.error)) return body.error.message || body.error.code || fallback;
    return fallback;
  } catch {
    return fallback;
  }
};

export const filenameFromDisposition = (header, fallback) => {
  const match = /filename\*?=(?:UTF-8''|")?([^\";]+)"?/i.exec(String(header || ""));
  if (!match) return fallback;
  try {
    return decodeURIComponent(match[1].trim());
  } catch {
    return match[1].trim() || fallback;
  }
};

/** POST auction snapshot → XLSX blob + suggested filename. */
export const requestAuctionExport = async (payload, { apiBase = "", fetchImpl = globalThis.fetch } = {}) => {
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch non disponibile.");
  }
  let response;
  try {
    response = await fetchImpl(apiUrl("/api/auction/export", apiBase), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    const error = new Error("Rete non raggiungibile per l'export.");
    error.cause = cause;
    throw error;
  }
  if (!response.ok) {
    throw new Error(await parseExportError(response));
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(
    response.headers.get("Content-Disposition"),
    `colpi_asta_${payload.profile_id || "asta"}.xlsx`,
  );
  return { blob, filename };
};

/** Trigger a browser download for the export blob. */
export const triggerBlobDownload = (blob, filename, { documentRef = globalThis.document, urlApi = globalThis.URL } = {}) => {
  if (!documentRef || !urlApi?.createObjectURL) {
    throw new Error("Download non supportato in questo ambiente.");
  }
  const href = urlApi.createObjectURL(blob);
  const anchor = documentRef.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = "noopener";
  documentRef.body?.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke after the click pipeline has a chance to start.
  setTimeout(() => urlApi.revokeObjectURL(href), 0);
};
