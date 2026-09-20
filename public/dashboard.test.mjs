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
    assert.ok(js.includes('String(top.notes || "").includes("UNREVIEWED")'), "strip lost its UNREVIEWED gate");
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
    assert.ok(js.includes("await refresh()"), "vet must refresh after the decision");
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
  it("Vet/Kill/Start/Lose/Win open the admin modal when the token is missing", () => {
    assert.ok(js.includes("function openAdminModal"), "app.js lost openAdminModal");
    assert.ok(js.includes('openAdminModal("Enter the admin token first.")'), "gated taps must open the admin modal with the toast text as subnote");
    assert.equal(js.split('openAdminModal("Enter the admin token first.")').length - 1, 5, "Vet/Kill/Start/Lose/Win must all open the modal");
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
