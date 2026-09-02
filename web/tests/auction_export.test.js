import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExportPayload,
  filenameFromDisposition,
  normalizeExportSeason,
  parseExportError,
  requestAuctionExport,
  triggerBlobDownload,
} from "../src/auction-export.js";

const sampleState = {
  teams: [
    { name: "Alpha", startingCredits: 750, credits: 700, roster: [] },
    { name: "Beta", startingCredits: 500, credits: 500, roster: [] },
  ],
  history: [
    { playerId: 11, owner: 0, price: 50 },
    { playerId: 22, owner: 1, price: 12 },
  ],
  assigned: {},
  undone: [],
};

test("normalizeExportSeason converts slash seasons", () => {
  assert.equal(normalizeExportSeason("2026/27"), "2026-27");
  assert.equal(normalizeExportSeason("2026-27"), "2026-27");
  assert.equal(normalizeExportSeason(""), "");
});

test("buildExportPayload normalizes camelCase auction state", () => {
  const payload = buildExportPayload(sampleState, {
    profileId: "my-team",
    season: "2026/27",
    roleBudgetPercentages: { P: 7, D: 18, C: 25, A: 50 },
  });
  assert.deepEqual(payload, {
    profile_id: "my-team",
    season: "2026-27",
    teams: [
      { name: "Alpha", starting_credits: 750 },
      { name: "Beta", starting_credits: 500 },
    ],
    history: [
      { player_id: 11, owner: 0, price: 50 },
      { player_id: 22, owner: 1, price: 12 },
    ],
    role_budget_percentages: { P: 7, D: 18, C: 25, A: 50 },
    custom_players: [],
  });
});

test("buildExportPayload includes custom players", () => {
  const payload = buildExportPayload(
    {
      ...sampleState,
      customPlayers: [
        { id: -1, nome: "Rossi Mario", ruolo: "A", squadra: "Roma" },
      ],
    },
    { profileId: "my-team", season: "2026-27" },
  );
  assert.deepEqual(payload.custom_players, [
    { id: -1, nome: "Rossi Mario", ruolo: "A", squadra: "Roma" },
  ]);
});

test("filenameFromDisposition reads attachment name", () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="colpi_asta_x.xlsx"', "fallback.xlsx"),
    "colpi_asta_x.xlsx",
  );
  assert.equal(filenameFromDisposition(null, "fallback.xlsx"), "fallback.xlsx");
});

test("parseExportError prefers structured API message", async () => {
  const response = {
    json: async () => ({ error: { code: "auction_data_missing", message: "Genera i dati." } }),
  };
  assert.equal(await parseExportError(response), "Genera i dati.");
});

test("requestAuctionExport posts payload and returns blob", async () => {
  const calls = [];
  const blob = new Blob(["PK"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      headers: {
        get: (name) =>
          name === "Content-Disposition" ? 'attachment; filename="colpi_asta_my-team.xlsx"' : null,
      },
      blob: async () => blob,
    };
  };
  const payload = buildExportPayload(sampleState, {
    profileId: "my-team",
    season: "2026-27",
  });
  const result = await requestAuctionExport(payload, {
    apiBase: "http://127.0.0.1:8000",
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/auction/export");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), payload);
  assert.equal(result.filename, "colpi_asta_my-team.xlsx");
  assert.equal(result.blob, blob);
});

test("requestAuctionExport surfaces API errors", async () => {
  const fetchImpl = async () => ({
    ok: false,
    json: async () => ({ error: { message: "Genera i dati prima di esportare i colpi." } }),
  });
  await assert.rejects(
    () => requestAuctionExport({ profile_id: "x" }, { fetchImpl }),
    /Genera i dati prima/,
  );
});

test("triggerBlobDownload creates object URL and clicks anchor", () => {
  const clicks = [];
  const revoked = [];
  const created = [];
  const anchor = {
    href: "",
    download: "",
    rel: "",
    click() {
      clicks.push(this.download);
    },
    remove() {},
  };
  const documentRef = {
    createElement(tag) {
      assert.equal(tag, "a");
      return anchor;
    },
    body: { appendChild() {} },
  };
  const urlApi = {
    createObjectURL(blob) {
      created.push(blob);
      return "blob:mock";
    },
    revokeObjectURL(href) {
      revoked.push(href);
    },
  };
  triggerBlobDownload(new Blob(["PK"]), "out.xlsx", { documentRef, urlApi });
  assert.equal(anchor.href, "blob:mock");
  assert.deepEqual(clicks, ["out.xlsx"]);
  assert.equal(created.length, 1);
});
