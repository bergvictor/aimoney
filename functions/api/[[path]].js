// AIMoney Lab API — Pages Functions catch-all router (D1 backend).
// Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

import { effectiveScore } from "../../worker/src/lib.js";

const clamp10 = (v, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(10, Math.max(1, Math.round(n)));
};

// effectiveScore shared via worker/src/lib.js (F3); scoreOf deduped (F6).
// (local duplicate removed; see import above)

function authed(request, env) {
  const want = (env.ADMIN_TOKEN || "").trim();
  if (!want) return { ok: false, reason: "writes disabled (ADMIN_TOKEN not set)" };
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!got || got.length !== want.length) return { ok: false, reason: "bad token" };
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0 ? { ok: true } : { ok: false, reason: "bad token" };
}

const OPP_FIELDS = ["slug", "title", "one_liner", "category", "status", "value",
  "effort", "confidence", "fit", "est_monthly_low", "est_monthly_high",
  "time_to_first_dollar", "capital_needed", "skills_needed", "source",
  "source_url", "notes"];

const OPP_STATUSES = new Set(["backlog", "researching", "testing", "scaling", "paused", "killed"]);
const EXP_STATUSES = new Set(["planned", "running", "won", "lost", "paused"]);

async function listOpportunities(env, url) {
  const status = url.searchParams.get("status") || "";
  const category = url.searchParams.get("category") || "";
  const sort = url.searchParams.get("sort") || "score";
  const unreviewedOnly = url.searchParams.get("unreviewed") === "1";
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const where = [];
  const args = [];
  if (status && OPP_STATUSES.has(status)) { where.push("o.status = ?"); args.push(status); }
  if (category) { where.push("o.category = ?"); args.push(category); }
  if (unreviewedOnly) { where.push("o.notes LIKE '%UNREVIEWED%'"); }
  const order = sort === "updated" ? "o.updated_at DESC" :
    sort === "oldest" ? "o.created_at ASC, o.id ASC" :
    sort === "value" ? "o.value DESC, o.score DESC" : "o.score DESC, o.updated_at DESC";
  const rows = await env.DB.prepare(
    `SELECT o.*,
       (SELECT COUNT(*) FROM briefs b WHERE b.opportunity_id = o.id) AS brief_count,
       (SELECT COUNT(*) FROM experiments e WHERE e.opportunity_id = o.id) AS experiment_count
     FROM opportunities o
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${order} LIMIT ?`
  ).bind(...args, limit).all();
  const capped = (rows.results || []).map((r) => ({ ...r, score: effectiveScore(r) }));
  if (sort === "score") {
    capped.sort((a, b) => (b.score - a.score) || String(b.updated_at).localeCompare(String(a.updated_at)));
  }
  return json({ opportunities: capped });
}

async function getOpportunity(env, id) {
  const row = await env.DB.prepare("SELECT * FROM opportunities WHERE id = ?")
    .bind(id).first();
  if (!row) return json({ error: "not found" }, 404);
  const briefs = await env.DB.prepare(
    "SELECT * FROM briefs WHERE opportunity_id = ? ORDER BY version DESC LIMIT 5")
    .bind(id).all();
  const experiments = await env.DB.prepare(
    "SELECT * FROM experiments WHERE opportunity_id = ? ORDER BY updated_at DESC")
    .bind(id).all();
  return json({ opportunity: { ...row, score: effectiveScore(row) }, briefs: briefs.results || [], experiments: experiments.results || [] });
}

async function createOpportunity(request, env) {
  const a = authed(request, env);
  if (!a.ok) return json({ error: a.reason }, a.reason.startsWith("writes") ? 503 : 401);
  const b = await request.json().catch(() => ({}));
  if (!b.slug || !b.title) return json({ error: "slug and title required" }, 400);
  const o = {
    slug: String(b.slug).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 80),
    title: String(b.title).slice(0, 200),
    one_liner: String(b.one_liner || "").slice(0, 500),
    category: String(b.category || "other").slice(0, 40),
    status: OPP_STATUSES.has(b.status) ? b.status : "backlog",
    value: clamp10(b.value, 5), effort: clamp10(b.effort, 5),
    confidence: clamp10(b.confidence, 5), fit: clamp10(b.fit, 5),
    est_monthly_low: Math.max(0, Number(b.est_monthly_low) || 0),
    est_monthly_high: Math.max(0, Number(b.est_monthly_high) || 0),
    time_to_first_dollar: String(b.time_to_first_dollar || "").slice(0, 120),
    capital_needed: String(b.capital_needed || "").slice(0, 120),
    skills_needed: Array.isArray(b.skills_needed) ? JSON.stringify(b.skills_needed) : "[]",
    source: String(b.source || "manual").slice(0, 40),
    source_url: String(b.source_url || "").slice(0, 500),
    notes: String(b.notes || "").slice(0, 8000),
  };
  o.score = effectiveScore(o);
  if (o.est_monthly_low > o.est_monthly_high) {
    return json({ error: "est_monthly_low must be <= est_monthly_high", field: "est_monthly_low" }, 400);
  }
  try {
    const r = await env.DB.prepare(
      `INSERT INTO opportunities (${OPP_FIELDS.join(",")}, score)
       VALUES (${OPP_FIELDS.map(() => "?").join(",")}, ?)`
    ).bind(...OPP_FIELDS.map((f) => o[f]), o.score).run();
    return json({ id: r.meta.last_row_id, score: o.score }, 201);
  } catch (e) {
    return json({ error: String(e && e.message || e).slice(0, 300) }, 400);
  }
}

async function updateOpportunity(request, env, id) {
  const a = authed(request, env);
  if (!a.ok) return json({ error: a.reason }, a.reason.startsWith("writes") ? 503 : 401);
  const cur = await env.DB.prepare("SELECT * FROM opportunities WHERE id = ?").bind(id).first();
  if (!cur) return json({ error: "not found" }, 404);
  const b = await request.json().catch(() => ({}));
  const next = { ...cur };
  for (const f of ["title", "one_liner", "category", "time_to_first_dollar",
      "capital_needed", "source", "source_url", "notes"]) {
    if (b[f] !== undefined) next[f] = String(b[f]);
  }
  if (b.status !== undefined && !OPP_STATUSES.has(b.status)) {
    return json({ error: "invalid status: " + String(b.status).slice(0, 40), field: "status" }, 400);
  }
  if (b.status !== undefined && OPP_STATUSES.has(b.status)) next.status = b.status;
  for (const f of ["value", "effort", "confidence", "fit"]) {
    if (b[f] !== undefined) next[f] = clamp10(b[f], cur[f]);
  }
  for (const f of ["est_monthly_low", "est_monthly_high"]) {
    if (b[f] !== undefined) next[f] = Math.max(0, Number(b[f]) || 0);
  }
  if (next.est_monthly_low > next.est_monthly_high) {
    return json({ error: "est_monthly_low must be <= est_monthly_high", field: "est_monthly_low" }, 400);
  }
  if (Array.isArray(b.skills_needed)) next.skills_needed = JSON.stringify(b.skills_needed);
  next.score = effectiveScore(next);
  await env.DB.prepare(
    `UPDATE opportunities SET title=?, one_liner=?, category=?, status=?, value=?,
     effort=?, confidence=?, fit=?, score=?, est_monthly_low=?, est_monthly_high=?,
     time_to_first_dollar=?, capital_needed=?, skills_needed=?, source=?,
     source_url=?, notes=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id=?`
  ).bind(next.title, next.one_liner, next.category, next.status, next.value,
    next.effort, next.confidence, next.fit, next.score, next.est_monthly_low,
    next.est_monthly_high, next.time_to_first_dollar, next.capital_needed,
    next.skills_needed, next.source, next.source_url, next.notes, id).run();
  return json({ id: Number(id), score: next.score });
}

async function listBriefs(env, url) {
  const opp = url.searchParams.get("opportunity_id");
  const q = opp
    ? env.DB.prepare("SELECT * FROM briefs WHERE opportunity_id = ? ORDER BY version DESC LIMIT 10").bind(opp)
    : env.DB.prepare("SELECT * FROM briefs ORDER BY id DESC LIMIT 20");
  const rows = await q.all();
  return json({ briefs: rows.results || [] });
}

async function createBrief(request, env) {
  const a = authed(request, env);
  if (!a.ok) return json({ error: a.reason }, a.reason.startsWith("writes") ? 503 : 401);
  const b = await request.json().catch(() => ({}));
  if (!b.opportunity_id) return json({ error: "opportunity_id required" }, 400);
  const briefParent = await env.DB.prepare("SELECT id FROM opportunities WHERE id = ?").bind(b.opportunity_id).first();
  if (!briefParent) return json({ error: "opportunity not found", field: "opportunity_id" }, 404);
  const cur = await env.DB.prepare(
    "SELECT COALESCE(MAX(version),0) AS v FROM briefs WHERE opportunity_id = ?")
    .bind(b.opportunity_id).first();
  const version = (cur ? cur.v : 0) + 1;
  const str = (v) => String(v || "");
  const r = await env.DB.prepare(
    `INSERT INTO briefs (opportunity_id, version, summary, what_works,
     numbers_json, risks, first_steps, sources_json, author)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(b.opportunity_id, version, str(b.summary).slice(0, 8000),
    str(b.what_works).slice(0, 8000),
    typeof b.numbers_json === "string" ? b.numbers_json : JSON.stringify(b.numbers || []),
    str(b.risks).slice(0, 8000), str(b.first_steps).slice(0, 8000),
    typeof b.sources_json === "string" ? b.sources_json : JSON.stringify(b.sources || []),
    str(b.author || "manual").slice(0, 40)).run();
  await env.DB.prepare(
    "UPDATE opportunities SET updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?")
    .bind(b.opportunity_id).run();
  return json({ id: r.meta.last_row_id, version }, 201);
}

const daysSince = (iso, now) => {
  if (!iso) return null;
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / 86400000));
};

// Reference timestamp for "days in status": running counts from started_at,
// closed rows from ended_at, otherwise from the last row touch. Read-only;
// the human still owns every status move.
const statusRefOf = (r) =>
  r.status === "running" ? (r.started_at || r.updated_at || r.created_at)
  : (r.status === "won" || r.status === "lost") ? (r.ended_at || r.updated_at || r.created_at)
  : (r.updated_at || r.created_at);

async function listExperiments(env, url) {
  const status = url.searchParams.get("status") || "";
  const opp = url.searchParams.get("opportunity_id") || "";
  const where = [];
  const args = [];
  if (status && EXP_STATUSES.has(status)) { where.push("e.status = ?"); args.push(status); }
  if (opp) { where.push("e.opportunity_id = ?"); args.push(opp); }
  const rows = await env.DB.prepare(
    `SELECT e.*, o.title AS opportunity_title, o.slug AS opportunity_slug
     FROM experiments e LEFT JOIN opportunities o ON o.id = e.opportunity_id
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY e.updated_at DESC LIMIT 100`
  ).bind(...args).all();
  const now = Date.now();
  const withAge = (rows.results || []).map((r) => ({
    ...r,
    orphaned: r.opportunity_title == null,
    days_in_status: daysSince(statusRefOf(r), now),
  }));
  return json({ experiments: withAge });
}

async function createExperiment(request, env) {
  const a = authed(request, env);
  if (!a.ok) return json({ error: a.reason }, a.reason.startsWith("writes") ? 503 : 401);
  const b = await request.json().catch(() => ({}));
  if (!b.opportunity_id || !b.name) return json({ error: "opportunity_id and name required" }, 400);
  if (b.status !== undefined && !EXP_STATUSES.has(b.status)) {
    return json({ error: `invalid status: ${String(b.status).slice(0, 40)}`, field: "status" }, 400);
  }
  const status = EXP_STATUSES.has(b.status) ? b.status : "planned";
  const parent = await env.DB.prepare("SELECT id FROM opportunities WHERE id = ?").bind(b.opportunity_id).first();
  if (!parent) return json({ error: "opportunity not found", field: "opportunity_id" }, 404);
  if (status === "won" || status === "lost") {
    const fields = {};
    if (!String(b.result || "").trim()) fields.result = "result is required to close as won/lost";
    if (!String(b.post_mortem || "").trim()) fields.post_mortem = "post_mortem is required to close as won/lost";
    if (Object.keys(fields).length) return json({ error: "result and post_mortem are required to close as won/lost", fields }, 400);
  }
  const nowIso = new Date().toISOString();
  let started_at = String(b.started_at || "");
  let ended_at = String(b.ended_at || "");
  if (status === "running" && !started_at.trim()) started_at = nowIso;
  if ((status === "won" || status === "lost") && !ended_at.trim()) ended_at = nowIso;
  const cents = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const revenue_cents = cents(b.revenue_cents);
  const spent_cents = cents(b.spent_cents);
  const str = (v) => String(v || "");
  const r = await env.DB.prepare(
    `INSERT INTO experiments (opportunity_id, name, hypothesis, status, budget_cap,
     spent, metric, target, result, started_at, ended_at, post_mortem,
     revenue_cents, spent_cents)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(b.opportunity_id, str(b.name).slice(0, 200), str(b.hypothesis).slice(0, 8000),
    status,
    str(b.budget_cap).slice(0, 120), str(b.spent).slice(0, 120),
    str(b.metric).slice(0, 300), str(b.target).slice(0, 300),
    str(b.result).slice(0, 8000), started_at.slice(0, 30),
    ended_at.slice(0, 30), str(b.post_mortem).slice(0, 8000), revenue_cents, spent_cents).run();
  if (status === "won" || status === "lost") {
    const day = nowIso.slice(0, 10);
    const oneLine = String(b.result || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const line = "[" + day + " outcome] Experiment " + String.fromCharCode(34) + String(b.name || "").slice(0, 120) + String.fromCharCode(34) + " " + status + ": " + oneLine;
    await env.DB.prepare(
      "UPDATE opportunities SET notes = substr(notes || ?, -8000) WHERE id = ?"
    ).bind(String.fromCharCode(10) + line, b.opportunity_id).run();
  }
  return json({ id: r.meta.last_row_id }, 201);
}

async function updateExperiment(request, env, id) {
  const a = authed(request, env);
  if (!a.ok) return json({ error: a.reason }, a.reason.startsWith("writes") ? 503 : 401);
  const cur = await env.DB.prepare("SELECT * FROM experiments WHERE id = ?").bind(id).first();
  if (!cur) return json({ error: "not found" }, 404);
  const b = await request.json().catch(() => ({}));
  const next = { ...cur };
  for (const f of ["name", "hypothesis", "budget_cap", "spent", "metric",
      "target", "result", "started_at", "ended_at", "post_mortem"]) {
    if (b[f] !== undefined) next[f] = String(b[f]);
  }
  if (b.status !== undefined && !EXP_STATUSES.has(b.status)) {
    return json({ error: `invalid status: ${String(b.status).slice(0, 40)}`, field: "status" }, 400);
  }
  if (b.status !== undefined && EXP_STATUSES.has(b.status)) next.status = b.status;
  for (const f of ["revenue_cents", "spent_cents"]) {
    if (b[f] !== undefined) next[f] = Math.max(0, Math.floor(Number(b[f]) || 0));
    else if (next[f] === undefined || next[f] === null) next[f] = 0;
  }
  const nowIso = new Date().toISOString();
  if (next.status === "running" && !String(next.started_at || "").trim()) next.started_at = nowIso;
  if (next.status === "won" || next.status === "lost") {
    const fields = {};
    if (!String(next.result || "").trim()) fields.result = "result is required to close as won/lost";
    if (!String(next.post_mortem || "").trim()) fields.post_mortem = "post_mortem is required to close as won/lost";
    if (Object.keys(fields).length) return json({ error: "result and post_mortem are required to close as won/lost", fields }, 400);
    if (!String(next.ended_at || "").trim()) next.ended_at = nowIso;
    // Outcome ledger (round3 Task 3): on the transition into won/lost, append
    // a one-line outcome to the parent opportunity notes (newest-kept 8000,
    // same substr idiom as the worker's evidence append). Score untouched —
    // the drawer offers a suggested rescore the human applies with one click.
    if (cur.status !== "won" && cur.status !== "lost" && cur.opportunity_id) {
      const day = nowIso.slice(0, 10);
      const oneLine = String(next.result || "").replace(/\s+/g, " ").trim().slice(0, 200);
      const line = `[${day} outcome] Experiment "${String(next.name || "").slice(0, 120)}" ${next.status}: ${oneLine}`;
      await env.DB.prepare(
        "UPDATE opportunities SET notes = substr(notes || ?, -8000), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      ).bind("\n" + line, cur.opportunity_id).run();
    }
  }
  await env.DB.prepare(
    `UPDATE experiments SET name=?, hypothesis=?, status=?, budget_cap=?, spent=?,
     metric=?, target=?, result=?, started_at=?, ended_at=?, post_mortem=?,
     revenue_cents=?, spent_cents=?,
     updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
  ).bind(next.name, next.hypothesis, next.status, next.budget_cap, next.spent,
    next.metric, next.target, next.result, next.started_at, next.ended_at,
    next.post_mortem, next.revenue_cents, next.spent_cents, id).run();
  return json({ id: Number(id), status: next.status });
}

async function listRuns(env, url) {
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 20));
  const rows = await env.DB.prepare(
    "SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?").bind(limit).all();
  return json({ runs: rows.results || [] });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const parts = (context.params.path || []).filter(Boolean);
  const method = request.method.toUpperCase();
  try {
    if (parts.length === 1 && parts[0] === "health" && method === "GET") {
      const db = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities").first().catch(() => null) : null;
      const unreviewedRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE notes LIKE '%UNREVIEWED%'").first().catch(() => null) : null;
      const bareRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL").first().catch(() => null) : null;
      const expRows = env.DB ? await env.DB.prepare("SELECT status, COUNT(*) AS n FROM experiments GROUP BY status").all().catch(() => ({ results: [] })) : { results: [] };
      const lastOk = env.DB ? await env.DB.prepare("SELECT finished_at, started_at FROM agent_runs WHERE status='ok' ORDER BY id DESC LIMIT 1").first().catch(() => null) : null;
      const oldestUnreviewed = env.DB ? await env.DB.prepare("SELECT created_at FROM opportunities WHERE notes LIKE '%UNREVIEWED%' ORDER BY created_at ASC, id ASC LIMIT 1").first().catch(() => null) : null;
      // Lane metric, read-only from existing columns (no migration): decisions
      // are won/lost rows closed in the window; vetted counts rows carrying
      // the "[YYYY-MM-DD vetted]" tag (see vetOpportunity) touched in 7d.
      const decisionsRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM experiments WHERE status IN ('won','lost') AND ended_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')").first().catch(() => null) : null;
      const revenueRow = env.DB ? await env.DB.prepare("SELECT COALESCE(SUM(revenue_cents),0) AS total FROM experiments WHERE status IN ('won','lost') AND ended_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')").first().catch(() => null) : null;
      const vettedRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities WHERE notes LIKE '%vetted]%' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')").first().catch(() => null) : null;
      const vettedNoExpRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities o WHERE o.notes LIKE '%vetted]%' AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.opportunity_id = o.id)").first().catch(() => null) : null;
      const dayAgoIso = new Date(Date.now() - 86400000).toISOString();
      const noiseRow = env.DB ? await env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE processed = 1 AND opportunity_id IS NULL AND created_at >= ?").bind(dayAgoIso).first().catch(() => null) : null;
      let oldest_unreviewed_age_h = null;
      let hours_since_last_ok_run = null;
      if (lastOk) {
        const ts = lastOk.finished_at || lastOk.started_at || "";
        const ms = ts ? Date.parse(ts) : NaN;
        if (Number.isFinite(ms)) hours_since_last_ok_run = Math.round(((Date.now() - ms) / 3600000) * 10) / 10;
      }
      if (oldestUnreviewed && oldestUnreviewed.created_at) {
        const oms = Date.parse(oldestUnreviewed.created_at);
        if (Number.isFinite(oms)) oldest_unreviewed_age_h = Math.round(((Date.now() - oms) / 3600000) * 10) / 10;
      }
      const experiments_by_status = {};
      for (const r of (expRows.results || [])) experiments_by_status[r.status] = r.n;
      let rev = "unknown";
      try {
        const r = await fetch(new URL("/release.json", url.origin));
        if (r.ok) rev = (await r.json()).revision || rev;
      } catch { /* static file may be absent in previews */ }
      return json({ ok: true, rev, db: db ? "up" : "down", opportunities: db ? db.n : 0, unreviewed: unreviewedRow ? unreviewedRow.n : 0, bare_without_brief: bareRow ? bareRow.n : 0, experiments_by_status, hours_since_last_ok_run, oldest_unreviewed_age_h, decisions_last_7d: decisionsRow ? decisionsRow.n : 0, revenue_last_7d: revenueRow ? (revenueRow.total || 0) : 0, vetted_last_7d: vettedRow ? vettedRow.n : 0, vetted_no_experiment: vettedNoExpRow ? vettedNoExpRow.n : 0, noise_24h: noiseRow ? noiseRow.n : 0, time: new Date().toISOString() });
    }
    if (parts.length === 1 && parts[0] === "meta" && method === "GET") {
      return json({
        worker_url: env.RESEARCH_WORKER_URL || "",
        writes_enabled: Boolean((env.ADMIN_TOKEN || "").trim()),
        scoring: "score = 100 * (value * confidence * fit) / (effort + 1)",
      });
    }
    if (parts[0] === "opportunities" && parts.length === 1 && method === "GET")
      return listOpportunities(env, url);
    if (parts[0] === "opportunities" && parts.length === 1 && method === "POST")
      return createOpportunity(request, env);
    if (parts[0] === "opportunities" && parts.length === 2 && method === "GET")
      return getOpportunity(env, parts[1]);
    if (parts[0] === "opportunities" && parts.length === 2 && (method === "PATCH" || method === "PUT"))
      return updateOpportunity(request, env, parts[1]);
    if (parts[0] === "briefs" && method === "GET") return listBriefs(env, url);
    if (parts[0] === "briefs" && method === "POST") return createBrief(request, env);
    if (parts[0] === "experiments" && parts.length === 1 && method === "GET")
      return listExperiments(env, url);
    if (parts[0] === "experiments" && parts.length === 1 && method === "POST")
      return createExperiment(request, env);
    if (parts[0] === "experiments" && parts.length === 2 && (method === "PATCH" || method === "PUT"))
      return updateExperiment(request, env, parts[1]);
    if (parts[0] === "runs" && method === "GET") return listRuns(env, url);
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e && e.message || e).slice(0, 500) }, 500);
  }
}
