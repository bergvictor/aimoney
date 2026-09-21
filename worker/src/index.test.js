// Research worker regression tests (round2 Task 2): POST /run discloses the
// triage-only split, and cron ticks carry the extra-brief backlog guard.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker, { agentMoneyEstimates, buildBriefPrompt, buildClassifyPrompt, exactUrlTarget, flushVerdictWrites, insertBrief, parseBriefJson, runResearch, _resetBriefSkippedForTests } from "./index.js";

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
    // The live pass and /debug-classify share one builder (round3 Task 3),
    // so the schema text lives in exactly one place.
    assert.equal(src.split('"est_monthly_low":0').length - 1, 1, "money schema must live in the shared classify builder only");
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
    // probe shares the same builder through its own call later in the file).
    const vStart = src.indexOf("let verdicts = [];");
    const guardAt = src.indexOf("if (fresh.length) {", vStart);
    const fetchAt = src.indexOf("SELECT id, slug, title, status, score", vStart);
    const promptAt = src.indexOf("buildClassifyPrompt(opps, fresh)", vStart);
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
    assert.ok(src.includes("await flushVerdictWrites(env, verdictWrites)"), "verdict writes must flush via the batch+fallback helper");
    assert.ok(src.includes("export async function flushVerdictWrites"), "worker lost the exported verdict-flush helper");
    assert.ok(src.includes("await env.DB.batch(verdictWrites)"), "flush helper lost the single-batch fast path");
    assert.ok(src.includes("await w.run()"), "flush helper lost the per-write retry");
    const loop = src.slice(src.indexOf("for (const v of verdicts)"), src.indexOf("await flushVerdictWrites(env, verdictWrites)"));
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

describe("verdict batch isolation fallback (audit 2026-09-20-round4 Task 3)", () => {
  it("rejected batch re-runs writes individually, keeps successes, counts failures", async () => {
    const landed = [];
    const ok = (id) => ({ run: async () => { landed.push(id); } });
    const bad = { run: async () => { throw new Error("bad write"); } };
    const env = { DB: { batch: async () => { throw new Error("batch bad"); } } };
    const failed = await flushVerdictWrites(env, [ok("a"), bad, ok("b")]);
    assert.equal(failed, 1);
    assert.deepEqual(landed, ["a", "b"]);
  });

  it("fast path batches once with no individual runs; empty flush batches nothing", async () => {
    let batched = null;
    let runs = 0;
    const env = { DB: { batch: async (stmts) => { batched = stmts; } } };
    const failed = await flushVerdictWrites(env, [{ run: async () => { runs++; } }]);
    assert.equal(failed, 0);
    assert.equal(batched.length, 1);
    assert.equal(runs, 0);
    let batchCalls = 0;
    const emptyEnv = { DB: { batch: async () => { batchCalls++; } } };
    assert.equal(await flushVerdictWrites(emptyEnv, []), 0);
    assert.equal(batchCalls, 0);
  });

  it("run log carries a conditional verdict:N_failed marker beside src_fail/brief:failed", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    const finishLine = src.split("\n").find((l) => l.includes('await finish("ok"'));
    assert.ok(finishLine.includes("src_fail:"), "finish lost the src_fail marker");
    assert.ok(finishLine.includes("brief:failed"), "finish lost the brief:failed marker");
    assert.ok(finishLine.includes("verdict:"), "finish lost the verdict marker");
    assert.ok(src.includes("verdict:${verdictFailed}_failed"), "verdict marker must carry the failure count");
    assert.ok(src.includes("verdictFailed ?"), "verdict suffix must be conditional (clean ticks carry none)");
  });

  it("same inflow cap, AI budget, and no-status-move rules", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("const MAX_NEW_PER_RUN = 2;"), "worker lost the inflow cap");
    assert.ok(src.includes("newInserts >= MAX_NEW_PER_RUN"), "worker lost the overflow guard");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
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

describe("bare-backlog inflow gate (audit 2026-09-20-round2 Task 3)", () => {
  it("caps inserts to 1 per run while bare-without-brief exceeds 10", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("const BARE_BACKLOG_CAP = 10;"), "worker lost the bare-backlog gate threshold");
    assert.ok(src.includes("let maxNewThisRun = MAX_NEW_PER_RUN;"), "worker lost the per-run cap variable");
    assert.ok(src.includes("SELECT COUNT(*) AS n FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL"), "worker lost the once-per-run bare-count query");
    assert.ok(src.includes("Number(bareRow.n) > BARE_BACKLOG_CAP"), "worker lost the bare-backlog comparison");
    assert.ok(src.includes("maxNewThisRun = 1"), "worker lost the 1-per-run gate when backlog exceeds 10");
    assert.ok(src.includes("newInserts >= maxNewThisRun"), "overflow guard must use the gated per-run cap");
    assert.ok(src.includes("stay processed = 0"), "overflow must stay processed = 0 for a later tick");
  });

  it("keeps AI budget, verdict validation, status rules, and manual skip", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes('v.action !== "new" && v.action !== "supports" && v.action !== "noise"'), "verdict validation changed");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
    assert.ok(src.includes("briefs_skipped"), "manual run lost its briefs_skipped disclosure");
  });

  it("README documents the backlog gate in one line", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("while bare-without-brief exceeds 10 the cap drops to 1 for that tick"), "README lost the backlog gate");
    assert.ok(readme.includes("at most 2 new proposals"), "README lost the inflow cap");
  });
});

describe("worker root health honesty (audit 2026-09-20-round3 Task 3)", () => {
  const getRoot = (env) => worker.fetch(new Request("http://localhost/"), env, {});

  it("reports ok:false (503) when the last-run read fails", async () => {
    const failingDB = { prepare: () => ({ first: async () => { throw new Error("D1 down"); } }) };
    const res = await getRoot({ DB: failingDB });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.agent, "research-v1");
    assert.equal(body.last_run, null);
  });

  it("reports ok:false (503) when DB is unbound", async () => {
    for (const DB of [null, undefined]) {
      const res = await getRoot({ DB });
      assert.equal(res.status, 503);
      assert.equal((await res.json()).ok, false);
    }
  });

  it("keeps the healthy shape unchanged, including an empty run log", async () => {
    const row = { id: 1, status: "ok" };
    const okDB = { prepare: () => ({ first: async () => row }) };
    const res = await getRoot({ DB: okDB });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ["ok", "agent", "last_run"]);
    assert.equal(body.ok, true);
    assert.equal(body.agent, "research-v1");
    assert.deepEqual(body.last_run, row);
    // An empty table (null row, answering database) is healthy, not down.
    const emptyDB = { prepare: () => ({ first: async () => null }) };
    const res2 = await getRoot({ DB: emptyDB });
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).ok, true);
  });
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

describe("D1-dead cron tick surfaces in worker logs (audit 2026-09-20-round1 F3)", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  const rejectingDB = () => ({
    prepare: () => ({
      bind: () => ({
        first: async () => { throw new Error("D1 down"); },
        all: async () => { throw new Error("D1 down"); },
        run: async () => { throw new Error("D1 down"); },
      }),
    }),
    batch: async () => { throw new Error("D1 down"); },
  });
  const captureError = async (fn) => {
    const logged = [];
    const orig = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(" ")); };
    try {
      await fn();
    } finally {
      console.error = orig;
    }
    return logged;
  };
  const runTick = async (env) => {
    let waited = null;
    await worker.scheduled({}, env, { waitUntil(p) { waited = p; } });
    await waited;
  };

  it("scheduled no longer swallows cron failures; the tail marker exists", () => {
    const src = readFileSync(SRC, "utf8");
    assert.ok(!src.includes('runResearch(env, "cron").catch(() => null)'), "scheduled still swallows cron failures into silence");
    assert.ok(src.includes("cron-failed"), "worker lost the tail-visible cron-failed marker");
  });

  it("pre-run D1 death (run-open throws) logs cron-failed instead of silence", async () => {
    const logged = await captureError(() => runTick({ DB: rejectingDB(), AI: null }));
    assert.ok(logged.some((l) => l.includes("cron-failed")), `tick stayed silent; logged: ${JSON.stringify(logged)}`);
  });

  it("mid-run D1 death (fresh take throws) logs cron-failed after the best-effort finish", async () => {
    // Run-open answers so the pass starts; everything after it rejects.
    // Collect is stubbed offline so no source fetch leaves the test.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    const db = {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => (String(sql).includes("INSERT INTO agent_runs") ? { id: 7 } : null),
          all: async () => { throw new Error("D1 down"); },
          run: async () => { throw new Error("D1 down"); },
        }),
      }),
      batch: async () => { throw new Error("D1 down"); },
    };
    let logged;
    try {
      logged = await captureError(() => runTick({ DB: db, AI: null }));
    } finally {
      globalThis.fetch = origFetch;
    }
    assert.ok(logged.some((l) => l.includes("cron-failed")), `mid-run death stayed silent; logged: ${JSON.stringify(logged)}`);
  });
});

describe("shared brief prompt+parse helpers (audit 2026-09-20-round1 F5)", () => {
  it("both brief passes build prompts and parse replies through the shared helpers", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("export function buildBriefPrompt(title, oneLiner, sigs)"), "worker lost the shared brief-prompt builder");
    assert.ok(src.includes("export function parseBriefJson(text)"), "worker lost the shared brief parser");
    assert.equal(src.split("buildBriefPrompt(").length - 1, 3, "definition + main + extra call sites must share buildBriefPrompt");
    assert.equal(src.split("parseBriefJson(").length - 1, 3, "definition + main + extra call sites must share parseBriefJson");
    assert.ok(src.includes("buildBriefPrompt(bare.title, bare.one_liner, sigs)"), "main brief must build its prompt through the helper");
    assert.ok(src.includes("buildBriefPrompt(extraBare.title, extraBare.one_liner, sigs2)"), "extra brief must build its prompt through the helper");
    assert.ok(src.includes("parseBriefJson(text)"), "main brief must parse through the helper");
    assert.ok(src.includes("parseBriefJson(text2)"), "extra brief must parse through the helper");
    assert.equal(src.split("You write terse, practical research briefs").length - 1, 1, "prompt text must live in exactly one place");
  });

  it("gates and budget stay inline at the call sites, untouched", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("timeoutMs: 90000, retries: 1"), "main brief lost its retries/timeout gate");
    assert.ok(src.includes("retries: 0"), "extra brief must use retries:0 to stay in budget");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(src.includes("oldest-first") && src.includes("top-scored"), "brief mode gates changed");
    assert.ok(src.includes("const extraBare = bare"), "extra query lost its null-bare branch");
    assert.equal(src.split("briefFailed = true").length - 1, 2, "both brief catches must record the failure");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
  });

  it("buildBriefPrompt renders the byte-identical prompt for both passes", () => {
    const [sys, user] = buildBriefPrompt("My title", "one liner", [{ title: "T", url: "U", snippet: "S" }]);
    assert.equal(sys.role, "system");
    assert.equal(sys.content, "You write terse, practical research briefs. Reply with ONLY a JSON object, no prose.");
    assert.equal(user.role, "user");
    assert.equal(user.content,
      "Write a research brief for this AI money-making opportunity as ONE JSON object with EXACTLY these keys: summary, what_works, numbers, risks, first_steps. Example shape:\n" +
      '{"summary":"2-3 sentences","what_works":"tactics as bullet lines","numbers":[{"claim":"...","source":"..."}],"risks":"...","first_steps":"numbered lines for week 1"}.\n' +
      "If you lack verified facts for a section, write that explicitly instead of inventing specifics.\n" +
      "Opportunity: My title — one liner\nSignals:\n- T (U) S");
    assert.ok(buildBriefPrompt("T", "O", [])[1].content.endsWith("Signals:\n(none — use general knowledge, mark confidence accordingly)"), "empty signals must render the no-evidence fallback");
  });

  it("parseBriefJson extracts the object span and repairs escaped underscores", () => {
    assert.deepEqual(parseBriefJson('lead {"summary":"s","first_steps":"f"} trail'), { summary: "s", first_steps: "f" });
    assert.deepEqual(parseBriefJson('{"opportunity\\_id":3}'), { opportunity_id: 3 });
    assert.deepEqual(parseBriefJson("no json here"), {});
    assert.throws(() => parseBriefJson("{not json}"), "a matched-but-invalid span must throw so the caller records brief:failed");
  });
});

describe("shared classify prompt builder (audit 2026-09-20-round3 Task 3)", () => {
  it("triage and debug-classify build prompts through the shared helper", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("export function buildClassifyPrompt(opps, fresh)"), "worker lost the shared classify-prompt builder");
    assert.equal(src.split("buildClassifyPrompt(").length - 1, 3, "definition + triage + debug call sites must share buildClassifyPrompt");
    assert.ok(src.includes("const classifyPrompt = buildClassifyPrompt(opps, fresh);"), "triage must build its prompt through the helper");
    assert.ok(src.includes("const prompt = buildClassifyPrompt(opps, fresh);"), "debug-classify must build its prompt through the helper");
    assert.equal(src.split("You triage money-making-with-AI leads").length - 1, 1, "prompt text must live in exactly one place");
    assert.equal(src.split("DEFAULT TO NOISE").length - 1, 1, "prompt rules must live in exactly one place");
  });

  it("both call sites emit byte-identical prompts, rules included", () => {
    const opps = [{ id: 7, title: "Widget rentals", status: "testing" }];
    const fresh = [
      { source: "hn", title: "I made $3k/mo with AI invoices", url: "https://example.com/a" },
      { source: "reddit", title: "AI agency pricing thread", url: "https://example.com/b" },
    ];
    const [sys, user] = buildClassifyPrompt(opps, fresh);
    assert.equal(sys.role, "system");
    assert.equal(sys.content, "You triage money-making-with-AI leads. Reply with one JSON object per line (NDJSON), no prose, no array, no fences. Keep every value short.");
    assert.equal(user.role, "user");
    assert.equal(user.content,
      "PRIORITY LIST (id | title | status):\n" +
      "7 | Widget rentals | testing" +
      "\n\nFRESH SIGNALS (n | source | title | url):\n" +
      "0 | hn | I made $3k/mo with AI invoices | https://example.com/a\n" +
      "1 | reddit | AI agency pricing thread | https://example.com/b" +
      "\n\nFor each signal index 0..1 emit exactly one line:\n" +
      '{"n":i,"action":"new"|"supports"|"noise","opportunity_id":id or null,"title":"short","one_liner":"under 20 words","category":"services|agency|saas|content|products|other","value":1-10,"effort":1-10,"confidence":1-10,"fit":1-10,"est_monthly_low":0,"est_monthly_high":0,"capital_needed":"$0","time_to_first_dollar":"2-4 weeks"}\n' +
      'Rules: DEFAULT TO NOISE. "new" only when the signal shows a repeatable way to earn money (pricing, revenue, customers, or an obvious buyer) that is NOT on the list. A GitHub repo, tool launch, or tutorial with no business model is noise. A variant of a listed method is "supports" with its numeric id. Confidence above 6 requires named revenue/users in the signal, else 5 or less. opportunity_id must be a numeric id from the list or null, never text. For "new", also estimate est_monthly_low/high ($/mo integers, low<=high), capital_needed ("$0" style, <=120 chars) and time_to_first_dollar ("2-4 weeks" style, <=120 chars); omit any you cannot estimate (safe defaults apply).');
    // Same inputs through the same builder: the two call sites cannot drift.
    assert.deepEqual(buildClassifyPrompt(opps, fresh), [sys, user]);
  });

  it("gates and budget stay inline at the call sites, untouched", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("timeoutMs: isCron ? 60000 : 12000, retries: isCron ? 1 : 0"), "triage lost its retries/timeout gate");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
  });
});

describe("manual /run failure surfaces in worker logs (audit 2026-09-20-round4 Task 2)", () => {
  it("manual catch no longer swallows failures; the tail marker exists on the manual path", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(!src.includes('runResearch(env, "manual").catch(() => null)'), "manual run still swallows failures into silence");
    const manualAt = src.indexOf('runResearch(env, "manual")');
    assert.ok(manualAt !== -1, "worker lost the manual runResearch call");
    assert.ok(src.indexOf("cron-failed", manualAt) !== -1, "manual catch lost the tail-visible cron-failed marker");
  });

  it("D1-dead manual run still 202s but logs cron-failed like cron", async () => {
    const rejectingDB = {
      prepare: () => ({
        bind: () => ({
          first: async () => { throw new Error("D1 down"); },
          all: async () => { throw new Error("D1 down"); },
          run: async () => { throw new Error("D1 down"); },
        }),
      }),
      batch: async () => { throw new Error("D1 down"); },
    };
    const adminToken = "test-admin-token";
    const req = new Request("http://localhost/run", {
      method: "POST",
      headers: { authorization: "Bearer " + adminToken },
    });
    const env = { ADMIN_TOKEN: adminToken, DB: rejectingDB, AI: null };
    let waited = null;
    const ctx = { waitUntil(p) { waited = p; } };
    const logged = [];
    const orig = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(" ")); };
    try {
      const res = await worker.fetch(req, env, ctx);
      assert.equal(res.status, 202);
      const body = await res.json();
      assert.equal(body.status, "accepted");
      assert.ok(waited, "manual run must schedule its pass via waitUntil");
      await waited;
    } finally {
      console.error = orig;
    }
    assert.ok(logged.some((l) => l.includes("cron-failed")), `manual D1 death stayed silent; logged: ${JSON.stringify(logged)}`);
  });
});

describe("shared brief-insert helper (audit 2026-09-20-round4 Task 4)", () => {
  it("both brief passes insert through insertBrief; the guard + SQL live in one place", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("export async function insertBrief(env, opportunityId, parsed, sigs)"), "worker lost the shared brief-insert helper");
    assert.ok(src.includes("await insertBrief(env, bare.id, b, sigs)"), "main brief must insert through the helper");
    assert.ok(src.includes("await insertBrief(env, extraBare.id, b2, sigs2)"), "extra brief must insert through the helper");
    assert.equal(src.split("INSERT INTO briefs (opportunity_id, version, summary, what_works,").length - 1, 1, "brief INSERT must live in exactly one place");
  });

  it("empty briefs write nothing on either path (guard inside the helper)", async () => {
    let writes = 0;
    const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => { writes++; } }) }) } };
    assert.equal(await insertBrief(env, 7, {}, []), false);
    assert.equal(await insertBrief(env, 7, { summary: "s" }, []), false);
    assert.equal(await insertBrief(env, 7, { first_steps: "f" }, []), false);
    assert.equal(await insertBrief(env, 7, { summary: "  ", first_steps: "f" }, []), false);
    assert.equal(await insertBrief(env, 7, { summary: "s", first_steps: "" }, []), false);
    assert.equal(await insertBrief(env, 7, null, []), false);
    assert.equal(writes, 0);
  });

  it("complete briefs write one row with the 9-column shape and sources JSON", async () => {
    let sql = "";
    let binds = null;
    const env = { DB: { prepare: (s) => ({ bind: (...b) => ({ run: async () => { sql = s; binds = b; } }) }) } };
    const ok = await insertBrief(env, 7,
      { summary: "s", what_works: "w", numbers: [{ claim: "c", source: "src" }], risks: "r", first_steps: "f" },
      [{ title: "T", url: "U", snippet: "S" }]);
    assert.equal(ok, true);
    assert.ok(sql.includes("INSERT INTO briefs (opportunity_id, version, summary, what_works,"), "helper lost the brief INSERT");
    assert.ok(sql.includes("VALUES (?,1,?,?,?,?,?,?,'agent')"), "helper lost the brief VALUES shape");
    assert.equal(binds[0], 7);
    assert.equal(binds[1], "s");
    assert.equal(binds[2], "w");
    assert.deepEqual(JSON.parse(binds[3]), [{ claim: "c", source: "src" }]);
    assert.equal(binds[4], "r");
    assert.equal(binds[5], "f");
    assert.deepEqual(JSON.parse(binds[6]), [{ title: "T", url: "U" }]);
  });

  it("a failed write throws so the caller records brief:failed", async () => {
    const env = { DB: { prepare: () => { throw new Error("D1 down"); } } };
    await assert.rejects(() => insertBrief(env, 7, { summary: "s", first_steps: "f" }, []), /D1 down/);
  });

  it("gates and budget stay inline at the call sites, untouched", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes("timeoutMs: 90000, retries: 1"), "main brief lost its retries/timeout gate");
    assert.ok(src.includes("retries: 0"), "extra brief must use retries:0 to stay in budget");
    assert.equal(src.split("await aiComplete(env, state").length - 1, 3, "AI call sites must stay at 3 (classify + brief + extra brief)");
    assert.ok(src.includes("const MAX_AI_CALLS = 4;"), "AI budget must stay at 4");
    assert.ok(src.includes("buildBriefPrompt(bare.title, bare.one_liner, sigs)"), "main brief lost its shared prompt builder");
    assert.ok(src.includes("buildBriefPrompt(extraBare.title, extraBare.one_liner, sigs2)"), "extra brief lost its shared prompt builder");
    assert.equal(src.split("briefFailed = true").length - 1, 2, "both brief catches must record the failure");
    assert.ok(src.includes("const extraBare = bare"), "extra query lost its null-bare branch");
    assert.ok(!src.includes("UPDATE opportunities SET status"), "worker must never move opportunity status");
  });
});

describe("unreviewed inflow pause (audit 2026-09-20-round2 Task 3)", () => {
  // Drives the real runResearch against a stubbed D1: two unprocessed
  // signals, a classify reply carrying two "new" verdicts, and configurable
  // bare/unreviewed backlog counts. Collectors see zero fresh signals (empty
  // fetch stub) and the manual trigger skips the brief pass, so the only AI
  // call is classify.
  const verdictLine = (n, title) => JSON.stringify({
    n, action: "new", opportunity_id: null, title,
    one_liner: "repeatable buyer-paid test service", category: "services",
    value: 6, effort: 3, confidence: 4, fit: 5,
    est_monthly_low: 100, est_monthly_high: 500,
    capital_needed: "$0", time_to_first_dollar: "1-2 weeks",
  });
  const CLASSIFY_REPLY = verdictLine(0, "Testable Widget Service") + "\n" + verdictLine(1, "Auditable Prompt Pack") + "\n";

  function stubEnv({ bare, unreviewed }) {
    const signals = [
      { id: 101, source: "hn", title: "Signal A", url: "https://example.com/a", snippet: "s", processed: 0, opportunity_id: null },
      { id: 102, source: "hn", title: "Signal B", url: "https://example.com/b", snippet: "s", processed: 0, opportunity_id: null },
    ];
    const inserted = [];
    let nextId = 1000;
    const DB = {
      prepare(sql) {
        const stmt = {
          sql,
          params: [],
          bind(...p) { stmt.params = p; return stmt; },
          async first() {
            if (sql.includes("INSERT INTO agent_runs")) return { id: 1 };
            if (sql.includes("LEFT JOIN briefs")) return { n: bare };
            if (sql.includes("FROM opportunities WHERE notes LIKE")) return { n: unreviewed };
            return null;
          },
          async all() {
            if (sql.includes("SELECT * FROM signals WHERE processed = 0")) {
              const limit = Number(stmt.params[0]) || signals.length;
              return { results: signals.filter((s) => s.processed === 0).slice(0, limit) };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO opportunities")) {
              inserted.push({ sql, params: stmt.params });
              return { meta: { last_row_id: nextId++ } };
            }
            if (sql.startsWith("UPDATE signals SET processed=1, opportunity_id")) {
              const [oppId, sigId] = stmt.params;
              const s = signals.find((x) => x.id === sigId);
              if (s) { s.processed = 1; s.opportunity_id = oppId; }
              return {};
            }
            if (sql.startsWith("UPDATE signals SET processed=1 WHERE id")) {
              const s = signals.find((x) => x.id === stmt.params[0]);
              if (s) s.processed = 1;
              return {};
            }
            if (sql.includes("UPDATE signals SET processed = 1 WHERE processed = 0 AND")) {
              return { meta: { changes: 0 } };
            }
            return {};
          },
        };
        return stmt;
      },
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    };
    const AI = { run: async () => ({ response: CLASSIFY_REPLY }) };
    return { env: { DB, AI }, signals, inserted };
  }

  async function runTick(opts) {
    const { env, signals, inserted } = stubEnv(opts);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    try {
      const result = await runResearch(env, "manual");
      return { result, signals, inserted };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("pauses inflow at 0 while unreviewed exceeds 10; overflow stays unprocessed", async () => {
    const { result, signals, inserted } = await runTick({ bare: 0, unreviewed: 11 });
    assert.equal(result.status, "ok", `run failed: ${result.error || "(no error)"}`);
    assert.equal(result.added, 0);
    assert.equal(inserted.length, 0);
    assert.deepEqual(signals.map((s) => s.processed), [0, 0], "overflow signals must stay processed = 0 for a later tick");
  });

  it("keeps the 2-per-run cap at unreviewed <= 10", async () => {
    const { result, signals, inserted } = await runTick({ bare: 0, unreviewed: 10 });
    assert.equal(result.status, "ok", `run failed: ${result.error || "(no error)"}`);
    assert.equal(result.added, 2);
    assert.equal(inserted.length, 2);
    assert.deepEqual(signals.map((s) => s.processed), [1, 1]);
  });

  it("keeps the bare-backlog drop to 1 while unreviewed is within cap", async () => {
    const { result, signals, inserted } = await runTick({ bare: 11, unreviewed: 3 });
    assert.equal(result.status, "ok", `run failed: ${result.error || "(no error)"}`);
    assert.equal(result.added, 1);
    assert.equal(inserted.length, 1);
    assert.deepEqual(signals.map((s) => s.processed), [1, 0], "the second new-verdict signal must wait for a later tick");
  });

  it("README documents the pause beside the bare-backlog gate", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("while unreviewed exceeds 10 the cap drops to 0 for that tick"), "README lost the inflow-pause gate");
    assert.ok(readme.includes("at most 2 new proposals"), "README lost the inflow cap");
  });
});

describe("poison-row brief rotation (audit 2026-09-20-round3 Task 3)", () => {
  // Drives the real runResearch on the cron trigger with stubbed AI that
  // always returns "{}" (parses, but keyless — insertBrief declines). Two
  // bare rows, fresh backlog (top-scored mode, no extra pass), zero fresh
  // signals so classify stays skipped and the brief pass is the only AI.
  function stubEnv() {
    const now = new Date().toISOString();
    const opportunities = [
      { id: 1, title: "Top scored", one_liner: "one", score: 9000, notes: "UNREVIEWED", created_at: now },
      { id: 2, title: "Second best", one_liner: "two", score: 8000, notes: "UNREVIEWED", created_at: now },
    ];
    const briefedIds = [];
    let runError = "";
    const DB = {
      prepare(sql) {
        const stmt = {
          sql,
          params: [],
          bind(...p) { stmt.params = p; return stmt; },
          async first() {
            if (sql.includes("INSERT INTO agent_runs")) return { id: 1 };
            if (sql.includes("SELECT o.* FROM opportunities o LEFT JOIN briefs")) {
              // Honor the NOT IN rotation exclusion (skip ids ride as the
              // trailing numeric binds) and the top-scored order.
              const excluded = new Set(stmt.params.filter((p) => typeof p === "number"));
              const rows = opportunities.filter((o) => !excluded.has(o.id))
                .sort((a, b) => b.score - a.score);
              return rows[0] || null;
            }
            if (sql.includes("SELECT created_at FROM opportunities")) return { created_at: now };
            if (sql.includes("COUNT(*)")) {
              if (sql.includes("LEFT JOIN briefs")) return { n: 2 };
              if (sql.includes("UNREVIEWED")) return { n: 2 };
              return { n: 0 };
            }
            return null;
          },
          async all() {
            if (sql.includes("SELECT * FROM signals WHERE processed = 0")) return { results: [] };
            if (sql.includes("SELECT title, url, snippet FROM signals")) {
              briefedIds.push(stmt.params[0]);
              return { results: [] };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("UPDATE agent_runs SET finished_at")) {
              runError = String(stmt.params[6] || "");
            }
            return {};
          },
        };
        return stmt;
      },
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    };
    const AI = { run: async () => ({ response: "{}" }) };
    return { env: { DB, AI }, briefedIds, runError: () => runError };
  }

  async function runTick() {
    const t = stubEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    try {
      const result = await runResearch(t.env, "cron");
      return { result, briefedIds: t.briefedIds, runError: t.runError() };
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  it("names the skipped row and briefs a different row on the next tick", async () => {
    _resetBriefSkippedForTests();
    const first = await runTick();
    assert.equal(first.result.status, "ok", `first tick failed: ${first.result.error || "(no error)"}`);
    assert.equal(first.result.briefs, 0);
    assert.deepEqual(first.briefedIds, [1], "first tick must attempt the top-scored bare row");
    assert.ok(first.runError.includes("brief:top-scored"), `run log lost the brief mode: ${first.runError}`);
    assert.ok(first.runError.includes("brief:skipped:1"), `run log must name the skipped row: ${first.runError}`);
    const second = await runTick();
    assert.equal(second.result.status, "ok", `second tick failed: ${second.result.error || "(no error)"}`);
    assert.deepEqual(second.briefedIds, [2], "second tick must rotate past the skipped row");
    assert.ok(second.runError.includes("brief:skipped:2"), `run log must name the newly skipped row: ${second.runError}`);
    _resetBriefSkippedForTests();
  });

  it("falls back to the unfiltered pick when every bare row was skipped", async () => {
    _resetBriefSkippedForTests();
    await runTick();
    await runTick();
    const third = await runTick();
    assert.equal(third.result.status, "ok", `third tick failed: ${third.result.error || "(no error)"}`);
    assert.deepEqual(third.briefedIds, [1], "an all-skipped backlog must keep attempting, not go quiet");
    _resetBriefSkippedForTests();
  });
});

describe("skip classify AI when inflow paused (audit 2026-09-20-round4 Task 3)", () => {
  // Drives the real runResearch on the cron trigger against a stubbed D1:
  // two unprocessed signals, a classify reply carrying two "new" verdicts,
  // one bare row for the brief pass, a fresh backlog (top-scored mode, no
  // extra pass), and an AI router that counts classify vs brief calls by
  // their prompt bytes (FRESH SIGNALS only appears in the classify prompt).
  const verdictLine = (n, title) => JSON.stringify({
    n, action: "new", opportunity_id: null, title,
    one_liner: "repeatable buyer-paid test service", category: "services",
    value: 6, effort: 3, confidence: 4, fit: 5,
    est_monthly_low: 100, est_monthly_high: 500,
    capital_needed: "$0", time_to_first_dollar: "1-2 weeks",
  });
  const CLASSIFY_REPLY = verdictLine(0, "Testable Widget Service") + "\n" + verdictLine(1, "Auditable Prompt Pack") + "\n";
  const BRIEF_JSON = JSON.stringify({
    summary: "Terse summary of the opportunity.", what_works: "Do X.",
    numbers: [], risks: "Low.", first_steps: "1. Ship the smallest test.",
  });

  function stubEnv({ bare, unreviewed }) {
    const now = new Date().toISOString();
    const signals = [
      { id: 101, source: "hn", title: "Signal A", url: "https://example.com/a", snippet: "s", processed: 0, opportunity_id: null },
      { id: 102, source: "hn", title: "Signal B", url: "https://example.com/b", snippet: "s", processed: 0, opportunity_id: null },
    ];
    const bareRow = { id: 7, title: "Bare row", one_liner: "needs evidence", score: 9000, notes: "UNREVIEWED", created_at: now };
    const inserted = [];
    const briefedIds = [];
    const calls = { classify: 0, brief: 0 };
    let nextId = 1000;
    let runError = "";
    const DB = {
      prepare(sql) {
        const stmt = {
          sql,
          params: [],
          bind(...p) { stmt.params = p; return stmt; },
          async first() {
            if (sql.includes("INSERT INTO agent_runs")) return { id: 1 };
            if (sql.includes("SELECT o.* FROM opportunities o LEFT JOIN briefs")) return bareRow;
            if (sql.includes("SELECT created_at FROM opportunities")) return { created_at: now };
            if (sql.includes("LEFT JOIN briefs")) return { n: bare };
            if (sql.includes("FROM opportunities WHERE notes LIKE")) return { n: unreviewed };
            return null;
          },
          async all() {
            if (sql.includes("SELECT * FROM signals WHERE processed = 0")) {
              const limit = Number(stmt.params[0]) || signals.length;
              return { results: signals.filter((s) => s.processed === 0).slice(0, limit) };
            }
            if (sql.includes("SELECT title, url, snippet FROM signals")) {
              briefedIds.push(stmt.params[0]);
              return { results: [] };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO opportunities")) {
              inserted.push({ sql, params: stmt.params });
              return { meta: { last_row_id: nextId++ } };
            }
            if (sql.startsWith("UPDATE signals SET processed=1, opportunity_id")) {
              const [oppId, sigId] = stmt.params;
              const s = signals.find((x) => x.id === sigId);
              if (s) { s.processed = 1; s.opportunity_id = oppId; }
              return {};
            }
            if (sql.startsWith("UPDATE signals SET processed=1 WHERE id")) {
              const s = signals.find((x) => x.id === stmt.params[0]);
              if (s) s.processed = 1;
              return {};
            }
            if (sql.includes("UPDATE signals SET processed = 1 WHERE processed = 0 AND")) {
              return { meta: { changes: 0 } };
            }
            if (sql.includes("UPDATE agent_runs SET finished_at")) {
              runError = String(stmt.params[6] || "");
            }
            return {};
          },
        };
        return stmt;
      },
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    };
    const AI = {
      run: async (_model, opts) => {
        const text = JSON.stringify((opts && opts.messages) || []);
        if (text.includes("FRESH SIGNALS")) { calls.classify++; return { response: CLASSIFY_REPLY }; }
        calls.brief++;
        return { response: BRIEF_JSON };
      },
    };
    return { env: { DB, AI }, signals, inserted, briefedIds, calls, runError: () => runError };
  }

  async function runTick(opts) {
    _resetBriefSkippedForTests();
    const t = stubEnv(opts);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    try {
      const result = await runResearch(t.env, "cron");
      return { result, signals: t.signals, inserted: t.inserted, briefedIds: t.briefedIds, calls: t.calls, runError: t.runError() };
    } finally {
      globalThis.fetch = realFetch;
      _resetBriefSkippedForTests();
    }
  }

  it("skips the classify AI call at unreviewed 11, logs inflow:paused, still briefs", async () => {
    const t = await runTick({ bare: 0, unreviewed: 11 });
    assert.equal(t.result.status, "ok", `run failed: ${t.result.error || "(no error)"}`);
    assert.equal(t.calls.classify, 0, "paused tick must make 0 classify AI calls");
    assert.ok(t.calls.brief >= 1, "paused tick must still run the brief pass");
    assert.ok(t.result.briefs >= 1, "paused tick must write at least one brief");
    assert.deepEqual(t.briefedIds, [7], "paused tick must brief the bare row");
    assert.ok(t.runError.includes("inflow:paused"), `run log must name the pause: ${t.runError}`);
    assert.equal(t.inserted.length, 0);
    assert.deepEqual(t.signals.map((s) => s.processed), [0, 0], "paused-tick signals must stay processed = 0 for a later tick");
  });

  it("classify runs as today at unreviewed <= 10 (cap 2, no pause bit)", async () => {
    const t = await runTick({ bare: 0, unreviewed: 10 });
    assert.equal(t.result.status, "ok", `run failed: ${t.result.error || "(no error)"}`);
    assert.equal(t.calls.classify, 1, "unpaused tick must classify exactly once");
    assert.equal(t.inserted.length, 2);
    assert.deepEqual(t.signals.map((s) => s.processed), [1, 1]);
    assert.ok(!t.runError.includes("inflow:paused"), `unpaused run log must not name a pause: ${t.runError}`);
  });

  it("bare-backlog drop to 1 survives the moved gate", async () => {
    const t = await runTick({ bare: 11, unreviewed: 3 });
    assert.equal(t.result.status, "ok", `run failed: ${t.result.error || "(no error)"}`);
    assert.equal(t.calls.classify, 1, "bare-gated tick must still classify");
    assert.equal(t.inserted.length, 1);
    assert.deepEqual(t.signals.map((s) => s.processed), [1, 0], "the second new-verdict signal must wait for a later tick");
    assert.ok(!t.runError.includes("inflow:paused"), `bare-gated run log must not name a pause: ${t.runError}`);
  });

  it("gates sit before the classify pass; the pause bit rides the finish line", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    const gateAt = src.indexOf("let maxNewThisRun = MAX_NEW_PER_RUN;");
    const verdictsAt = src.indexOf("let verdicts = [];");
    assert.ok(gateAt !== -1 && verdictsAt !== -1 && gateAt < verdictsAt, "inflow gates must be read before the classify pass");
    assert.ok(src.includes("if (maxNewThisRun > 0)"), "classify AI call lost its inflow-pause guard");
    assert.ok(src.includes('maxNewThisRun === 0 ? " inflow:paused" : ""'), "run log lost the inflow:paused disclosure");
  });

  it("README documents the classify skip beside the pause gate", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("skips the classify AI call entirely"), "README lost the classify skip");
    assert.ok(readme.includes("inflow:paused"), "README lost the inflow:paused marker");
  });
});

describe("top-scored brief skips killed/paused (audit 2026-09-20-round2 Task 3)", () => {
  const BRIEF_JSON = JSON.stringify({
    summary: "Terse summary of the opportunity.", what_works: "Do X.",
    numbers: [], risks: "Low.", first_steps: "1. Ship the smallest test.",
  });

  // Two bare rows: a high-score killed row (the old unfiltered top-scored
  // pick would take it) and a lower-score live row (the fixed pick must take
  // it). The stub emulates the SQL status filter so the test fails on the old
  // query (briefs id 8) and passes on the fixed one (briefs id 7).
  function stubEnv() {
    const now = new Date().toISOString();
    const killedBare = { id: 8, title: "Killed bare", one_liner: "decided", score: 99999, status: "killed", notes: "decided", created_at: now };
    const liveBare = { id: 7, title: "Live bare", one_liner: "needs evidence", score: 9000, status: "researching", notes: "UNREVIEWED", created_at: now };
    const briefedIds = [];
    const queries = [];
    let runError = "";
    const DB = {
      prepare(sql) {
        queries.push(sql);
        const stmt = {
          sql,
          params: [],
          bind(...p) { stmt.params = p; return stmt; },
          async first() {
            if (sql.includes("INSERT INTO agent_runs")) return { id: 1 };
            if (sql.includes("SELECT o.* FROM opportunities o LEFT JOIN briefs")) {
              if (sql.includes("ORDER BY o.score DESC")) {
                if (sql.includes("NOT IN ('killed','paused')")) return liveBare;
                return killedBare;
              }
              return liveBare;
            }
            if (sql.includes("SELECT created_at FROM opportunities")) return { created_at: now };
            if (sql.includes("LEFT JOIN briefs")) return { n: 0 };
            if (sql.includes("FROM opportunities WHERE notes LIKE")) return { n: 1 };
            return null;
          },
          async all() {
            if (sql.includes("SELECT * FROM signals WHERE processed = 0")) return { results: [] };
            if (sql.includes("SELECT title, url, snippet FROM signals")) {
              briefedIds.push(stmt.params[0]);
              return { results: [] };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("UPDATE signals SET processed = 1 WHERE processed = 0 AND")) return { meta: { changes: 0 } };
            if (sql.includes("UPDATE agent_runs SET finished_at")) runError = String(stmt.params[6] || "");
            return {};
          },
        };
        return stmt;
      },
      async batch(stmts) {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        return out;
      },
    };
    const AI = { run: async () => ({ response: BRIEF_JSON }) };
    return { env: { DB, AI }, briefedIds, queries, runError: () => runError };
  }

  it("briefs the top live bare row instead of a higher-score killed bare row", async () => {
    _resetBriefSkippedForTests();
    const t = stubEnv();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });
    try {
      const result = await runResearch(t.env, "cron");
      assert.equal(result.status, "ok", `run failed: ${result.error || "(no error)"}`);
      assert.ok(result.briefs >= 1, "tick must write at least one brief");
      assert.deepEqual(t.briefedIds, [7], "top-scored brief must skip the killed row for the live row");
      assert.ok(t.runError().includes("brief:top-scored"), `run log must name top-scored mode: ${t.runError()}`);
      assert.ok(t.queries.some((q) => q.includes("NOT IN ('killed','paused')")), "top-scored query must carry the killed/paused exclusion");
    } finally {
      globalThis.fetch = realFetch;
      _resetBriefSkippedForTests();
    }
  });

  it("leaves the unreviewed-scoped picks and gates byte-identical", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.equal(src.split("NOT IN ('killed','paused')").length - 1, 1, "exactly the top-scored pick must exclude killed/paused");
    assert.ok(!src.includes("WHERE b.id IS NULL ORDER BY o.score DESC"), "top-scored pick must no longer be unfiltered");
    assert.ok(src.includes("WHERE b.id IS NULL AND o.notes LIKE ? ORDER BY o.created_at ASC LIMIT 1"), "oldest-first pick changed");
    assert.ok(src.includes("WHERE b.id IS NULL AND o.notes LIKE '%UNREVIEWED%'"), "extra-brief pick changed");
    assert.ok(src.includes("SELECT COUNT(*) AS n FROM opportunities o LEFT JOIN briefs b ON b.opportunity_id = o.id WHERE b.id IS NULL"), "bare count changed");
    assert.ok(src.includes("SELECT COUNT(*) AS n FROM opportunities WHERE notes LIKE '%UNREVIEWED%'"), "unreviewed gate changed");
  });

  it("README documents the decided-row exclusion beside the brief mode", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");
    assert.ok(readme.includes("top-scored excluding killed/paused"), "README lost the decided-row exclusion");
  });
});
