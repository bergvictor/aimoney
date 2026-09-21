// Research worker regression tests (round2 Task 2): POST /run discloses the
// triage-only split, and cron ticks carry the extra-brief backlog guard.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker, { agentMoneyEstimates, exactUrlTarget } from "./index.js";

describe("manual run disclosure (/run)", () => {
  it("202 carries briefs_skipped:true with a reason", async () => {
    const req = new Request("http://localhost/run", {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });
    const env = { ADMIN_TOKEN: "secret", DB: null, AI: null };
    const ctx = { waitUntil(p) { if (p && p.catch) p.catch(() => {}); } };
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, "accepted");
    assert.equal(body.briefs_skipped, true);
    assert.ok(body.reason && body.reason.length > 0);
  });

  it("still 401s without the admin token", async () => {
    const req = new Request("http://localhost/run", { method: "POST" });
    const env = { ADMIN_TOKEN: "secret", DB: null, AI: null };
    const ctx = { waitUntil() {} };
    const res = await worker.fetch(req, env, ctx);
    assert.equal(res.status, 401);
  });
});

describe("main brief oldest-first on old backlog (static guard)", () => {
  it("flips the main brief past 48h with mode disclosure", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("briefMode"), "worker lost the briefMode flag");
    assert.ok(src.includes("oldest-first"), "worker lost the oldest-first mode");
    assert.ok(src.includes("top-scored"), "worker lost the top-scored default");
    assert.ok(src.includes("oldestForBrief"), "main brief lost the backlog age check");
    assert.ok(src.includes("ORDER BY o.created_at ASC LIMIT 1"), "main brief lost the oldest-first query");
    assert.ok(src.includes("ORDER BY o.score DESC LIMIT 1"), "main brief lost the top-scored query");
    assert.ok(src.includes("brief:"), "run log lost the brief mode disclosure");
  });
});

describe("oldest-first triage with staleness bound (static guard)", () => {
  it("takes the oldest unprocessed signals first in the pass and the debug probe", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("SELECT * FROM signals WHERE processed = 0 ORDER BY id ASC LIMIT"), "triage lost the oldest-first take");
    assert.ok(!src.includes("SELECT * FROM signals WHERE processed = 0 ORDER BY id DESC"), "triage still starves older signals newest-first");
  });

  it("marks signals older than 30d as noise with a count", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("UPDATE signals SET processed = 1 WHERE processed = 0"), "worker lost the stale-mark UPDATE");
    assert.ok(src.includes("-30 days"), "worker lost the 30-day staleness bound");
    assert.ok(src.includes("state.stale"), "worker lost the stale-signal count");
  });
});

describe("brief on quiet ticks (audit 2026-09-20-round3 Task 2)", () => {
  it("zero fresh signals still reach the brief pass; classify AI stays skipped", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("!fresh.length ? [] : parseJsonLines(await aiComplete"), "classify AI call lost its empty-fresh guard");
    const briefAt = src.indexOf('state.briefs++');
    assert.ok(briefAt !== -1, "worker lost the brief pass");
    const firstFinish = src.indexOf('await finish("ok",');
    assert.ok(firstFinish !== -1 && firstFinish > briefAt, "quiet tick still finishes before the brief pass");
    const noteAt = src.indexOf('note: "no fresh signals"');
    assert.ok(noteAt !== -1 && noteAt > briefAt, "quiet-tick note must only appear at the final return, after the brief pass");
  });

  it("manual runs still skip the brief pass by deadline", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes('trigger === "cron" ? 300000 : -1'), "manual path lost its brief-skipping deadline");
  });
});

describe("single run-finish write (audit 2026-09-20-round1 Task 3)", () => {
  it("finishes the run log exactly once, carrying the brief mode", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split('await finish("ok"').length - 1, 1, "run must finish the run log exactly once");
    assert.ok(src.includes('await finish("ok", (briefMode'), "the single finish must carry the brief-mode message");
  });
});

describe("shared oldest-unreviewed query (audit 2026-09-20-round1 Task 3)", () => {
  it("brief mode and extra brief share one oldest query per run", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("SELECT created_at FROM opportunities WHERE notes LIKE").length - 1, 1, "oldest-unreviewed must be queried once per run");
    assert.ok(src.includes("oldestUnreviewedAgeMs"), "worker lost the shared backlog-age variable");
  });
});

describe("agent money estimates (audit 2026-09-20-round1 Task 1)", () => {
  it("triage verdict schema asks for the four money keys", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    for (const k of ["est_monthly_low", "est_monthly_high", "capital_needed", "time_to_first_dollar"]) {
      assert.ok(src.includes(`"${k}"`), `classify schema lost "${k}"`);
    }
    // Both the live pass and /debug-classify carry the schema.
    assert.ok(src.indexOf("est_monthly_low") !== src.lastIndexOf("est_monthly_low"), "money schema must appear in both classify prompts");
  });

  it("new-row INSERT persists the four money columns", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("est_monthly_low, est_monthly_high,"), "INSERT lost the $/mo columns");
    assert.ok(src.includes("capital_needed, time_to_first_dollar,"), "INSERT lost the capital/first-$ columns");
    assert.ok(src.includes("m.est_monthly_low, m.est_monthly_high, m.capital_needed, m.time_to_first_dollar"), "INSERT lost the money binds");
  });

  it("notes tag the estimates for correction on vet", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("agent estimates — correct on vet"), "new-row notes lost the agent-estimates tag");
  });

  it("same AI budget, no status moves, manual skip intact", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
  });

  it("README names the estimate fields and their reversibility", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("est_monthly_low") && readme.includes("time_to_first_dollar"), "README lost the estimate field names");
    assert.ok(readme.includes("agent estimates — correct on vet"), "README lost the estimates tag");
    assert.ok(readme.includes("reversible"), "README lost the reversibility rule");
  });
});

describe("agentMoneyEstimates", () => {
  it("passes sane estimates through", () => {
    assert.deepEqual(agentMoneyEstimates({ est_monthly_low: 500, est_monthly_high: 5000, capital_needed: "$0-200/mo tools", time_to_first_dollar: "2-4 weeks" }),
      { est_monthly_low: 500, est_monthly_high: 5000, capital_needed: "$0-200/mo tools", time_to_first_dollar: "2-4 weeks" });
  });

  it("defaults missing keys to 0/0/''/''", () => {
    const dflt = { est_monthly_low: 0, est_monthly_high: 0, capital_needed: "", time_to_first_dollar: "" };
    assert.deepEqual(agentMoneyEstimates({}), dflt);
    assert.deepEqual(agentMoneyEstimates(null), dflt);
    assert.deepEqual(agentMoneyEstimates(undefined), dflt);
  });

  it("clamps malformed numbers to 0 instead of NaN/negatives", () => {
    const m = agentMoneyEstimates({ est_monthly_low: "bogus", est_monthly_high: -500, capital_needed: 123, time_to_first_dollar: null });
    assert.equal(m.est_monthly_low, 0);
    assert.equal(m.est_monthly_high, 0);
    assert.equal(m.capital_needed, "123");
    assert.equal(m.time_to_first_dollar, "");
  });

  it("clamps an inverted range high up to low, never rejects", () => {
    const m = agentMoneyEstimates({ est_monthly_low: 5000, est_monthly_high: 500 });
    assert.equal(m.est_monthly_low, 5000);
    assert.equal(m.est_monthly_high, 5000);
  });

  it("floors fractional dollars and truncates long strings to 120", () => {
    const m = agentMoneyEstimates({ est_monthly_low: 99.9, est_monthly_high: 100.9, capital_needed: "x".repeat(200), time_to_first_dollar: "y".repeat(200) });
    assert.equal(m.est_monthly_low, 99);
    assert.equal(m.est_monthly_high, 100);
    assert.equal(m.capital_needed.length, 120);
    assert.equal(m.time_to_first_dollar.length, 120);
  });
});

describe("slug-collision link-as-supports (audit 2026-09-20-round3 Task 3)", () => {
  it("links the colliding signal to the existing row, never drops it", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("Slug collision: link as supports"), "worker lost the collision rule comment");
    assert.ok(src.includes("SELECT id FROM opportunities WHERE slug = ?"), "collision lost the existing-row lookup by slug");
    assert.ok(src.includes("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?"), "collision must set the signal parent");
    assert.ok(src.includes("substr(notes || ?, -8000)"), "collision must append evidence newest-kept");
    assert.ok(src.includes("[signal ${new Date().toISOString().slice(0, 10)}]"), "collision must reuse the supports evidence line");
    assert.ok(src.includes("state.updated++"), "collision-as-supports must count as updated");
  });

  it("adds no AI calls and no status moves", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
  });

  it("README states the collision rule", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("slug collision"), "README lost the collision rule");
    assert.ok(readme.includes("supports"), "README must say link-as-supports");
    assert.ok(readme.includes("reversible"), "README must say reversible");
    assert.ok(readme.includes("no status move"), "README must say no status move");
  });
});

describe("exact-URL supports pre-pass (audit 2026-09-20-round1 Task 2)", () => {
  it("links exact-URL matches as supports before triage, excluded from the classify prompt", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("Exact-URL supports pre-pass"), "worker lost the pre-pass block");
    assert.ok(src.includes("exactUrlTarget(sig.url, oppUrls, linkedUrls)"), "pre-pass must match each taken signal by exact URL");
    assert.ok(src.includes("SELECT id, source_url FROM opportunities"), "pre-pass lost the opportunity URL lookup");
    assert.ok(src.includes("opportunity_id IS NOT NULL"), "pre-pass lost the linked-signal URL lookup");
    assert.ok(src.includes("fresh.push(...rest)"), "pre-pass must exclude linked signals from the classify prompt");
    assert.ok(src.includes("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?"), "pre-pass must set the signal parent");
    assert.ok(src.includes("substr(notes || ?, -8000)"), "pre-pass must append evidence newest-kept");
    assert.ok(src.includes("state.updated++"), "pre-pass links must count as updated");
  });

  it("adds no AI calls and no status moves, manual skip intact", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
  });

  it("README states the exact-URL rule", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("exactly matches"), "README lost the exact-URL rule");
    assert.ok(readme.includes("linked as supports before triage"), "README must say linked as supports before triage");
    assert.ok(readme.includes("no AI call"), "README must say no AI call");
  });
});

describe("exactUrlTarget", () => {
  it("matches an existing opportunity source_url exactly", () => {
    assert.equal(exactUrlTarget("https://x.com/a", [{ id: 7, source_url: "https://x.com/a" }], []), 7);
  });

  it("falls back to an already-linked signal URL", () => {
    assert.equal(exactUrlTarget("https://x.com/b", [{ id: 7, source_url: "https://x.com/a" }], [{ url: "https://x.com/b", opportunity_id: 3 }]), 3);
  });

  it("returns null without an exact match", () => {
    assert.equal(exactUrlTarget("https://x.com/c", [{ id: 7, source_url: "https://x.com/a" }], []), null);
    assert.equal(exactUrlTarget("https://x.com/a/", [{ id: 7, source_url: "https://x.com/a" }], []), null);
    assert.equal(exactUrlTarget("HTTPS://X.COM/A", [{ id: 7, source_url: "https://x.com/a" }], []), null);
  });

  it("never matches empty URLs on either side", () => {
    assert.equal(exactUrlTarget("", [{ id: 7, source_url: "https://x.com/a" }], []), null);
    assert.equal(exactUrlTarget(null, [], []), null);
    assert.equal(exactUrlTarget("https://x.com/a", [{ id: 7, source_url: "" }], [{ url: "", opportunity_id: 3 }]), null);
  });
});

describe("extra brief on old backlog (static guard)", () => {
  it("cron path briefs one extra oldest-unreviewed row past 48h within budget", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("extraBare"), "worker lost the extra-brief query");
    assert.ok(src.includes("48 * 3600000"), "worker lost the 48h backlog gate");
    assert.ok(src.includes("retries: 0"), "extra brief must use retries:0 to stay in budget");
    assert.ok(src.includes("state.ai_calls < MAX_AI_CALLS"), "extra brief must respect MAX_AI_CALLS");
  });
});

describe("new-proposal inflow cap (audit 2026-09-20-round2 Task 2)", () => {
  it("caps new inserts at 2 per run; overflow stays unprocessed for a later tick", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("const MAX_NEW_PER_RUN = 2;"), "worker lost the inflow cap");
    assert.ok(src.includes("newInserts >= MAX_NEW_PER_RUN"), "worker lost the overflow guard");
    assert.ok(src.includes("stay processed = 0"), "overflow must stay processed = 0 for a later tick");
    assert.ok(src.includes("newInserts++"), "worker lost the new-insert count");
  });

  it("noise/supports paths, verdict validation, and manual disclosure untouched", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes('v.action !== "new" && v.action !== "supports" && v.action !== "noise"'), "verdict validation changed");
    assert.ok(src.includes("supports without a valid id is noise"), "supports guard changed");
    assert.ok(src.includes("UPDATE signals SET processed=1, opportunity_id=? WHERE id=?"), "supports path changed");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
    assert.ok(src.includes("-30 days"), "worker lost the 30-day staleness bound");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
  });

  it("README states the inflow rule", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("at most 2 new proposals"), "README lost the inflow cap");
    assert.ok(readme.includes("stay unprocessed for a later tick"), "README lost the retake rule");
    assert.ok(readme.includes("inflow"), "README lost the inflow rule");
    assert.ok(readme.includes("reversible"), "README must say reversible");
    assert.ok(readme.includes("no status move"), "README must say no status move");
  });
});

describe("bounded pre-pass + skipped classify fetch (audit 2026-09-20-round3 Task 1)", () => {
  it("quiet ticks skip the top-60 list query and the prompt build", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    // The live-pass fetch sits inside the fresh guard (the /debug-classify
    // probe keeps its own unconditional copy later in the file).
    const vStart = src.indexOf("let verdicts = [];");
    const guardAt = src.indexOf("if (fresh.length) {", vStart);
    const fetchAt = src.indexOf("SELECT id, slug, title, status, score", vStart);
    const promptAt = src.indexOf("const classifyPrompt = [", vStart);
    assert.ok(vStart !== -1, "worker lost the quiet-tick verdicts default");
    assert.ok(guardAt !== -1 && guardAt < fetchAt && guardAt < promptAt, "top-60 fetch and prompt build must sit inside the fresh guard");
    assert.ok(src.includes("!fresh.length ? [] : parseJsonLines(await aiComplete"), "classify AI call lost its empty-fresh guard");
  });

  it("pre-pass matches via bounded IN selects, not full-table URL loads", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("WHERE source_url IN ("), "opportunity pre-pass lost its bounded IN select");
    assert.ok(src.includes("AND url IN ("), "linked-signal pre-pass lost its bounded IN select");
    assert.ok(!src.includes("WHERE source_url != ''"), "opportunity pre-pass still loads the full URL table");
    assert.ok(!src.includes("AND url != ''"), "linked-signal pre-pass still loads the full URL table");
    assert.ok(src.includes("freshUrls"), "pre-pass lost its fresh-URL set");
    assert.ok(src.includes("exactUrlTarget(sig.url, oppUrls, linkedUrls)"), "pre-pass must still match via exactUrlTarget");
    assert.ok(src.includes("fresh.push(...rest)"), "pre-pass must still exclude linked signals from the classify prompt");
  });

  it("keeps verdicts, links, AI budget, status rules, and manual skip", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
    assert.ok(src.includes("state.updated++"), "pre-pass links must count as updated");
  });
});

describe("batched verdict writes + single heartbeat (audit 2026-09-20-round3 Task 3)", () => {
  it("per-verdict signal/note writes go out as one env.DB.batch", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("const verdictWrites = [];"), "worker lost the verdict-writes accumulator");
    assert.ok(src.includes("if (verdictWrites.length) await env.DB.batch(verdictWrites);"), "verdict writes must flush as one batch");
    const loop = src.slice(src.indexOf("for (const v of verdicts)"), src.indexOf("if (verdictWrites.length)"));
    assert.ok(loop.includes("verdictWrites.push"), "verdict loop must accumulate into the batch");
    assert.equal(loop.split("await env.DB.prepare").length - 1, 2, "only the new-row INSERT and the slug-collision lookup stay inline");
    assert.ok(src.includes("SELECT id FROM opportunities WHERE slug = ?"), "slug-collision lookup must stay inline");
  });

  it("keeps one post-collect heartbeat plus the single finish write", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await mark(").length - 1, 1, "worker must keep exactly one mid-run heartbeat");
    assert.ok(src.includes('await mark(state.stale ? `collected stale:${state.stale}` : "collected")'), "the kept heartbeat must be the post-collect one");
    assert.equal(src.split('await finish("ok"').length - 1, 1, "run must finish the run log exactly once");
    assert.ok(src.includes('await finish("ok", (briefMode'), "the single finish must carry the brief-mode message");
  });

  it("verdict outcomes, inflow cap, AI budget, and run-log row unchanged", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes('v.action !== "new" && v.action !== "supports" && v.action !== "noise"'), "verdict validation changed");
    assert.ok(src.includes("supports without a valid id is noise"), "supports guard changed");
    assert.ok(src.includes("const MAX_NEW_PER_RUN = 2;"), "worker lost the inflow cap");
    assert.ok(src.includes("newInserts >= MAX_NEW_PER_RUN"), "worker lost the overflow guard");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("INSERT INTO opportunities (slug, title, one_liner"), "new-row INSERT changed");
  });
});

describe("failed-source + failed-brief markers (audit 2026-09-20-round2 Task 3)", () => {
  it("per-query throw marks its source; all-failed sources land in state.src_fail", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("src_fail: []"), "state lost the failed-source list");
    assert.ok(src.includes("async function hnSignals(state)"), "hnSignals lost its state arg");
    assert.ok(src.includes("async function redditSignals(state)"), "redditSignals lost its state arg");
    assert.ok(src.includes("async function githubSignals(state)"), "githubSignals lost its state arg");
    assert.ok(src.includes("failed === HN_QUERIES.length"), "hn lost its all-queries-failed check");
    assert.ok(src.includes("failed === REDDIT_QUERIES.length"), "reddit lost its all-queries-failed check");
    assert.ok(src.includes("failed === queries.length"), "github lost its all-queries-failed check");
    assert.ok(src.includes('state.src_fail.push("hn")'), "hn lost its failure report");
    assert.ok(src.includes('state.src_fail.push("reddit")'), "reddit lost its failure report");
    assert.ok(src.includes('state.src_fail.push("github")'), "github lost its failure report");
    assert.ok(src.includes("Promise.allSettled([hnSignals(state), redditSignals(state), githubSignals(state)])"), "collectors lost their state arg at the collect site");
  });

  it("finish-ok error line appends src_fail beside brief/stale; quiet ticks carry none", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("src_fail:"), "run log lost the src_fail marker");
    assert.ok(src.includes("state.src_fail.join"), "run log lost the failed-source list");
    assert.ok(src.includes("state.src_fail.length ?"), "src_fail suffix must be conditional (quiet ticks carry none)");
  });

  it("failed brief parse/insert records brief:failed, keeping skip-and-retry", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("briefFailed"), "worker lost the brief-failure flag");
    assert.equal(src.split("briefFailed = true").length - 1, 2, "both brief catches must record the failure");
    assert.ok(src.includes('" brief:failed"'), "run log lost the brief:failed marker");
    assert.equal(src.split('await finish("ok"').length - 1, 1, "run must finish the run log exactly once");
  });

  it("same AI budget, no status moves, manual brief-skip intact", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
    assert.ok(src.includes('trigger === "cron" ? 300000 : -1'), "manual path lost its brief-skipping deadline");
  });

  it("README names the src_fail and brief:failed markers", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("src_fail"), "README lost the failed-source marker");
    assert.ok(readme.includes("brief:failed"), "README lost the failed-brief marker");
  });
});

describe("agentMoneyEstimates zero-spend normalization (audit 2026-09-20-round2 Task 3)", () => {
  it("prefixes bare 0/free/none phrasings with $0, raw phrasing preserved", () => {
    assert.equal(agentMoneyEstimates({ capital_needed: "Free" }).capital_needed, "$0 Free");
    assert.equal(agentMoneyEstimates({ capital_needed: "none" }).capital_needed, "$0 none");
    assert.equal(agentMoneyEstimates({ capital_needed: "0" }).capital_needed, "$0 0");
    assert.equal(agentMoneyEstimates({ capital_needed: "  FREE trial  " }).capital_needed, "$0 FREE trial");
  });

  it("leaves $0-form, non-zero, and empty capital untouched", () => {
    assert.equal(agentMoneyEstimates({ capital_needed: "$0-200/mo tools" }).capital_needed, "$0-200/mo tools");
    assert.equal(agentMoneyEstimates({ capital_needed: "$100/mo" }).capital_needed, "$100/mo");
    assert.equal(agentMoneyEstimates({ capital_needed: "unknown" }).capital_needed, "unknown");
    assert.equal(agentMoneyEstimates({ capital_needed: "freelancer fees" }).capital_needed, "freelancer fees");
    assert.equal(agentMoneyEstimates({}).capital_needed, "");
  });

  it("normalized values still fit the 120-char column", () => {
    const m = agentMoneyEstimates({ capital_needed: "free " + "x".repeat(200) });
    assert.ok(m.capital_needed.startsWith("$0 free "));
    assert.equal(m.capital_needed.length, 120);
  });

  it("same AI budget, no status moves, manual skip intact", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
  });
});

describe("hygiene: dead rails gone, shared auth (audit 2026-09-20-round1 Task 4)", () => {
  it("drops the unenforced deadline, the unused import, and the slice-or-string mismatch", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(!src.includes("BRIEF_DEADLINE_MS"), "worker still ships the unenforced deadline constant");
    assert.ok(!src.includes("scoreOf"), "worker still imports the unused scoreOf");
    assert.ok(!src.includes("ai-side-project"), "worker still lists the unfetched GitHub query");
    assert.ok(!src.includes("slice(0, 2)"), "worker still slices the GitHub query list");
    assert.ok(src.includes("const queries = GITHUB_QUERIES;"), "worker lost the GitHub query list");
    assert.ok(src.includes("failed === queries.length"), "github lost its all-queries-failed check");
  });

  it("all three worker token checks use the shared constant-time compare", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(!src.includes("got !== want"), "worker still compares tokens with !==");
    assert.equal(src.split("tokensMatch(got, want)").length - 1, 3, "ping-ai, debug-classify, and run must all use tokensMatch");
    assert.ok(src.includes("tokensMatch } from \"./lib.js\""), "worker must import tokensMatch from lib.js");
  });

  it("wrong or missing tokens still 401 on run, ping-ai, and debug-classify", async () => {
    const env = { ADMIN_TOKEN: "secret", DB: null, AI: null };
    const ctx = { waitUntil() {} };
    const wrong = new Request("http://localhost/run", {
      method: "POST",
      headers: { authorization: "Bearer [REDACTED]" },
    });
    assert.equal((await worker.fetch(wrong, env, ctx)).status, 401);
    const missing = new Request("http://localhost/run", { method: "POST" });
    assert.equal((await worker.fetch(missing, env, ctx)).status, 401);
    const ping = new Request("http://localhost/ping-ai", { method: "GET" });
    assert.equal((await worker.fetch(ping, env, ctx)).status, 401);
    const debug = new Request("http://localhost/debug-classify", { method: "GET" });
    assert.equal((await worker.fetch(debug, env, ctx)).status, 401);
  });

  // Correct-token acceptance stays pinned by the pre-existing 202 test in
  // "manual run disclosure (/run)" above: it passes the same token the
  // shared compare now checks, so no second copy is kept here.
});

describe("extra brief ungated from first pass (audit 2026-09-20-round3 Task 3)", () => {
  it("extra gate drops the bare requirement but keeps cron, budget, clock, and 48h gates", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(!src.includes('trigger === "cron" && bare &&'), "extra gate still requires the first-pass bare row");
    assert.ok(src.includes('if (trigger === "cron" && state.ai_calls < MAX_AI_CALLS && Date.now() - t0 < briefDeadline)'), "extra gate lost cron/budget/clock");
    assert.ok(src.includes("oldestUnreviewedAgeMs > 48 * 3600000"), "extra gate lost the 48h backlog check");
  });

  it("null bare briefs the oldest row; non-null bare excludes it (second-oldest)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("const extraBare = bare"), "extra query lost its null-bare branch");
    assert.ok(src.includes("AND o.id != ? ORDER BY o.created_at ASC LIMIT 1"), "non-null bare must still exclude the first-pass row");
    assert.ok(src.includes("WHERE b.id IS NULL AND o.notes LIKE '%UNREVIEWED%' ORDER BY o.created_at ASC LIMIT 1"), "null bare must fall back to the oldest unreviewed bare row");
  });

  it("same AI budget, no status moves, one oldest query, manual skip intact", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(src.includes("retries: 0"), "extra brief must use retries:0 to stay in budget");
    assert.equal(src.split("SELECT created_at FROM opportunities WHERE notes LIKE").length - 1, 1, "oldest-unreviewed must be queried once per run");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
  });
});
