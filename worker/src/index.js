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
const MAX_AI_CALLS = 4;
const FETCH_TIMEOUT_MS = 6000;
const CLASSIFY_TOKENS = 700;
const BRIEF_TOKENS = 900;
const BRIEF_DEADLINE_MS = 18000; // skip the brief pass past this elapsed time
// Runs stuck in "running" past this are declared dead by the next run.
const STUCK_RUN_MINUTES = 30;

const HN_QUERIES = ["AI passive income", "AI SaaS revenue", "AI automation agency", "make money with AI"];
const REDDIT_QUERIES = ["AI side income", "AI SaaS", "AI agency"];
const REDDITS = "SideProject+Entrepreneur+alphaandbeta+startups";
const GITHUB_QUERIES = ["ai-saas-boilerplate", "ai-money", "ai-side-project"];

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

async function hnSignals() {
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
    } catch { /* source hiccup must not kill the run */ }
    return out;
  };
  return (await Promise.all(HN_QUERIES.map(one))).flat();
}

async function redditSignals() {
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
    } catch { /* 429s happen; HN usually carries the run */ }
    return out;
  };
  return (await Promise.all(REDDIT_QUERIES.map(one))).flat();
}

async function githubSignals() {
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
    } catch { /* unauth rate limit is 10 req/min; fine at this volume */ }
    return out;
  };
  return (await Promise.all(GITHUB_QUERIES.slice(0, 2).map(one))).flat();
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

import { clamp10, slugify, scoreOf, parseJsonArray } from "./lib.js";

async function runResearch(env, trigger) {
  const state = { ai_calls: 0, added: 0, updated: 0, briefs: 0, seen: 0 };
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
    const batches = await Promise.allSettled([hnSignals(), redditSignals(), githubSignals()]);
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
    await mark("collected");
    const fresh = await env.DB.prepare(
      "SELECT * FROM signals WHERE processed = 0 ORDER BY id DESC LIMIT ?")
      .bind(MAX_AI_SIGNALS).all().then((r) => r.results || []);
    if (!fresh.length) {
      await finish("ok");
      return { status: "ok", note: "no fresh signals", ...state };
    }

    // 2. One AI pass: classify signals against the live priority list.
    const opps = await env.DB.prepare(
      "SELECT id, slug, title, status, score FROM opportunities ORDER BY score DESC LIMIT 60")
      .all().then((r) => r.results || []);
    const classifyPrompt = [
      { role: "system", content: "You triage money-making-with-AI leads. Reply with ONLY a JSON array, no prose." },
      { role: "user", content:
        `PRIORITY LIST (id | slug | title | status | score):\n` +
        opps.map((o) => `${o.id} | ${o.slug} | ${o.title} | ${o.status} | ${o.score}`).join("\n") +
        `\n\nFRESH SIGNALS (n | source | title | snippet | url):\n` +
        fresh.map((s, i) => `${i} | ${s.source} | ${s.title} | ${s.snippet} | ${s.url}`).join("\n") +
        `\n\nFor each signal index 0..${fresh.length - 1} emit one object:
{"n":i,"action":"new"|"supports"|"noise","opportunity_id":id|null,"title":"...","one_liner":"...","category":"...","value":1-10,"effort":1-10,"confidence":1-10,"fit":1-10,"why":"..."}.
Rules: "new" only for a genuinely NEW money-making method not on the list (be strict — variants are "supports" or "noise"). value=realistic monthly revenue at modest scale (10≈$10k+/mo). effort=weeks to first dollar (10≈6+ months). confidence=evidence strength. fit=leverage of automation/bot/content skills. "supports" needs the matching opportunity_id.` },
    ];
    await mark("classify-ai");
    const isCron = trigger === "cron";
    const verdicts = parseJsonArray(await aiComplete(env, state, {
      model: AI_CLASSIFY, fallback: AI_BRIEF, maxTokens: CLASSIFY_TOKENS,
      messages: classifyPrompt,
      timeoutMs: isCron ? 60000 : 12000, retries: isCron ? 1 : 0,
    }));
    await mark(`classified:${verdicts.length}`);
    for (const v of verdicts) {
      const sig = fresh[v.n];
      if (!sig) continue;
      if (v.action === "new" && v.title) {
        const slug = slugify(v.title) || `agent-${sig.id}`;
        const o = { value: clamp10(v.value), effort: clamp10(v.effort),
          confidence: clamp10(v.confidence, 3), fit: clamp10(v.fit) };
        try {
          const r = await env.DB.prepare(
            `INSERT INTO opportunities (slug, title, one_liner, category, status,
             value, effort, confidence, fit, score, source, source_url, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(slug, String(v.title).slice(0, 200), String(v.one_liner || "").slice(0, 500),
            String(v.category || "other").slice(0, 40), "researching",
            o.value, o.effort, o.confidence, o.fit, scoreOf(o),
            "agent", String(sig.url || "").slice(0, 500),
            `Agent proposal: ${String(v.why || "").slice(0, 1000)}`).run();
          state.added++;
          await env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?")
            .bind(r.meta.last_row_id, sig.id).run();
        } catch {
          await env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id).run();
        }
      } else if (v.action === "supports" && v.opportunity_id) {
        state.updated++;
        await env.DB.prepare("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?")
          .bind(v.opportunity_id, sig.id).run();
        await env.DB.prepare(
          `UPDATE opportunities SET notes = substr(notes || ?, 1, 8000),
           updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
          .bind(`\n[signal ${new Date().toISOString().slice(0, 10)}] ${sig.title} — ${sig.url}`,
            v.opportunity_id).run().catch(() => null);
      } else {
        await env.DB.prepare("UPDATE signals SET processed=1 WHERE id=?").bind(sig.id).run();
      }
    }

    // 3. One AI pass: brief the highest-scored opportunity that has no brief —
    // unless the clock is nearly spent (it lands on a later run instead).
    const bare = (Date.now() - t0 < briefDeadline) ? await env.DB.prepare(
      `SELECT o.* FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id
       WHERE b.id IS NULL ORDER BY o.score DESC LIMIT 1`).first() : null;
    if (bare) {
      const sigs = await env.DB.prepare(
        "SELECT title, url, snippet FROM signals WHERE opportunity_id = ? ORDER BY id DESC LIMIT 6")
        .bind(bare.id).all().then((r) => r.results || []);
      await mark("brief-ai");
      const text = await aiComplete(env, state, {
        model: AI_BRIEF, fallback: AI_CLASSIFY, maxTokens: BRIEF_TOKENS,
        timeoutMs: 90000, retries: 1,
        messages: [
        { role: "system", content: "You write terse, practical research briefs. Reply with ONLY a JSON object, no prose." },
        { role: "user", content:
          `Write a research brief for this AI money-making opportunity as JSON:
{"summary":"2-3 sentences","what_works":"tactics as bullet lines","numbers":[{"claim":"...","source":"..."}],"risks":"...","first_steps":"numbered lines for week 1"}.
Opportunity: ${bare.title} — ${bare.one_liner}
Signals:\n${sigs.map((s) => `- ${s.title} (${s.url}) ${s.snippet}`).join("\n") || "(none — use general knowledge, mark confidence accordingly)"}` },
        ],
      });
      try {
        const m = String(text).match(/\{[\s\S]*\}/);
        const b = JSON.parse(m ? m[0] : "{}");
        await env.DB.prepare(
          `INSERT INTO briefs (opportunity_id, version, summary, what_works,
           numbers_json, risks, first_steps, sources_json, author)
           VALUES (?,1,?,?,?,?,?,?,'agent')`
        ).bind(bare.id, String(b.summary || ""), String(b.what_works || ""),
          JSON.stringify(b.numbers || []), String(b.risks || ""),
          String(b.first_steps || ""),
          JSON.stringify(sigs.map((s) => ({ title: s.title, url: s.url })))).run();
        state.briefs++;
      } catch { /* malformed brief JSON: skip, briefs stay human-seeded */ }
    }

    await finish("ok");
    return { status: "ok", ...state };
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
      const last = await env.DB.prepare(
        "SELECT * FROM agent_runs ORDER BY id DESC LIMIT 1").first().catch(() => null);
      return json({ ok: true, agent: "research-v1", last_run: last });
    }
    if (request.method === "GET" && url.pathname === "/ping-ai") {
      const want = (env.ADMIN_TOKEN || "").trim();
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!want || got !== want) return json({ error: "unauthorized" }, 401);
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
    if (request.method === "POST" && url.pathname === "/run") {
      const want = (env.ADMIN_TOKEN || "").trim();
      const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!want || got !== want) return json({ error: "unauthorized" }, 401);
      // Accepted, not awaited: a research pass outlives the fetch-handler
      // wall clock, so it runs in waitUntil exactly like the cron path.
      // Watch progress at GET / and in the dashboard research log.
      ctx.waitUntil(runResearch(env, "manual").catch(() => null));
      return json({ status: "accepted" }, 202);
    }
    return json({ error: "not found" }, 404);
  },
};
