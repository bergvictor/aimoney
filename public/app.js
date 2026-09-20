/* AIMoney Lab dashboard. Reads are public; writes need the admin token
   (Pages env ADMIN_TOKEN), kept in localStorage after one entry. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  opportunities: [], experiments: [], runs: [], meta: {},
  statusFilter: "", detail: null, reviewOnly: false, reviewList: [], zeroOnly: false, topBriefText: {},
  health: {},
  apiFailures: [],
  token: localStorage.getItem("aimoney_admin") || "",
};

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const r = await fetch(path, { ...opts, headers });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function toast(msg, action = null) {
  const t = $("#toast");
  t.textContent = msg;
  if (action && action.label && typeof action.onClick === "function") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn small ghost toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { t.classList.add("hidden"); action.onClick(); });
    t.appendChild(document.createTextNode(" "));
    t.appendChild(btn);
  }
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 3200);
}

const money = (lo, hi) => {
  if (!lo && !hi) return "—";
  const f = (n) => n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `$${n}`;
  return lo && hi && lo !== hi ? `${f(lo)}–${f(hi)}` : f(hi || lo);
};

// Precise dollars from integer cents: always fixed-2dp ($10.50, never $10.5).
// Separate from money(), which formats $/mo ranges with k-suffixes.
const moneyCents = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;

const meter = (v) => {
  v = Math.max(1, Math.min(10, Number(v) || 1));
  return `<span class="meter"><b>${v}</b> <span>${"●".repeat(v)}${"○".repeat(10 - v)}</span></span>`;
};

const statusPill = (s) => `<span class="pill st-${esc(s)}">${esc(s)}</span>`;

/* ---- tabs (deep-linkable via ?tab=priority|experiments|research) ---- */
const TAB_NAMES = ["priority", "experiments", "research"];
function activateTab(name, push) {
  if (!TAB_NAMES.includes(name)) return;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const n of TAB_NAMES) $(`#tab-${n}`).classList.toggle("hidden", n !== name);
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set("tab", name);
    history.replaceState(null, "", url);
  }
}
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab, true));
});
activateTab(new URLSearchParams(location.search).get("tab") || "priority", false);

/* ---- zero-spend starter: hero strip + $0 filter (read-only) ---- */
// A row is zero-spend when capital_needed reads as $0: "$0…" in any spacing,
// or a bare "0", "free", or "none" (case-insensitive; the model writes verbatim).
const isZeroSpend = (o) =>
  /^\s*(\$0|0\b|free\b|none\b)/i.test(String((o && o.capital_needed) || ""));

const topOpportunity = (opps) =>
  (opps || []).filter((o) => o.status !== "killed" && o.status !== "paused").sort((a, b) => (b.score || 0) - (a.score || 0))[0] || null;

const firstStepsFirstLine = (brief) =>
  String((brief && brief.first_steps) || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";

// "Start here today" strip: the #1-by-score opportunity with its $/mo range,
// capital to start, and the brief's first next action. The brief line loads
// via one detail fetch per top pick (cached in state.topBriefText); the
// button deep-links into the drawer via openDrawer. When the top pick still
// carries UNREVIEWED, the strip also shows Vet/Kill reusing vetOpportunity /
// killOpportunity (same toasts + refresh); vetted picks keep the drawer link only.
function renderStartHere() {
  const el = $("#start-here");
  if (!el) return;
  const top = topOpportunity(state.opportunities);
  if (!top) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const cached = state.topBriefText[top.id];
  const nextAction = cached !== undefined
    ? (cached || "No brief yet — open the drawer for facts.")
    : "Loading next action…";
  const needsReview = String(top.notes || "").includes("UNREVIEWED");
  el.classList.remove("hidden");
  el.innerHTML =
    `<div style="background:var(--green-wash);border:1px solid var(--green);border-radius:8px;padding:10px 12px;margin-bottom:12px">` +
    `<p style="margin:0 0 4px"><b>Start here today:</b> ${esc(top.title)}</p>` +
    `<p class="muted" style="margin:0 0 8px;font-size:13px"><span class="mono">${money(top.est_monthly_low, top.est_monthly_high)}/mo</span>` +
    ` · <span>Capital: ${esc(top.capital_needed || "—")}</span>` +
    ` · <span>Next: ${esc(nextAction)}</span></p>` +
    `<p style="margin:0"><button id="start-here-open" class="btn small" type="button">Open in drawer</button>` +
    (needsReview ? ` <button id="start-here-vet" class="btn small" type="button">Vet</button> <button id="start-here-kill" class="btn small ghost danger" type="button">Kill</button>` : "") +
    `</p>` +
    `</div>`;
  $("#start-here-open").addEventListener("click", () => openDrawer(top.id));
  if (needsReview) {
    $("#start-here-vet").addEventListener("click", () => vetOpportunity(top.id));
    $("#start-here-kill").addEventListener("click", (ev) => killOpportunity(top.id, ev.currentTarget));
  }
  if (cached === undefined) {
    api(`/api/opportunities/${top.id}`).then((d) => {
      state.topBriefText[top.id] = firstStepsFirstLine(d.briefs && d.briefs[0]);
      if (topOpportunity(state.opportunities) && topOpportunity(state.opportunities).id === top.id) renderStartHere();
    }).catch(() => {
      state.topBriefText[top.id] = "";
      if (topOpportunity(state.opportunities) && topOpportunity(state.opportunities).id === top.id) renderStartHere();
    });
  }
}

/* ---- priority list ---- */
function renderLedger() {
  renderStartHere();
  if (state.reviewOnly) return renderReview();
  const rows = state.opportunities.filter((o) =>
    (!state.statusFilter || o.status === state.statusFilter) && (!state.zeroOnly || isZeroSpend(o)));
  const max = Math.max(1, ...state.opportunities.map((o) => o.score || 0));
  $("#ledger-body").innerHTML = rows.length ? rows.map((o, i) => `
    <tr class="row" data-id="${o.id}">
      <td class="num rank">${i + 1}</td>
      <td><div class="opp-title">${esc(o.title)} <span class="cat muted">· ${esc(o.category)}</span></div>
        <div class="opp-sub">${esc(o.one_liner || "")}</div>${testingBadge(o)}</td>
      <td>${statusPill(o.status)}</td>
      <td class="score-cell"><span class="score-num">${esc(o.score)}</span>${noBriefBadge(o)}
        <div class="score-bar"><i style="width:${Math.round(100 * (o.score || 0) / max)}%"></i></div></td>
      <td>${meter(o.value)}</td><td>${meter(o.effort)}</td>
      <td>${meter(o.confidence)}</td><td>${meter(o.fit)}</td>
      <td class="num money">${money(o.est_monthly_low, o.est_monthly_high)}</td>
      <td class="muted">${esc(o.time_to_first_dollar || "—")}</td>
    </tr>`).join("")
    : (state.apiFailures.includes("/api/opportunities")
      ? `<tr><td colspan="10" class="muted">Could not load the priority list — see the banner above and retry.</td></tr>`
      : `<tr><td colspan="10" class="muted">Nothing here. The next agent run may add some — or add one yourself.</td></tr>`);
  document.querySelectorAll("#ledger-body tr.row").forEach((tr) => {
    tr.addEventListener("click", () => openDrawer(Number(tr.dataset.id)));
  });
}

// Review decision line: capital + next action + source under each review row,
// so the vet-vs-kill call needs no drawer round-trip. Next hides when the row
// has no brief (brief_first_steps is null-safe from the list API); the source
// falls back to plain text when no URL is stored.
const reviewDecisionLine = (o) => {
  const next = firstStepsFirstLine({ first_steps: o.brief_first_steps });
  const source = o.source_url
    ? `<a href="${esc(o.source_url)}" target="_blank" rel="noreferrer">source</a>`
    : esc(o.source || "");
  const parts = [`Capital: ${esc(o.capital_needed || "—")}`];
  if (next) parts.push(`Next: ${esc(next)}`);
  if (source) parts.push(source);
  return `<div class="review-decision muted">${parts.join(" · ")}</div>`;
};

function renderReview() {
  const rows = state.reviewList.filter((o) => !state.zeroOnly || isZeroSpend(o));
  const max = Math.max(1, ...rows.map((o) => o.score || 0));
  $("#ledger-body").innerHTML = rows.length ? rows.map((o, i) => `
    <tr class="row" data-id="${o.id}">
      <td class="num rank">${i + 1}</td>
      <td><div class="opp-title">${esc(o.title)} <span class="cat muted">· ${esc(o.category)}</span></div>
        <div class="opp-sub">${esc(o.one_liner || "")}</div>
        ${reviewDecisionLine(o)}
        <div class="review-actions">
          <button class="btn small" data-vet="${o.id}" type="button">Vet</button>
          <button class="btn small ghost danger" data-kill="${o.id}" type="button">Kill</button>
        </div></td>
      <td>${statusPill(o.status)}</td>
      <td class="score-cell"><span class="score-num">${esc(o.score)}</span>${noBriefBadge(o)}
        <div class="score-bar"><i style="width:${Math.round(100 * (o.score || 0) / max)}%"></i></div></td>
      <td>${meter(o.value)}</td><td>${meter(o.effort)}</td>
      <td>${meter(o.confidence)}</td><td>${meter(o.fit)}</td>
      <td class="num money">${money(o.est_monthly_low, o.est_monthly_high)}</td>
      <td class="muted">${esc(o.time_to_first_dollar || "—")}</td>
    </tr>`).join("")
    : `<tr><td colspan="10" class="muted">Review queue empty — every agent proposal has been vetted or killed.</td></tr>`;
  document.querySelectorAll("#ledger-body tr.row").forEach((tr) => {
    tr.addEventListener("click", () => openDrawer(Number(tr.dataset.id)));
  });
  document.querySelectorAll("[data-vet]").forEach((b) => {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); vetOpportunity(Number(b.dataset.vet)); });
  });
  document.querySelectorAll("[data-kill]").forEach((b) => {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); killOpportunity(Number(b.dataset.kill), b); });
  });
}

async function refreshReview() {
  try {
    const r = await api("/api/opportunities?unreviewed=1&sort=oldest&limit=200");
    state.reviewList = r.opportunities || [];
  } catch { state.reviewList = []; }
  const el = $("#review-count");
  if (el) el.textContent = state.reviewList.length;
  const ageEl = $("#review-age");
  if (ageEl) ageEl.textContent = oldestReviewAge();
  updateReviewChipTitle();
}

const fmtAgeH = (h) =>
  h < 1 ? " · oldest <1h" : h < 24 ? ` · oldest ${Math.floor(h)}h` : ` · oldest ${Math.floor(h / 24)}d`;

// Oldest unreviewed age for the review chip: prefer /api/health, fall back
// to the oldest row of the already-fetched oldest-first review list.
function oldestReviewAge() {
  if (!state.reviewList.length) return "";
  const h = state.health && state.health.oldest_unreviewed_age_h;
  if (typeof h === "number" && Number.isFinite(h)) return fmtAgeH(h);
  const ms = Date.parse(state.reviewList[0].created_at || "");
  if (!Number.isFinite(ms)) return "";
  return fmtAgeH((Date.now() - ms) / 3600000);
}

// Review chip tooltip: append the without-briefs count from the
// already-fetched health payload so the evidence gap is visible pre-click.
function updateReviewChipTitle() {
  const chip = document.querySelector('.filters .chip[data-review="1"]');
  if (!chip) return;
  const n = state.health && state.health.bare_without_brief;
  chip.title = (typeof n === "number" && Number.isFinite(n))
    ? `${state.reviewList.length} need review · ${n} without briefs`
    : `${state.reviewList.length} need review`;
}

// Inline one-line post-mortem row: replaces blocking prompt() with an in-page
// input + Confirm/Cancel so a phone keeps context. Empty confirms cancel with
// the row untouched; the API closure gate (result + post_mortem required)
// stays unchanged. Returns false when a row is already open.
function inlinePostMortem(container, { label, placeholder, confirmText, onSubmit, cancelToast }) {
  if (!container) return false;
  if (container.querySelector("[data-pm-input]")) return false;
  const row = document.createElement("div");
  row.className = "pm-inline";
  const input = document.createElement("input");
  input.type = "text";
  input.dataset.pmInput = "1";
  input.placeholder = placeholder || label || "One-line post-mortem";
  input.setAttribute("aria-label", label || "One-line post-mortem");
  input.maxLength = 200;
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "btn small";
  ok.textContent = confirmText || "Confirm";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn small ghost";
  cancel.textContent = "Cancel";
  const cleanup = () => row.remove();
  cancel.addEventListener("click", (ev) => { ev.stopPropagation(); cleanup(); toast(cancelToast); });
  const submit = () => {
    const pm = input.value;
    if (!pm || !pm.trim()) { cleanup(); toast(cancelToast); return; }
    cleanup();
    onSubmit(pm);
  };
  ok.addEventListener("click", (ev) => { ev.stopPropagation(); submit(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); toast(cancelToast); }
  });
  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);
  container.appendChild(row);
  input.focus();
  return true;
}
function cleanUnreviewed(notes) {
  return String(notes || "").replace(/UNREVIEWED,?\s*/g, "").replace(/UNREVIEWED/g, "").trim();
}

async function vetOpportunity(id) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  // (modal gate above supersedes the toast gate on the next line)
  if (!state.token) return toast("Enter the admin token first.");
  const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
  if (!o) return;
  const day = new Date().toISOString().slice(0, 10);
  const notes = `${cleanUnreviewed(o.notes)}\n[${day} vetted] Human vetted; cap lifted.`.trim().slice(-8000);
  try {
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    toast("Vetted — log the experiment or move to testing", { label: "Log experiment", onClick: () => openExperimentModal(null, id) });
    await refresh();
    await refreshReview();
    if (state.reviewOnly) renderLedger();
  } catch (e) { toast(`Vet failed: ${e.message}`); }
}

async function killOpportunity(id, anchorEl) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  // (modal gate above supersedes the toast gate on the next line)
  if (!state.token) return toast("Enter the admin token first.");
  const killContainer = (anchorEl ? (anchorEl.closest(".review-actions") || anchorEl.closest(".card") || anchorEl.parentElement) : null) || document.querySelector("#ledger-body") || document.body;
  const doKill = async (pm) => {
  // (cancel handled by inline row: empty still cancels, row untouched)
  const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
  if (!o) return;
  const day = new Date().toISOString().slice(0, 10);
  const notes = `${cleanUnreviewed(o.notes)}\n[${day} killed] ${pm.trim()}`.trim().slice(-8000);
  try {
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "killed", notes }),
    });
    toast("Killed with post-mortem");
    await refresh();
    await refreshReview();
    if (state.reviewOnly) renderLedger();
    if (state.detail) openDrawer(state.detail.opportunity.id);
  } catch (e) { toast(`Kill failed: ${e.message}`); }
  };
  inlinePostMortem(killContainer, { label: "One-line post-mortem (required to kill):", placeholder: "One-line post-mortem (required to kill):", confirmText: "Kill", onSubmit: (pm) => doKill(pm), cancelToast: "Kill cancelled — post-mortem required." });
}

document.querySelectorAll(".filters .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    if (chip.dataset.zero) {
      state.zeroOnly = !state.zeroOnly;
      chip.classList.toggle("active", state.zeroOnly);
      renderLedger();
      return;
    }
    document.querySelectorAll(".filters .chip").forEach((c) => { if (!c.dataset.zero) c.classList.remove("active"); });
    chip.classList.add("active");
    const zeroChip = document.querySelector('.filters .chip[data-zero="1"]');
    if (zeroChip) zeroChip.classList.toggle("active", !!state.zeroOnly);
    if (chip.dataset.review) {
      state.reviewOnly = true;
      state.statusFilter = "";
      refreshReview().then(renderLedger);
      return;
    }
    state.reviewOnly = false;
    state.statusFilter = chip.dataset.status;
    renderLedger();
  });
});

/* ---- experiments board ---- */
const EXP_COLS = [["running", "Running"], ["planned", "Planned"], ["won", "Won"], ["lost", "Lost"], ["paused", "Paused"]];

// Stale-first age chip for open experiments (days_in_status from the API).
const ageChip = (e) =>
  (e.status === "planned" || e.status === "running") && Number.isFinite(e.days_in_status)
    ? ` <span class="age-chip" title="Days in ${esc(e.status)}">${e.days_in_status}d</span>` : "";

// Stalest open (planned/running) non-orphaned experiment by days_in_status,
// or null when every open card is fresh, closed, or orphaned.
const stalestOpenExp = (exps) => {
  const open = (exps || []).filter((e) =>
    (e.status === "planned" || e.status === "running") && !e.orphaned &&
    Number.isFinite(e.days_in_status));
  open.sort((a, b) => b.days_in_status - a.days_in_status);
  return open[0] || null;
};

// One-click Start for planned experiments: a single PATCH to running (the API
// stamps started_at; won/lost still require result + post-mortem). Token-gated
// like vetOpportunity; orphaned cards never render the button.
// First candidate to start: 'Spec-ad sprint: 10 brands, 10 free ads'
// (d1/seed.sql) — a human still presses it.
async function startExperiment(id) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  // (modal gate above supersedes the toast gate on the next line)
  if (!state.token) return toast("Enter the admin token first.");
  try {
    await api(`/api/experiments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    toast("Experiment started");
    await refresh();
  } catch (e) { toast(`Start failed: ${e.message}`); }
}

// One-click Lose for planned/running experiments: one inline input for the
// post-mortem line, then a single PATCH to lost sending that line as both
// result and post_mortem so the API closure gate holds unchanged. Token-gated
// like startExperiment; orphaned cards never render the button; an empty
// inline line cancels with the row untouched. Human-pressed, one decision.
async function loseExperiment(id, anchorEl) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  // (modal gate above supersedes the toast gate on the next line)
  if (!state.token) return toast("Enter the admin token first.");
  const loseContainer = (anchorEl ? (anchorEl.closest(".card") || anchorEl.closest(".review-actions") || anchorEl.parentElement) : null) || document.querySelector("#board") || document.body;
  const doLose = async (pm) => {
  // (cancel handled by inline row: empty still cancels, row untouched)
  try {
    await api(`/api/experiments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "lost", result: pm.trim(), post_mortem: pm.trim() }),
    });
    toast("Experiment closed as lost");
    await refresh();
  } catch (e) { toast(`Close failed: ${e.message}`); }
  };
  inlinePostMortem(loseContainer, { label: "One-line post-mortem (required to close as lost):", placeholder: "One-line post-mortem (required to close as lost):", confirmText: "Lose", onSubmit: (pm) => doLose(pm), cancelToast: "Close cancelled — post-mortem required." });
}

function renderExperiments() {
  const exps = state.experiments;
  $("#exp-count").textContent = exps.length || "";
  const running = exps.filter((e) => e.status === "running").length;
  const won = exps.filter((e) => e.status === "won").length;
  const decisions = state.health && typeof state.health.decisions_last_7d === "number" ? state.health.decisions_last_7d : null;
  const vetted = state.health && typeof state.health.vetted_last_7d === "number" ? state.health.vetted_last_7d : null;
  const vettedNoExp = state.health && typeof state.health.vetted_no_experiment === "number" ? state.health.vetted_no_experiment : null;
  const revenue = state.health && typeof state.health.revenue_last_7d === "number" ? state.health.revenue_last_7d : null;
  let summary = exps.length
    ? `${exps.length} experiments · ${running} running · ${won} won`
    : (state.apiFailures.includes("/api/experiments")
      ? "Could not load experiments — see the banner above and retry."
      : "No experiments yet.");
  if (decisions !== null && vetted !== null) {
    let conv = `${decisions} decisions this week · ${vetted} vetted this week → ${exps.length} total experiments`;
    if (revenue !== null) conv += ` · ${moneyCents(revenue)} revenue this week`;
    if (vettedNoExp !== null && vettedNoExp > 0) conv += ` · ${vettedNoExp} vetted, no experiment`;
    summary = `${summary} · ${conv}`;
  }
  // Stall nudge (read-only): when the week has zero decisions, name the
  // stalest open card with its age so the next move is one click away.
  // No auto-transitions — the human still owns every status move.
  const nudge = (decisions === 0) ? stalestOpenExp(exps) : null;
  const summaryEl = $("#exp-summary");
  if (nudge) {
    summaryEl.innerHTML = `${esc(summary)} · <span class="nudge">Nudge: &ldquo;${esc(nudge.name)}&rdquo; has been ${esc(nudge.status)} ${nudge.days_in_status}d <button id="exp-nudge-open" class="btn small ghost" type="button">Open it</button></span>`;
    $("#exp-nudge-open").addEventListener("click", () => openDrawer(nudge.opportunity_id, nudge.id));
  } else {
    summaryEl.textContent = summary;
  }
  $("#board").innerHTML = EXP_COLS.map(([st, label]) => {
    const list = exps.filter((e) => e.status === st)
      .sort((a, b) => (b.days_in_status ?? -1) - (a.days_in_status ?? -1));
    return `<div class="column"><h3>${label} (${list.length})</h3>` +
      (list.map((e) => `
        <div class="card" data-id="${e.id}" data-opp="${e.opportunity_id}"${e.orphaned ? ` data-orphan="1"` : ""}>
          <h4>${esc(e.name)}</h4>
          <p>${e.orphaned ? `<span class="pill st-killed">orphaned</span> ` : ""}${esc(e.opportunity_title || "(opportunity deleted)")}${e.metric ? ` · ${esc(e.metric)}` : ""}${ageChip(e)}${runningMismatchBadge(e)}${e.revenue_cents > 0 ? ` · <span class="mono">${moneyCents(e.revenue_cents)} rev</span>` : ""}${e.spent_cents > 0 ? ` · <span class="mono">${moneyCents(e.spent_cents)} spent</span>` : ""}</p>
          <div class="meta">${statusPill(e.status)}
            <span class="muted mono">${esc(e.result ? `→ ${e.result.slice(0, 40)}` : (e.target || ""))}</span></div>
          ${e.status === "planned" && !e.orphaned ? `<p style="margin:6px 0 0"><button class="btn small" data-start-exp="${e.id}" type="button">Start</button></p>` : ""}
          ${(e.status === "planned" || e.status === "running") && !e.orphaned ? `<p style="margin:6px 0 0"><button class="btn small ghost danger" data-lose-exp="${e.id}" type="button">Lose</button></p>` : ""}
        </div>`).join("") || `<p class="muted">—</p>`) + `</div>`;
  }).join("");
  document.querySelectorAll("#board .card").forEach((c) => {
    c.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-start-exp]")) return;
      if (ev.target.closest("[data-lose-exp]")) return;
      if (c.dataset.orphan === "1") return toast("Orphaned experiment — its opportunity was deleted.");
      openDrawer(Number(c.dataset.opp), Number(c.dataset.id));
    });
  });
}

/* ---- research log ---- */
function renderRuns() {
  const runs = state.runs;
  const last = runs[0];
  const pill = $("#agent-pill");
  const dbDown = state.health && state.health.db && state.health.db !== "up";
  if (dbDown) {
    $("#agent-text").textContent = "agent: db down";
    pill.classList.remove("ok");
    pill.classList.add("bad");
    pill.title = "Database unreachable (health.db != up)";
  } else if (last) {
    const noise = state.health && typeof state.health.noise_24h === "number" ? state.health.noise_24h : null;
    pill.title = noise !== null ? "Latest research run: +" + last.added + "/" + last.updated + " " + String.fromCharCode(183) + " " + noise + " noise" : "Latest research run";
    const when = last.finished_at || last.started_at || "";
    $("#agent-text").textContent =
      `agent: ${last.status} · +${last.added}/${last.updated}/${last.briefs} · ${when.slice(0, 16).replace("T", " ")}`;
    if (noise !== null) $("#agent-text").textContent += " " + String.fromCharCode(183) + " " + noise + " noise";
    pill.classList.toggle("ok", last.status === "ok");
    pill.classList.toggle("bad", last.status === "error");
    const runsTab = document.querySelector("#tab-research");
    let runsSummary = document.querySelector("#runs-summary");
    if (!runsSummary && runsTab) {
      runsSummary = document.createElement("p");
      runsSummary.id = "runs-summary";
      runsSummary.className = "muted";
      const wrap = runsTab.querySelector(".table-wrap");
      if (wrap) runsTab.insertBefore(runsSummary, wrap);
    }
    if (runsSummary) {
      runsSummary.textContent = noise !== null ? "Last run +" + last.added + "/" + last.updated + " " + String.fromCharCode(183) + " " + noise + " noise in 24h" : "";
    }
  }
  $("#runs-body").innerHTML = runs.length ? runs.map((r) => `
    <tr><td class="mono">#${r.id} ${esc(r.agent)}</td><td>${esc(r.trigger)}</td>
      <td class="mono">${esc((r.finished_at || "—").slice(0, 16).replace("T", " "))}</td>
      <td>${r.status === "ok" ? `<span class="pill st-scaling">ok</span>`
        : r.status === "running" ? `<span class="pill st-testing">running</span>`
        : `<span class="pill st-killed">error</span>`}</td>
      <td class="num">${r.signals_seen}</td><td class="num">${r.added}</td>
      <td class="num">${r.updated}</td><td class="num">${r.briefs}</td>
      <td class="num">${r.ai_calls}</td>
      <td class="muted">${esc((r.error || "").slice(0, 80))}</td></tr>`).join("")
    : (state.apiFailures.includes("/api/runs")
      ? `<tr><td colspan="10" class="muted">Could not load the research log — see the banner above and retry.</td></tr>`
      : `<tr><td colspan="10" class="muted">No agent runs yet — the first cron pass lands within 6h of deploy.</td></tr>`);
}

/* ---- detail drawer ---- */
function briefHtml(b) {
  if (!b) return `<p class="muted">No brief yet — the agent writes one for unbriefed opportunities automatically.</p>`;
  let nums = [];
  try { nums = JSON.parse(b.numbers_json || "[]"); } catch { /* keep empty */ }
  let srcs = [];
  try { srcs = JSON.parse(b.sources_json || "[]"); } catch { /* keep empty */ }
  return `
    <p class="prose">${esc(b.summary)}</p>
    <h3>What works</h3><p class="prose">${esc(b.what_works)}</p>
    ${nums.length ? `<h3>Numbers</h3><p class="prose">${nums.map((n) => `• ${esc(n.claim || n)}${n.source ? ` — ${esc(n.source)}` : ""}`).join("\n")}</p>` : ""}
    <h3>Risks</h3><p class="prose">${esc(b.risks)}</p>
    <h3>First steps</h3><p class="prose">${esc(b.first_steps)}</p>
    ${srcs.length ? `<h3>Sources</h3><p class="prose">${srcs.map((s) => typeof s === "string" ? esc(s) : `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title || s.url)}</a>`).join("\n")}</p>` : ""}
    <p class="muted mono">brief v${b.version} · ${esc(b.author)} · ${esc((b.created_at || "").slice(0, 10))}</p>`;
}

async function openDrawer(id, focusExp = null) {
  try {
    const d = await api(`/api/opportunities/${id}`);
    state.detail = d;
    const o = d.opportunity;
    $("#drawer-slug").textContent = o.slug;
    $("#drawer-body").innerHTML = `
      <p>${statusPill(o.status)} <span class="muted">· ${esc(o.category)} · score </span><b class="mono">${esc(o.score)}</b>${String(o.notes || "").includes("UNREVIEWED") ? ' <span class="muted">(capped — unreviewed)</span>' : ""}</p>
      ${String(o.notes || "").includes("UNREVIEWED") ? '<div class="review-actions"><button class="btn small" id="drawer-vet" type="button">Vet</button> <button class="btn small ghost danger" id="drawer-kill" type="button">Kill</button></div>' : ""}
      <h2>${esc(o.title)}</h2>
      <p class="muted">${esc(o.one_liner || "")}</p>
      <h3>Facts</h3>
      <dl class="kv">
        <dt>Revenue range</dt><dd class="mono">${money(o.est_monthly_low, o.est_monthly_high)}/mo</dd>
        <dt>Time to first $</dt><dd>${esc(o.time_to_first_dollar || "—")}</dd>
        <dt>Capital needed</dt><dd>${esc(o.capital_needed || "—")}</dd>
        <dt>Skills</dt><dd>${esc((JSON.parse(o.skills_needed || "[]") || []).join(", ") || "—")}</dd>
        <dt>Value/effort/conf/fit</dt><dd class="mono">${o.value} / ${o.effort} / ${o.confidence} / ${o.fit}</dd>
        <dt>Source</dt><dd>${o.source_url ? `<a href="${esc(o.source_url)}" target="_blank" rel="noreferrer">${esc(o.source)}</a>` : esc(o.source)}</dd>
      </dl>
      ${o.notes ? `<h3>Notes</h3><p class="prose">${esc(o.notes)}</p>` : ""}
      <h3>Research brief</h3>${briefHtml(d.briefs[0])}
      <h3>Experiments (${d.experiments.length})</h3>
      <p class="muted" style="font-size:12.5px">Closing as won/lost requires result + post-mortem; ended_at stamps automatically. Running stamps started_at when empty.</p>
      ${d.experiments.length ? d.experiments.map((e) => `
        <div class="card" data-exp="${e.id}" ${focusExp === e.id ? `style="border-color:var(--green)"` : ""}>
          <h4>${esc(e.name)}</h4>
          <p>${esc(e.hypothesis || "")}</p>
          <div class="meta">${statusPill(e.status)}<span class="muted mono">${esc(e.result || e.target || "")}</span> <span class="muted mono">${moneyCents(e.revenue_cents || 0)} rev / ${moneyCents(e.spent_cents || 0)} spent${e.ended_at ? ` · ended ${esc(String(e.ended_at).slice(0, 10))}` : ""}</span></div>
          ${e.post_mortem ? `<p><b>Post-mortem:</b> ${esc(e.post_mortem)}</p>` : ""}
          <p style="margin-top:6px"><button class="btn small ghost" data-edit-exp="${e.id}" type="button">Update</button></p>
        </div>`).join("") : `<p class="muted">None yet.</p>`}
      <div id="admin-zone"></div>`;
    document.querySelectorAll("[data-edit-exp]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openExperimentModal(d.experiments.find((e) => e.id === Number(btn.dataset.editExp)));
      });
    });
    const drawerVet = $("#drawer-vet");
    if (drawerVet) drawerVet.addEventListener("click", (ev) => { ev.stopPropagation(); vetOpportunity(o.id).then(() => { if (state.detail) openDrawer(o.id); }); });
    const drawerKill = $("#drawer-kill");
    if (drawerKill) drawerKill.addEventListener("click", (ev) => { ev.stopPropagation(); killOpportunity(o.id, ev.currentTarget); });
    renderAdminZone();
    $("#drawer").classList.remove("hidden");
    $("#drawer-scrim").classList.remove("hidden");
  } catch (e) { toast(`Could not open: ${e.message}`); }
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
  $("#drawer-scrim").classList.add("hidden");
  state.detail = null;
}
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);

// Suggested (never auto-applied) confidence/value delta from the most recent
// closed experiment: won nudges +1/+1, lost nudges −1/−1, clamped 1–10.
// Returns null when nothing closed yet or nothing would change.
const suggestRescore = (o, experiments) => {
  const closed = (experiments || []).filter((e) => e.status === "won" || e.status === "lost");
  if (!closed.length) return null;
  closed.sort((a, b) => String(b.ended_at || b.updated_at || "").localeCompare(String(a.ended_at || a.updated_at || "")));
  const last = closed[0];
  const delta = last.status === "won" ? 1 : -1;
  const confidence = Math.min(10, Math.max(1, Number(o.confidence) + delta));
  const value = Math.min(10, Math.max(1, Number(o.value) + delta));
  if (confidence === Number(o.confidence) && value === Number(o.value)) return null;
  return { from: { value: Number(o.value), confidence: Number(o.confidence) }, to: { value, confidence }, status: last.status, name: last.name };
};

function renderAdminZone() {
  const z = $("#admin-zone");
  if (!z || !state.detail) return;
  const o = state.detail.opportunity;
  const suggestion = suggestRescore(o, state.detail.experiments || []);
  const suggestHtml = suggestion ? `
    <div style="margin-top:12px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--wash);font-size:13px">
      <b>Suggested rescore</b> from &ldquo;${esc(suggestion.name)}&rdquo; (${esc(suggestion.status)}):
      value ${suggestion.from.value}→${suggestion.to.value}, confidence ${suggestion.from.confidence}→${suggestion.to.confidence}.
      <button class="btn small" id="az-apply-suggest" type="button">Apply suggestion</button>
    </div>` : "";
  z.innerHTML = state.token ? `
    ${suggestHtml}
    <h3>Re-optimize (admin)</h3>
    <div class="admin-grid">
      <label>Status
        <select id="az-status">${["backlog", "researching", "testing", "scaling", "paused", "killed"]
          .map((s) => `<option ${s === o.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Value 1–10<input id="az-value" type="number" min="1" max="10" value="${o.value}"></label>
      <label>Effort 1–10<input id="az-effort" type="number" min="1" max="10" value="${o.effort}"></label>
      <label>Confidence 1–10<input id="az-conf" type="number" min="1" max="10" value="${o.confidence}"></label>
      <label>Fit 1–10<input id="az-fit" type="number" min="1" max="10" value="${o.fit}"></label>
      <label>$/mo low–high<input id="az-money" value="${o.est_monthly_low || ""},${o.est_monthly_high || ""}" placeholder="500,5000"></label>
    </div>
    <label style="display:block;margin-top:8px;font-size:13px;color:var(--muted)">Append note
      <textarea id="az-note" placeholder="What did you learn?"></textarea></label>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn small" id="az-save" type="button">Save + rescore</button>
      <button class="btn small ghost" id="az-exp" type="button">Log experiment</button>
    </div>`
    : `<p class="muted" style="margin-top:16px">Enter the admin token (top-right) to re-score, change status, or log experiments.</p>`;
  if (!state.token) return;
  $("#az-save").addEventListener("click", async () => {
    try {
      const [lo, hi] = $("#az-money").value.split(",").map((x) => Number(x.trim()) || 0);
      const note = $("#az-note").value.trim();
      const azStatus = $("#az-status").value;
      if (azStatus === "killed" && o.status !== "killed") {
        const azContainer = $("#admin-zone") || $("#drawer-body") || document.body;
        const doAzKill = async (pm) => {
        // (cancel handled by inline row: empty still cancels, row untouched)
        const day = new Date().toISOString().slice(0, 10);
        const killedNotes = `${cleanUnreviewed(o.notes)}\n[${day} killed] ${pm.trim()}${note ? `\n[${day} you] ${note}` : ""}`.trim().slice(-8000);
        try {
          const r = await api(`/api/opportunities/${o.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "killed",
              value: Number($("#az-value").value), effort: Number($("#az-effort").value),
              confidence: Number($("#az-conf").value), fit: Number($("#az-fit").value),
              est_monthly_low: lo, est_monthly_high: hi, notes: killedNotes,
            }),
          });
          toast(`Saved — new score ${r.score}`);
          await refresh();
          openDrawer(o.id);
        } catch (e) { toast(`Save failed: ${e.message}`); }
        };
        inlinePostMortem(azContainer, { label: "One-line post-mortem (required to kill):", placeholder: "One-line post-mortem (required to kill):", confirmText: "Kill", onSubmit: (pm) => doAzKill(pm), cancelToast: "Kill cancelled — post-mortem required." });
        return;
      }
      const r = await api(`/api/opportunities/${o.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: $("#az-status").value,
          value: Number($("#az-value").value), effort: Number($("#az-effort").value),
          confidence: Number($("#az-conf").value), fit: Number($("#az-fit").value),
          est_monthly_low: lo, est_monthly_high: hi,
          ...(note ? { notes: `${o.notes || ""}\n[${new Date().toISOString().slice(0, 10)} you] ${note}`.slice(-8000) } : {}),
        }),
      });
      toast(`Saved — new score ${r.score}`);
      await refresh();
      openDrawer(o.id);
    } catch (e) { toast(`Save failed: ${e.message}`); }
  });
  $("#az-exp").addEventListener("click", () => openExperimentModal(null, o.id));
  const applySuggest = $("#az-apply-suggest");
  if (applySuggest && suggestion) applySuggest.addEventListener("click", async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const r = await api(`/api/opportunities/${o.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          value: suggestion.to.value,
          confidence: suggestion.to.confidence,
          notes: `${o.notes || ""}\n[${day} rescore] Applied outcome suggestion from "${suggestion.name}" (${suggestion.status}): value ${suggestion.from.value}→${suggestion.to.value}, confidence ${suggestion.from.confidence}→${suggestion.to.confidence}.`.slice(-8000),
        }),
      });
      toast(`Suggested rescore applied — new score ${r.score}`);
      await refresh();
      openDrawer(o.id);
    } catch (e) { toast(`Rescore failed: ${e.message}`); }
  });
}

/* ---- modals ---- */
function showModal(html) {
  const f = $("#modal-form");
  f.innerHTML = html;
  $("#modal").showModal();
  return f;
}

// Token modal, reused by gated taps (vet/kill/start/lose): reuses the Admin
// button's showModal block, then pins the dead-end toast text as a subnote so
// a phone tap lands in the token field instead of a toast.
function openAdminModal(subnote = "") {
  const modal = $("#modal");
  if (!modal.open) $("#btn-admin").click();
  if (subnote) {
    const f = $("#modal-form");
    if (f && !f.querySelector("[data-admin-subnote]")) {
      const p = document.createElement("p");
      p.className = "muted";
      p.dataset.adminSubnote = "1";
      p.textContent = subnote;
      const h3 = f.querySelector("h3");
      if (h3 && h3.nextSibling) h3.parentNode.insertBefore(p, h3.nextSibling);
      else f.prepend(p);
    }
  }
  return $("#modal-form");
}
$("#btn-admin").addEventListener("click", () => {
  const f = showModal(`
    <h3>Admin token</h3>
    <p class="muted">Same value as the <span class="mono">ADMIN_TOKEN</span> env var. Stored in this browser only.</p>
    <label>Token<input id="m-token" type="password" value="${esc(state.token)}" autocomplete="off"></label>
    <div class="actions">
      <button class="btn ghost" value="cancel" formnovalidate type="submit">Cancel</button>
      <button class="btn" id="m-save" value="default" type="submit">Save</button>
    </div>`);
  f.addEventListener("submit", (ev) => {
    if (ev.submitter && ev.submitter.id === "m-save") {
      state.token = $("#m-token").value.trim();
      if (state.token) localStorage.setItem("aimoney_admin", state.token);
      else localStorage.removeItem("aimoney_admin");
      toast(state.token ? "Admin unlocked" : "Admin locked");
      if (state.detail) renderAdminZone();
    }
  }, { once: true });
});

$("#btn-add").addEventListener("click", () => {
  if (!state.token) return toast("Enter the admin token first.");
  const f = showModal(`
    <h3>Add opportunity</h3>
    <label>Title<input id="m-title" required maxlength="200"></label>
    <label>One-liner<input id="m-one" maxlength="500"></label>
    <div class="row">
      <label>Category<input id="m-cat" value="services" maxlength="40"></label>
      <label>Status<select id="m-status">
        ${["backlog", "researching", "testing"].map((s) => `<option>${s}</option>`).join("")}</select></label>
      <label>Value 1–10<input id="m-v" type="number" min="1" max="10" value="5"></label>
      <label>Effort 1–10<input id="m-e" type="number" min="1" max="10" value="5"></label>
      <label>Confidence 1–10<input id="m-c" type="number" min="1" max="10" value="3"></label>
      <label>Fit 1–10<input id="m-f" type="number" min="1" max="10" value="5"></label>
      <label>$/mo low–high<input id="m-money" placeholder="500,5000"></label>
      <label>Capital needed<input id="m-capital" maxlength="120" placeholder="$0"></label>
      <label>Time to first $<input id="m-first" maxlength="120" placeholder="1-2 weeks"></label>
    </div>
    <div class="actions">
      <button class="btn ghost" value="cancel" formnovalidate type="submit">Cancel</button>
      <button class="btn" id="m-save" value="default" type="submit">Add</button>
    </div>`);
  f.addEventListener("submit", async (ev) => {
    if (!(ev.submitter && ev.submitter.id === "m-save")) return;
    ev.preventDefault();
    try {
      const title = $("#m-title").value.trim();
      const [lo, hi] = $("#m-money").value.split(",").map((x) => Number(x.trim()) || 0);
      await api("/api/opportunities", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
          title, one_liner: $("#m-one").value.trim(), category: $("#m-cat").value.trim(),
          status: $("#m-status").value, value: Number($("#m-v").value),
          effort: Number($("#m-e").value), confidence: Number($("#m-c").value),
          fit: Number($("#m-f").value), source: "manual",
          est_monthly_low: lo, est_monthly_high: hi,
          capital_needed: $("#m-capital").value.trim(),
          time_to_first_dollar: $("#m-first").value.trim(),
        }),
      });
      $("#modal").close();
      toast("Added to the priority list");
      await refresh();
    } catch (e) { toast(`Add failed: ${e.message}`); }
  });
});

function openExperimentModal(exp, defaultOpp = null) {
  if (!state.token) return toast("Enter the admin token first.");
  const isNew = !exp;
  const opps = state.opportunities;
  const f = showModal(`
    <h3>${isNew ? "Log experiment" : "Update experiment"}</h3>
    <label>Opportunity
      <select id="m-opp">${opps.map((o) =>
        `<option value="${o.id}" ${String(o.id) === String(isNew ? defaultOpp : exp.opportunity_id) ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select></label>
    <label>Name<input id="m-name" required maxlength="200" value="${esc(exp?.name || "")}"></label>
    <label>Hypothesis<textarea id="m-hyp">${esc(exp?.hypothesis || "")}</textarea></label>
    <div class="row">
      <label>Status<select id="m-status">
        ${["planned", "running", "won", "lost", "paused"].map((s) =>
          `<option ${exp?.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
      <label>Budget cap<input id="m-budget" value="${esc(exp?.budget_cap || "")}"></label>
      <label>Metric<input id="m-metric" value="${esc(exp?.metric || "")}"></label>
      <label>Target<input id="m-target" value="${esc(exp?.target || "")}"></label>
      <label>Spent<input id="m-spent" value="${esc(exp?.spent || "")}"></label>
      <label>Revenue ($)<input id="m-revenue" inputmode="decimal" value="${esc(exp?.revenue_cents ? (exp.revenue_cents / 100) : "")}"></label>
      <label>Precise spend ($)<input id="m-spend" inputmode="decimal" value="${esc(exp?.spent_cents ? (exp.spent_cents / 100) : "")}"></label>
      <label>Result<input id="m-result" value="${esc(exp?.result || "")}"></label>
    </div>
    <label>Post-mortem (required when won/lost)<textarea id="m-pm">${esc(exp?.post_mortem || "")}</textarea></label>
    <div class="actions">
      <button class="btn ghost" value="cancel" formnovalidate type="submit">Cancel</button>
      <button class="btn" id="m-save" value="default" type="submit">${isNew ? "Log" : "Save"}</button>
    </div>`);
  f.addEventListener("submit", async (ev) => {
    if (!(ev.submitter && ev.submitter.id === "m-save")) return;
    ev.preventDefault();
    const payload = {
      opportunity_id: Number($("#m-opp").value), name: $("#m-name").value.trim(),
      hypothesis: $("#m-hyp").value.trim(), status: $("#m-status").value,
      budget_cap: $("#m-budget").value.trim(), metric: $("#m-metric").value.trim(),
      target: $("#m-target").value.trim(), spent: $("#m-spent").value.trim(),
      result: $("#m-result").value.trim(), post_mortem: $("#m-pm").value.trim(),
      revenue_cents: Math.max(0, Math.round(Number($("#m-revenue").value.trim()) * 100) || 0),
      spent_cents: Math.max(0, Math.round(Number($("#m-spend").value.trim()) * 100) || 0),
    };
    try {
      if (isNew) await api("/api/experiments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      else await api(`/api/experiments/${exp.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      $("#modal").close();
      toast(isNew ? "Experiment logged" : "Experiment updated");
      await refresh();
      if (state.detail) openDrawer(state.detail.opportunity.id);
    } catch (e) { toast(`Save failed: ${e.message}`); }
  });
}
$("#btn-add-exp").addEventListener("click", () => openExperimentModal(null));

// Delegated one-click Start: board cards re-render on every refresh, so one
// #board listener covers all Start buttons (card clicks ignore the button).
$("#board").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-start-exp]");
  if (!b) return;
  ev.stopPropagation();
  startExperiment(Number(b.dataset.startExp));
});

// Delegated one-click Lose: mirrors the Start listener above (cards re-render
// on every refresh, so delegation covers all Lose buttons the same way).
$("#board").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-lose-exp]");
  if (!b) return;
  ev.stopPropagation();
  loseExperiment(Number(b.dataset.loseExp), b);
});

/* ---- manual research trigger ---- */
$("#btn-run").addEventListener("click", async () => {
  if (!state.token) return toast("Enter the admin token first.");
  const worker = state.meta.worker_url;
  if (!worker) return toast("Worker URL not configured (RESEARCH_WORKER_URL).");
  const btn = $("#btn-run");
  btn.disabled = true;
  btn.textContent = "Triaging…";
  try {
    const r = await fetch(`${worker}/run`, {
      method: "POST", headers: { authorization: `Bearer ${state.token}` },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    toast("Triage started — proposals land in Priority; briefs land on the next cron tick. Watch the Research log.");
    setTimeout(refresh, 45000);
    await refresh();
  } catch (e) { toast(`Research failed: ${e.message}`); }
  btn.disabled = false;
  btn.textContent = "Run triage now (briefs on cron)";
});

/* ---- read-only warnings (no auto-transitions) ---- */
const testingBadge = (o) =>
  o.status === "testing" && !(Number(o.experiment_count) > 0)
    ? ` <span class="warn-badge" title="Status is testing but no experiments are logged">testing · 0 experiments</span>`
    : "";

// A score with no evidence behind it must say so: pill in the score cell
// when the row's returned brief_count is zero. Read-only.
const noBriefBadge = (o) =>
  Number(o.brief_count) === 0
    ? ` <span class="warn-badge" title="No research brief yet — score has no evidence behind it">no brief</span>`
    : "";

const runningMismatchBadge = (e) => {
  if (e.status !== "running" || e.orphaned) return "";
  const parent = state.opportunities.find((o) => String(o.id) === String(e.opportunity_id));
  return parent && parent.status === "researching"
    ? ` <span class="warn-badge" title="Experiment is running but its opportunity is still researching">running exp · opp still researching</span>`
    : "";
};

function renderApiErrors() {
  const el = $("#api-errors");
  if (!el) return;
  const fails = state.apiFailures || [];
  if (!fails.length) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = `API ${fails.length === 1 ? "error" : "errors"}: ${fails.map((f) => esc(f)).join(", ")} failed to load. <button id="api-retry" class="btn small ghost" type="button">Retry</button> <button id="api-dismiss" class="btn small ghost" type="button" aria-label="Dismiss">Dismiss</button>`;
  const retry = $("#api-retry");
  if (retry) retry.addEventListener("click", () => refresh());
  const dismiss = $("#api-dismiss");
  if (dismiss) dismiss.addEventListener("click", () => el.classList.add("hidden"));
}

/* ---- boot ---- */
async function refresh() {
  state.apiFailures = [];
  const [opps, exps, runs, health] = await Promise.all([
    api("/api/opportunities?limit=200").catch(() => { state.apiFailures.push("/api/opportunities"); return { opportunities: [] }; }),
    api("/api/experiments").catch(() => { state.apiFailures.push("/api/experiments"); return { experiments: [] }; }),
    api("/api/runs?limit=20").catch(() => { state.apiFailures.push("/api/runs"); return { runs: [] }; }),
    api("/api/health").catch(() => { state.apiFailures.push("/api/health"); return {}; }),
  ]);
  state.opportunities = opps.opportunities || [];
  state.experiments = exps.experiments || [];
  state.runs = runs.runs || [];
  state.health = health || {};
  state.meta = await api("/api/meta").catch(() => ({}));
  await refreshReview().catch(() => {});
  $("#rev").textContent = health.rev ? `rev ${health.rev}` : "";
  renderApiErrors();
  renderLedger();
  renderExperiments();
  renderRuns();
}
refresh().catch((e) => {
  $("#ledger-body").innerHTML = `<tr><td colspan="10">API unreachable: ${esc(e.message)} — is the D1 binding attached?</td></tr>`;
});
