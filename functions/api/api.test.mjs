// AIMoney API regression tests (F2 review queue, F5 closure rules, health §3,
// F3 cross-boundary cap agreement). In-memory D1 stub, no network.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "./[[path]].js";
import { effectiveScore as workerEffectiveScore } from "../../worker/src/lib.js";

// ---------- In-memory D1 stub (prepare().bind().all()/first()/run()) ----------
function makeDB(seed = {}) {
  const data = {
    opportunities: (seed.opportunities || []).map((o) => ({ ...o })),
    briefs: (seed.briefs || []).map((b) => ({ ...b })),
    experiments: (seed.experiments || []).map((e) => ({ ...e })),
    runs: (seed.runs || []).map((r) => ({ ...r })),
  };

  function listOpportunities(sql, args) {
    const limit = Number(args[args.length - 1]) || 100;
    const filterArgs = args.slice(0, -1);
    let idx = 0;
    let status = null;
    let category = null;
    if (sql.includes("o.status = ?")) status = filterArgs[idx++];
    if (sql.includes("o.category = ?")) category = filterArgs[idx++];
    const unreviewed = sql.includes("UNREVIEWED");
    let rows = data.opportunities.slice();
    if (status) rows = rows.filter((o) => o.status === status);
    if (category) rows = rows.filter((o) => o.category === category);
    if (unreviewed) rows = rows.filter((o) => String(o.notes || "").includes("UNREVIEWED"));
    if (sql.includes("o.created_at ASC")) {
      rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
    } else if (sql.includes("o.value DESC")) {
      rows.sort((a, b) => (b.value - a.value) || (b.score - a.score));
    } else if (sql.includes("o.score DESC")) {
      rows.sort((a, b) => (b.score - a.score) || String(b.updated_at).localeCompare(String(a.updated_at)));
    } else if (sql.includes("o.updated_at DESC")) {
      rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    rows = rows.slice(0, limit).map((o) => ({
      ...o,
      brief_count: data.briefs.filter((b) => b.opportunity_id === o.id).length,
      experiment_count: data.experiments.filter((e) => e.opportunity_id === o.id).length,
    }));
    return { results: rows };
  }

  function handleAll(sql, args) {
    if (sql.includes("FROM opportunities o")) return listOpportunities(sql, args);
    if (sql.includes("FROM experiments") && sql.includes("GROUP BY status")) {
      const counts = {};
      for (const e of data.experiments) counts[e.status] = (counts[e.status] || 0) + 1;
      return { results: Object.entries(counts).map(([status, n]) => ({ status, n })) };
    }
    if (sql.includes("FROM agent_runs")) {
      const limit = Number(args[0]) || 20;
      const rows = data.runs.slice().sort((a, b) => b.id - a.id).slice(0, limit);
      return { results: rows };
    }
    return { results: [] };
  }

  function handleFirst(sql, args) {
    if (sql.includes("b.id IS NULL")) {
      const briefed = new Set(data.briefs.map((b) => b.opportunity_id));
      return { n: data.opportunities.filter((o) => !briefed.has(o.id)).length };
    }
    if (sql.includes("UNREVIEWED") && sql.includes("COUNT(*)")) {
      return { n: data.opportunities.filter((o) => String(o.notes || "").includes("UNREVIEWED")).length };
    }
    if (sql.includes("COUNT(*)") && sql.includes("FROM opportunities") && !sql.includes("WHERE")) {
      return { n: data.opportunities.length };
    }
    if (sql.includes("FROM experiments WHERE id = ?")) {
      return data.experiments.find((e) => String(e.id) === String(args[0])) || null;
    }
    if (sql.includes("FROM opportunities WHERE id = ?")) {
      return data.opportunities.find((o) => String(o.id) === String(args[0])) || null;
    }
    if (sql.includes("FROM agent_runs") && sql.includes("status='ok'")) {
      const oks = data.runs.filter((r) => r.status === "ok").sort((a, b) => b.id - a.id);
      return oks[0] || null;
    }
    return null;
  }

  function handleRun(sql, args) {
    if (sql.includes("UPDATE experiments SET")) {
      const [name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem, id] = args;
      const row = data.experiments.find((e) => String(e.id) === String(id));
      if (row) {
        Object.assign(row, { name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem });
      }
      return { success: true };
    }
    if (sql.includes("UPDATE opportunities SET")) {
      return { success: true };
    }
    return { success: true };
  }

  const db = {
    data,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...a) { stmt._args = a; return stmt; },
        async all() { return handleAll(sql, stmt._args); },
        async first() { return handleFirst(sql, stmt._args); },
        async run() { return handleRun(sql, stmt._args); },
      };
      return stmt;
    },
  };
  return db;
}

async function callApi(pathParts, url, { method = "GET", token = null, body = undefined } = {}, db) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined && method !== "GET" && method !== "HEAD") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const request = new Request(url, init);
  const env = { DB: db, ADMIN_TOKEN: "secret", RESEARCH_WORKER_URL: "" };
  const res = await onRequest({ request, env, params: { path: pathParts } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

function oppSeed() {
  return [
    { id: 1, slug: "seed-one", title: "Seed one", one_liner: "", category: "services", status: "backlog", value: 8, effort: 3, confidence: 8, fit: 10, score: 16000, notes: "human seed", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
    { id: 2, slug: "agent-high", title: "Agent high", one_liner: "", category: "saas", status: "researching", value: 7, effort: 1, confidence: 5, fit: 10, score: 17500, notes: "Agent proposal — UNREVIEWED, scores capped", created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
    { id: 3, slug: "agent-low", title: "Agent low", one_liner: "", category: "other", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 2083.3, notes: "foo UNREVIEWED bar", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
  ];
}

function expSeed() {
  return [
    { id: 1, opportunity_id: 1, name: "E1", hypothesis: "", status: "planned", budget_cap: "", spent: "", metric: "", target: "", result: "", started_at: "", ended_at: "", post_mortem: "" },
    { id: 2, opportunity_id: 1, name: "E2", hypothesis: "", status: "planned", budget_cap: "", spent: "", metric: "", target: "", result: "", started_at: "2026-01-01T00:00:00Z", ended_at: "", post_mortem: "" },
  ];
}

describe("review queue (F2)", () => {
  it("filters UNREVIEWED rows", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities?unreviewed=1", {}, db);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.opportunities.map((o) => o.id).sort(), [2, 3]);
  });

  it("sorts oldest-first", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities?unreviewed=1&sort=oldest", {}, db);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.opportunities.map((o) => o.id), [3, 2]);
  });

  it("caps UNREVIEWED scores via the shared worker function (F3)", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    // Stored 17500, effective 6000 — matches worker/src/lib.js directly.
    assert.equal(byId[2].score, 6000);
    assert.equal(byId[2].score, workerEffectiveScore({ value: 7, effort: 1, confidence: 5, fit: 10, notes: "UNREVIEWED" }));
    assert.equal(byId[1].score, 16000);
    // Honest ranking: reviewed top pick outranks capped proposals.
    assert.deepEqual(r.body.opportunities.map((o) => o.id), [1, 2, 3]);
  });
});

describe("experiment closure rules (F5)", () => {
  it("400s when closing without result", async () => {
    const db = makeDB({ experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", post_mortem: "pm" } }, db);
    assert.equal(r.status, 400);
    assert.ok(r.body.fields && r.body.fields.result);
  });

  it("400s when closing without post_mortem", async () => {
    const db = makeDB({ experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "r" } }, db);
    assert.equal(r.status, 400);
    assert.ok(r.body.fields && r.body.fields.post_mortem);
  });

  it("400s on invalid status with a field-level reason", async () => {
    const db = makeDB({ experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "bogus" } }, db);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "status");
  });

  it("happy path stamps ended_at on won", async () => {
    const db = makeDB({ experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "made $", post_mortem: "worked" } }, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "won");
    assert.ok(db.data.experiments[0].ended_at);
  });

  it("stamps started_at on running when absent, keeps it when present", async () => {
    const db = makeDB({ experiments: expSeed() });
    const r1 = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "running" } }, db);
    assert.equal(r1.status, 200);
    assert.ok(db.data.experiments[0].started_at);
    const r2 = await callApi(["experiments", "2"], "http://localhost/api/experiments/2",
      { method: "PATCH", token: "secret", body: { status: "running" } }, db);
    assert.equal(r2.status, 200);
    assert.equal(db.data.experiments[1].started_at, "2026-01-01T00:00:00Z");
  });
});

describe("health (G4)", () => {
  it("reports backlog and freshness fields", async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      briefs: [{ id: 1, opportunity_id: 1 }],
      experiments: [
        { id: 1, opportunity_id: 1, status: "planned" },
        { id: 2, opportunity_id: 1, status: "running" },
      ],
      runs: [
        { id: 1, status: "ok", finished_at: twoHoursAgo, started_at: twoHoursAgo },
        { id: 2, status: "error", finished_at: "", started_at: twoHoursAgo },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.unreviewed, 2);
    assert.equal(r.body.bare_without_brief, 2);
    assert.deepEqual(r.body.experiments_by_status, { planned: 1, running: 1 });
    assert.ok(typeof r.body.hours_since_last_ok_run === "number");
    assert.ok(Math.abs(r.body.hours_since_last_ok_run - 2) < 0.3);
  });

  it("leaves /api/meta unchanged", async () => {
    const db = makeDB({});
    const r = await callApi(["meta"], "http://localhost/api/meta", {}, db);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["scoring", "worker_url", "writes_enabled"]);
  });
});
