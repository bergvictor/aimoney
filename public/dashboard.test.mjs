// Dashboard disclosure regression tests (round2 Tasks 1-3): static guards in the
// repo's own style (no DOM; the bundle is browser code). Fails when the board
// loses the decisions/vetted copy, the triage button/toast stops disclosing
// the cron-only brief split, or the API-failure banner and mismatch badges go
// missing. Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const js = readFileSync(join(ROOT, "app.js"), "utf8");
const css = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("start-here skips killed/paused (audit 2026-09-20-round3 Task 3)", () => {
  it("topOpportunity filters killed and paused rows", () => {
    assert.ok(js.includes('o.status !== "killed"'), "topOpportunity must exclude killed rows");
    assert.ok(js.includes('o.status !== "paused"'), "topOpportunity must exclude paused rows");
  });

  it("scaling rows stay eligible and the strip hides when nothing actionable remains", () => {
    assert.ok(!js.includes('o.status !== "scaling"'), "topOpportunity must keep scaling rows eligible");
    assert.ok(js.includes("if (!top)"), "strip must hide when no actionable row remains");
  });
});

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
    assert.ok(js.includes("0\\b|free\\b|none\\b"), "zero-spend must tolerate bare 0/free/none phrasings");
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
    assert.ok(js.includes("focusNudgeCard"), "app.js lost the nudge deep-link helper");
    assert.ok(js.includes("focusNudgeCard(nudge)"), "nudge must deep-link to the stalest board card");
    assert.ok(js.includes('activateTab("experiments"'), "nudge deep-link must switch to the Experiments tab");
    assert.ok(js.includes("scrollIntoView"), "nudge deep-link must scroll to the stalest card");
    assert.ok(js.includes("exp-nudge-start"), "planned nudge lacks its one-click Start");
    assert.ok(js.includes("startExperiment(nudge.id)"), "planned nudge must carry its own Start");
    assert.ok(!js.includes("openDrawer(nudge.opportunity_id, nudge.id)"), "nudge must deep-link to the board card, not the drawer");
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
    assert.ok(js.includes("vetted this week →"), "exp summary lost 'Y vetted this week → Z total experiments'");
    assert.ok(js.includes("total experiments"), "exp summary lost the 'total experiments' window label");
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
    assert.ok(js.includes('state.apiFailures.push("/api/opportunities")'), "opps failure untracked");
    assert.ok(js.includes('state.apiFailures.push("/api/experiments")'), "experiments failure untracked");
    assert.ok(js.includes('state.apiFailures.push("/api/runs")'), "runs failure untracked");
    assert.ok(js.includes('state.apiFailures.push("/api/health")'), "health failure untracked");
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

describe("add-modal money fields (audit 2026-09-20 Task 2)", () => {
  it("Add modal owns $/mo, capital, and time-to-first-$ inputs", () => {
    assert.ok(js.includes('id="m-money"'), "Add modal lost the $/mo low-high input");
    assert.ok(js.includes('id="m-capital"'), "Add modal lost the capital_needed input");
    assert.ok(js.includes('id="m-first"'), "Add modal lost the time_to_first_dollar input");
  });

  it("Add submit parses $/mo like the drawer and sends money keys", () => {
    assert.ok(js.includes('$("#m-money").value.split(",")'), "Add submit must split the $/mo input on comma");
    assert.ok(js.includes("Number(x.trim()) || 0"), "Add submit must reuse the drawer $/mo parsing");
    assert.ok(js.includes("est_monthly_low: lo"), "Add POST lost est_monthly_low");
    assert.ok(js.includes("est_monthly_high: hi"), "Add POST lost est_monthly_high");
    assert.ok(js.includes('capital_needed: $("#m-capital")'), "Add POST lost capital_needed");
    assert.ok(js.includes('time_to_first_dollar: $("#m-first")'), "Add POST lost time_to_first_dollar");
  });

  it("a manual $0 add flows to the Zero spend filter", () => {
    assert.ok(js.includes("isZeroSpend"), "app.js lost the isZeroSpend helper");
    assert.ok(js.includes("\\$0|0\\b"), "manual $0 rows must still match the Zero spend chip");
    assert.ok(js.includes('capital_needed: $("#m-capital").value.trim()'), "manual adds must POST capital_needed so $0 rows match the chip");
  });
});

describe("drawer Vet/Kill with post-mortem parity (audit 2026-09-20 Task 3)", () => {
  it("drawer shows Vet/Kill for UNREVIEWED rows reusing the review handlers", () => {
    assert.ok(js.includes('id="drawer-vet"'), "drawer lost its Vet button");
    assert.ok(js.includes('id="drawer-kill"'), "drawer lost its Kill button");
    assert.ok(js.includes("vetOpportunity(o.id)"), "drawer Vet must reuse vetOpportunity");
    assert.ok(js.includes("killOpportunity(o.id, ev.currentTarget)"), "drawer Kill must reuse killOpportunity with its button anchor");
  });

  it("drawer admin status-to-killed routes through the same post-mortem inline input", () => {
    assert.ok(js.includes('azStatus === "killed"'), "admin save must gate the killed transition");
    assert.ok(js.includes("One-line post-mortem (required to kill):"), "killed gate lost the post-mortem prompt");
    assert.ok(js.includes("Kill cancelled — post-mortem required."), "killed gate lost the cancel toast");
    assert.ok(js.includes("cleanUnreviewed(o.notes)"), "killed gate must strip UNREVIEWED like killOpportunity");
    assert.ok(js.includes("killed] ${pm.trim()}"), "killed gate must append the prompted post-mortem");
  });
});

describe("weekly revenue header (audit 2026-09-20-round3 Task 1)", () => {
  it("experiments summary appends $X revenue this week from health, hidden on old backends", () => {
    assert.ok(js.includes("revenue_last_7d"), "app.js never reads health.revenue_last_7d");
    assert.ok(js.includes("revenue this week"), "exp summary lost the 'revenue this week' copy");
    assert.ok(js.includes("moneyCents(revenue)"), "exp summary must format revenue_last_7d via moneyCents");
    assert.ok(js.includes("revenue !== null"), "revenue line must hide when the key is absent (old backends)");
  });

  it("cents render as fixed-2dp dollars, never raw", () => {
    assert.ok(js.includes("moneyCents"), "app.js lost the moneyCents helper");
    assert.ok(js.includes("toFixed(2)"), "moneyCents must render fixed-2dp dollars");
    assert.ok(!js.includes("money(e.revenue_cents/100"), "board still formats revenue via the $/mo money() helper");
    assert.ok(!js.includes("money(e.spent_cents/100"), "board still formats spend via the $/mo money() helper");
  });
});

describe("review decision line (audit 2026-09-20-round1 Task 2)", () => {
  it("review rows show capital, next action, and source without the drawer", () => {
    assert.ok(js.includes("reviewDecisionLine"), "app.js lost the reviewDecisionLine helper");
    assert.ok(js.includes("${reviewDecisionLine(o)}"), "renderReview must render reviewDecisionLine(o)");
    assert.ok(js.includes('Capital: ${esc(o.capital_needed'), "decision line must show capital_needed");
    assert.ok(js.includes("Next: ${esc(next)}"), "decision line must show the brief next action");
    assert.ok(js.includes("brief_first_steps"), "decision line must reuse the list-API brief excerpt");
    assert.ok(js.includes("firstStepsFirstLine({ first_steps: o.brief_first_steps })"), "decision line must reuse firstStepsFirstLine");
  });

  it("next action hides when the row has no brief; source falls back to text", () => {
    assert.ok(js.includes("if (next) parts.push"), "Next segment must hide when the excerpt is empty");
    assert.ok(js.includes("o.source_url"), "decision line must link source_url");
    assert.ok(js.includes('target="_blank"'), "source link must open in a new tab");
    assert.ok(js.includes('rel="noreferrer"'), "source link must carry rel=noreferrer");
    assert.ok(js.includes('esc(o.source || "")'), "source must fall back to plain text without a URL");
  });
});

describe("one-click Start (audit 2026-09-20-round1 Task 3)", () => {
  it("planned cards show a Start button; orphaned cards never do", () => {
    assert.ok(js.includes("data-start-exp"), "board lost the Start button");
    assert.ok(js.includes('e.status === "planned" && !e.orphaned'), "Start must show only on planned, non-orphaned cards");
    assert.ok(js.includes(">Start</button>"), "Start button lost its label");
  });

  it("one click PATCHes running via a token-gated handler", () => {
    assert.ok(js.includes("startExperiment"), "app.js lost the startExperiment handler");
    assert.ok(js.includes("startExperiment(Number("), "Start click must call startExperiment with the card id");
    assert.ok(js.includes('JSON.stringify({ status: "running" })'), "Start must PATCH status=running only");
    assert.ok(js.includes("Experiment started"), "Start lost its success toast");
    assert.ok(js.includes('if (ev.target.closest("[data-start-exp]")) return;'), "card clicks must ignore the Start button");
  });

  it("names the spec-ad sprint as the first candidate, human-pressed", () => {
    assert.ok(js.includes("Spec-ad sprint: 10 brands, 10 free ads"), "app.js lost the first-candidate experiment name");
    assert.ok(js.includes("a human still presses it"), "Start must stay a human decision");
  });
});

describe("experiment money in cents (audit 2026-09-20 Task 4)", () => {
  it("experiment modal owns revenue and precise-spend inputs", () => {
    assert.ok(js.includes('id="m-revenue"'), "experiment modal lost the revenue input");
    assert.ok(js.includes('id="m-spend"'), "experiment modal lost the precise-spend input");
  });

  it("experiment save converts dollars to integer cents", () => {
    assert.ok(js.includes("revenue_cents:"), "experiment POST lost revenue_cents");
    assert.ok(js.includes("spent_cents:"), "experiment POST lost spent_cents");
    assert.ok(js.includes('* 100) || 0'), "experiment save must convert dollars to cents");
  });

  it("board cards show revenue/spend $ figures", () => {
    assert.ok(js.includes("moneyCents(e.revenue_cents)"), "board must format revenue_cents via moneyCents");
    assert.ok(js.includes("moneyCents(e.spent_cents)"), "board must format spent_cents via moneyCents");
    assert.ok(js.includes("} rev</span>"), "board lost the revenue figure copy");
    assert.ok(js.includes("} spent</span>"), "board lost the spend figure copy");
  });
});

describe("strip Vet/Kill (audit 2026-09-20-round2 Task 1)", () => {
  it("strip shows Vet/Kill when the top pick carries UNREVIEWED, reusing the review handlers", () => {
    assert.ok(js.includes('isNeedsReview(top)'), "strip lost its needs_review gate");
    assert.ok(js.includes('id="start-here-vet"'), "strip lost its Vet button");
    assert.ok(js.includes('id="start-here-kill"'), "strip lost its Kill button");
    assert.ok(js.includes("vetOpportunity(top.id)"), "strip Vet must reuse vetOpportunity");
    assert.ok(js.includes("killOpportunity(top.id, ev.currentTarget)"), "strip Kill must reuse killOpportunity with its button anchor");
  });

  it("vetted top picks render the strip unchanged (drawer link only)", () => {
    assert.ok(js.includes("(needsReview ?"), "strip Vet/Kill must render only when needsReview");
    assert.ok(js.includes("if (needsReview)"), "strip Vet/Kill listeners must attach only when needsReview");
    assert.ok(js.includes('id="start-here-open"'), "strip lost its drawer opener button");
  });

  it("vet keeps the Log-experiment handoff toast and refresh", () => {
    assert.ok(js.includes("Vetted — log the experiment"), "vet toast lost the next-step copy");
    assert.ok(js.includes("openExperimentModal(null, id)"), "vet handoff must reuse openExperimentModal(null, id)");
    const vet = js.slice(js.indexOf("async function vetOpportunity"), js.indexOf("async function vetAndLogStarter"));
    assert.ok(vet.includes("await refreshTargets({ experiments: false, runs: false })"), "vet must refetch opportunities+health only");
  });
});

describe("one-click Lose (audit 2026-09-20-round2 Task 2)", () => {
  it("planned/running cards show Lose; orphaned cards never do", () => {
    assert.ok(js.includes("data-lose-exp"), "board lost the Lose button");
    assert.ok(js.includes('(e.status === "planned" || e.status === "running") && !e.orphaned'), "Lose must show only on planned/running, non-orphaned cards");
    assert.ok(js.includes(">Lose</button>"), "Lose button lost its label");
  });

  it("one click + one inline line PATCHes lost with that line as result and post-mortem", () => {
    assert.ok(js.includes("loseExperiment"), "app.js lost the loseExperiment handler");
    assert.ok(js.includes("loseExperiment(Number("), "Lose click must call loseExperiment with the card id");
    assert.ok(js.includes("One-line post-mortem (required to close as lost):"), "Lose lost its post-mortem prompt");
    assert.ok(js.includes("Close cancelled — post-mortem required."), "Lose lost its empty-line cancel toast");
    assert.ok(js.includes("result: pm.trim(), post_mortem: pm.trim()"), "Lose must send the prompt line as both result and post_mortem");
    assert.ok(js.includes("Experiment closed as lost"), "Lose lost its success toast");
    assert.ok(js.includes('if (ev.target.closest("[data-lose-exp]")) return;'), "card clicks must ignore the Lose button");
  });

  it("Lose delegates off #board like Start and stays token-gated", () => {
    assert.equal(js.split('$("#board").addEventListener').length - 1, 3, "board must delegate Start, Lose, and Win clicks");
    assert.ok(js.includes("b.dataset.loseExp"), "Lose delegation must read the card id from data-lose-exp");
    assert.ok(js.includes("Human-pressed, one decision"), "Lose must stay a human decision");
  });
});

describe("one-click Win (audit 2026-09-20-round2 Task 1)", () => {
  it("planned/running cards show Win beside Lose; orphaned cards never do", () => {
    assert.ok(js.includes("data-win-exp"), "board lost the Win button");
    assert.ok(js.includes('(e.status === "planned" || e.status === "running") && !e.orphaned'), "Win must show only on planned/running, non-orphaned cards");
    assert.ok(js.includes(">Win</button>"), "Win button lost its label");
    const winLine = js.split("\n").find((l) => l.includes("data-win-exp"));
    assert.ok(winLine && winLine.includes("data-lose-exp"), "Win must sit beside Lose on the same row");
  });

  it("one click + $ + one inline line PATCHes won with that line as result and post-mortem", () => {
    assert.ok(js.includes("winExperiment"), "app.js lost the winExperiment handler");
    assert.ok(js.includes("winExperiment(Number("), "Win click must call winExperiment with the card id");
    assert.ok(js.includes("inlineWinClose"), "app.js lost the inlineWinClose helper");
    assert.ok(js.includes("One-line post-mortem (required to close as won):"), "Win lost its post-mortem prompt");
    assert.ok(js.includes("Win cancelled — post-mortem required."), "Win lost its empty-line cancel toast");
    assert.ok(js.includes('JSON.stringify({ status: "won"'), "Win must PATCH status=won");
    assert.ok(js.includes("result: pm.trim(), post_mortem: pm.trim()"), "Win must send the prompt line as both result and post_mortem");
    assert.ok(js.includes("revenue_cents: revenueCents"), "Win must send the human-entered amount as revenue_cents");
    assert.ok(js.includes("Experiment closed as won"), "Win lost its success toast");
    assert.ok(js.includes('if (ev.target.closest("[data-win-exp]")) return;'), "card clicks must ignore the Win button");
  });

  it("empty line cancels with the row untouched", () => {
    const winRow = js.slice(js.indexOf("function inlineWinClose"), js.indexOf("function cleanUnreviewed"));
    assert.ok(winRow.includes("[data-pm-input]"), "Win row lacks its one-line input");
    assert.ok(winRow.includes("if (!pm || !pm.trim()) { cleanup(); toast(cancelToast); return; }"), "Win empty line must cancel with the row untouched");
  });

  it("bad/negative $ amounts clamp to 0 exactly like the modal", () => {
    assert.ok(js.includes('Math.max(0, Math.round(Number($("#m-revenue").value.trim()) * 100) || 0)'), "modal lost its revenue clamp");
    assert.ok(js.includes("Math.max(0, Math.round(Number(amount.value.trim()) * 100) || 0)"), "Win must clamp the inline $ amount exactly like the modal");
  });

  it("Win delegates off #board like Start/Lose and stays token-gated", () => {
    assert.equal(js.split('$("#board").addEventListener').length - 1, 3, "board must delegate Start, Lose, and Win clicks");
    assert.ok(js.includes("b.dataset.winExp"), "Win delegation must read the card id from data-win-exp");
    assert.ok(js.includes("Human-pressed, one decision"), "Win must stay a human decision");
    const winFn = js.slice(js.indexOf("async function winExperiment"), js.indexOf("async function winExperiment") + 2000);
    assert.ok(winFn.includes('openAdminModal("Enter the admin token first.")'), "Win must open the admin modal without a token");
  });
});

describe("revenue source (audit 2026-09-20-round2 Task 3)", () => {
  it("experiment modal owns a revenue-source input and sends ≤120 chars", () => {
    assert.ok(js.includes('<input id="m-source" maxlength="120"'), "experiment modal lost the revenue-source input");
    assert.ok(js.includes('revenue_source: $("#m-source").value.trim().slice(0, 120)'), "experiment save must send revenue_source truncated to 120");
    assert.ok(js.includes('exp?.revenue_source || ""'), "modal must prefill the source on update");
  });

  it("board shows the amount with its source; old rows render unchanged", () => {
    assert.ok(js.includes("moneyCents(e.revenue_cents)"), "board lost its revenue figure");
    assert.ok(js.includes("} rev</span>"), "board lost the revenue figure copy");
    assert.ok(js.includes("e.revenue_source"), "board never reads revenue_source");
    assert.ok(js.includes("via ${esc(e.revenue_source)}"), "board lost the via-source copy");
    const boardLine = js.split("\n").find((l) => l.includes("} rev</span>"));
    assert.ok(boardLine && boardLine.includes("e.revenue_cents > 0 ?"), "board must gate revenue display on stored cents");
    assert.ok(boardLine && boardLine.includes("e.revenue_source ?"), "via-source must render only when a source exists");
  });

  it("drawer shows the amount with its source plus the ended date", () => {
    assert.ok(js.includes("moneyCents(e.revenue_cents || 0)"), "drawer lost its revenue figure");
    assert.ok(js.includes("rev /"), "drawer lost the '$X rev / $Y spent' copy");
    assert.ok(js.includes("via ${esc(e.revenue_source)}"), "drawer lost the via-source copy");
    assert.ok(js.includes("e.ended_at"), "drawer lost the ended_at date");
  });
});

describe("closed-experiment money in drawer (audit 2026-09-20-round3 Task 1)", () => {
  it("drawer cards show fixed-2dp revenue/spend plus ended date", () => {
    assert.ok(js.includes("moneyCents(e.revenue_cents || 0)"), "drawer lost its revenue figure");
    assert.ok(js.includes("moneyCents(e.spent_cents || 0)"), "drawer lost its spend figure");
    assert.ok(js.includes("rev /"), "drawer lost the '$X rev / $Y spent' copy");
    assert.ok(js.includes("e.ended_at"), "drawer lost the ended_at date");
    assert.ok(js.includes("· ended"), "drawer lost the ended date copy");
  });

  it("board cards keep their existing money figures unchanged", () => {
    assert.ok(js.includes("moneyCents(e.revenue_cents)"), "board lost its revenue figure");
    assert.ok(js.includes("moneyCents(e.spent_cents)"), "board lost its spend figure");
    assert.ok(js.includes("} rev</span>"), "board lost the revenue figure copy");
    assert.ok(js.includes("} spent</span>"), "board lost the spend figure copy");
  });
});

describe("token modal + inline post-mortem (audit 2026-09-20-round3 Task 2)", () => {
  it("Vet/Kill/Start/Lose/Win/Starter open the admin modal when the token is missing", () => {
    assert.ok(js.includes("function openAdminModal"), "app.js lost openAdminModal");
    assert.ok(js.includes('openAdminModal("Enter the admin token first.")'), "gated taps must open the admin modal with the toast text as subnote");
    assert.equal(js.split('openAdminModal("Enter the admin token first.")').length - 1, 7, "shared fetchDetailForWrite gate + Vet/Kill/Start/Lose/Win/Starter handlers must all open the modal");
    assert.ok(js.includes("[data-admin-subnote]"), "modal must pin the subnote");
    assert.ok(js.includes('$("#btn-admin").click()'), "openAdminModal must reuse the Admin showModal block");
  });

  it("kill and lose use an inline one-line input, empty cancels, row untouched", () => {
    assert.ok(js.includes("inlinePostMortem"), "app.js lost the inlinePostMortem helper");
    assert.ok(js.includes("[data-pm-input]"), "inline row lacks its one-line input");
    assert.ok(js.includes("Kill cancelled — post-mortem required."), "kill lost its empty-cancel toast");
    assert.ok(js.includes("Close cancelled — post-mortem required."), "lose lost its empty-cancel toast");
    assert.ok(js.includes("One-line post-mortem (required to kill):"), "kill lost its post-mortem copy");
    assert.ok(js.includes("One-line post-mortem (required to close as lost):"), "lose lost its post-mortem copy");
    assert.ok(!js.includes("const pm = prompt("), "app.js still blocks on prompt()");
    assert.ok(css.includes(".pm-inline"), "styles lack the inline row");
  });

  it("API closure gate intact: result + post-mortem still required", () => {
    assert.ok(js.includes("result: pm.trim(), post_mortem: pm.trim()"), "lose must still send result + post-mortem");
    assert.ok(js.includes("killed] ${pm.trim()}"), "kill must still append the post-mortem");
  });
});

describe("review brief line (audit 2026-09-20-round1 Task 1)", () => {
  it("review rows render the brief summary under the decision line", () => {
    assert.ok(js.includes("reviewBriefLine"), "app.js lost the reviewBriefLine helper");
    assert.ok(js.includes("${reviewDecisionLine(o)}"), "renderReview lost reviewDecisionLine(o)");
    assert.ok(js.includes("${reviewBriefLine(o)}"), "renderReview must render reviewBriefLine(o)");
    assert.ok(js.indexOf("${reviewBriefLine(o)}") > js.indexOf("${reviewDecisionLine(o)}"), "brief line must sit under the decision line");
    assert.ok(js.includes("o.brief_summary"), "brief line must reuse the list-API brief excerpt");
    assert.ok(js.includes("review-brief muted"), "brief line must render as one muted line");
  });

  it("bare rows read No brief yet instead of rendering empty", () => {
    assert.ok(js.includes("No brief yet"), "brief line lost the 'No brief yet' copy");
    assert.ok(js.includes('s || "No brief yet"'), "brief line must fall back to 'No brief yet' when the excerpt is empty");
  });
});

describe("lifetime revenue header (audit 2026-09-20-round1 Task 3)", () => {
  it("experiments summary appends the lifetime figure, hidden on old backends", () => {
    assert.ok(js.includes("revenue_total"), "app.js never reads health.revenue_total");
    assert.ok(js.includes("moneyCents(revenueTotal)"), "exp summary must format revenue_total via moneyCents");
    assert.ok(js.includes("} lifetime"), "exp summary lost the lifetime figure copy");
    assert.ok(js.includes("revenueTotal !== null"), "lifetime line must hide when the key is absent (old backends)");
  });

  it("weekly revenue figure stays unchanged", () => {
    assert.ok(js.includes("moneyCents(revenue)"), "exp summary lost the weekly revenue format");
    assert.ok(js.includes("revenue this week"), "exp summary lost the 'revenue this week' copy");
    assert.ok(js.indexOf("revenue this week") < js.indexOf("} lifetime"), "lifetime figure must sit next to the weekly figure");
  });
});

describe("vet & log starter (audit 2026-09-20-round3 Task 1)", () => {
  it("review rows show Vet & log starter beside Vet", () => {
    assert.ok(js.includes("data-vet-starter"), "review rows lost the Vet & log starter button");
    assert.ok(js.includes("Vet &amp; log starter"), "starter button lost its label");
    assert.ok(js.includes("vetAndLogStarter(Number("), "starter click must call vetAndLogStarter with the row id");
    const actions = js.slice(js.indexOf('<div class="review-actions">'), js.indexOf('<div class="review-actions">') + 600);
    assert.ok(actions.includes("data-vet=") && actions.includes("data-vet-starter"), "starter must sit beside Vet in the review actions");
  });

  it("one tap vets, POSTs a prefilled planned experiment, and flips to testing", () => {
    assert.ok(js.includes("async function vetAndLogStarter"), "app.js lost the vetAndLogStarter handler");
    const fn = js.slice(js.indexOf("async function vetAndLogStarter"), js.indexOf("async function killOpportunity"));
    assert.ok(fn.includes("vettedNotes(o.notes)"), "starter must vet via the shared vettedNotes helper");
    assert.ok(fn.includes('api("/api/experiments",'), "starter must POST the experiment");
    assert.ok(fn.includes('status: "planned"'), "starter experiment must enter as planned");
    assert.ok(fn.includes("Starter: ${o.title}"), "starter name must prefill from the row title");
    assert.ok(fn.includes("o.one_liner"), "starter hypothesis must prefill from the row one-liner");
    assert.ok(fn.includes("o.brief_first_steps"), "starter hypothesis must fall back to the brief next action");
    assert.ok(fn.includes("metric:"), "starter must prefill a metric");
    assert.ok(fn.includes('JSON.stringify({ status: "testing" })'), "starter must flip the row to testing");
  });

  it("toast carries a Start shortcut and the tap stays token-gated", () => {
    const fn = js.slice(js.indexOf("async function vetAndLogStarter"), js.indexOf("async function killOpportunity"));
    assert.ok(fn.includes("starter logged, moved to testing"), "starter lost its success toast");
    assert.ok(fn.includes("startExperiment(created.id)"), "starter toast must carry a Start shortcut for the created experiment");
    assert.ok(fn.includes('openAdminModal("Enter the admin token first.")'), "starter must open the admin modal without a token");
    assert.ok(fn.includes("await refreshTargets({ runs: false })"), "starter must refetch opportunities+experiments+health (runs only change on triage)");
  });
});

describe("shared vetted-notes helper (audit 2026-09-20-round1 Task 4)", () => {
  it("vettedNotes owns the tag, the UNREVIEWED clear, and the 8000-char cap", () => {
    assert.ok(js.includes("function vettedNotes(notes)"), "app.js lost the vettedNotes helper");
    const helper = js.slice(js.indexOf("function vettedNotes(notes)"), js.indexOf("async function fetchDetailForWrite"));
    assert.ok(helper.includes("[${day} vetted] Human vetted; cap lifted."), "helper lost the vetted tag");
    assert.ok(helper.includes("cleanUnreviewed(notes)"), "helper must clear UNREVIEWED");
    assert.ok(helper.includes(".slice(-8000)"), "helper must keep the 8000-char cap");
  });

  it("Vet and Vet-&-starter both call vettedNotes with no inline tag left", () => {
    const vetInner = js.slice(js.indexOf("async function vetOpportunityInner"), js.indexOf("async function vetAndLogStarter"));
    const starterInner = js.slice(js.indexOf("async function vetAndLogStarterInner"), js.indexOf("async function killOpportunity"));
    for (const [name, fn] of [["vet", vetInner], ["starter", starterInner]]) {
      assert.ok(fn.includes("vettedNotes(o.notes)"), `${name} must vet via the shared vettedNotes helper`);
      assert.ok(!fn.includes("[${day} vetted]"), `${name} must not keep an inline vetted tag beside the helper`);
    }
    assert.equal(js.split("[${day} vetted] Human vetted; cap lifted.").length - 1, 1, "vetted tag must live in exactly one place");
  });
});

describe("win revenue source (audit 2026-09-20-round3 Task 2)", () => {
  it("Win inline row owns an optional one-line source input beside $ + post-mortem", () => {
    const winRow = js.slice(js.indexOf("function inlineWinClose"), js.indexOf("function cleanUnreviewed"));
    assert.ok(winRow.includes("dataset.winSource"), "Win row lacks its source input");
    assert.ok(winRow.includes("Revenue source (optional)"), "Win source input lost its optional copy");
    assert.ok(winRow.includes("source.maxLength = 120"), "Win source input must cap at 120 chars like the modal");
    assert.ok(winRow.includes("row.appendChild(source)"), "Win row must render the source input");
  });

  it("close sends revenue_source truncated to 120; empty renders exactly as today", () => {
    const winRow = js.slice(js.indexOf("function inlineWinClose"), js.indexOf("function cleanUnreviewed"));
    assert.ok(winRow.includes("source.value.trim().slice(0, 120)"), "Win must trim + truncate the source like the modal");
    assert.ok(js.includes("revenue_source: revenueSource"), "Win close must send revenue_source");
    assert.ok(js.includes("e.revenue_source ?"), "empty source must keep rendering without the via bit");
    const doWin = js.slice(js.indexOf("const doWin = async"), js.indexOf("inlineWinClose(winContainer"));
    assert.ok(doWin.includes('status: "won"'), "Win must still PATCH status=won");
    assert.ok(doWin.includes("result: pm.trim(), post_mortem: pm.trim()"), "Win must still send the line as result + post-mortem");
  });

  it("empty post-mortem line still cancels with the row untouched", () => {
    const winRow = js.slice(js.indexOf("function inlineWinClose"), js.indexOf("function cleanUnreviewed"));
    assert.ok(winRow.includes("if (!pm || !pm.trim()) { cleanup(); toast(cancelToast); return; }"), "Win empty line must cancel with the row untouched");
    assert.ok(winRow.includes("onSubmit(pm, revenueCents, revenueSource)"), "Win submit must pass the source through");
  });
});

describe("nudge deep-link (audit 2026-09-20-round3 Task 3)", () => {
  it("deep-link helper switches tab, scrolls, and highlights the stalest card", () => {
    assert.ok(js.includes("function focusNudgeCard"), "app.js lost focusNudgeCard");
    const fn = js.slice(js.indexOf("// Nudge deep-link"), js.indexOf("async function startExperiment"));
    assert.ok(fn.includes('activateTab("experiments", true)'), "deep-link must switch to the Experiments tab");
    assert.ok(fn.includes('#board .card[data-id="'), "deep-link must find the stalest card on the board");
    assert.ok(fn.includes("scrollIntoView"), "deep-link must scroll to the card");
    assert.ok(fn.includes("borderColor"), "deep-link must highlight the card");
    assert.ok(fn.includes("No auto-transitions"), "deep-link must stay human-pressed");
  });

  it("planned nudges carry their own Start; the nudge still fires only at zero decisions", () => {
    assert.ok(js.includes('nudge.status === "planned"'), "nudge Start must gate on planned status");
    assert.ok(js.includes("exp-nudge-start"), "planned nudge lacks its Start button");
    assert.ok(js.includes("startExperiment(nudge.id)"), "planned nudge Start must reuse startExperiment");
    assert.ok(js.includes("decisions === 0"), "nudge must still fire only when decisions_last_7d is 0");
  });
});

describe("tolerant zero-spend match (audit 2026-09-20-round2 Task 3)", () => {
  // The matcher is extracted from the shipped source (not copied) so these
  // cases fail if app.js regresses to prefix matching or drops a phrasing.
  const isZeroSpendSrc = js.match(/const isZeroSpend = \(o\) =>\s*(\/[^;]*\/i)\.test/);
  assert.ok(isZeroSpendSrc, "isZeroSpend must stay a single case-insensitive regex test");
  const isZeroSpendRe = new RegExp(isZeroSpendSrc[1].slice(1, -2), "i");

  it("matches $0, bare 0, free, and none case-insensitively", () => {
    for (const c of ["$0", "$0-200/mo tools", "  $0 + 10 hours", "0", "0 USD", "Free", "free trial", "None", "none yet"]) {
      assert.ok(isZeroSpendRe.test(c), `should match zero-spend: ${JSON.stringify(c)}`);
    }
  });

  it("rejects non-zero, empty, and near-miss phrasings", () => {
    for (const c of ["", "unknown", "$100-400/mo telco+AI", "$50-200/mo", "$5", "10 hours", "freelancer fees", "nonetheless"]) {
      assert.ok(!isZeroSpendRe.test(c), `should not match zero-spend: ${JSON.stringify(c)}`);
    }
  });

  it("seeds keep their $0 classification (none uses a newly-matched phrasing)", () => {
    const seedSql = readFileSync(join(ROOT, "..", "d1", "seed.sql"), "utf8");
    for (const c of ["$0", "$0-200/mo tools", "$0-100/mo", "$0-300/mo", "$0-500", "$0-200/mo"]) {
      assert.ok(seedSql.includes(`'${c}'`), `seed lost capital ${JSON.stringify(c)} — recheck classification`);
      assert.ok(isZeroSpendRe.test(c), `seed should match zero-spend: ${JSON.stringify(c)}`);
    }
    for (const c of ["$100-400/mo telco+AI", "$50-200/mo"]) {
      assert.ok(seedSql.includes(`'${c}'`), `seed lost capital ${JSON.stringify(c)} — recheck classification`);
      assert.ok(!isZeroSpendRe.test(c), `seed should not match zero-spend: ${JSON.stringify(c)}`);
    }
  });
});

describe("client-side review list (audit 2026-09-20-round1 Task 1)", () => {
  // The derivation is extracted from the shipped source (not copied) so these
  // cases fail if app.js regresses to a second list fetch or drops the sort.
  const deriveStart = js.indexOf("const deriveReviewList");
  assert.ok(deriveStart !== -1, "app.js lost the deriveReviewList helper");
  const deriveReviewList = new Function(
    `${js.slice(deriveStart, js.indexOf(";", deriveStart) + 1)} return deriveReviewList;`)();

  it("keeps UNREVIEWED rows only", () => {
    const rows = [
      { id: 1, notes: "Agent proposal — UNREVIEWED, capped", created_at: "2026-09-18T00:00:00Z" },
      { id: 2, notes: "[2026-09-19 vetted] Human vetted; cap lifted.", created_at: "2026-09-10T00:00:00Z" },
      { id: 3, notes: null, created_at: "2026-09-11T00:00:00Z" },
    ];
    assert.deepEqual(deriveReviewList(rows).map((o) => o.id), [1]);
  });

  it("sorts oldest-first; rows without a date sort first like the server ASC", () => {
    const rows = [
      { id: 1, notes: "UNREVIEWED", created_at: "2026-09-18T00:00:00Z" },
      { id: 2, notes: "UNREVIEWED", created_at: "2026-09-10T00:00:00Z" },
      { id: 3, notes: "UNREVIEWED", created_at: "" },
    ];
    assert.deepEqual(deriveReviewList(rows).map((o) => o.id), [3, 2, 1]);
  });

  it("is null-safe on missing notes and empty input", () => {
    assert.deepEqual(deriveReviewList(null), []);
    assert.deepEqual(deriveReviewList([]), []);
    assert.deepEqual(deriveReviewList([{ id: 9 }]).map((o) => o.id), []);
  });

  it("refreshReview derives first and keeps the endpoint only as a truncation fallback", () => {
    const fn = js.slice(js.indexOf("async function refreshReview"), js.indexOf("const fmtAgeH"));
    assert.ok(fn.includes("deriveReviewList(state.opportunities)"), "refreshReview must derive from the already-fetched main list");
    assert.ok(fn.includes("unreviewed=1&sort=oldest&limit=200"), "refreshReview lost the truncation fallback endpoint");
    assert.ok(fn.indexOf("deriveReviewList") < fn.indexOf("unreviewed=1"), "derivation must run before any fallback fetch");
    assert.ok(fn.includes("state.opportunities.length"), "fallback must trigger only when the main list hit its limit");
    assert.ok(fn.includes("r.opportunities || rows"), "a failed fallback must keep the client-side rows");
  });

  it("refresh fetches the opportunity list exactly once (no second list fetch)", () => {
    const fn = js.slice(js.indexOf("async function refresh()"));
    assert.equal(fn.split('api("/api/opportunities').length - 1, 1, "refresh must fetch the opportunity list exactly once");
  });
});

describe("targeted refresh per action (audit 2026-09-20-round2 Task 1)", () => {
  const fnBetween = (start, end) => js.slice(js.indexOf(start), js.indexOf(end));
  const vet = fnBetween("async function vetOpportunity", "async function vetAndLogStarter");
  const starter = fnBetween("async function vetAndLogStarter", "async function killOpportunity");
  const kill = fnBetween("async function killOpportunity", 'document.querySelectorAll(".filters .chip")');
  const start = fnBetween("async function startExperiment", "async function loseExperiment");
  const lose = fnBetween("async function loseExperiment", "async function winExperiment");
  const win = fnBetween("async function winExperiment", "function renderExperiments");
  const admin = fnBetween("function renderAdminZone", "/* ---- modals ---- */");
  const expSave = fnBetween("function openExperimentModal", '$("#btn-add-exp")');

  it("vet/kill refetch opportunities+health only (runs change on triage, not on review)", () => {
    for (const [name, fn] of [["vet", vet], ["kill", kill]]) {
      assert.ok(fn.includes("await refreshTargets({ experiments: false, runs: false })"), `${name} must refetch opportunities+health only`);
      assert.ok(!fn.includes("await refresh()"), `${name} must not pay for a full refresh`);
    }
  });

  it("Start refetches experiments+health only (starting writes no ledger line)", () => {
    assert.ok(start.includes("await refreshTargets({ opportunities: false, runs: false })"), "Start must refetch experiments+health only");
    assert.ok(!start.includes("await refresh()"), "Start must not pay for a full refresh");
  });

  it("win/lose also refetch opportunities (closing appends the outcome-ledger line)", () => {
    for (const [name, fn] of [["lose", lose], ["win", win]]) {
      assert.ok(fn.includes("await refreshTargets({ runs: false })"), `${name} must refetch opportunities+experiments+health`);
      assert.ok(!fn.includes("await refresh()"), `${name} must not refetch the research log`);
    }
  });

  it("vet-&-log-starter and experiment saves refetch opportunities too (they create rows)", () => {
    for (const [name, fn] of [["starter", starter], ["experiment save", expSave]]) {
      assert.ok(fn.includes("await refreshTargets({ runs: false })"), `${name} must refetch opportunities+experiments+health`);
      assert.ok(!fn.includes("await refresh()"), `${name} must not refetch the research log`);
    }
  });

  it("drawer save/kill/rescore and add-opportunity refetch opportunities+health only", () => {
    assert.equal(admin.split("await refreshTargets({ experiments: false, runs: false })").length - 1, 3, "admin save/kill/rescore must each refetch opportunities+health only");
    assert.ok(!admin.includes("await refresh()"), "admin saves must not pay for a full refresh");
    const addAt = js.indexOf('toast("Added to the priority list")');
    const add = js.slice(addAt, addAt + 150);
    assert.ok(add.includes("await refreshTargets({ experiments: false, runs: false })"), "add must refetch opportunities+health only");
  });

  it("runs still refetch on boot, banner Retry, the delayed triage refresh, and Research-tab switch", () => {
    const full = js.slice(js.indexOf("async function refresh()"));
    assert.ok(full.includes("return refreshTargets({})"), "refresh() must stay the full repaint via refreshTargets({})");
    assert.ok(js.includes("refresh().catch"), "boot must keep the full refresh");
    assert.ok(js.includes("() => refresh()"), "banner Retry must stay a full refresh");
    assert.ok(js.includes("setTimeout(refresh, 45000)"), "delayed post-triage refresh must stay full");
    const tabs = fnBetween('tab.addEventListener("click", () => {', "activateTab(new URLSearchParams");
    assert.ok(tabs.includes('tab.dataset.tab === "research"'), "tab switch must refetch the log when opening Research");
    assert.ok(tabs.includes("refreshTargets({ opportunities: false, experiments: false })"), "Research-tab switch must refetch runs+health only");
  });

  it("scoped refresh keeps failure tracking, the review derive, and all three renders", () => {
    const rt = js.slice(js.indexOf("async function refreshTargets"));
    assert.ok(rt.includes('state.apiFailures.push("/api/opportunities")'), "opps failure untracked");
    assert.ok(rt.includes('state.apiFailures.push("/api/experiments")'), "experiments failure untracked");
    assert.ok(rt.includes('state.apiFailures.push("/api/runs")'), "runs failure untracked");
    assert.ok(rt.includes('state.apiFailures.push("/api/health")'), "health failure untracked");
    assert.ok(rt.includes("filter((f) => !refetching.has(f))"), "scoped refresh must keep unrelated failure flags");
    assert.ok(rt.includes("await refreshReview()"), "refresh must keep the client-side review derive");
    assert.ok(rt.includes("renderLedger()") && rt.includes("renderExperiments()") && rt.includes("renderRuns()"), "refresh must repaint all sections (renders are free)");
  });
});

describe("start-here list excerpt (audit 2026-09-20-round2 Task 3)", () => {
  const strip = js.slice(js.indexOf("function renderStartHere"), js.indexOf("/* ---- priority list ---- */"));

  it("reads the next action from the list payload, with the bare-row fallback", () => {
    assert.ok(strip.includes("firstStepsFirstLine({ first_steps: top.brief_first_steps })"), "strip must reuse the list-API brief excerpt");
    assert.ok(strip.includes('excerpt || "No brief yet — open the drawer for facts."'), "strip must keep the bare-row fallback");
    assert.ok(strip.includes("money(top.est_monthly_low, top.est_monthly_high)"), "strip must keep the $/mo range");
  });

  it("issues zero detail fetches and keeps no brief-text cache", () => {
    assert.ok(!strip.includes("api(`/api/opportunities/${top.id}`)"), "strip must not fetch the detail endpoint");
    assert.ok(!strip.includes("topBriefText"), "strip must not keep the brief-text cache");
    assert.ok(!js.includes("topBriefText"), "topBriefText state must be gone everywhere");
    assert.ok(!strip.includes("Loading next action"), "strip must not show a loading state for data it already has");
  });
});

describe("needs_review bit + detail-before-write (audit 2026-09-20-round3 Task 2)", () => {
  it("deriveReviewList honors the bit, falling back to notes", () => {
    const deriveStart = js.indexOf("const deriveReviewList");
    const deriveReviewList = new Function(
      `${js.slice(deriveStart, js.indexOf(";", deriveStart) + 1)} return deriveReviewList;`)();
    assert.deepEqual(deriveReviewList([
      { id: 1, needs_review: 1, created_at: "2026-09-18T00:00:00Z" },
      { id: 2, needs_review: 0, notes: "UNREVIEWED stale?", created_at: "2026-09-10T00:00:00Z" },
      { id: 3, notes: "Agent proposal — UNREVIEWED", created_at: "2026-09-11T00:00:00Z" },
    ]).map((o) => o.id), [3, 1]);
  });

  it("strip gates Vet/Kill on the bit with zero detail fetches", () => {
    const strip = js.slice(js.indexOf("function renderStartHere"), js.indexOf("/* ---- priority list ---- */"));
    assert.ok(strip.includes("isNeedsReview(top)"), "strip must gate on the needs_review bit");
    assert.ok(!strip.includes("api(`/api/opportunities/${top.id}`)"), "strip must not fetch the detail endpoint");
  });

  it("Vet, Vet-&-starter, and Kill share one detail-before-write helper, then append byte-identical tags", () => {
    const helper = js.slice(js.indexOf("async function fetchDetailForWrite"), js.indexOf("async function vetOpportunity"));
    assert.ok(helper.includes('openAdminModal("Enter the admin token first.")'), "helper must open the admin modal without a token");
    assert.ok(helper.includes("api(`/api/opportunities/${id}`)"), "helper must GET the detail endpoint");
    assert.ok(helper.includes("o.notes = d.opportunity.notes"), "helper must stash full detail notes for the write");
    assert.ok(helper.includes("toast(`${actionLabel} failed:"), "helper must toast the action label on failure");
    assert.ok(helper.includes("return null"), "helper must return null when the caller must return early");
    for (const [name, start, end, label] of [
      ["vet", "async function vetOpportunity", "async function vetOpportunityInner", "Vet"],
      ["starter", "async function vetAndLogStarter", "async function vetAndLogStarterInner", "Starter"],
      ["kill", "async function killOpportunity", "async function killOpportunityInner", "Kill"],
    ]) {
      const fn = js.slice(js.indexOf(start), js.indexOf(end));
      assert.ok(fn.includes(`fetchDetailForWrite(id, "${label}")`), `${name} must reuse the shared detail-before-write helper with its label`);
      assert.ok(!fn.includes("api(`/api/opportunities/${id}`)"), `${name} must not keep an inline detail fetch beside the helper`);
      assert.ok(fn.indexOf("fetchDetailForWrite") < fn.indexOf("Inner(id"), `${name} must fetch before delegating to the write`);
    }
    assert.ok(js.includes("[${day} vetted] Human vetted; cap lifted."), "vetted tag changed");
    assert.ok(js.includes("[${day} killed] ${pm.trim()}"), "killed tag changed");
  });
});

describe("meta once + delayed-only triage refresh (audit 2026-09-20-round1 Task 2)", () => {
  it("fetches /api/meta from one guarded site (once per boot, retry on failure)", () => {
    assert.equal(js.split('api("/api/meta")').length - 1, 1, "/api/meta must be fetched from exactly one site");
    const fn = js.slice(js.indexOf("async function refresh()"));
    assert.ok(fn.includes("if (!metaLoaded)"), "refresh must guard the meta fetch with the once-per-boot flag");
    assert.equal(js.split("metaLoaded = true").length - 1, 1, "metaLoaded must set only on success, so a failed boot retries");
  });

  it("manual triage paints once via the delayed refresh only", () => {
    const fn = js.slice(js.indexOf('$("#btn-run")'), js.indexOf("/* ---- read-only warnings"));
    assert.ok(fn.includes("setTimeout(refresh, 45000)"), "manual run lost its delayed refresh");
    assert.ok(!fn.includes("await refresh()"), "manual run still paints an immediate no-op refresh");
  });
});

describe("five-second read (audit 2026-09-20-round1 Task 3)", () => {
  it("Start-here strip renders above the filter toolbar inside #tab-priority", () => {
    const stripAt = html.indexOf('id="start-here"');
    const toolbarAt = html.indexOf('<div class="toolbar">');
    const sectionAt = html.indexOf('id="tab-priority"');
    assert.ok(stripAt !== -1 && toolbarAt !== -1, "index.html lost #start-here or the toolbar");
    assert.ok(sectionAt !== -1 && sectionAt < stripAt, "#start-here must stay inside #tab-priority");
    assert.ok(stripAt < toolbarAt, "#start-here must sit above the filter toolbar");
  });

  it("strip keeps the #1 pick with $/mo, capital, next action, and Vet/Kill-or-drawer actions", () => {
    assert.ok(js.includes("money(top.est_monthly_low, top.est_monthly_high)"), "strip lost the $/mo range");
    assert.ok(js.includes("Capital: ${esc(top.capital_needed"), "strip lost the capital line");
    assert.ok(js.includes("firstStepsFirstLine({ first_steps: top.brief_first_steps })"), "strip lost the brief next action");
    assert.ok(js.includes('id="start-here-open"'), "strip lost its drawer opener button");
    assert.ok(js.includes("openDrawer(top.id)"), "strip must deep-link via openDrawer(top.id)");
    assert.ok(js.includes('id="start-here-vet"'), "strip lost its Vet button");
    assert.ok(js.includes('id="start-here-kill"'), "strip lost its Kill button");
  });

  it("mobile masthead compacts so the strip reads without scrolling on a 360px phone", () => {
    const mobileAt = css.indexOf("@media (max-width: 760px)");
    assert.ok(mobileAt !== -1, "styles.css lost the mobile block");
    const mobile = css.slice(mobileAt);
    assert.ok(/\.masthead h1 \{ font-size: 22px/.test(mobile), "mobile headline must shrink to 22px");
    assert.ok(/\.lede \{[^}]*text-overflow: ellipsis/.test(mobile), "mobile lede must collapse to one ellipsized line");
    assert.ok(/\.masthead-inner \{[^}]*padding: 16px 16px 12px/.test(mobile), "mobile masthead must tighten its padding");
  });

  it("every filter, tab, and handler behaves exactly as today", () => {
    for (const chip of ['data-status=""', 'data-status="backlog"', 'data-status="researching"', 'data-status="testing"', 'data-status="scaling"', 'data-status="killed"', 'data-zero="1"', 'data-review="1"']) {
      assert.ok(html.includes(chip), `index.html lost the ${chip} chip`);
    }
    assert.ok(html.includes('id="btn-add"'), "index.html lost the Add opportunity button");
    for (const tab of ['data-tab="priority"', 'data-tab="experiments"', 'data-tab="research"']) {
      assert.ok(html.includes(tab), `index.html lost the ${tab} tab`);
    }
    assert.ok(js.includes("chip.dataset.zero"), "chip handler ignores the Zero spend chip");
    assert.ok(js.includes("chip.dataset.review"), "chip handler ignores the review chip");
    assert.ok(js.includes("chip.dataset.status"), "chip handler ignores the status chips");
    assert.ok(js.includes("renderStartHere()"), "ledger render lost the strip call");
  });
});

describe("dead toast gates (audit 2026-09-20-round1 Task 4)", () => {
  it("unreachable toast gates behind modal returns are gone; live gates stay", () => {
    assert.ok(!js.includes("supersedes the toast gate"), "app.js still ships dead toast gates");
    assert.equal(js.split('openAdminModal("Enter the admin token first.")').length - 1, 7, "modal gates must stay at 7 (one shared write-path gate + six handlers)");
    assert.equal(js.split('return toast("Enter the admin token first.")').length - 1, 3, "only the 3 live toast gates must remain");
  });
});

describe("probe-failure disclosure (audit 2026-09-20-round2 Task 3)", () => {
  it("agent pill title names failing health probes", () => {
    assert.ok(js.includes("health_probe_failures"), "app.js never reads health.health_probe_failures");
    const runs = js.slice(js.indexOf("function renderRuns"), js.indexOf("/* ---- detail drawer ---- */"));
    assert.ok(runs.includes("failing probes: "), "pill title lost the failing-probes disclosure");
  });

  it("error banner names failing health probes without a new fetch", () => {
    const banner = js.slice(js.indexOf("function renderApiErrors"), js.indexOf("/* ---- boot ---- */"));
    assert.ok(banner.includes("probeFailures()"), "banner must reuse the probeFailures helper");
    assert.ok(banner.includes("Health probes failing: "), "banner lost the failing-probes copy");
    assert.ok(!banner.includes("api(\"/api/"), "banner must not issue a new fetch for probe names");
  });

  it("pill stays non-red on partial probe failures", () => {
    const runs = js.slice(js.indexOf("function renderRuns"), js.indexOf("/* ---- detail drawer ---- */"));
    assert.ok(runs.includes('pill.classList.toggle("bad", last.status === "error")'), "pill bad-toggle must key off run status only");
    assert.equal(runs.split('"bad"').length - 1, 2, "renderRuns must add no new red path for probe failures");
  });
});

describe("neutral first paint (audit 2026-09-20-round2 Task 4)", () => {
  it("served shell shows … placeholders, never hardcoded digits, in count spans", () => {
    assert.ok(html.includes('<span id="review-count">…</span>'), "review-count lost its … placeholder");
    const hardcoded = [...html.matchAll(/<span[^>]*id="[^"]*"[^>]*>\d+/g)].map((m) => m[0]);
    assert.deepEqual(hardcoded, [], `served shell fabricates a count before JS loads: ${hardcoded.join("; ")}`);
  });

  it("JS fills the review count from data and keeps the placeholder on fetch failure", () => {
    const rr = js.slice(js.indexOf("async function refreshReview"), js.indexOf("const fmtAgeH"));
    assert.ok(rr.includes('$("#review-count")'), "app.js lost the review-count fill");
    assert.ok(rr.includes("el.textContent = state.reviewList.length"), "review count must fill from the derived review list");
    assert.ok(rr.includes("apiFailures"), "review fill must keep the … placeholder when the opps fetch failed");
  });

  it("review-chip tooltip contract stays intact", () => {
    assert.ok(js.includes("updateReviewChipTitle"), "app.js lost updateReviewChipTitle");
    assert.ok(js.includes("need review"), "chip title lost the 'need review' copy");
  });
});

describe("decisions fallback on probe failure (audit 2026-09-20-round3 Task 2)", () => {
  // The helper is extracted from the shipped source (not copied) so these
  // cases fail if app.js miscounts the window or drops the fallback wiring.
  const fbStart = js.indexOf("const fallbackDecisions");
  assert.ok(fbStart !== -1, "app.js lost the fallbackDecisions helper");
  const fallbackDecisions = new Function(
    `${js.slice(fbStart, js.indexOf("\n};", fbStart) + 3)} return fallbackDecisions;`)();

  it("counts won/lost closed in 7d from the loaded list, ignoring open and stale rows", () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const exps = [
      { status: "won", ended_at: daysAgo(2) },
      { status: "lost", ended_at: daysAgo(6) },
      { status: "won", ended_at: daysAgo(10) },
      { status: "planned", ended_at: "" },
      { status: "running", ended_at: daysAgo(1) },
      { status: "paused", ended_at: daysAgo(1) },
      { status: "lost", ended_at: "" },
      { status: "won", ended_at: "not-a-date" },
    ];
    assert.equal(fallbackDecisions(exps), 2);
  });

  it("is null-safe and counts the 7d boundary like the API window", () => {
    assert.equal(fallbackDecisions(null), 0);
    assert.equal(fallbackDecisions([]), 0);
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    assert.equal(fallbackDecisions([{ status: "won", ended_at: daysAgo(6.99) }]), 1);
    assert.equal(fallbackDecisions([{ status: "lost", ended_at: daysAgo(7.01) }]), 0);
  });

  it("health wins whenever present; the fallback feeds the week line and the nudge", () => {
    assert.ok(js.includes("decisions_last_7d"), "fallback must not drop the health read");
    assert.ok(js.includes("healthDecisions !== null ? healthDecisions : fallbackDecisions(exps)"), "health decisions must win; fallback only on null probes");
    const line = js.indexOf("const decisions = healthDecisions");
    const nudge = js.indexOf("const nudge = (decisions === 0)");
    assert.ok(line !== -1 && nudge !== -1 && line < nudge, "the nudge must gate on the post-fallback decisions count");
    assert.ok(js.includes("decisions this week"), "the week line must survive the fallback path");
    assert.ok(js.includes("exp-nudge-start"), "the fallback nudge must keep its Start button");
    assert.ok(js.includes("Nudge:"), "the fallback nudge must keep its copy");
  });
});

describe("schema-migration disclosure (audit 2026-09-20-round2 Task 2)", () => {
  it("pairs a failing probe with its missing column (pure helper, live-shaped payload)", () => {
    const start = js.indexOf("const probeLabel");
    assert.ok(start !== -1, "app.js lost the probeLabel helper");
    const probeLabel = new Function(
      `${js.slice(start, js.indexOf(";", start) + 1)} return probeLabel;`)();
    const detail = { revenue_week: "revenue_cents", revenue_lifetime: "revenue_cents" };
    assert.equal(probeLabel("revenue_week", detail), "revenue_week (revenue_cents)");
    assert.equal(probeLabel("decisions_week", detail), "decisions_week");
    assert.equal(probeLabel("revenue_week", null), "revenue_week");
    assert.equal(probeLabel("revenue_week", {}), "revenue_week");
  });

  it("error banner names the column and prints the migration one-liner without a new fetch", () => {
    const banner = js.slice(js.indexOf("function renderApiErrors"), js.indexOf("/* ---- boot ---- */"));
    assert.ok(banner.includes("probeLabel("), "banner must pair probes with their columns");
    assert.ok(banner.includes("schemaMissingColumns()"), "banner must reuse the schemaMissingColumns helper");
    assert.ok(js.includes("state.health.schema_missing_columns"), "app.js never reads health.schema_missing_columns");
    assert.ok(banner.includes("Missing columns: "), "banner lost the missing-columns copy");
    assert.ok(banner.includes("schemaMigrationLine()"), "banner must reuse the schemaMigrationLine helper");
    assert.ok(js.includes("state.health.schema_migration"), "app.js never reads health.schema_migration");
    assert.ok(banner.includes("Schema migration: "), "banner lost the migration-line copy");
    assert.ok(!banner.includes("api(\"/api/"), "banner must not issue a new fetch for schema names");
  });

  it("agent pill tooltip mirrors the column names and stays non-red", () => {
    const runs = js.slice(js.indexOf("function renderRuns"), js.indexOf("/* ---- detail drawer ---- */"));
    assert.ok(runs.includes("probeLabel("), "pill tooltip must pair probes with their columns");
    assert.ok(runs.includes("failing probes: "), "pill title lost the failing-probes disclosure");
    assert.equal(runs.split('"bad"').length - 1, 2, "renderRuns must add no new red path for probe failures");
  });
});

describe("last-good first paint (audit 2026-09-20-round3 Task 2)", () => {
  it("persists the painted surfaces to localStorage on each successful refresh", () => {
    assert.ok(js.includes('const LAST_GOOD_KEY = "aimoney_last_good"'), "app.js lost the last-good cache key");
    assert.ok(js.includes("function saveLastGood"), "app.js lost saveLastGood");
    assert.ok(js.includes("localStorage.setItem(LAST_GOOD_KEY"), "saveLastGood never writes the cache");
    const rt = js.slice(js.indexOf("async function refreshTargets"));
    assert.ok(rt.includes("saveLastGood({"), "refreshTargets never persists the last-good snapshot");
    assert.ok(rt.includes("opps: fetchOpps"), "save must know which parts this round refetched");
    assert.ok(js.includes("topOpportunity(state.opportunities)"), "snapshot must carry the #1 pick");
    assert.ok(js.includes("state.reviewList.length"), "snapshot must carry the review count");
  });

  it("paints pill/strip/review chip from cache synchronously before the live refresh", () => {
    assert.ok(js.includes("function paintLastGood"), "app.js lost paintLastGood");
    assert.ok(js.includes("localStorage.getItem(LAST_GOOD_KEY"), "paintLastGood never reads the cache");
    const paintAt = js.indexOf("paintLastGood();");
    const refreshAt = js.indexOf("refresh().catch");
    assert.ok(paintAt !== -1 && refreshAt !== -1 && paintAt < refreshAt, "cache paint must run before the live refresh");
    const paint = js.slice(js.indexOf("function paintLastGood"), js.indexOf("/* ---- boot ---- */"));
    assert.ok(paint.includes('$("#agent-text")'), "cache paint must fill the agent pill");
    assert.ok(paint.includes('$("#start-here")'), "cache paint must fill the Start-here strip");
    assert.ok(paint.includes('$("#review-count")'), "cache paint must fill the review chip");
    assert.ok(paint.includes("Start here today"), "cached strip must keep the strip copy");
    assert.ok(paint.includes("openDrawer(cachedTop.id)"), "cached strip must deep-link via openDrawer");
    assert.ok(!paint.includes('api("/api/'), "cache paint must not issue a fetch");
  });

  it("stale-marks cache older than one 6h cron tick; unknown age reads stale", () => {
    assert.ok(js.includes("const LAST_GOOD_MAX_AGE_MS = 6 * 3600000"), "cache lost the one-cron-tick bound");
    assert.ok(js.includes("LAST_GOOD_STALE_MARK"), "cache lost the stale mark");
    const constAt = js.indexOf("const LAST_GOOD_MAX_AGE_MS");
    const fnAt = js.indexOf("const isSnapshotStale");
    assert.ok(constAt !== -1 && fnAt !== -1, "app.js lost the staleness helper");
    const isSnapshotStale = new Function(
      `${js.slice(constAt, js.indexOf(";", constAt) + 1)} ${js.slice(fnAt, js.indexOf(";", fnAt) + 1)} return isSnapshotStale;`)();
    const now = Date.now();
    assert.equal(isSnapshotStale(now - 1000, now), false, "fresh cache must paint unmarked");
    assert.equal(isSnapshotStale(now - 6 * 3600000 - 1, now), true, "cache past one tick must stale-mark");
    assert.equal(isSnapshotStale(undefined, now), true, "undated cache must read stale");
    assert.equal(isSnapshotStale(null, now), true, "null age must read stale");
    const paint = js.slice(js.indexOf("function paintLastGood"), js.indexOf("/* ---- boot ---- */"));
    assert.ok(paint.split("LAST_GOOD_STALE_MARK").length - 1 >= 4, "stale mark must reach pill, chip, and strip");
  });

  it("live data always wins; failures keep the cache instead of wiping", () => {
    const strip = js.slice(js.indexOf("function renderStartHere"), js.indexOf("/* ---- priority list ---- */"));
    assert.ok(strip.includes('includes("/api/opportunities")'), "failed refresh must keep the cached strip");
    assert.ok(strip.includes("el.innerHTML ="), "live strip must still repaint on success");
    const rr = js.slice(js.indexOf("async function refreshReview"), js.indexOf("const fmtAgeH"));
    assert.ok(rr.includes("el.textContent = state.reviewList.length"), "review count must still fill from live data");
  });
});

describe("shipped-JS parse gate (audit 2026-09-20-round2 Task 1)", () => {
  const REPO = join(ROOT, "..");
  const checkParses = (abs) =>
    spawnSync(process.execPath, ["--check", abs], { encoding: "utf8" });

  it("every shipped JS file parses (node --check), not just contains markers", () => {
    const shipped = [
      "public/app.js",
      "functions/api/[[path]].js",
      "worker/src/index.js",
      "worker/src/lib.js",
    ];
    for (const rel of shipped) {
      const abs = join(REPO, rel);
      assert.ok(existsSync(abs), `shipped file missing: ${rel}`);
      const r = checkParses(abs);
      assert.equal(r.status, 0, `${rel} does not parse as JS: ${(r.stderr || "").split("\n").slice(0, 3).join(" ")}`);
    }
  });

  it("positive control: the same check fails a broken-syntax fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "aimoney-parse-gate-"));
    try {
      // Same failure class as the dropped-`}` that killed the dashboard bundle.
      const broken = join(dir, "broken.js");
      writeFileSync(broken, "const parts = [\"a\"];\nconst el = {};\nel.innerHTML = `${parts.join(\" \") <button>Retry</button>`;\n");
      const r = checkParses(broken);
      assert.notEqual(r.status, 0, "parse gate passed a broken-syntax fixture — it checks nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
