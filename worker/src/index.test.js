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
    const briefAt = src.indexOf('mark("brief-ai")');
    assert.ok(briefAt !== -1, "worker lost the brief-ai pass");
    const firstFinish = src.indexOf('await finish("ok")');
    assert.ok(firstFinish !== -1 && firstFinish > briefAt, "quiet tick still finishes before the brief pass");
    const noteAt = src.indexOf('note: "no fresh signals"');
    assert.ok(noteAt !== -1 && noteAt > briefAt, "quiet-tick note must only appear at the final return, after the brief pass");
  });

  it("manual runs still skip the brief pass by deadline", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.js"), "utf8");
    assert.ok(src.includes('trigger === "cron" ? 300000 : -1'), "manual path lost its brief-skipping deadline");
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
