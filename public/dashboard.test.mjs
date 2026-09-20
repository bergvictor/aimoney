// Dashboard disclosure regression tests (round2 Tasks 1-3): static guards in the
// repo's own style (no DOM; the bundle is browser code). Fails when the board
// loses the decisions/vetted copy, the triage button/toast stops disclosing
// the cron-only brief split, or the API-failure banner and mismatch badges go
// missing. Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const js = readFileSync(join(ROOT, "app.js"), "utf8");
const css = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("zero-spend starter (Task 1)", () => {
  it("served page owns the Start-here strip container above the ledger", () => {
    assert.ok(html.includes('id="start-here"'), "index.html lost #start-here");
    const stripAt = html.indexOf('id="start-here"');
    const ledgerAt = html.indexOf('id="ledger"');
    assert.ok(stripAt !== -1 && ledgerAt !== -1 && stripAt < ledgerAt, "#start-here must sit above #ledger");
  });

  it("served page owns a Zero spend chip", () => {
    assert.ok(html.includes('data-zero="1"'), "index.html lost the data-zero chip");
    assert.ok(html.includes("Zero spend"), "index.html lost the 'Zero spend' chip copy");
  });

  it("strip shows the #1-by-score pick with money, capital, next action, and a drawer link", () => {
    assert.ok(js.includes("Start here today"), "app.js lost the 'Start here today' copy");
    assert.ok(js.includes("renderStartHere"), "app.js lost renderStartHere");
    assert.ok(js.includes("topOpportunity"), "app.js lost the topOpportunity helper");
    assert.ok(js.includes("firstStepsFirstLine"), "app.js lost the first-steps line helper");
    assert.ok(js.includes("first_steps"), "strip must read brief first_steps");
    assert.ok(js.includes("money(top.est_monthly_low, top.est_monthly_high)"), "strip must reuse money() for the $/mo range");
    assert.ok(js.includes("capital_needed"), "strip must show capital_needed");
    assert.ok(js.includes("start-here-open"), "strip lacks its drawer opener button");
    assert.ok(js.includes("openDrawer(top.id)"), "strip must deep-link via openDrawer(top.id)");
  });

  it("Zero spend chip filters capital_needed $0 rows", () => {
    assert.ok(js.includes("isZeroSpend"), "app.js lost the isZeroSpend helper");
    assert.ok(js.includes('startsWith("$0")'), "zero-spend must match capital_needed starting with $0");
    assert.ok(js.includes("state.zeroOnly"), "app.js lost the zeroOnly filter state");
    assert.ok(js.includes("chip.dataset.zero"), "chip handler ignores the Zero spend chip");
  });
});

describe("stale nudge + vet handoff (round3 Task 2)", () => {
  it("experiments header nudges the stalest open card when decisions are zero", () => {
    assert.ok(js.includes("stalestOpenExp"), "app.js lost the stalest-open helper");
    assert.ok(js.includes("decisions === 0"), "nudge must fire only when decisions_last_7d is 0");
    assert.ok(js.includes("Nudge:"), "exp summary lost the 'Nudge:' copy");
    assert.ok(js.includes("days_in_status"), "nudge must reuse days_in_status");
    assert.ok(js.includes("exp-nudge-open"), "nudge lacks its opener button");
    assert.ok(js.includes("openDrawer(nudge.opportunity_id, nudge.id)"), "nudge must open the stalest card drawer");
  });

  it("experiments header shows the vetted-without-experiment count", () => {
    assert.ok(js.includes("vetted_no_experiment"), "app.js never reads health.vetted_no_experiment");
    assert.ok(js.includes("vetted, no experiment"), "exp summary lost the vetted-no-experiment count");
  });

  it("vet toast offers one-click Log experiment", () => {
    assert.ok(js.includes("Vetted — log the experiment"), "vet toast lost the next-step copy");
    assert.ok(js.includes("Log experiment"), "vet toast lost its Log experiment action");
    assert.ok(js.includes("openExperimentModal(null, id)"), "vet handoff must reuse openExperimentModal(null, id)");
  });
});

describe("outcome rescore suggestion (round3 Task 3)", () => {
  it("drawer admin zone suggests a confidence/value delta, never auto-applied", () => {
    assert.ok(js.includes("suggestRescore"), "app.js lost the suggestRescore helper");
    assert.ok(js.includes("Suggested rescore"), "drawer lost the 'Suggested rescore' copy");
    assert.ok(js.includes("az-apply-suggest"), "suggestion lacks its one-click apply button");
    assert.ok(js.includes("Applied outcome suggestion"), "apply must note the outcome suggestion in notes");
    assert.ok(js.includes("never auto-applied"), "suggestion must stay human-applied");
  });
});

describe("triage noise pill (Task 3)", () => {
  it("agent pill and runs tab show added/updated with 24h noise", () => {
    assert.ok(js.includes("noise_24h"), "app.js never reads health.noise_24h");
    assert.ok(js.includes("runs-summary"), "runs tab lost the noise summary element");
    assert.ok(js.includes("noise in 24h"), "runs summary lost the 24h noise copy");
    assert.ok(js.includes("Latest research run: +"), "pill title lost the added/updated noise format");
  });
});

describe("decisions/week header (Task 1)", () => {
  it("experiments summary renders decisions and vetted conversion", () => {
    assert.ok(js.includes("decisions_last_7d"), "app.js never reads health.decisions_last_7d");
    assert.ok(js.includes("vetted_last_7d"), "app.js never reads health.vetted_last_7d");
    assert.ok(js.includes("decisions this week"), "exp summary lost 'decisions this week'");
    assert.ok(js.includes("vetted →"), "exp summary lost 'Y vetted → Z experiments'");
  });
});

describe("triage disclosure (Task 2)", () => {
  it("run button reads triage-only with cron note", () => {
    const btn = html.match(/<button[^>]*id="btn-run"[^>]*>([^<]*)<\/button>/);
    assert.ok(btn, "#btn-run missing from index.html");
    assert.ok(/triage/i.test(btn[1]), `#btn-run must say triage, got: ${btn[1]}`);
    assert.ok(/cron/i.test(btn[1]), `#btn-run must mention cron, got: ${btn[1]}`);
    assert.ok(js.includes("Run triage now (briefs on cron)"), "app.js reset text diverged from the button copy");
  });

  it("toast states where briefs land", () => {
    assert.ok(js.includes("briefs land on the next cron tick"), "toast must state briefs land on cron ticks");
  });
});

describe("failure banner and mismatch badges (Task 3)", () => {
  it("served page owns an alert banner container", () => {
    assert.ok(html.includes('id="api-errors"'), "index.html lost #api-errors");
    assert.ok(html.includes('role="alert"'), "#api-errors must carry role=alert");
  });

  it("refresh tracks failures and renders a named banner with retry", () => {
    assert.ok(js.includes("state.apiFailures.push(\"/api/opportunities\")"), "opps failure untracked");
    assert.ok(js.includes("state.apiFailures.push(\"/api/experiments\")"), "experiments failure untracked");
    assert.ok(js.includes("state.apiFailures.push(\"/api/runs\")"), "runs failure untracked");
    assert.ok(js.includes("state.apiFailures.push(\"/api/health\")"), "health failure untracked");
    assert.ok(js.includes("renderApiErrors()"), "refresh never renders the banner");
    assert.ok(js.includes("api-retry") && js.includes("Retry"), "banner lacks a Retry button");
    assert.ok(js.includes("Could not load the priority list"), "ledger still claims Nothing here on failure");
  });

  it("db-down turns the agent pill red", () => {
    assert.ok(js.includes("agent: db down"), "pill never shows 'db down'");
    assert.ok(js.includes('health.db !== "up"') || js.includes("health.db !== 'up'"), "pill ignores health.db");
  });

  it("testing and running mismatches get read-only badges", () => {
    assert.ok(js.includes("testing · 0 experiments"), "ledger lost the testing badge");
    assert.ok(js.includes("running exp · opp still researching"), "board lost the running badge");
    assert.ok(js.includes("experiment_count"), "badges must reuse the returned experiment_count");
    assert.ok(js.includes("no auto-transitions"), "warnings block must stay read-only");
  });

  it("banner and badge styles stay in the light palette", () => {
    assert.ok(css.includes(".error-banner"), "styles.css lost .error-banner");
    assert.ok(css.includes(".warn-badge"), "styles.css lost .warn-badge");
    assert.ok(!css.includes("prefers-color-scheme"), "styles.css gained a dark-mode query");
  });
});

describe("honest drawer + no-brief pill (Task 2)", () => {
  it("drawer marks capped unreviewed scores", () => {
    assert.ok(js.includes("(capped — unreviewed)"), "drawer lost the capped-unreviewed marker");
    assert.ok(js.includes('includes("UNREVIEWED")'), "drawer marker must key off the UNREVIEWED marker");
  });

  it("ledger pills rows without briefs in the score cell", () => {
    assert.ok(js.includes("noBriefBadge"), "app.js lost the noBriefBadge helper");
    assert.ok(js.includes("brief_count"), "pill must reuse the returned brief_count");
    assert.ok(js.includes("no brief"), "ledger lost the 'no brief' pill copy");
    assert.ok(js.includes("${noBriefBadge(o)}"), "score cell must render noBriefBadge(o)");
  });

  it("review chip tooltip carries the without-briefs count", () => {
    assert.ok(js.includes("updateReviewChipTitle"), "app.js lost updateReviewChipTitle");
    assert.ok(js.includes("bare_without_brief"), "chip title must reuse health.bare_without_brief");
    assert.ok(js.includes("without briefs"), "chip title lost the 'without briefs' copy");
  });
});
