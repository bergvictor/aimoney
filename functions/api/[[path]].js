// AIMoney Lab API — Pages Functions catch-all router (D1 backend).
// Reads are public. Writes require `Authorization: Bearer <ADMIN_TOKEN>`.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

import { effectiveScore, tokensMatch } from "../../worker/src/lib.js";

// release.json is deploy-static: its revision is fetched once per isolate and
// reused by every later /api/health call (a failed fetch retries next call).
let cachedHealthRev = null;

// Self-migration switch (audit 2026-09-20-round3 Finding 1): live D1 may
// predate the money columns the health probes read. On first need — a failed
// money probe — the health handler calls ensureMoneyColumns, which compares
// PRAGMA table_info(experiments) ONLY against the columns the probes read.
// When columns are missing AND the owner set ALLOW_SCHEMA_MIGRATION=1, it
// applies exactly the ADD COLUMN statements from
// d1/migrate-2026-09-20-experiment-cents.sql, one at a time (ADD-only, no
// endpoint). Default-off: unset changes nothing; the health payload then
// names the missing columns plus the disabled line. At most once per
// isolate (cached below); tests reset via _resetSchemaMigrationForTests.
const MONEY_PROBE_COLUMNS = ["revenue_cents", "spent_cents"];
const MONEY_COLUMN_DDL = {
  revenue_cents: "ALTER TABLE experiments ADD COLUMN revenue_cents INTEGER NOT NULL DEFAULT 0",
  spent_cents: "ALTER TABLE experiments ADD COLUMN spent_cents INTEGER NOT NULL DEFAULT 0",
};
let schemaMigrationState = null;
export function _resetSchemaMigrationForTests() { schemaMigrationState = null; }

async function ensureMoneyColumns(env) {
  if (schemaMigrationState) return schemaMigrationState;
  const none = { missing: [], migrated: false, disabled: false };
  if (!env.DB) { schemaMigrationState = none; return none; }
  let have;
  try {
    const info = await env.DB.prepare("PRAGMA table_info(experiments)").all();
    have = new Set((info.results || []).map((c) => c.name));
  } catch {
    // PRAGMA unsupported or the database unreachable: leave the probes to
    // report (unset behaviour stays byte-identical to today).
    schemaMigrationState = none;
    return none;
  }
  // An empty table_info (an unknown stub shape) means "cannot tell": report
  // nothing rather than guessing the table is old.
  if (!have.size) { schemaMigrationState = none; return none; }
  const missing = MONEY_PROBE_COLUMNS.filter((c) => !have.has(c));
  if (!missing.length) { schemaMigrationState = none; return none; }
  if (String(env.ALLOW_SCHEMA_MIGRATION || "") !== "1") {
    const disabled = { missing, migrated: false, disabled: true };
    schemaMigrationState = disabled;
    return disabled;
  }
  const stillMissing = [];
  for (const col of missing) {
    try {
      await env.DB.prepare(MONEY_COLUMN_DDL[col]).run();
    } catch (e) {
      // Duplicate-column means a sibling isolate already added it: no-op.
      // Any other failure keeps the column missing (the probes name it).
      const msg = String((e && e.message) || e || "");
      if (!/duplicate column|already exists/i.test(msg)) stillMissing.push(col);
    }
  }
  const done = { missing: stillMissing, migrated: stillMissing.length < missing.length, disabled: false };
  schemaMigrationState = done;
  return done;
}

const clamp10 = (v, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(10, Math.max(1, Math.round(n)));
};

// Ledger money: integer cents to fixed-2dp dollars ($10.50, never $10.5).
// Mirrors public/app.js moneyCents so drawer and ledger agree.
const centsDollars = (cents) => "$" + (Number(cents) / 100).toFixed(2);
// effectiveScore shared via worker/src/lib.js (F3); scoreOf deduped (F6).
// (local duplicate removed; see import above)

// Experiment-write schema tolerance (audit 2026-09-20-round3 finding 3): a
// live D1 that predates 2026-09-20 lacks revenue_source, which the
// self-migration deliberately does not cover (probe-read cents only). Each
// experiment write path retries once without that column when the write
// fails naming exactly it (identical to its DEFAULT ''); any other narrow
// "no such column" failure answers 503 naming only the column — never SQL
// or driver text (same regex as health detail). The router awaits exactly
// these two write paths so their rejections land here.
const missingColumnOf = (err) => {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = /no such column:\s*([A-Za-z_][\w.]*)/i.exec(msg);
  return m ? m[1] : null;
};
function authed(request, env) {
  const want = (env.ADMIN_TOKEN || "").trim();
  if (!want) return { ok: false, reason: "writes disabled (ADMIN_TOKEN not set)" };
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!tokensMatch(got, want)) return { ok: false, reason: "bad token" };
  return { ok: true };
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
    `SELECT o.id, o.slug, o.title, o.one_liner, o.category, o.status, o.value,
       o.effort, o.confidence, o.fit, o.score, o.est_monthly_low, o.est_monthly_high,
       o.time_to_first_dollar, o.capital_needed, o.skills_needed, o.source, o.source_url,
       o.created_at, o.updated_at,
       (o.notes LIKE '%UNREVIEWED%') AS needs_review,
       (SELECT COUNT(*) FROM briefs b WHERE b.opportunity_id = o.id) AS brief_count,
       (SELECT substr(b.first_steps, 1, 300) FROM briefs b WHERE b.opportunity_id = o.id ORDER BY b.version DESC LIMIT 1) AS brief_first_steps,
       (SELECT substr(b.summary, 1, 200) FROM briefs b WHERE b.opportunity_id = o.id ORDER BY b.version DESC LIMIT 1) AS brief_summary,
       (SELECT COUNT(*) FROM experiments e WHERE e.opportunity_id = o.id) AS experiment_count
     FROM opportunities o
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY ${order} LIMIT ?`
  ).bind(...args, limit).all();
  // List rows carry needs_review (0/1) instead of full notes: the 8000-char
  // bodies are the single largest per-tap waste (F2). Scores still cap via
  // the bit (falling back to notes when a row still carries them), and the
  // full body is stripped before responding — writers fetch detail first.
  const capped = (rows.results || []).map((r) => {
    const { notes, ...rest } = r;
    const needsReview = r.needs_review ? true : String(notes || "").includes("UNREVIEWED");
    const score = effectiveScore({ value: r.value, effort: r.effort, confidence: r.confidence, fit: r.fit, notes: needsReview ? "UNREVIEWED" : "" });
    return { ...rest, score };
  });
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
  // Same bounds as createOpportunity: an unbounded PATCH must not write past
  // the newest-kept idiom every other writer honors (F7).
  const OPP_TEXT_BOUNDS = { title: 200, one_liner: 500, category: 40,
    time_to_first_dollar: 120, capital_needed: 120, source: 40,
    source_url: 500, notes: 8000 };
  for (const f of Object.keys(OPP_TEXT_BOUNDS)) {
    if (b[f] !== undefined) next[f] = String(b[f]).slice(0, OPP_TEXT_BOUNDS[f]);
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
  const revenue_source = String(b.revenue_source || "").slice(0, 120);
  const str = (v) => String(v || "");
  const insertArgs = [b.opportunity_id, str(b.name).slice(0, 200), str(b.hypothesis).slice(0, 8000),
    status,
    str(b.budget_cap).slice(0, 120), str(b.spent).slice(0, 120),
    str(b.metric).slice(0, 300), str(b.target).slice(0, 300),
    str(b.result).slice(0, 8000), started_at.slice(0, 30),
    ended_at.slice(0, 30), str(b.post_mortem).slice(0, 8000), revenue_cents, spent_cents, revenue_source];
  let r;
  try {
    r = await env.DB.prepare(
      `INSERT INTO experiments (opportunity_id, name, hypothesis, status, budget_cap,
       spent, metric, target, result, started_at, ended_at, post_mortem,
       revenue_cents, spent_cents, revenue_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(...insertArgs).run();
  } catch (e) {
    // Old-schema tolerance: retry once without revenue_source (DEFAULT '').
    if (missingColumnOf(e) !== "revenue_source") throw e;
    r = await env.DB.prepare(
      `INSERT INTO experiments (opportunity_id, name, hypothesis, status, budget_cap,
       spent, metric, target, result, started_at, ended_at, post_mortem,
       revenue_cents, spent_cents)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(...insertArgs.slice(0, 14)).run();
  }
  if (status === "won" || status === "lost") {
    const day = nowIso.slice(0, 10);
    const oneLine = String(b.result || "").replace(/\s+/g, " ").trim().slice(0, 200);
    const viaBit = revenue_source ? " via " + revenue_source : "";
    const moneyBit = " (" + centsDollars(revenue_cents) + " rev / " + centsDollars(spent_cents) + " spent" + viaBit + ")";
    const line = "[" + day + " outcome] Experiment " + String.fromCharCode(34) + String(b.name || "").slice(0, 120) + String.fromCharCode(34) + " " + status + ": " + oneLine + moneyBit;
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
  // Same bounds as createExperiment: an unbounded PATCH must not write past
  // the newest-kept idiom every other writer honors (round3 Task 2).
  const EXP_TEXT_BOUNDS = { name: 200, hypothesis: 8000, budget_cap: 120,
    spent: 120, metric: 300, target: 300, result: 8000, started_at: 30,
    ended_at: 30, post_mortem: 8000 };
  for (const f of Object.keys(EXP_TEXT_BOUNDS)) {
    if (b[f] !== undefined) next[f] = String(b[f]).slice(0, EXP_TEXT_BOUNDS[f]);
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
  if (b.revenue_source !== undefined) next.revenue_source = String(b.revenue_source).slice(0, 120);
  else if (next.revenue_source === undefined || next.revenue_source === null) next.revenue_source = "";
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
      const viaBit = next.revenue_source ? ` via ${next.revenue_source}` : "";
      const moneyBit = ` (${centsDollars(next.revenue_cents)} rev / ${centsDollars(next.spent_cents)} spent${viaBit})`;
      const line = `[${day} outcome] Experiment "${String(next.name || "").slice(0, 120)}" ${next.status}: ${oneLine}${moneyBit}`;
      await env.DB.prepare(
        "UPDATE opportunities SET notes = substr(notes || ?, -8000), updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?"
      ).bind("\n" + line, cur.opportunity_id).run();
    }
  }
  const updateArgs = [next.name, next.hypothesis, next.status, next.budget_cap, next.spent,
    next.metric, next.target, next.result, next.started_at, next.ended_at,
    next.post_mortem, next.revenue_cents, next.spent_cents, next.revenue_source, id];
  try {
    await env.DB.prepare(
      `UPDATE experiments SET name=?, hypothesis=?, status=?, budget_cap=?, spent=?,
       metric=?, target=?, result=?, started_at=?, ended_at=?, post_mortem=?,
       revenue_cents=?, spent_cents=?, revenue_source=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
    ).bind(...updateArgs).run();
  } catch (e) {
    // Old-schema tolerance: retry once without revenue_source (DEFAULT '').
    if (missingColumnOf(e) !== "revenue_source") throw e;
    await env.DB.prepare(
      `UPDATE experiments SET name=?, hypothesis=?, status=?, budget_cap=?, spent=?,
       metric=?, target=?, result=?, started_at=?, ended_at=?, post_mortem=?,
       revenue_cents=?, spent_cents=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`
    ).bind(...updateArgs.slice(0, 13), id).run();
  }
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
      const dayAgoIso = new Date(Date.now() - 86400000).toISOString();
      // Vetted-this-week counts tag dates, not touches: the [YYYY-MM-DD vetted]
      // tag the dashboard appends is fixed-width and greppable, so the last 7
      // calendar days match inline — no migration, and a fresh touch on an
      // old-vetted row no longer fakes velocity.
      const vettedDays = [];
      for (let i = 0; i < 7; i++) vettedDays.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
      // One batched round-trip for every independent health select (paired
      // scans merged: lifetime totals, unreviewed+oldest; decisions split from revenue).
      // Lifetime totals sum every row regardless of status (recorded cents
      // are recorded cents); the weekly probe stays bound to rows closed
      // in-window via ended_at.
      // Probe names for the isolation fallback: when the batch rejects, each
      // statement re-runs individually and the failing probe is named in
      // `health_probe_failures` instead of blanking the whole report (F1).
      const healthProbeNames = ["opportunities", "unreviewed", "bare_without_brief",
        "experiments_by_status", "last_ok_run", "decisions_week",
        "revenue_week", "revenue_lifetime", "vetted_7d", "vetted_no_experiment", "noise_24h",
        "last_vetted"];
      const healthStmts = env.DB ? [
        env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities"),
        env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM opportunities WHERE notes LIKE '%UNREVIEWED%'"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL"),
        env.DB.prepare("SELECT status, COUNT(*) AS n FROM experiments GROUP BY status"),
        env.DB.prepare("SELECT finished_at, started_at FROM agent_runs WHERE status='ok' ORDER BY id DESC LIMIT 1"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM experiments WHERE status IN ('won','lost') AND ended_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')"),
        env.DB.prepare("SELECT COALESCE(SUM(revenue_cents),0) AS total FROM experiments WHERE status IN ('won','lost') AND ended_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')"),
        env.DB.prepare("SELECT COALESCE(SUM(revenue_cents),0) AS revenue, COALESCE(SUM(spent_cents),0) AS spent FROM experiments"),
        env.DB.prepare(`SELECT COUNT(*) AS n FROM opportunities WHERE ${vettedDays.map((d) => `notes LIKE '%[${d} vetted]%'`).join(" OR ")}`),
        env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities o WHERE o.notes LIKE '%vetted]%' AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.opportunity_id = o.id)"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE processed = 1 AND opportunity_id IS NULL AND created_at >= ?").bind(dayAgoIso),
        env.DB.prepare("SELECT notes FROM opportunities WHERE notes LIKE '%vetted]%'"),
      ] : [];
      let healthRes = healthStmts.length ? await env.DB.batch(healthStmts).catch(() => null) : null;
      // Isolation fallback (F1): one bad probe (e.g. a SELECT touching a
      // column a migration never applied) must not fail the other eleven. When
      // the batch rejects, each statement re-runs individually: the healthy
      // probes still report, only the failing counts go null, and `db` reads
      // by whether the database answered at all. A total outage keeps the
      // exact outage payload (ok:false, db down, all null, no new key).
      let healthProbeFailures = null;
      let healthProbeDetail = null;
      if (!healthRes && healthStmts.length) {
        const perProbe = [];
        const failed = [];
        const failedDetail = {};
        for (let i = 0; i < healthStmts.length; i++) {
          try {
            if (i === 3 || healthProbeNames[i] === "last_vetted") perProbe.push(await healthStmts[i].all());
            else {
              const row = await healthStmts[i].first();
              perProbe.push({ results: row ? [row] : [] });
            }
          } catch (err) {
            perProbe.push(null);
            failed.push(healthProbeNames[i] || String(i));
            // Schema-drift hint: name ONLY the missing column or table (narrow regex on
            // the driver message) - never the SQL or the raw error text.
            const driftMsg = err instanceof Error ? err.message : String(err ?? "");
            const driftMatch = /no such (column|table):\s*([A-Za-z_][\w.]*)/i.exec(driftMsg);
            if (driftMatch) failedDetail[healthProbeNames[i] || String(i)] = driftMatch[2];
          }
        }
        if (perProbe.some((r) => r !== null)) {
          healthRes = perProbe;
          // A spuriously-rejected batch whose probes all answer attaches no
          // key: presence of health_probe_failures means at least one probe
          // actually failed (an empty array is truthy, so [] would leak).
          healthProbeFailures = failed.length ? failed : null;
          healthProbeDetail = Object.keys(failedDetail).length ? failedDetail : null;
        }
      }
      // Lazy self-migration (Finding 1): only when a money probe actually
      // failed (the old-schema signal) does the handler PRAGMA the table
      // and, when the owner enabled ALLOW_SCHEMA_MIGRATION=1, ADD the
      // missing money columns, then re-run the failed money probes so this
      // same call reports numbers. Default-off: unset leaves the table
      // untouched and the payload names the missing columns plus the
      // disabled line below. At most once per isolate; ADD-only.
      let schemaNote = null;
      if (healthProbeFailures && (healthProbeFailures.includes("revenue_week") || healthProbeFailures.includes("revenue_lifetime"))) {
        schemaNote = await ensureMoneyColumns(env);
        if (schemaNote.migrated) {
          for (const i of [6, 7]) {
            if (!healthProbeFailures.includes(healthProbeNames[i])) continue;
            try {
              const row = await healthStmts[i].first();
              healthRes[i] = { results: row ? [row] : [] };
              healthProbeFailures = healthProbeFailures.filter((n) => n !== healthProbeNames[i]);
              if (healthProbeDetail) delete healthProbeDetail[healthProbeNames[i]];
            } catch {
              // Still failing: keep today's null + failure naming.
            }
          }
          if (!healthProbeFailures.length) { healthProbeFailures = null; healthProbeDetail = null; }
        }
      }
      // A batch with zero answering probes reads as an outage, not as zeros:
      // ok flips to false (so the unchanged verify.sh '"ok":true' grep fails
      // the rollout) and every count key goes null — the dashboard
      // typeof-guards each one.
      const healthDown = !healthRes;
      // Partial-failure honesty: a probe the fallback could not run reports
      // null for its counts (never 0) — the dashboard typeof-guards each one.
      const probeFailed = (i) =>
        healthProbeFailures !== null && healthProbeFailures.includes(healthProbeNames[i]);
      const firstRow = (i) => (healthRes && healthRes[i] && healthRes[i].results && healthRes[i].results[0]) || null;
      const db = firstRow(0);
      const unreviewedRow = firstRow(1);
      const bareRow = firstRow(2);
      const expRows = { results: (healthRes && healthRes[3] && healthRes[3].results) || [] };
      const lastOk = firstRow(4);
      const decisionsWeekRow = firstRow(5);
      const revenueWeekRow = firstRow(6);
      const lifetimeRow = firstRow(7);
      const vettedRow = firstRow(8);
      const vettedNoExpRow = firstRow(9);
      const noiseRow = firstRow(10);
      // Last-verdict date (finding 2): max [YYYY-MM-DD vetted] tag across all
      // rows, null when no vetted row exists. Parsed in JS (not SQL) so every
      // tag in a row counts and a stall shows its age without a told count.
      const lastVettedRows = (healthRes && healthRes[11] && healthRes[11].results) || [];
      let last_vetted = null;
      if (!healthDown && !probeFailed(11)) {
        for (const r of lastVettedRows) {
          const text = String((r && r.notes) || "");
          for (const m of text.matchAll(/\[(\d{4}-\d{2}-\d{2}) vetted\]/g)) {
            if (!last_vetted || m[1] > last_vetted) last_vetted = m[1];
          }
        }
      }
      // Lane metric, read-only from existing columns (no migration): decisions
      // are won/lost rows closed in the window; vetted counts rows carrying
      // the "[YYYY-MM-DD vetted]" tag (see vetOpportunity) dated in the last 7 calendar days.
      const decisionsRow = decisionsWeekRow ? { n: decisionsWeekRow.n } : null;
      const revenueRow = revenueWeekRow ? { total: revenueWeekRow.total } : null;
      const revenueTotalRow = lifetimeRow ? { total: lifetimeRow.revenue } : null;
      const spentTotalRow = lifetimeRow ? { total: lifetimeRow.spent } : null;
      const oldestUnreviewed = unreviewedRow && unreviewedRow.oldest ? { created_at: unreviewedRow.oldest } : null;
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
      let rev = cachedHealthRev || "unknown";
      try {
        const r = cachedHealthRev ? { ok: false } : await fetch(new URL("/release.json", url.origin));
        if (r.ok) {
          const gotRev = (await r.json()).revision;
          if (gotRev) { rev = gotRev; cachedHealthRev = gotRev; }
        }
      } catch { /* static file may be absent in previews */ }
      return json({ ok: !healthDown, rev, db: healthDown ? "down" : (db || healthProbeFailures ? "up" : "down"), opportunities: (healthDown || probeFailed(0)) ? null : (db ? db.n : 0), unreviewed: (healthDown || probeFailed(1)) ? null : (unreviewedRow ? unreviewedRow.n : 0), bare_without_brief: (healthDown || probeFailed(2)) ? null : (bareRow ? bareRow.n : 0), experiments_by_status, hours_since_last_ok_run, oldest_unreviewed_age_h, decisions_last_7d: (healthDown || probeFailed(5)) ? null : (decisionsRow ? decisionsRow.n : 0), revenue_last_7d: (healthDown || probeFailed(6)) ? null : (revenueRow ? (revenueRow.total || 0) : 0), revenue_total: (healthDown || probeFailed(7)) ? null : (revenueTotalRow ? (revenueTotalRow.total || 0) : 0), spent_total: (healthDown || probeFailed(7)) ? null : (spentTotalRow ? (spentTotalRow.total || 0) : 0), vetted_last_7d: (healthDown || probeFailed(8)) ? null : (vettedRow ? vettedRow.n : 0), last_vetted: (healthDown || probeFailed(11)) ? null : last_vetted, vetted_no_experiment: (healthDown || probeFailed(9)) ? null : (vettedNoExpRow ? vettedNoExpRow.n : 0), noise_24h: (healthDown || probeFailed(10)) ? null : (noiseRow ? noiseRow.n : 0), time: new Date().toISOString(), ...(healthProbeFailures ? { health_probe_failures: healthProbeFailures } : {}), ...(healthProbeDetail ? { health_probe_detail: healthProbeDetail } : {}), ...(schemaNote && schemaNote.disabled && schemaNote.missing.length ? { schema_missing_columns: schemaNote.missing, schema_migration: "disabled (set ALLOW_SCHEMA_MIGRATION=1 to add missing columns)" } : {}) });
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
      return await createExperiment(request, env);
    if (parts[0] === "experiments" && parts.length === 2 && (method === "PATCH" || method === "PUT"))
      return await updateExperiment(request, env, parts[1]);
    if (parts[0] === "runs" && method === "GET") return listRuns(env, url);
    return json({ error: "not found" }, 404);
  } catch (e) {
    const col = missingColumnOf(e); if (col) return json({ error: "missing column: " + col, column: col }, 503);
    return json({ error: String(e && e.message || e).slice(0, 500) }, 500);
  }
}
