// AIMoney research agent — Cloudflare Worker.
// Cron (every 6h) + manual POST /run. Scans public sources for AI-money
// signals, dedupes against the D1 priority list with Workers AI, adds new
// opportunities and briefs, and logs every run. The agent PROPOSES; the human
// owns the testing workflow (it never moves status to testing/scaling/killed).

// Time budget: waitUntil is cancelled 30s after the response (proven live via
// wrangler tail), and the manual path shares it — so the whole pass must fit.
// Cron gets longer, but the pass is engineered for <30s everywhere: parallel
// sources, ONE batched D1 round-trip per phase, small AI payloads, and the
// brief pass self-skips when the clock is nearly spent (it lands next run).
const AI_CLASSIFY = "@cf/mistral/mistral-7b-instruct-v0.1"; // fast triage
const AI_BRIEF = "@cf/meta/llama-3.1-8b-instruct";          // quality writing
const MAX_SIGNALS_PER_SOURCE = 8;
const MAX_AI_SIGNALS = 6;
const MAX_NEW_PER_RUN = 2; // inflow cap: at most 2 new proposals per run (brief capacity is 1+1 per cron tick)
const BARE_BACKLOG_CAP = 10; // while bare-without-brief exceeds 10, cap inserts to 1 for that tick
const MAX_AI_CALLS = 4;
const FETCH_TIMEOUT_MS = 6000;
const CLASSIFY_TOKENS = 1200;
const BRIEF_TOKENS = 1500;
// Runs stuck in "running" past this are declared dead by the next run.
const STUCK_RUN_MINUTES = 30;

const HN_QUERIES = ["AI passive income", "AI SaaS revenue", "AI automation agency", "make money with AI"];
const REDDIT_QUERIES = ["AI side income", "AI SaaS", "AI agency"];
const REDDITS = "SideProject+Entrepreneur+alphaandbeta+startups";
const GITHUB_QUERIES = ["ai-saas-boilerplate", "ai-money"];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// The timeout MUST cover the body read, not just the headers: one live run
// stalled forever on a source that sent headers then trickled the body
// (the old helper cleared the timer as soon as headers arrived).
async function timedJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(`timeout after ${FETCH_TIMEOUT_MS}ms`), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function hnSignals(state) {
  // A query that throws marks this source failed; a source whose queries ALL
  // fail is named in the run log, so a total outage never reads as a quiet tick.
  let failed = 0;
  // Queries run in parallel: sequential fetches + one hanging source blew the
  // fetch-handler wall clock on the first live run (stuck "running" forever).
  const one = async (q) => {
    const out = [];
    try {
      const j = await timedJson(
        `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=${MAX_SIGNALS_PER_SOURCE}`);
      for (const h of (j.hits || [])) {
        if (!h.title) continue;
        out.push({
          source: "hn", external_id: String(h.objectID || h.title),
          title: String(h.title).slice(0, 300),
          url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
          snippet: `HN: ${h.points || 0} points, ${h.num_comments || 0} comments.`,
          published_at: h.created_at || "",
        });
      }
    } catch { failed++; /* source hiccup must not kill the run */ }
    return out;
  };
  const rows = (await Promise.all(HN_QUERIES.map(one))).flat();
  if (failed === HN_QUERIES.length) state.src_fail.push("hn");
  return rows;
}

async function redditSignals(state) {
  // Same failure accounting as hnSignals: all queries failed names the source.
  let failed = 0;
  const one = async (q) => {
    const out = [];
    try {
      const j = await timedJson(
        `https://www.reddit.com/r/${REDDITS}/search.json?q=${encodeURIComponent(q)}&sort=new&limit=${MAX_SIGNALS_PER_SOURCE}&restrict_sr=on`,
        { headers: { "User-Agent": "aimoney-lab/0.1 research (contact: local)" } });
      for (const c of ((j.data || {}).children || [])) {
        const d = c.data || {};
        if (!d.title) continue;
        out.push({
          source: "reddit", external_id: String(d.id || d.title),
          title: String(d.title).slice(0, 300),
          url: `https://www.reddit.com${d.permalink || ""}`,
          snippet: `r/${d.subreddit}: ${d.score || 0} upvotes. ${(d.selftext || "").slice(0, 280)}`,
          published_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "",
        });
      }
    } catch { failed++; /* 429s happen; HN usually carries the run */ }
    return out;
  };
  const rows = (await Promise.all(REDDIT_QUERIES.map(one))).flat();
  if (failed === REDDIT_QUERIES.length) state.src_fail.push("reddit");
  return rows;
}

async function githubSignals(state) {
  // Same failure accounting as hnSignals: all queries failed names the source.
  let failed = 0;
  const since = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);
  const one = async (q) => {
    const out = [];
    try {
      const j = await timedJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+created:>${since}&sort=stars&order=desc&per_page=${MAX_SIGNALS_PER_SOURCE}`,
        { headers: { "User-Agent": "aimoney-lab/0.1", "Accept": "application/vnd.github+json" } });
      for (const repo of (j.items || [])) {
        out.push({
          source: "github", external_id: String(repo.id || repo.full_name),
          title: `${repo.full_name}: ${repo.description || "no description"}`.slice(0, 300),
          url: repo.html_url || "",
          snippet: `GitHub: ${repo.stargazers_count || 0} stars. ${(repo.description || "").slice(0, 240)}`,
          published_at: repo.created_at || "",
        });
      }
    } catch { failed++; /* unauth rate limit is 10 req/min; fine at this volume */ }
    return out;
  };
  const queries = GITHUB_QUERIES;
  const rows = (await Promise.all(queries.map(one))).flat();
  if (failed === queries.length) state.src_fail.push("github");
  return rows;
}

// Every AI call races a timeout: a queued model must fail HONESTLY (and be
// retried by a later tick) instead of freezing the run past the 30s cap.
async function aiComplete(env, state, { model, fallback, maxTokens, messages, timeoutMs, retries }) {
  if (state.ai_calls >= MAX_AI_CALLS) throw new Error("ai call budget spent");
  const attempts = [model, ...(retries > 0 ? [fallback] : [])];
  let lastErr = null;
  for (const m of attempts) {
    state.ai_calls++;
    try {
      const r = await Promise.race([
        env.AI.run(m, { messages, max_tokens: maxTokens }),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`AI timeout after ${timeoutMs}ms (${m})`)), timeoutMs)),
      ]);
      return r.response || "";
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("AI failed");
}

import { clamp10, slugify, effectiveScore, parseJsonLines, repairJson, tokensMatch } from "./lib.js";

// Agent money estimates (F1): the triage verdict may carry est_monthly_low,
// est_monthly_high, capital_needed, and time_to_first_dollar for "new" rows.
// Missing/malformed keys default safely (0/0/''/''); an inverted range clamps
// high up to low instead of rejecting (the API's 400 guard must never fire on
// agent rows, so a bad estimate can never 500 the cron pass). Zero-spend
// phrasings ("free"/"none"/bare "0", any case) normalize to "$0 …"-form with
// the raw phrasing kept after the prefix (reversible at vet time). Pure for tests.
// Exact-URL duplicate match (pure): returns the opportunity id a fresh signal
// links to as supports, or null when no exact-URL match exists. A URL matching
// an existing opportunity source_url — or an already-linked signal URL — needs
// no model call. Empty URLs never match. Pure for tests.
export function exactUrlTarget(signalUrl, opportunities, linkedSignals) {
  const url = String(signalUrl || "");
  if (!url) return null;
  for (const o of (opportunities || [])) {
    if (o && o.id && o.source_url && String(o.source_url) === url) return o.id;
  }
  for (const s of (linkedSignals || [])) {
    if (s && s.opportunity_id && s.url && String(s.url) === url) return s.opportunity_id;
  }
  return null;
}

export function agentMoneyEstimates(v) {
  const o = (v && typeof v === "object") ? v : {};
  const est_monthly_low = Math.max(0, Math.floor(Number(o.est_monthly_low) || 0));
  let est_monthly_high = Math.max(0, Math.floor(Number(o.est_monthly_high) || 0));
  if (est_monthly_high < est_monthly_low) est_monthly_high = est_monthly_low;
  const rawCapital = String(o.capital_needed || "");
  const capital_needed = (!/^\s*\$0/.test(rawCapital) && /^\s*(0\b|free\b|none\b)/i.test(rawCapital))
    ? ("$0 " + rawCapital.trim()).slice(0, 120)
    : rawCapital.slice(0, 120);
  return {
    est_monthly_low,
    est_monthly_high,
    capital_needed,
    time_to_first_dollar: String(o.time_to_first_dollar || "").slice(0, 120),
  };
}

async function runResearch(env, trigger) {
  const state = { ai_calls: 0, added: 0, updated: 0, briefs: 0, seen: 0, stale: 0, src_fail: [] };
  // Reap runs a killed worker left behind: a "running" row older than the
  // cutoff is dead by definition (a live run finishes in minutes).
  await env.DB.prepare(
    `UPDATE agent_runs SET status='error', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
     error='worker killed mid-run (wall clock); reaped by next run'
     WHERE agent='research-v1' AND status='running'
     AND started_at < strftime('%Y-%m-%dT%H:%M:%SZ','now', ?)`
  ).bind(`-${STUCK_RUN_MINUTES} minutes`).run().catch(() => null);
  const run = await env.DB.prepare(
    "INSERT INTO agent_runs (agent, trigger) VALUES ('research-v1', ?) RETURNING id")
    .bind(trigger).first().catch(() => null);
  // D1 RETURNING support varies; fall back to last_row_id lookup.
  let runId = run && run.id;
  if (!runId) {
    const r = await env.DB.prepare(
      "SELECT id FROM agent_runs WHERE agent='research-v1' ORDER BY id DESC LIMIT 1").first();
    runId = r ? r.id : null;
  }
  const finish = (status, error = "") =>
    runId ? env.DB.prepare(
      `UPDATE agent_runs SET finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       status=?, signals_seen=?, added=?, updated=?, briefs=?, ai_calls=?, error=?
       WHERE id=?`
    ).bind(status, state.seen, state.added, state.updated, state.briefs,
      state.ai_calls, String(error).slice(0, 1000), runId).run().catch(() => null) : null;

  try {
    const t0 = Date.now();
    // The manual path shares waitUntil's 30s cap (proven live), so it runs
    // collect+classify only and always fits. The brief pass runs on cron
    // ticks, which get a long wall clock; a slow tick still self-skips.
    const briefDeadline = trigger === "cron" ? 300000 : -1;
    // 1. Collect signals (bounded, independent — one dead source is fine).
    const batches = await Promise.allSettled([hnSignals(state), redditSignals(state), githubSignals(state)]);
    const srcNames = ["hn", "reddit", "github"];
    batches.forEach((b, i) => {
      // A rejected collector means every query failed: name it like the
      // per-query path does, so no outage reads as a quiet tick.
      if (b.status === "rejected" && !state.src_fail.includes(srcNames[i])) state.src_fail.push(srcNames[i]);
    });
    const signals = batches.flatMap((b) => (b.status === "fulfilled" ? b.value : []));
    state.seen = signals.length;
    // ONE batched round-trip instead of ~24 sequential inserts (9s -> 0.5s),
    // then a heartbeat so the dashboard shows progress even if AI is slow.
    if (signals.length) {
      await env.DB.batch(signals.map((s) => env.DB.prepare(
        `INSERT OR IGNORE INTO signals (source, external_id, title, url, snippet, published_at)
         VALUES (?,?,?,?,?,?)`
      ).bind(s.source, s.external_id, s.title, s.url, s.snippet, s.published_at)));
    }
    const mark = (phase) => runId
      ? env.DB.prepare("UPDATE agent_runs SET signals_seen=?, ai_calls=?, error=? WHERE id=?")
        .bind(state.seen, state.ai_calls, `phase:${phase}`).run().catch(() => null)
      : Promise.resolve();
    // Staleness bound: unprocessed signals older than 30d become noise
    // (counted in state.stale) so the oldest-first take cannot wedge on
    // ancient pre-deploy backlog. Best-effort; the take still bounds work.
    try {
      const staleRun = await env.DB.prepare(
        "UPDATE signals SET processed = 1 WHERE processed = 0 AND created_at != '' AND created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')").run();
      const staleMeta = (staleRun && staleRun.meta) || {};
      state.stale = Number(staleMeta.changes || staleMeta.rows_written) || 0;
    } catch { /* stale sweep failed; triage proceeds anyway */ }
    await mark(state.stale ? `collected stale:${state.stale}` : "collected");
    const fresh = await env.DB.prepare(
      "SELECT * FROM signals WHERE processed = 0 ORDER BY id ASC LIMIT ?")
      .bind(MAX_AI_SIGNALS).all().then((r) => r.results || []);
    // Exact-URL supports pre-pass (no AI call): a taken signal whose URL
    // exactly matches an existing opportunity source_url or an already-linked
    // signal URL is linked as supports before triage — reversible, notes
    // newest-kept, no status move. Linked rows leave `fresh` in place, so the
    // classify prompt and verdict indices below only see genuinely new signals.
    if (fresh.length) {
      // Bounded pre-pass (F4): match only the ≤6 fresh URLs in SQL instead of
      // loading two full-table URL sets. Empty URLs never match (exactUrlTarget
      // returns null), so they are filtered before the query.
      const freshUrls = [...new Set(fresh.map((s) => String(s.url || "")).filter(Boolean))];
      let oppUrls = [];
      let linkedUrls = [];
      if (freshUrls.length) {
        const placeholders = freshUrls.map(() => "?").join(",");
        oppUrls = await env.DB.prepare(
          `SELECT id, source_url FROM opportunities WHERE source_url IN (${placeholders})`)
          .bind(...freshUrls).all().then((r) => r.results || []).catch(() => []);
        linkedUrls = await env.DB.prepare(
          `SELECT url, opportunity_id FROM signals WHERE opportunity_id IS NOT NULL AND url IN (${placeholders})`)
          .bind(...freshUrls).all().then((r) => r.results || []).catch(() => []);
      }
      const rest = [];
      for (const sig of fresh) {
        const target = exactUrlTarget(sig.url, oppUrls, linkedUrls);
        if (target === null) { rest.push(sig); continue; }
        state.updated++;
        await env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?").bind(target, sig.id).run();
        await env.DB.prepare(`UPDATE opportunities SET notes = substr(notes || ?, -8000), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).bind(`\n[signal ${new Date().toISOString().slice(0, 10)}] ${sig.title} — ${sig.url}`, target).run().catch(() => null);
      }
      fresh.length = 0;
      fresh.push(...rest);
    }
    if (!fresh.length) {
      // Intentionally no early return: quiet ticks still brief bare rows below.
      // The classify AI call is skipped when fresh is empty (see verdicts guard).
    }

    // 2. One AI pass: classify signals against the live priority list.
    // Quiet ticks skip the top-60 fetch and the prompt build entirely (F5):
    // the guarded block runs only with fresh signals, otherwise verdicts
    // stay [] and the run continues to the brief pass below.
    let verdicts = [];
    if (fresh.length) {
      const opps = await env.DB.prepare(
        "SELECT id, slug, title, status, score FROM opportunities ORDER BY score DESC LIMIT 60")
        .all().then((r) => r.results || []);
      const classifyPrompt = [
        { role: "system", content: "You triage money-making-with-AI leads. Reply with one JSON object per line (NDJSON), no prose, no array, no fences. Keep every value short." },
        { role: "user", content:
          `PRIORITY LIST (id | title | status):\n` +
          opps.map((o) => `${o.id} | ${o.title} | ${o.status}`).join("\n") +
          `\n\nFRESH SIGNALS (n | source | title | url):\n` +
          fresh.map((s, i) => `${i} | ${s.source} | ${s.title} | ${s.url}`).join("\n") +
          `\n\nFor each signal index 0..${fresh.length - 1} emit exactly one line:
{"n":i,"action":"new"|"supports"|"noise","opportunity_id":id or null,"title":"short","one_liner":"under 20 words","category":"services|agency|saas|content|products|other","value":1-10,"effort":1-10,"confidence":1-10,"fit":1-10,"est_monthly_low":0,"est_monthly_high":0,"capital_needed":"$0","time_to_first_dollar":"2-4 weeks"}
Rules: DEFAULT TO NOISE. "new" only when the signal shows a repeatable way to earn money (pricing, revenue, customers, or an obvious buyer) that is NOT on the list. A GitHub repo, tool launch, or tutorial with no business model is noise. A variant of a listed method is "supports" with its numeric id. Confidence above 6 requires named revenue/users in the signal, else 5 or less. opportunity_id must be a numeric id from the list or null, never text. For "new", also estimate est_monthly_low/high ($/mo integers, low<=high), capital_needed ("$0" style, <=120 chars) and time_to_first_dollar ("2-4 weeks" style, <=120 chars); omit any you cannot estimate (safe defaults apply).` },
      ];
      const isCron = trigger === "cron";
      verdicts = !fresh.length ? [] : parseJsonLines(await aiComplete(env, state, {
        model: AI_CLASSIFY, fallback: AI_BRIEF, maxTokens: CLASSIFY_TOKENS,
        messages: classifyPrompt,
        timeoutMs: isCron ? 60000 : 12000, retries: isCron ? 1 : 0,
      }));
    }
    // Validate: one verdict per signal (first wins), strict action enum,
    // numeric-or-null opportunity_id (the model once emitted repo names).
    const seen = new Set();
    let newInserts = 0; // new rows inserted this run (capped at maxNewThisRun)
    // Backlog gate: once per run read bare-without-brief; while it exceeds 10
    // cap inserts to 1 for that tick so evidence drains faster than inflow.
    // Overflow stays processed = 0 for a later tick — reversible, no status move.
    let maxNewThisRun = MAX_NEW_PER_RUN;
    try {
      const bareRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL").first();
      if (bareRow && Number(bareRow.n) > BARE_BACKLOG_CAP) maxNewThisRun = 1;
    } catch { /* bare count failed; keep the default cap */ }
    // Verdict writes batch (F3): signal UPDATEs and notes appends accumulate
    // here and go out as ONE env.DB.batch after the loop — the collect phase
    // proved batching cuts ~9s to ~0.5s. New-row INSERTs and the slug-collision
    // lookup stay inline since they branch. A failed batch loses this tick's
    // verdict writes (signals stay unprocessed, retried next tick) — the same
    // tradeoff round 2's health batching already accepted.
    const verdictWrites = [];
    for (const v of verdicts) {
      if (!v || typeof v !== "object") continue;
      const n = Number(v.n);
      if (!Number.isInteger(n) || n < 0 || n >= fresh.length || seen.has(n)) continue;
      seen.add(n);
      const sig = fresh[n];
      if (v.action !== "new" && v.action !== "supports" && v.action !== "noise") {
        verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id));
        continue;
      }
      if (v.opportunity_id !== null && v.opportunity_id !== undefined && !Number.isInteger(Number(v.opportunity_id))) {
        v.opportunity_id = null;
      }
      if (v.action === "supports" && (v.opportunity_id === null || v.opportunity_id === undefined)) {
        v.action = "noise"; // supports without a valid id is noise, not new
      }
      if (v.action === "new" && v.title) {
        if (newInserts >= maxNewThisRun) continue; // newInserts >= MAX_NEW_PER_RUN when backlog low; overflow new-verdict signals stay processed = 0 for a later tick
        const slug = slugify(v.title) || `agent-${sig.id}`;
        // Code-enforced humility: live runs proved model calibration is
        // fiction (confidence 10 for a random GitHub repo, outranking the
        // human top pick). Agent proposals are capped to ≤6000 until reviewed.
        const o = { value: Math.min(7, clamp10(v.value)), effort: clamp10(v.effort),
          confidence: Math.min(5, clamp10(v.confidence, 3)), fit: clamp10(v.fit) };
        const oneLiner = String(v.one_liner || "").trim()
          || `Via ${sig.source}: ${sig.title}`.slice(0, 500);
        const m = agentMoneyEstimates(v);
        try {
          const r = await env.DB.prepare(
            `INSERT INTO opportunities (slug, title, one_liner, category, status,
             value, effort, confidence, fit, score, est_monthly_low, est_monthly_high,
             capital_needed, time_to_first_dollar, source, source_url, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(slug, String(v.title).slice(0, 200), oneLiner.slice(0, 500),
            String(v.category || "other").slice(0, 40), "researching",
            o.value, o.effort, o.confidence, o.fit, effectiveScore({ ...o, notes: "UNREVIEWED" }),
            m.est_monthly_low, m.est_monthly_high, m.capital_needed, m.time_to_first_dollar,
            "agent", String(sig.url || "").slice(0, 500),
            `Agent proposal from ${sig.source} signal "${sig.title}" (${sig.url}) — UNREVIEWED, scores capped until a human vets it (agent estimates — correct on vet).`.slice(0, 1000)).run();
          state.added++;
          newInserts++;
          verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?")
            .bind(r.meta.last_row_id, sig.id));
        } catch {
          // Slug collision: link as supports, not drop — reversible, notes
          // newest-kept, no status move. The duplicate proposal is free
          // corroborating evidence for the existing row.
          const existing = await env.DB.prepare("SELECT id FROM opportunities WHERE slug = ?").bind(slug).first().catch(() => null);
          if (existing && existing.id) {
            state.updated++;
            verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?").bind(existing.id, sig.id));
            verdictWrites.push(env.DB.prepare(`UPDATE opportunities SET notes = substr(notes || ?, -8000), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).bind(`\n[signal ${new Date().toISOString().slice(0, 10)}] ${sig.title} — ${sig.url}`, existing.id));
          } else {
            verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id));
          }
        }
      } else if (v.action === "supports" && v.opportunity_id) {
        state.updated++;
        verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?")
          .bind(v.opportunity_id, sig.id));
        verdictWrites.push(env.DB.prepare(
          `UPDATE opportunities SET notes = substr(notes || ?, -8000),
           updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
          .bind(`\n[signal ${new Date().toISOString().slice(0, 10)}] ${sig.title} — ${sig.url}`,
            v.opportunity_id));
      } else {
        verdictWrites.push(env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id));
      }
    }
    if (verdictWrites.length) await env.DB.batch(verdictWrites);

    // 3. One AI pass: brief one bare row — top-scored, or oldest-unreviewed-first past 48h —
    // unless the clock is nearly spent (it lands on a later run instead).
    let briefMode = "skipped";
    let briefFailed = false; // a brief parse/insert threw: named in the run log, retried next tick
    let bare = null;
    // Backlog age shared by the brief-mode flip and the extra-brief gate: one
    // oldest-unreviewed query per run (new proposals land newer, so the oldest
    // cannot change mid-run).
    let oldestUnreviewedAgeMs = NaN;
    if (Date.now() - t0 < briefDeadline) {
      briefMode = "top-scored";
      if (trigger === "cron") {
        const oldestForBrief = await env.DB.prepare("SELECT created_at FROM opportunities WHERE notes LIKE ? ORDER BY created_at ASC LIMIT 1").bind(String.fromCharCode(37) + "UNREVIEWED" + String.fromCharCode(37)).first().catch(() => null);
        const ageMsForBrief = oldestForBrief && oldestForBrief.created_at ? Date.now() - Date.parse(oldestForBrief.created_at) : NaN;
        oldestUnreviewedAgeMs = ageMsForBrief;
        if (Number.isFinite(ageMsForBrief) && ageMsForBrief > 48 * 3600000) {
          briefMode = "oldest-first";
        }
      }
      if (briefMode === "oldest-first") {
        bare = await env.DB.prepare("SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL AND o.notes LIKE ? ORDER BY o.created_at ASC LIMIT 1").bind(String.fromCharCode(37) + "UNREVIEWED" + String.fromCharCode(37)).first().catch(() => null);
      } else {
        bare = await env.DB.prepare(
      `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id
       WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1`).first().catch(() => null); } }
    if (bare) {
      const sigs = await env.DB.prepare(
        "SELECT title, url, snippet FROM signals WHERE opportunity_id = ? ORDER BY id DESC LIMIT 6")
        .bind(bare.id).all().then((r) => r.results || []);
      const text = await aiComplete(env, state, {
        model: AI_BRIEF, fallback: AI_CLASSIFY, maxTokens: BRIEF_TOKENS,
        timeoutMs: 90000, retries: 1,
        messages: [
        { role: "system", content: "You write terse, practical research briefs. Reply with ONLY a JSON object, no prose." },
        { role: "user", content:
          `Write a research brief for this AI money-making opportunity as ONE JSON object with EXACTLY these keys: summary, what_works, numbers, risks, first_steps. Example shape:
{"summary":"2-3 sentences","what_works":"tactics as bullet lines","numbers":[{"claim":"...","source":"..."}],"risks":"...","first_steps":"numbered lines for week 1"}.
If you lack verified facts for a section, write that explicitly instead of inventing specifics.
Opportunity: ${bare.title} — ${bare.one_liner}
Signals:\n${sigs.map((s) => `- ${s.title} (${s.url}) ${s.snippet}`).join("\n") || "(none — use general knowledge, mark confidence accordingly)"}` },
        ],
      });
      try {
        const m = String(text).match(/\{[\s\S]*\}/);
        const b = JSON.parse(repairJson(m ? m[0] : "{}"));
        // Never store an empty brief (a parsed-but-keyless object once wrote
        // five blank fields). Retry naturally on the next tick instead.
        if (String(b.summary || "").trim() && String(b.first_steps || "").trim()) {
          await env.DB.prepare(
          `INSERT INTO briefs (opportunity_id, version, summary, what_works,
           numbers_json, risks, first_steps, sources_json, author)
           VALUES (?,1,?,?,?,?,?,?,'agent')`
        ).bind(bare.id, String(b.summary || ""), String(b.what_works || ""),
          JSON.stringify(b.numbers || []), String(b.risks || ""),
          String(b.first_steps || ""),
          JSON.stringify(sigs.map((s) => ({ title: s.title, url: s.url })))).run();
          state.briefs++;
        }
      } catch { briefFailed = true; /* malformed brief JSON or failed brief write: skip, briefs stay human-seeded */ }
    }

    // When the review backlog is old (>48h), brief one extra oldest-unreviewed
    // bare row per cron tick. Mirrors the brief pass above (retries:0 to stay
    // within MAX_AI_CALLS); best-effort, lands next run on failure. Ungated
    // from the first pass: when the first pass came up empty (bare is null)
    // the oldest row is still briefed here instead of skipping the tick.
    if (trigger === "cron" && state.ai_calls < MAX_AI_CALLS && Date.now() - t0 < briefDeadline) {
      // Reuses the backlog age from the brief-mode check above: no second query.
      if (Number.isFinite(oldestUnreviewedAgeMs) && oldestUnreviewedAgeMs > 48 * 3600000) {
        // Second-oldest when the first pass already took the oldest; the
        // oldest itself when the first pass found nothing (null-safe: no
        // exclusion bind when bare is null).
        const extraBare = bare
          ? await env.DB.prepare(
            `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id
             WHERE b.id IS NULL AND o.notes LIKE '%UNREVIEWED%' AND o.id != ? ORDER BY o.created_at ASC LIMIT 1`
          ).bind(bare.id).first().catch(() => null)
          : await env.DB.prepare(
            `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id
             WHERE b.id IS NULL AND o.notes LIKE '%UNREVIEWED%' ORDER BY o.created_at ASC LIMIT 1`
          ).first().catch(() => null);
        if (extraBare && state.ai_calls < MAX_AI_CALLS) {
          try {
            const sigs2 = await env.DB.prepare(
              "SELECT title, url, snippet FROM signals WHERE opportunity_id = ? ORDER BY id DESC LIMIT 6")
              .bind(extraBare.id).all().then((r) => r.results || []);
            const text2 = await aiComplete(env, state, {
              model: AI_BRIEF, fallback: AI_CLASSIFY, maxTokens: BRIEF_TOKENS,
              timeoutMs: 90000, retries: 0,
              messages: [
                { role: "system", content: "You write terse, practical research briefs. Reply with ONLY a JSON object, no prose." },
                { role: "user", content:
                  `Write a research brief for this AI money-making opportunity as ONE JSON object with EXACTLY these keys: summary, what_works, numbers, risks, first_steps. Example shape:\n` +
                  `{"summary":"2-3 sentences","what_works":"tactics as bullet lines","numbers":[{"claim":"...","source":"..."}],"risks":"...","first_steps":"numbered lines for week 1"}.\n` +
                  `If you lack verified facts for a section, write that explicitly instead of inventing specifics.\n` +
                  `Opportunity: ${extraBare.title} — ${extraBare.one_liner}\nSignals:\n${sigs2.map((s) => `- ${s.title} (${s.url}) ${s.snippet}`).join("\n") || "(none — use general knowledge, mark confidence accordingly)"}` },
              ],
            });
            const m2 = String(text2).match(/\{[\s\S]*\}/);
            const b2 = JSON.parse(repairJson(m2 ? m2[0] : "{}"));
            if (String(b2.summary || "").trim() && String(b2.first_steps || "").trim()) {
              await env.DB.prepare(
              `INSERT INTO briefs (opportunity_id, version, summary, what_works,
               numbers_json, risks, first_steps, sources_json, author)
               VALUES (?,1,?,?,?,?,?,?,'agent')`
              ).bind(extraBare.id, String(b2.summary || ""), String(b2.what_works || ""),
                JSON.stringify(b2.numbers || []), String(b2.risks || ""),
                String(b2.first_steps || ""),
                JSON.stringify(sigs2.map((s) => ({ title: s.title, url: s.url })))).run();
              state.briefs++;
            }
          } catch { briefFailed = true; /* extra brief is best-effort; lands next run */ }
        }
      }
    }
    // Single run-log write carrying the brief mode (a bare finish used to run
    // first and be overwritten here).
    await finish("ok", (briefMode === "skipped" ? "" : "brief:" + briefMode) + (state.stale ? ` stale:${state.stale}` : "") + (state.src_fail.length ? ` src_fail:${state.src_fail.join(",")}` : "") + (briefFailed ? " brief:failed" : ""));
    return { status: "ok", ...(!fresh.length ? { note: "no fresh signals" } : {}), ...state };
  } catch (e) {
    await finish("error", e && e.message || e);
    return { status: "error", error: String(e && e.message || e), ...state };
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runResearch(env, "cron").catch(() => null));
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      // A dead database must read as unhealthy: ok:false (503) when the
      // last-run read fails or DB is unbound, so the surface and the
      // verify.sh worker-status gate fail closed instead of passing green.
      if (!env.DB) return json({ ok: false, agent: "research-v1", last_run: null }, 503);
      let last;
      try {
        last = await env.DB.prepare(
          "SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1").first();
      } catch {
        return json({ ok: false, agent: "research-v1", last_run: null }, 503);
      }
      return json({ ok: true, agent: "research-v1", last_run: last });
    }
    if (request.method === "GET" && url.pathname === "/ping-ai") {
      const want = (env.ADMIN_TOKEN || "").trim();
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!tokensMatch(got, want)) return json({ error: "unauthorized" }, 401);
      const t0 = Date.now();
      try {
        const r = await env.AI.run(AI_CLASSIFY, {
          messages: [{ role: "user", content: "Reply with exactly: ok" }],
          max_tokens: 5,
        });
        return json({ ok: true, ms: Date.now() - t0, sample: String(r.response || "").slice(0, 20) });
      } catch (e) {
        return json({ ok: false, ms: Date.now() - t0, error: String(e && e.message || e).slice(0, 200) }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/debug-classify") {
      const want = (env.ADMIN_TOKEN || "").trim();
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!tokensMatch(got, want)) return json({ error: "unauthorized" }, 401);
      const fresh = await env.DB.prepare(
        "SELECT * FROM signals WHERE processed = 0 ORDER BY id ASC LIMIT ?")
        .bind(MAX_AI_SIGNALS).all().then((r) => r.results || []);
      const opps = await env.DB.prepare(
        "SELECT id, slug, title, status, score FROM opportunities ORDER BY score DESC LIMIT 60")
        .all().then((r) => r.results || []);
      const prompt = [
        { role: "system", content: "You triage money-making-with-AI leads. Reply with one JSON object per line (NDJSON), no prose, no array, no fences. Keep every value short." },
        { role: "user", content:
          `PRIORITY LIST (id | title | status):\n` +
          opps.map((o) => `${o.id} | ${o.title} | ${o.status}`).join("\n") +
          `\n\nFRESH SIGNALS (n | source | title | url):\n` +
          fresh.map((s, i) => `${i} | ${s.source} | ${s.title} | ${s.url}`).join("\n") +
          `\n\nFor each signal index 0..${fresh.length - 1} emit exactly one line:\n` +
          `{"n":i,"action":"new"|"supports"|"noise","opportunity_id":id or null,"title":"short","one_liner":"under 20 words","category":"services|agency|saas|content|products|other","value":1-10,"effort":1-10,"confidence":1-10,"fit":1-10,"est_monthly_low":0,"est_monthly_high":0,"capital_needed":"$0","time_to_first_dollar":"2-4 weeks"} For "new", also estimate est_monthly_low/high ($/mo integers, low<=high), capital_needed ("$0" style, <=120 chars) and time_to_first_dollar ("2-4 weeks" style, <=120 chars); omit any you cannot estimate (safe defaults apply).` },
      ];
      const t0 = Date.now();
      try {
        const r = await env.AI.run(AI_CLASSIFY, { messages: prompt, max_tokens: CLASSIFY_TOKENS });
        const raw = String(r.response || "");
        return json({ ok: true, ms: Date.now() - t0, raw_len: raw.length,
          raw_head: raw.slice(0, 2000), parsed: parseJsonLines(raw).length });
      } catch (e) {
        return json({ ok: false, ms: Date.now() - t0,
          error: String(e && e.message || e).slice(0, 300) }, 500);
      }
    }
    if (request.method === "POST" && url.pathname === "/run") {
      const want = (env.ADMIN_TOKEN || "").trim();
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!tokensMatch(got, want)) return json({ error: "unauthorized" }, 401);
      // Accepted, not awaited: a research pass outlives the fetch-handler
      // wall clock, so it runs in waitUntil exactly like the cron path.
      // Watch progress at GET / and in the dashboard research log.
      ctx.waitUntil(runResearch(env, "manual").catch(() => null));
      return json({ status: "accepted", briefs_skipped: true, reason: "manual skips brief pass" }, 202);
    }
    return json({ error: "not found" }, 404);
  },
};

