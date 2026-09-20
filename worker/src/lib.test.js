// Focused regression tests for the research agent's triage math.
// Run: npm test  (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp10, slugify, scoreOf, parseJsonLines, repairJson, effectiveScore, isUnreviewed, appendKeepNewest, UNREVIEWED_SCORE_CAP } from "./lib.js";

describe("scoreOf", () => {
  it("matches the documented formula", () => {
    // 100 * (8*8*10)/(3+1) = 16000 — the seeded top pick.
    assert.equal(scoreOf({ value: 8, effort: 3, confidence: 8, fit: 10 }), 16000);
    assert.equal(scoreOf({ value: 6, effort: 5, confidence: 5, fit: 8 }), 4000);
  });
  it("rewards low effort and punishes high effort", () => {
    const lo = scoreOf({ value: 5, effort: 1, confidence: 5, fit: 5 });
    const hi = scoreOf({ value: 5, effort: 10, confidence: 5, fit: 5 });
    assert.ok(lo > hi * 4);
  });
});

describe("clamp10", () => {
  it("clamps, rounds, and falls back", () => {
    assert.equal(clamp10(99), 10);
    assert.equal(clamp10(-3), 1);
    assert.equal(clamp10(4.6), 5);
    assert.equal(clamp10("junk"), 5);
    assert.equal(clamp10(undefined, 3), 3);
  });
});

describe("slugify", () => {
  it("produces URL-safe slugs", () => {
    assert.equal(slugify("AI UGC Ads for DTC Brands!"), "ai-ugc-ads-for-dtc-brands");
    assert.equal(slugify("  --x-- "), "x");
    assert.equal(slugify(""), "");
  });
});

describe("parseJsonLines", () => {
  it("parses one verdict per line, skipping prose", () => {
    const out = parseJsonLines('Here you go:\n{"n":0,"action":"noise"}\n{"n":1,"action":"new"}\nDone.');
    assert.deepEqual(out, [{ n: 0, action: "noise" }, { n: 1, action: "new" }]);
  });
  it("tolerates fences and keeps verdicts before a truncated tail", () => {
    const out = parseJsonLines('```json\n{"n":0,"action":"supports","opportunity_id":3}\n{"n":1,"action":"new","tit');
    assert.deepEqual(out, [{ n: 0, action: "supports", opportunity_id: 3 }]);
  });
  it("extracts objects from numbered and bulleted lines", () => {
    const out = parseJsonLines('1. {"n":0,"action":"noise"}\n- {"n":1,"action":"new"} trailing note');
    assert.deepEqual(out, [{ n: 0, action: "noise" }, { n: 1, action: "new" }]);
  });
  it("returns [] for missing or malformed JSON", () => {
    assert.deepEqual(parseJsonLines("no json here"), []);
    assert.deepEqual(parseJsonLines("[{broken"), []);
    assert.deepEqual(parseJsonLines(""), []);
    assert.deepEqual(parseJsonLines(null), []);
  });
});

describe("repairJson", () => {
  it("unescapes model-escaped underscores (live Mistral output)", () => {
    const out = parseJsonLines('0:{"n":0,"action":"new","opportunity\\_id":null,"one\\_liner":"x"}');
    assert.deepEqual(out, [{ n: 0, action: "new", opportunity_id: null, one_liner: "x" }]);
    assert.equal(repairJson("a\\_b"), "a_b");
  });
});

describe("effectiveScore (F3 honest cap)", () => {
  it("clamps UNREVIEWED rows to at most 6000", () => {
    // Capped-max inputs from the audit: 100*7*5*10/2 = 17500 uncapped.
    const uncapped = scoreOf({ value: 7, effort: 1, confidence: 5, fit: 10 });
    assert.equal(uncapped, 17500);
    const capped = effectiveScore({ value: 7, effort: 1, confidence: 5, fit: 10, notes: "x UNREVIEWED y" });
    assert.equal(capped, UNREVIEWED_SCORE_CAP);
    assert.equal(capped, 6000);
    assert.ok(capped < uncapped);
  });
  it("leaves reviewed rows untouched", () => {
    assert.equal(effectiveScore({ value: 8, effort: 3, confidence: 8, fit: 10, notes: "seed" }), 16000);
    assert.equal(effectiveScore({ value: 6, effort: 5, confidence: 5, fit: 8, notes: "" }), 4000);
  });
  it("detects the marker in notes or raw strings", () => {
    assert.equal(isUnreviewed({ notes: "a UNREVIEWED b" }), true);
    assert.equal(isUnreviewed("UNREVIEWED"), true);
    assert.equal(isUnreviewed({ notes: "vetted" }), false);
    assert.equal(isUnreviewed({}), false);
  });
});

describe("appendKeepNewest (F4)", () => {
  it("keeps the newest 8000 chars", () => {
    const old = "o".repeat(8000);
    const fresh = "n".repeat(100);
    const out = appendKeepNewest(old, fresh);
    assert.equal(out.length, 8000);
    assert.ok(out.endsWith(fresh));
    assert.equal(out, "o".repeat(7900) + "n".repeat(100));
  });
  it("returns the whole string when short", () => {
    assert.equal(appendKeepNewest("a", "b"), "ab");
    assert.equal(appendKeepNewest("", ""), "");
  });
});
