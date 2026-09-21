// AIMoney API regression tests (F2 review queue, F5 closure rules, health §3,
// F3 cross-boundary cap agreement). In-memory D1 stub, no network.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { onRequest } from "./[[path]].js";
import { effectiveScore as workerEffectiveScore } from "../../worker/src/lib.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------- In-memory D1 stub (prepare().bind().all()/first()/run()) ----------
function makeDB(seed = {}) {
  const data = {
    opportunities: (seed.opportunities || []).map((o) => ({ ...o })),
    briefs: (seed.briefs || []).map((b) => ({ ...b })),
    experiments: (seed.experiments || []).map((e) => ({ ...e })),
    runs: (seed.runs || []).map((r) => ({ ...r })),
    signals: (seed.signals || []).map((s) => ({ ...s })),
  };

  function listOpportunities(sql, args) {
    const limit = Number(args[args.length - 1]) || 100;
    const filterArgs = args.slice(0, -1);
    let idx = 0;
    let status = null;
    let category = null;
    if (sql.includes("o.status = ?")) status = filterArgs[idx++];
    if (sql.includes("o.category = ?")) category = filterArgs[idx++];
    const whereAt = sql.indexOf("WHERE");
    const unreviewed = whereAt !== -1 && sql.slice(whereAt).includes("UNREVIEWED");
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
      needs_review: String(o.notes || "").includes("UNREVIEWED") ? 1 : 0,
      brief_first_steps: (() => { const bl = data.briefs.filter((b) => b.opportunity_id === o.id).sort((a, b) => (b.version || 0) - (a.version || 0)); return bl.length ? String(bl[0].first_steps ?? "").slice(0, 300) : null; })(),
      brief_summary: (() => { const bl = data.briefs.filter((b) => b.opportunity_id === o.id).sort((a, b) => (b.version || 0) - (a.version || 0)); return bl.length ? String(bl[0].summary ?? "").slice(0, 200) : null; })(),
      experiment_count: data.experiments.filter((e) => e.opportunity_id === o.id).length,
    }));
    return { results: rows };
  }

  // Emulates listExperiments: honors the JOIN type in the SQL (inner JOIN
  // drops dangling rows, LEFT JOIN keeps them with null opp fields),
  // status/opportunity filters, updated_at DESC order, LIMIT 100.
  function listExperiments(sql, args) {
    let idx = 0;
    let status = null;
    let opp = null;
    if (sql.includes("e.status = ?")) status = args[idx++];
    if (sql.includes("e.opportunity_id = ?")) opp = args[idx++];
    const leftJoin = sql.includes("LEFT JOIN");
    let rows = data.experiments.slice();
    if (status) rows = rows.filter((e) => e.status === status);
    if (opp) rows = rows.filter((e) => String(e.opportunity_id) === String(opp));
    rows.sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
    rows = rows.slice(0, 100).map((e) => {
      const o = data.opportunities.find((x) => String(x.id) === String(e.opportunity_id));
      return { ...e, opportunity_title: o ? o.title : null, opportunity_slug: o ? o.slug : null };
    });
    if (!leftJoin) rows = rows.filter((r) => r.opportunity_title !== null);
    return { results: rows };
  }

  function handleAll(sql, args) {
    if (sql.includes("FROM opportunities o")) return listOpportunities(sql, args);
    if (sql.includes("FROM experiments e")) return listExperiments(sql, args);
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
    if (sql.includes("UNREVIEWED") && sql.includes("MIN(created_at)")) {
      const unrev = data.opportunities.filter((o) => String(o.notes || "").includes("UNREVIEWED"));
      const oldest = unrev.length ? unrev.map((o) => String(o.created_at || "")).sort()[0] : null;
      return { n: unrev.length, oldest };
    }
    if (sql.includes("UNREVIEWED") && sql.includes("COUNT(*)")) {
      return { n: data.opportunities.filter((o) => String(o.notes || "").includes("UNREVIEWED")).length };
    }
    if (sql.includes("UNREVIEWED") && sql.includes("ORDER BY created_at")) {
      const unrev = data.opportunities
        .filter((o) => String(o.notes || "").includes("UNREVIEWED"))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id);
      return unrev[0] ? { created_at: unrev[0].created_at } : null;
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
    if (sql.includes("SUM(revenue_cents)") && sql.includes("SUM(spent_cents)") && !sql.includes("-7 days")) {
      let revenue = 0;
      let spent = 0;
      for (const e of data.experiments) {
        if (e.status !== "won" && e.status !== "lost") continue;
        revenue += (Number(e.revenue_cents) || 0);
        spent += (Number(e.spent_cents) || 0);
      }
      return { revenue, spent };
    }
    if (sql.includes("COUNT(*)") && sql.includes("SUM(revenue_cents)") && sql.includes("-7 days")) {
      const cutoff = Date.now() - 7 * 86400000;
      let n = 0;
      let total = 0;
      for (const e of data.experiments) {
        if (e.status !== "won" && e.status !== "lost") continue;
        const ms = Date.parse(e.ended_at || "");
        if (Number.isFinite(ms) && ms >= cutoff) { n++; total += (Number(e.revenue_cents) || 0); }
      }
      return { n, total };
    }
    if (sql.includes("FROM experiments") && sql.includes("SUM(revenue_cents)")) {
      const revenueLifetime = !sql.includes("-7 days");
      const cutoff = Date.now() - 7 * 86400000;
      let total = 0;
      for (const e of data.experiments) {
        if (e.status !== "won" && e.status !== "lost") continue;
        const ms = Date.parse(e.ended_at || "");
        if (revenueLifetime || (Number.isFinite(ms) && ms >= cutoff)) total += (Number(e.revenue_cents) || 0);
      }
      return { total };
    }
    if (sql.includes("FROM experiments") && sql.includes("SUM(spent_cents)")) {
      let total = 0;
      for (const e of data.experiments) {
        if (e.status !== "won" && e.status !== "lost") continue;
        total += (Number(e.spent_cents) || 0);
      }
      return { total };
    }
    if (sql.includes("FROM experiments") && sql.includes("ended_at") && sql.includes("COUNT(*)")) {
      const cutoff = Date.now() - 7 * 86400000;
      let n = 0;
      for (const e of data.experiments) {
        if (e.status !== "won" && e.status !== "lost") continue;
        const ms = Date.parse(e.ended_at || "");
        if (Number.isFinite(ms) && ms >= cutoff) n++;
      }
      return { n };
    }
    if (sql.includes("FROM signals") && sql.includes("COUNT(*)")) {
      const cutoffArg = Date.parse(args[0] || "");
      const cutoff = Number.isFinite(cutoffArg) ? cutoffArg : Date.now() - 86400000;
      let n = 0;
      for (const s of data.signals) {
        if (Number(s.processed) !== 1) continue;
        if (s.opportunity_id !== null && s.opportunity_id !== undefined) continue;
        const ms = Date.parse(s.created_at || "");
        if (Number.isFinite(ms) && ms >= cutoff) n++;
      }
      return { n };
    }
    if (sql.includes("vetted]%") && sql.includes("NOT EXISTS")) {
      const withExp = new Set(data.experiments.map((e) => String(e.opportunity_id)));
      return { n: data.opportunities.filter((o) => String(o.notes || "").includes("vetted]") && !withExp.has(String(o.id))).length };
    }
    if (sql.includes("vetted]%") && /\[\d{4}-\d{2}-\d{2} vetted\]/.test(sql)) {
      // Tag-date vetted count: emulate each inlined [YYYY-MM-DD vetted] LIKE.
      const days = [...sql.matchAll(/\[(\d{4}-\d{2}-\d{2}) vetted\]/g)].map((m) => `[${m[1]} vetted]`);
      return { n: data.opportunities.filter((o) => days.some((d) => String(o.notes || "").includes(d))).length };
    }
    // Legacy updated_at shape (production now inlines the tag dates above).
    if (sql.includes("vetted]%") && sql.includes("COUNT(*)")) {
      const cutoff = Date.now() - 7 * 86400000;
      let n = 0;
      for (const o of data.opportunities) {
        if (!String(o.notes || "").includes("vetted]")) continue;
        const ms = Date.parse(o.updated_at || "");
        if (Number.isFinite(ms) && ms >= cutoff) n++;
      }
      return { n };
    }
    return null;
  }

  function handleRun(sql, args) {
    if (sql.includes("INSERT INTO experiments")) {
      const [opportunity_id, name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem, revenue_cents, spent_cents, revenue_source] = args;
      const id = data.experiments.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0) + 1;
      const now = new Date().toISOString();
      data.experiments.push({ id, opportunity_id, name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem, revenue_cents: revenue_cents || 0, spent_cents: spent_cents || 0, revenue_source: revenue_source || "", created_at: now, updated_at: now });
      return { success: true, meta: { last_row_id: id } };
    }
    if (sql.includes("INSERT INTO opportunities")) {
      const fields = ["slug", "title", "one_liner", "category", "status", "value", "effort", "confidence", "fit", "est_monthly_low", "est_monthly_high", "time_to_first_dollar", "capital_needed", "skills_needed", "source", "source_url", "notes"];
      const row = { id: data.opportunities.reduce((m, o) => Math.max(m, Number(o.id) || 0), 0) + 1 };
      fields.forEach((f, i) => { row[f] = args[i]; });
      row.score = args[fields.length];
      const now = new Date().toISOString();
      row.created_at = now; row.updated_at = now;
      data.opportunities.push(row);
      return { success: true, meta: { last_row_id: row.id } };
    }
    if (sql.includes("UPDATE experiments SET")) {
      const [name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem, revenue_cents, spent_cents, revenue_source, id] = args;
      const row = data.experiments.find((e) => String(e.id) === String(id));
      if (row) {
        Object.assign(row, { name, hypothesis, status, budget_cap, spent, metric, target, result, started_at, ended_at, post_mortem, revenue_cents, spent_cents, revenue_source });
      }
      return { success: true };
    }
    if (sql.includes("UPDATE opportunities SET notes = substr")) {
      const [addition, id] = args;
      const row = data.opportunities.find((o) => String(o.id) === String(id));
      if (row) {
        const combined = String(row.notes || "") + String(addition || "");
        row.notes = combined.length <= 8000 ? combined : combined.slice(-8000);
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
    async batch(stmts) {
      db._batchCalls = (db._batchCalls || 0) + 1;
      return (stmts || []).map((s) => {
        const sql = (s && s._sql) || "";
        const args = (s && s._args) || [];
        if (sql.includes("GROUP BY status")) return handleAll(sql, args);
        const row = handleFirst(sql, args);
        return { results: row ? [row] : [] };
      });
    },
    prepare(sql) {
      (db._prepared = db._prepared || []).push(sql);
      const stmt = {
        _sql: sql,
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

describe("create guards (round3 Task 1)", () => {
  it("POST /experiments 400s on invalid status with a field-level reason", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "X", status: "bogus" } }, db);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "status");
    assert.equal(db.data.experiments.length, 0);
  });

  it("POST /experiments 404s on unknown opportunity_id", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 999, name: "Orphan" } }, db);
    assert.equal(r.status, 404);
    assert.equal(db.data.experiments.length, 0);
  });

  it("POST /experiments mirrors PATCH closure rules for won/lost", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const noResult = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "X", status: "won", post_mortem: "pm" } }, db);
    assert.equal(noResult.status, 400);
    assert.ok(noResult.body.fields && noResult.body.fields.result);
    const noPm = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "X", status: "lost", result: "r" } }, db);
    assert.equal(noPm.status, 400);
    assert.ok(noPm.body.fields && noPm.body.fields.post_mortem);
    assert.equal(db.data.experiments.length, 0);
  });

  it("POST /experiments happy paths stamp started_at/ended_at like PATCH", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const running = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "R", status: "running" } }, db);
    assert.equal(running.status, 201);
    assert.ok(running.body.id);
    const won = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "W", status: "won", result: "made $", post_mortem: "worked" } }, db);
    assert.equal(won.status, 201);
    const byId = Object.fromEntries(db.data.experiments.map((e) => [e.id, e]));
    assert.ok(byId[running.body.id].started_at);
    assert.equal(byId[running.body.id].ended_at, "");
    assert.ok(byId[won.body.id].ended_at);
    const planned = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "P" } }, db);
    assert.equal(planned.status, 201);
    assert.equal(db.data.experiments.find((e) => e.id === planned.body.id).status, "planned");
  });

  it("POST /opportunities 400s when est_monthly_low > est_monthly_high", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities",
      { method: "POST", token: "secret", body: { slug: "bad-range", title: "Bad range", est_monthly_low: 5000, est_monthly_high: 500 } }, db);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "est_monthly_low");
    assert.equal(db.data.opportunities.length, 3);
    const ok = await callApi(["opportunities"], "http://localhost/api/opportunities",
      { method: "POST", token: "secret", body: { slug: "good-range", title: "Good range", est_monthly_low: 500, est_monthly_high: 5000 } }, db);
    assert.equal(ok.status, 201);
    assert.equal(db.data.opportunities.length, 4);
  });
});

describe("vetted without experiment (round3 Task 2)", () => {
  it("reports vetted_no_experiment from existing columns", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "a", title: "A", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "x\n[2026-09-18 vetted] Human vetted; cap lifted.", created_at: daysAgo(10), updated_at: daysAgo(2) },
        { id: 2, slug: "b", title: "B", status: "testing", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "y\n[2026-09-18 vetted] Human vetted; cap lifted.", created_at: daysAgo(10), updated_at: daysAgo(2) },
        { id: 3, slug: "c", title: "C", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "Agent proposal  vetted] but never an experiment", created_at: daysAgo(1), updated_at: daysAgo(1) },
        { id: 4, slug: "d", title: "D", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "Agent proposal UNREVIEWED", created_at: daysAgo(1), updated_at: daysAgo(1) },
      ],
      experiments: [
        { id: 1, opportunity_id: 2, name: "E", status: "running" },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.vetted_no_experiment, 2);
  });
});

describe("closed-experiment outcomes (round3 Task 3)", () => {
  const opp = () => ([
    { id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ]);
  const exp = (over = {}) => ([
    { id: 1, opportunity_id: 1, name: "Landing test", hypothesis: "", status: "running", budget_cap: "", spent: "", metric: "", target: "", result: "", started_at: "2026-09-01T00:00:00Z", ended_at: "", post_mortem: "", ...over },
  ]);

  it("PATCH to won appends a one-line outcome to parent notes, score untouched", async () => {
    const db = makeDB({ opportunities: opp(), experiments: exp() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "12 signups in 7d", post_mortem: "headline worked" } }, db);
    assert.equal(r.status, 200);
    const row = db.data.opportunities[0];
    assert.equal(row.score, 7000);
    assert.equal(row.notes.split("\n").length, 2);
    assert.ok(row.notes.includes('outcome] Experiment "Landing test" won: 12 signups in 7d'));
  });

  it("PATCH to lost collapses multi-line results to one line", async () => {
    const db = makeDB({ opportunities: opp(), experiments: exp() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "zero sales\nad account banned", post_mortem: "wrong channel" } }, db);
    assert.equal(r.status, 200);
    const row = db.data.opportunities[0];
    assert.equal(row.score, 7000);
    assert.ok(row.notes.includes('outcome] Experiment "Landing test" lost: zero sales ad account banned'));
  });

  it("editing an already-closed row appends nothing", async () => {
    const db = makeDB({
      opportunities: opp(),
      experiments: exp({ status: "won", result: "old", post_mortem: "old pm", ended_at: "2026-09-10T00:00:00Z" }),
    });
    const before = db.data.opportunities[0].notes;
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { result: "updated result" } }, db);
    assert.equal(r.status, 200);
    assert.equal(db.data.opportunities[0].notes, before);
  });

  it("closing an orphaned experiment still succeeds without a parent row", async () => {
    const db = makeDB({
      opportunities: opp(),
      experiments: exp({ opportunity_id: 999 }),
    });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "r", post_mortem: "pm" } }, db);
    assert.equal(r.status, 200);
    assert.equal(db.data.opportunities[0].notes, "seed notes");
  });

  it("one-click rescore PATCHes value/confidence through the shared scorer", async () => {
    const db = makeDB({ opportunities: opp(), experiments: exp() });
    const r = await callApi(["opportunities", "1"], "http://localhost/api/opportunities/1",
      { method: "PATCH", token: "secret", body: { value: 8, confidence: 6 } }, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.score, 9600);
  });
});

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

describe("experiment age + backlog age (round1 Task 1)", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

  it("adds days_in_status from the status reference timestamp", async () => {
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "s", title: "Seed one", status: "backlog", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "", created_at: daysAgo(30), updated_at: daysAgo(30) },
      ],
      experiments: [
        { id: 1, opportunity_id: 1, name: "stale planned", status: "planned", created_at: daysAgo(21), updated_at: daysAgo(21), started_at: "", ended_at: "" },
        { id: 2, opportunity_id: 1, name: "fresh planned", status: "planned", created_at: daysAgo(1), updated_at: daysAgo(1), started_at: "", ended_at: "" },
        { id: 3, opportunity_id: 1, name: "running", status: "running", created_at: daysAgo(10), updated_at: daysAgo(1), started_at: daysAgo(5), ended_at: "" },
        { id: 4, opportunity_id: 1, name: "won", status: "won", created_at: daysAgo(40), updated_at: daysAgo(2), started_at: daysAgo(30), ended_at: daysAgo(2), result: "r", post_mortem: "pm" },
      ],
    });
    const r = await callApi(["experiments"], "http://localhost/api/experiments", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.experiments.map((e) => [e.id, e]));
    assert.equal(byId[1].days_in_status, 21);
    assert.equal(byId[2].days_in_status, 1);
    assert.equal(byId[3].days_in_status, 5);
    assert.equal(byId[4].days_in_status, 2);
  });

  it("reports oldest_unreviewed_age_h on /api/health, null when queue empty", async () => {
    const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "a", title: "A", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "UNREVIEWED", created_at: hoursAgo(50), updated_at: hoursAgo(50) },
        { id: 2, slug: "b", title: "B", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "UNREVIEWED", created_at: hoursAgo(5), updated_at: hoursAgo(5) },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.unreviewed, 2);
    assert.ok(Math.abs(r.body.oldest_unreviewed_age_h - 50) < 0.5);
    const empty = makeDB({ opportunities: [] });
    const r2 = await callApi(["health"], "http://localhost/api/health", {}, empty);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.oldest_unreviewed_age_h, null);
  });
});

describe("orphaned experiments (round1 Task 3)", () => {
  it("keeps dangling rows via LEFT JOIN with orphaned:true", async () => {
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "s", title: "Seed one", status: "backlog", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      ],
      experiments: [
        { id: 9, opportunity_id: 999, name: "Orphan", status: "running", created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-06T00:00:00Z", started_at: "2026-01-06T00:00:00Z", ended_at: "" },
        { id: 10, opportunity_id: 1, name: "Linked", status: "planned", created_at: "2026-01-05T00:00:00Z", updated_at: "2026-01-05T00:00:00Z", started_at: "", ended_at: "" },
      ],
    });
    const r = await callApi(["experiments"], "http://localhost/api/experiments", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.experiments.map((e) => [e.id, e]));
    assert.equal(byId[9].orphaned, true);
    assert.equal(byId[9].opportunity_title, null);
    assert.equal(byId[10].orphaned, false);
    assert.equal(byId[10].opportunity_title, "Seed one");
  });
});

describe("decisions/week + vetted rate (round2 Task 1)", () => {
  it("counts decisions_last_7d from won/lost closed in 7d", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: daysAgo(2) },
        { id: 2, opportunity_id: 1, status: "lost", ended_at: daysAgo(6) },
        { id: 3, opportunity_id: 1, status: "won", ended_at: daysAgo(10) },
        { id: 4, opportunity_id: 1, status: "running", ended_at: "" },
        { id: 5, opportunity_id: 1, status: "lost", ended_at: "" },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.decisions_last_7d, 2);
  });

  it("counts vetted_last_7d from [date vetted] tags in the last 7 calendar days", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "a", title: "A", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "x [" + daysAgo(1).slice(0, 10) + " vetted] Human vetted; cap lifted.", created_at: daysAgo(10), updated_at: daysAgo(1) },
        { id: 2, slug: "b", title: "B", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "y [" + daysAgo(30).slice(0, 10) + " vetted] Human vetted; cap lifted.", created_at: daysAgo(40), updated_at: daysAgo(1) },
        { id: 4, slug: "d", title: "D", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "w [" + daysAgo(8).slice(0, 10) + " vetted] Human vetted; cap lifted.", created_at: daysAgo(20), updated_at: daysAgo(8) },
        { id: 5, slug: "e", title: "E", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "v [" + daysAgo(0).slice(0, 10) + " vetted] Human vetted; cap lifted.", created_at: daysAgo(1), updated_at: daysAgo(0) },
        { id: 3, slug: "c", title: "C", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "Agent proposal \u2014 UNREVIEWED", created_at: daysAgo(1), updated_at: daysAgo(1) },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.vetted_last_7d, 2);
  });

  it("keeps every existing health key for verify.sh", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    for (const k of ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "time"]) {
      assert.ok(k in r.body, `health missing ${k}`);
    }
    assert.equal(typeof r.body.decisions_last_7d, "number");
    assert.equal(typeof r.body.vetted_last_7d, "number");
  });
});

describe("create-update-gaps", () => {
  it("patch range guard works", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities", "1"], "http://localhost/api/opportunities/1", { method: "PATCH", token: "secret", body: { est_monthly_low: 5000, est_monthly_high: 500 } }, db);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "est_monthly_low");
  });
  it("patch status guard works", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities", "1"], "http://localhost/api/opportunities/1", { method: "PATCH", token: "secret", body: { status: "bogus" } }, db);
    assert.equal(r.status, 400);
    assert.equal(r.body.field, "status");
  });
  it("brief parent guard works", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["briefs"], "http://localhost/api/briefs", { method: "POST", token: "secret", body: { opportunity_id: 999, summary: "x" } }, db);
    assert.equal(r.status, 404);
    assert.equal(r.body.field, "opportunity_id");
  });
  it("ledger on create works", async () => {
    const db = makeDB({ opportunities: [{ id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
    const r = await callApi(["experiments"], "http://localhost/api/experiments", { method: "POST", token: "secret", body: { opportunity_id: 1, name: "W", status: "won", result: "made cash", post_mortem: "worked" } }, db);
    assert.equal(r.status, 201);
    const row = db.data.opportunities[0];
    assert.equal(row.score, 7000);
    assert.ok(row.notes.includes("outcome] Experiment"));
    assert.ok(row.notes.includes("W"));
    assert.ok(row.notes.includes("won: made cash"));
  });
});

describe("triage noise (Task 3)", () => {
  it("reports noise_24h from processed signals with no parent in 24h", async () => {
    const hoursAgo = (n) => new Date(Date.now() - n * 3600000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      signals: [
        { id: 1, processed: 1, opportunity_id: null, created_at: hoursAgo(2) },
        { id: 2, processed: 1, opportunity_id: null, created_at: hoursAgo(20) },
        { id: 3, processed: 1, opportunity_id: null, created_at: hoursAgo(30) },
        { id: 4, processed: 1, opportunity_id: 1, created_at: hoursAgo(2) },
        { id: 5, processed: 0, opportunity_id: null, created_at: hoursAgo(2) },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.noise_24h, 2);
  });
  it("keeps every existing health key alongside noise_24h", async () => {
    const db = makeDB({ opportunities: oppSeed(), signals: [] });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    for (const k of ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "time"]) {
      assert.ok(k in r.body, "health missing " + k);
    }
  });
});

describe("detail-view cap agreement (Task 2)", () => {
  it("GET /api/opportunities/:id returns the capped effective score, stored row untouched", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const detail = await callApi(["opportunities", "2"], "http://localhost/api/opportunities/2", {}, db);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.opportunity.score, 6000);
    const list = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    const listed = list.body.opportunities.find((o) => o.id === 2);
    assert.equal(detail.body.opportunity.score, listed.score);
    assert.equal(db.data.opportunities.find((o) => o.id === 2).score, 17500);
  });

  it("leaves reviewed detail scores untouched", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const detail = await callApi(["opportunities", "1"], "http://localhost/api/opportunities/1", {}, db);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.opportunity.score, 16000);
  });

  it("404s on unknown detail id", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities", "999"], "http://localhost/api/opportunities/999", {}, db);
    assert.equal(r.status, 404);
  });
});

describe("experiment revenue/spend cents (audit 2026-09-20 Task 4)", () => {
  it("POST /experiments stores revenue_cents/spent_cents, defaulting 0", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Paid pilot", revenue_cents: 50000, spent_cents: 1200 } }, db);
    assert.equal(r.status, 201);
    const row = db.data.experiments.find((e) => e.id === r.body.id);
    assert.equal(row.revenue_cents, 50000);
    assert.equal(row.spent_cents, 1200);
    const dflt = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "No money yet" } }, db);
    assert.equal(dflt.status, 201);
    const row2 = db.data.experiments.find((e) => e.id === dflt.body.id);
    assert.equal(row2.revenue_cents, 0);
    assert.equal(row2.spent_cents, 0);
  });

  it("POST /experiments clamps bad cents to 0 instead of storing NaN/negatives", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Bad cents", revenue_cents: -500, spent_cents: "bogus" } }, db);
    assert.equal(r.status, 201);
    const row = db.data.experiments.find((e) => e.id === r.body.id);
    assert.equal(row.revenue_cents, 0);
    assert.equal(row.spent_cents, 0);
  });

  it("PATCH /experiments updates cents and clamps like create", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { revenue_cents: 9999, spent_cents: 100 } }, db);
    assert.equal(r.status, 200);
    assert.equal(db.data.experiments[0].revenue_cents, 9999);
    assert.equal(db.data.experiments[0].spent_cents, 100);
    const bad = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { revenue_cents: -1, spent_cents: "x" } }, db);
    assert.equal(bad.status, 200);
    assert.equal(db.data.experiments[0].revenue_cents, 0);
    assert.equal(db.data.experiments[0].spent_cents, 0);
  });

  it("reports revenue_last_7d summed from won/lost closed in 7d", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: daysAgo(2), revenue_cents: 50000 },
        { id: 2, opportunity_id: 1, status: "lost", ended_at: daysAgo(6), revenue_cents: 700 },
        { id: 3, opportunity_id: 1, status: "won", ended_at: daysAgo(10), revenue_cents: 99999 },
        { id: 4, opportunity_id: 1, status: "running", ended_at: "", revenue_cents: 12345 },
        { id: 5, opportunity_id: 1, status: "lost", ended_at: "", revenue_cents: 111 },
        { id: 6, opportunity_id: 1, status: "won", ended_at: daysAgo(1) },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.revenue_last_7d, 50700);
  });

  it("keeps revenue_last_7d alongside every existing health key", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    for (const k of ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "revenue_last_7d", "time"]) {
      assert.ok(k in r.body, "health missing " + k);
    }
    assert.equal(r.body.revenue_last_7d, 0);
  });
});

describe("review brief excerpt (audit 2026-09-20-round1 Task 2)", () => {
  it("list SQL selects the latest brief first_steps per row", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "[[path]].js"), "utf8");
    assert.ok(src.includes("AS brief_first_steps"), "listOpportunities lost the brief excerpt subquery");
    assert.ok(src.includes("ORDER BY b.version DESC LIMIT 1"), "excerpt must take the latest brief version");
  });

  it("returns the excerpt, null when the row has no brief", async () => {
    const db = makeDB({
      opportunities: oppSeed(),
      briefs: [
        { id: 1, opportunity_id: 2, version: 1, first_steps: "1. Old step" },
        { id: 2, opportunity_id: 2, version: 2, first_steps: "1. New step\n2. More" },
      ],
    });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities?unreviewed=1&sort=oldest", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].brief_first_steps, "1. New step\n2. More");
    assert.equal(byId[3].brief_first_steps, null);
  });

  it("leaves ledger order, scoring, and writes untouched", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    assert.deepEqual(r.body.opportunities.map((o) => o.id), [1, 2, 3]);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].score, 6000);
    assert.equal(byId[1].score, 16000);
  });
});

describe("one-click Start (audit 2026-09-20-round1 Task 3)", () => {
  it("PATCH planned→running stamps started_at with one click", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "running" } }, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "running");
    assert.equal(db.data.experiments[0].status, "running");
    assert.ok(db.data.experiments[0].started_at);
  });

  it("401s without the admin token, row untouched", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", body: { status: "running" } }, db);
    assert.equal(r.status, 401);
    assert.equal(db.data.experiments[0].status, "planned");
  });

  it("won/lost still require result + post-mortem", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "made $" } }, db);
    assert.equal(r.status, 400);
    assert.ok(r.body.fields && r.body.fields.post_mortem);
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

describe("closed-experiment money in ledger (audit 2026-09-20-round3 Task 1)", () => {
  const oppMoney = () => ([
    { id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  ]);
  const expMoney = (over = {}) => ([
    { id: 1, opportunity_id: 1, name: "Landing test", hypothesis: "", status: "running", budget_cap: "", spent: "", metric: "", target: "", result: "", started_at: "2026-09-01T00:00:00Z", ended_at: "", post_mortem: "", revenue_cents: 0, spent_cents: 0, ...over },
  ]);

  it("PATCH close appends $X rev / $Y spent from cents, score untouched", async () => {
    const db = makeDB({ opportunities: oppMoney(), experiments: expMoney() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "12 signups in 7d", post_mortem: "headline worked", revenue_cents: 50000, spent_cents: 1250 } }, db);
    assert.equal(r.status, 200);
    const row = db.data.opportunities[0];
    assert.equal(row.score, 7000);
    assert.ok(row.notes.includes('outcome] Experiment "Landing test" won: 12 signups in 7d ($500.00 rev / $12.50 spent)'));
  });

  it("POST close appends $X rev / $Y spent, zero defaults to $0.00", async () => {
    const db = makeDB({ opportunities: oppMoney() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "W", status: "won", result: "made cash", post_mortem: "worked", revenue_cents: 1050, spent_cents: 0 } }, db);
    assert.equal(r.status, 201);
    const row = db.data.opportunities[0];
    assert.ok(row.notes.includes('outcome] Experiment "W" won: made cash ($10.50 rev / $0.00 spent)'));
    const db2 = makeDB({ opportunities: oppMoney() });
    const r2 = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Z", status: "lost", result: "no sales", post_mortem: "wrong channel" } }, db2);
    assert.equal(r2.status, 201);
    assert.ok(db2.data.opportunities[0].notes.includes('outcome] Experiment "Z" lost: no sales ($0.00 rev / $0.00 spent)'));
  });

  it("editing a closed row still appends nothing", async () => {
    const db = makeDB({
      opportunities: oppMoney(),
      experiments: expMoney({ status: "won", result: "old", post_mortem: "old pm", ended_at: "2026-09-10T00:00:00Z", revenue_cents: 100, spent_cents: 50 }),
    });
    const before = db.data.opportunities[0].notes;
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { result: "updated" } }, db);
    assert.equal(r.status, 200);
    assert.equal(db.data.opportunities[0].notes, before);
  });
});

describe("review brief summary (audit 2026-09-20-round1 Task 1)", () => {
  it("list SQL selects the latest brief summary excerpt per row", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "[[path]].js"), "utf8");
    assert.ok(src.includes("AS brief_summary"), "listOpportunities lost the brief summary subquery");
    assert.ok(src.includes("substr(b.summary, 1, 200)"), "summary excerpt must truncate to ~200 chars in SQL");
    assert.ok(src.includes("ORDER BY b.version DESC LIMIT 1"), "excerpt must take the latest brief version");
  });

  it("returns the summary excerpt, null when the row has no brief", async () => {
    const db = makeDB({
      opportunities: oppSeed(),
      briefs: [
        { id: 1, opportunity_id: 2, version: 1, summary: "Old summary", first_steps: "1. Old step" },
        { id: 2, opportunity_id: 2, version: 2, summary: "New summary", first_steps: "1. New step" },
      ],
    });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities?unreviewed=1&sort=oldest", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].brief_summary, "New summary");
    assert.equal(byId[3].brief_summary, null);
  });

  it("truncates long summaries to 200 chars like the SQL substr", async () => {
    const db = makeDB({
      opportunities: oppSeed(),
      briefs: [{ id: 1, opportunity_id: 2, version: 1, summary: "x".repeat(250), first_steps: "" }],
    });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    assert.equal(r.status, 200);
    const row = r.body.opportunities.find((o) => o.id === 2);
    assert.equal(row.brief_summary.length, 200);
  });

  it("leaves ledger order, scoring, and writes untouched", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    assert.deepEqual(r.body.opportunities.map((o) => o.id), [1, 2, 3]);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].score, 6000);
    assert.equal(byId[1].score, 16000);
  });
});

describe("lifetime revenue/spend totals (audit 2026-09-20-round1 Task 3)", () => {
  it("reports revenue_total/spent_total over all won/lost, no date bound", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: daysAgo(2), revenue_cents: 50000, spent_cents: 1200 },
        { id: 2, opportunity_id: 1, status: "lost", ended_at: daysAgo(6), revenue_cents: 700, spent_cents: 300 },
        { id: 3, opportunity_id: 1, status: "won", ended_at: daysAgo(10), revenue_cents: 99999, spent_cents: 5000 },
        { id: 4, opportunity_id: 1, status: "running", ended_at: "", revenue_cents: 12345, spent_cents: 999 },
        { id: 5, opportunity_id: 1, status: "lost", ended_at: "", revenue_cents: 111, spent_cents: 11 },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.revenue_total, 150810);
    assert.equal(r.body.spent_total, 6511);
  });

  it("keeps the weekly revenue figure unchanged", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: daysAgo(2), revenue_cents: 50000 },
        { id: 3, opportunity_id: 1, status: "won", ended_at: daysAgo(10), revenue_cents: 99999 },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.revenue_last_7d, 50000);
    assert.equal(r.body.revenue_total, 149999);
  });

  it("keeps lifetime totals alongside every existing health key", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    for (const k of ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "revenue_last_7d", "revenue_total", "spent_total", "time"]) {
      assert.ok(k in r.body, "health missing " + k);
    }
    assert.equal(r.body.revenue_total, 0);
    assert.equal(r.body.spent_total, 0);
  });
});

describe("experiment revenue source (audit 2026-09-20-round2 Task 3)", () => {
  it("POST /experiments stores revenue_source, defaulting '' and truncating to 120", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Paid pilot", revenue_cents: 50000, revenue_source: "Stripe" } }, db);
    assert.equal(r.status, 201);
    assert.equal(db.data.experiments.find((e) => e.id === r.body.id).revenue_source, "Stripe");
    const dflt = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "No source yet" } }, db);
    assert.equal(dflt.status, 201);
    assert.equal(db.data.experiments.find((e) => e.id === dflt.body.id).revenue_source, "");
    const long = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Long source", revenue_source: "x".repeat(200) } }, db);
    assert.equal(long.status, 201);
    assert.equal(db.data.experiments.find((e) => e.id === long.body.id).revenue_source, "x".repeat(120));
  });

  it("PATCH /experiments updates revenue_source, truncates, and defaults '' on legacy rows", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { revenue_source: "Gumroad" } }, db);
    assert.equal(r.status, 200);
    assert.equal(db.data.experiments[0].revenue_source, "Gumroad");
    const long = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { revenue_source: "y".repeat(200) } }, db);
    assert.equal(long.status, 200);
    assert.equal(db.data.experiments[0].revenue_source, "y".repeat(120));
    // Legacy row without the key (pre-migration read): an unrelated PATCH defaults it to ''.
    const db2 = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const untouched = await callApi(["experiments", "2"], "http://localhost/api/experiments/2",
      { method: "PATCH", token: "secret", body: { target: "10 replies" } }, db2);
    assert.equal(untouched.status, 200);
    assert.equal(db2.data.experiments[1].revenue_source, "");
  });

  it("POST close carries via {source} in the ledger; empty source renders unchanged", async () => {
    const db = makeDB({ opportunities: [{ id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
    const r = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "W", status: "won", result: "made cash", post_mortem: "worked", revenue_cents: 50000, spent_cents: 1250, revenue_source: "Stripe" } }, db);
    assert.equal(r.status, 201);
    assert.ok(db.data.opportunities[0].notes.includes('outcome] Experiment "W" won: made cash ($500.00 rev / $12.50 spent via Stripe)'));
    const db2 = makeDB({ opportunities: [{ id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] });
    const r2 = await callApi(["experiments"], "http://localhost/api/experiments",
      { method: "POST", token: "secret", body: { opportunity_id: 1, name: "Z", status: "lost", result: "no sales", post_mortem: "wrong channel" } }, db2);
    assert.equal(r2.status, 201);
    assert.ok(db2.data.opportunities[0].notes.includes('outcome] Experiment "Z" lost: no sales ($0.00 rev / $0.00 spent)'));
    assert.ok(!db2.data.opportunities[0].notes.includes("via "), "empty source must leave the ledger line unchanged");
  });

  it("PATCH close carries via {source}; editing a closed row still appends nothing", async () => {
    const db = makeDB({
      opportunities: [{ id: 1, slug: "a", title: "A", status: "testing", value: 7, effort: 3, confidence: 5, fit: 8, score: 7000, notes: "seed notes", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }],
      experiments: [{ id: 1, opportunity_id: 1, name: "Landing test", hypothesis: "", status: "running", budget_cap: "", spent: "", metric: "", target: "", result: "", started_at: "2026-09-01T00:00:00Z", ended_at: "", post_mortem: "", revenue_cents: 0, spent_cents: 0 }],
    });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "12 signups in 7d", post_mortem: "headline worked", revenue_cents: 1050, revenue_source: "PayPal" } }, db);
    assert.equal(r.status, 200);
    assert.ok(db.data.opportunities[0].notes.includes('outcome] Experiment "Landing test" won: 12 signups in 7d ($10.50 rev / $0.00 spent via PayPal)'));
    const before = db.data.opportunities[0].notes;
    const edit = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { result: "updated" } }, db);
    assert.equal(edit.status, 200);
    assert.equal(db.data.opportunities[0].notes, before);
  });

  it("closure gate unchanged: won/lost still require result + post-mortem", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "won", result: "made $", revenue_source: "Stripe" } }, db);
    assert.equal(r.status, 400);
    assert.ok(r.body.fields && r.body.fields.post_mortem);
  });
});

describe("health batch + rev cache (audit 2026-09-20-round2 Task 2)", () => {
  it("answers health from a single batch of merged selects", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(db._batchCalls, 1, "health must issue exactly one DB.batch");
    const prepared = db._prepared || [];
    assert.equal(prepared.length, 10, `health must prepare 10 statements, got ${prepared.length}`);
    assert.ok(prepared.some((s) => s.includes("COUNT(*)") && s.includes("SUM(revenue_cents)") && s.includes("-7 days")), "decisions+revenue must merge to one scan");
    assert.ok(prepared.some((s) => s.includes("SUM(revenue_cents)") && s.includes("SUM(spent_cents)")), "lifetime totals must merge to one scan");
    assert.ok(prepared.some((s) => s.includes("UNREVIEWED") && s.includes("MIN(created_at)")), "unreviewed count+oldest must merge to one scan");
  });

  it("keeps every health key byte-identical (order included) for verify.sh", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body), ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "revenue_last_7d", "revenue_total", "spent_total", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "time"]);
  });

  it("reports merged figures identical to the old per-query math", async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const db = makeDB({
      opportunities: [
        { id: 1, slug: "a", title: "A", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "UNREVIEWED", created_at: daysAgo(6), updated_at: daysAgo(6) },
        { id: 2, slug: "b", title: "B", status: "researching", value: 5, effort: 5, confidence: 5, fit: 5, score: 1, notes: "UNREVIEWED", created_at: daysAgo(2), updated_at: daysAgo(2) },
      ],
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: daysAgo(2), revenue_cents: 50000, spent_cents: 1200 },
        { id: 2, opportunity_id: 1, status: "lost", ended_at: daysAgo(10), revenue_cents: 700, spent_cents: 300 },
      ],
    });
    const r = await callApi(["health"], "http://localhost/api/health", {}, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.unreviewed, 2);
    assert.ok(Math.abs(r.body.oldest_unreviewed_age_h - 144) < 1, `oldest age wrong: ${r.body.oldest_unreviewed_age_h}`);
    assert.equal(r.body.decisions_last_7d, 1);
    assert.equal(r.body.revenue_last_7d, 50000);
    assert.equal(r.body.revenue_total, 50700);
    assert.equal(r.body.spent_total, 1500);
  });

  it("fetches release.json once per deploy and reuses the revision", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ revision: "test-rev-batch" }) }; };
    try {
      const db = makeDB({ opportunities: oppSeed() });
      const first = await callApi(["health"], "http://localhost/api/health", {}, db);
      const second = await callApi(["health"], "http://localhost/api/health", {}, db);
      assert.equal(first.body.rev, "test-rev-batch");
      assert.equal(second.body.rev, "test-rev-batch");
      assert.equal(calls, 1, "release.json must be fetched once, then cached");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("list needs_review bit + excerpt cap (audit 2026-09-20-round3 Task 2)", () => {
  it("list SQL selects the bit and a 300-char excerpt, not full notes", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "[[path]].js"), "utf8");
    assert.ok(src.includes("(o.notes LIKE '%UNREVIEWED%') AS needs_review"), "list lost the needs_review bit");
    assert.ok(src.includes("substr(b.first_steps, 1, 300)"), "list lost the 300-char excerpt cap");
    assert.ok(!src.includes("SELECT o.*,"), "list still selects full rows (notes) per tap");
  });

  it("list rows carry needs_review and no notes; scores still cap", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].needs_review, 1);
    assert.equal(byId[1].needs_review, 0);
    assert.ok(!("notes" in byId[2]), "list row still ships full notes");
    assert.equal(byId[2].score, 6000);
    assert.equal(byId[1].score, 16000);
    assert.deepEqual(r.body.opportunities.map((o) => o.id), [1, 2, 3]);
  });

  it("long excerpts arrive capped at 300 chars; detail still serves full notes", async () => {
    const db = makeDB({
      opportunities: oppSeed(),
      briefs: [{ id: 1, opportunity_id: 2, version: 1, first_steps: "x".repeat(2000) }],
    });
    const r = await callApi(["opportunities"], "http://localhost/api/opportunities?unreviewed=1&sort=oldest", {}, db);
    assert.equal(r.status, 200);
    const byId = Object.fromEntries(r.body.opportunities.map((o) => [o.id, o]));
    assert.equal(byId[2].brief_first_steps.length, 300);
    const d = await callApi(["opportunities", "2"], "http://localhost/api/opportunities/2", {}, db);
    assert.equal(d.status, 200);
    assert.ok(String(d.body.opportunity.notes).includes("UNREVIEWED"), "detail lost the full notes writers append to");
  });
});

describe("health outage honesty (audit 2026-09-20-round2 Task 1)", () => {
  const COUNT_KEYS = ["opportunities", "unreviewed", "bare_without_brief", "decisions_last_7d", "revenue_last_7d", "revenue_total", "spent_total", "vetted_last_7d", "vetted_no_experiment", "noise_24h"];
  // Total outage: the batch AND every individual statement fail, so the
  // isolation fallback finds zero answering probes (a batch-only throw now
  // recovers via the per-probe re-run below).
  const downDB = () => {
    const db = makeDB({ opportunities: oppSeed() });
    return {
      ...db,
      batch: async () => { throw new Error("D1 down"); },
      prepare: (sql) => {
        const stmt = {
          _sql: sql,
          _args: [],
          bind(...a) { stmt._args = a; return stmt; },
          all: async () => { throw new Error("D1 down"); },
          first: async () => { throw new Error("D1 down"); },
          run: async () => { throw new Error("D1 down"); },
        };
        return stmt;
      },
    };
  };

  it("total outage returns HTTP 200 with ok:false, db down, and null counters", async () => {
    const r = await callApi(["health"], "http://localhost/api/health", {}, downDB());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.db, "down");
    for (const k of COUNT_KEYS) {
      assert.equal(r.body[k], null, `health ${k} must be null during a DB outage, not 0`);
    }
    assert.deepEqual(r.body.experiments_by_status, {});
    assert.deepEqual(Object.keys(r.body), ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "revenue_last_7d", "revenue_total", "spent_total", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "time"]);
  });

  it("unchanged verify.sh ok:true grep fails the outage payload, passes the healthy one", async () => {
    const up = await callApi(["health"], "http://localhost/api/health", {}, makeDB({ opportunities: oppSeed() }));
    assert.ok(JSON.stringify(up.body).includes('"ok":true'), "healthy payload must keep the verify.sh marker");
    const down = await callApi(["health"], "http://localhost/api/health", {}, downDB());
    assert.ok(!JSON.stringify(down.body).includes('"ok":true'), "outage payload must fail the unchanged verify.sh grep");
  });

  it("dashboard typeof-guards each health count it renders (no client change)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "app.js"), "utf8");
    for (const k of ["decisions_last_7d", "vetted_last_7d", "vetted_no_experiment", "revenue_last_7d", "revenue_total", "noise_24h"]) {
      assert.ok(src.includes(`typeof state.health.${k} === "number"`), `dashboard lost its typeof guard for ${k}`);
    }
    assert.ok(src.includes("state.health.oldest_unreviewed_age_h"), "dashboard lost its oldest-age consumer");
    assert.ok(src.includes('if (typeof h === "number" && Number.isFinite(h))'), "dashboard lost the oldest-age typeof guard");
    assert.ok(src.includes("state.health.bare_without_brief"), "dashboard lost its bare-count consumer");
    assert.ok(src.includes('(typeof n === "number" && Number.isFinite(n))'), "dashboard lost the bare-count typeof guard");
  });
});

describe("health probe isolation (audit 2026-09-20-round1 Task 1)", () => {
  // One bad probe (the lifetime-totals SELECT, as on live when the revenue
  // migration never applied): the batch rejects and that statement fails
  // individually too, while the other nine answer.
  const oneBadProbeDB = () => {
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: new Date().toISOString(), revenue_cents: 50000, spent_cents: 1200 },
      ],
    });
    const realPrepare = db.prepare.bind(db);
    return {
      ...db,
      batch: async () => { throw new Error("no such column: revenue_cents"); },
      prepare: (sql) => {
        const stmt = realPrepare(sql);
        if (sql.includes("SUM(spent_cents)") && !sql.includes("-7 days")) {
          stmt.all = async () => { throw new Error("no such column: spent_cents"); };
          stmt.first = async () => { throw new Error("no such column: spent_cents"); };
        }
        return stmt;
      },
    };
  };

  it("failed batch with nine answering probes reports their numbers, db up", async () => {
    const r = await callApi(["health"], "http://localhost/api/health", {}, oneBadProbeDB());
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.db, "up");
    assert.equal(r.body.opportunities, 3);
    assert.equal(r.body.unreviewed, 2);
    assert.equal(r.body.bare_without_brief, 3);
    assert.deepEqual(r.body.experiments_by_status, { won: 1 });
    assert.equal(r.body.decisions_last_7d, 1);
    assert.equal(r.body.revenue_last_7d, 50000);
    assert.equal(r.body.vetted_last_7d, 0);
    assert.equal(r.body.vetted_no_experiment, 0);
    assert.equal(r.body.noise_24h, 0);
    assert.equal(r.body.revenue_total, null);
    assert.equal(r.body.spent_total, null);
  });

  it("names the failing probe, keeps existing keys byte-identical for verify.sh", async () => {
    const r = await callApi(["health"], "http://localhost/api/health", {}, oneBadProbeDB());
    assert.deepEqual(r.body.health_probe_failures, ["revenue_lifetime"]);
    assert.deepEqual(Object.keys(r.body), ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "revenue_last_7d", "revenue_total", "spent_total", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "time", "health_probe_failures"]);
    assert.ok(JSON.stringify(r.body).includes('"ok":true'), "partial payload must keep the verify.sh marker");
  });

  it("db reads up when the database answers even if the count probe itself fails", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const realPrepare = db.prepare.bind(db);
    const probe0Down = {
      ...db,
      batch: async () => { throw new Error("probe 0 bad"); },
      prepare: (sql) => {
        const stmt = realPrepare(sql);
        if (sql.includes("COUNT(*)") && sql.includes("FROM opportunities") && !sql.includes("WHERE")) {
          stmt.first = async () => { throw new Error("probe 0 bad"); };
        }
        return stmt;
      },
    };
    const r = await callApi(["health"], "http://localhost/api/health", {}, probe0Down);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.db, "up");
    assert.equal(r.body.opportunities, null);
    assert.equal(r.body.unreviewed, 2);
    assert.deepEqual(r.body.health_probe_failures, ["opportunities"]);
  });

  it("spurious batch rejection with all probes answering attaches no failures key", async () => {
    const db = makeDB({
      opportunities: oppSeed(),
      experiments: [
        { id: 1, opportunity_id: 1, status: "won", ended_at: new Date().toISOString(), revenue_cents: 50000, spent_cents: 1200 },
      ],
    });
    const flakyBatch = { ...db, batch: async () => { throw new Error("spurious batch reject"); } };
    const r = await callApi(["health"], "http://localhost/api/health", {}, flakyBatch);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.db, "up");
    assert.ok(!("health_probe_failures" in r.body), "a batch that rejects spuriously must not attach an empty failures key");
    assert.deepEqual(Object.keys(r.body), ["ok", "rev", "db", "opportunities", "unreviewed", "bare_without_brief", "experiments_by_status", "hours_since_last_ok_run", "oldest_unreviewed_age_h", "decisions_last_7d", "revenue_last_7d", "revenue_total", "spent_total", "vetted_last_7d", "vetted_no_experiment", "noise_24h", "time"]);
    assert.equal(r.body.opportunities, 3);
    assert.equal(r.body.unreviewed, 2);
    assert.equal(r.body.decisions_last_7d, 1);
    assert.equal(r.body.revenue_last_7d, 50000);
    assert.equal(r.body.revenue_total, 50000);
    assert.equal(r.body.spent_total, 1200);
  });
});

describe("vetted tag-date SELECT (audit 2026-09-20-round2 Task 2)", () => {
  it("emits one vetted SELECT OR-matching the last 7 calendar days, no updated_at", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    await callApi(["health"], "http://localhost/api/health", {}, db);
    const vetted = (db._prepared || []).filter((s) => s.includes("vetted]%") && !s.includes("NOT EXISTS"));
    assert.equal(vetted.length, 1, "health must carry exactly one vetted-7d SELECT");
    assert.ok(!vetted[0].includes("updated_at"), "vetted-7d must not key on updated_at");
    const days = [...vetted[0].matchAll(/\[(\d{4}-\d{2}-\d{2}) vetted\]/g)].map((m) => m[1]);
    assert.equal(days.length, 7, `vetted SELECT must inline 7 day tags, got ${days.length}`);
    const expect = [];
    for (let i = 0; i < 7; i++) expect.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    assert.deepEqual(days, expect);
  });
});

describe("one-click Lose (audit 2026-09-20-round2 Task 2)", () => {
  it("PATCH to lost with one line as result + post-mortem closes and stamps ended_at", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "2/10 replies, 0 pilots", post_mortem: "2/10 replies, 0 pilots" } }, db);
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "lost");
    assert.equal(db.data.experiments[0].status, "lost");
    assert.ok(db.data.experiments[0].ended_at);
  });

  it("401s without the admin token, row untouched", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const r = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", body: { status: "lost", result: "x", post_mortem: "x" } }, db);
    assert.equal(r.status, 401);
    assert.equal(db.data.experiments[0].status, "planned");
    assert.equal(db.data.experiments[0].ended_at, "");
  });

  it("closure gate unchanged: empty result or post-mortem still 400s, row untouched", async () => {
    const db = makeDB({ opportunities: oppSeed(), experiments: expSeed() });
    const noResult = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "  ", post_mortem: "pm" } }, db);
    assert.equal(noResult.status, 400);
    assert.ok(noResult.body.fields && noResult.body.fields.result);
    const noPm = await callApi(["experiments", "1"], "http://localhost/api/experiments/1",
      { method: "PATCH", token: "secret", body: { status: "lost", result: "r", post_mortem: "" } }, db);
    assert.equal(noPm.status, 400);
    assert.ok(noPm.body.fields && noPm.body.fields.post_mortem);
    assert.equal(db.data.experiments[0].status, "planned");
    assert.equal(db.data.experiments[0].ended_at, "");
  });
});

describe("opportunity update bounds (audit 2026-09-20-round1 Task 4)", () => {
  it("PATCH truncates oversized strings exactly like create", async () => {
    const db = makeDB({ opportunities: oppSeed() });
    const seen = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = realPrepare(sql);
      if (sql.includes("UPDATE opportunities SET") && !sql.includes("substr")) {
        const realBind = stmt.bind.bind(stmt);
        stmt.bind = (...a) => { seen.push(a); return realBind(...a); };
      }
      return stmt;
    };
    const r = await callApi(["opportunities", "1"], "http://localhost/api/opportunities/1",
      {
        method: "PATCH",
        token: "secret",
        body: {
          title: "t".repeat(300), one_liner: "o".repeat(600), category: "c".repeat(50),
          time_to_first_dollar: "w".repeat(200), capital_needed: "m".repeat(200),
          source: "s".repeat(50), source_url: "u".repeat(600), notes: "n".repeat(9000),
        },
      }, db);
    assert.equal(r.status, 200);
    assert.equal(seen.length, 1);
    const args = seen[0];
    assert.equal(args[0].length, 200);
    assert.equal(args[1].length, 500);
    assert.equal(args[2].length, 40);
    assert.equal(args[11].length, 120);
    assert.equal(args[12].length, 120);
    assert.equal(args[14].length, 40);
    assert.equal(args[15].length, 500);
    assert.equal(args[16].length, 8000);
  });
});
