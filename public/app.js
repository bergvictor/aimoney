/* AIMoney Lab dashboard. Reads are public; writes need the admin token
   (Pages env ADMIN_TOKEN), kept in localStorage after one entry. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  opportunities: [], experiments: [], runs: [], meta: {},
  statusFilter: "", detail: null, reviewOnly: false, reviewList: [], zeroOnly: false,
  health: {},
  apiFailures: [],
  token: localStorage.getItem("aimoney_admin") || "",
};

let metaLoaded = false; // /api/meta is deploy-static: fetch once per boot, reuse state.meta

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const API_READ_TIMEOUT_MS = 15000;
const API_WRITE_TIMEOUT_MS = 25000;
// Pure: reads fail fast, writes wait longer; opts.timeoutMs overrides (tests).
const apiTimeoutMs = (opts = {}) => {
  const override = Number(opts.timeoutMs);
  if (Number.isFinite(override) && override > 0) return override;
  const method = String(opts.method || "GET").toUpperCase();
  return (method === "GET" || method === "HEAD") ? API_READ_TIMEOUT_MS : API_WRITE_TIMEOUT_MS;
};

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const { timeoutMs: _timeoutIgnored, ...fetchOpts } = opts;
  const timeoutMs = apiTimeoutMs(opts);
  const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
  const timeoutErr = () => {
    const e = new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    e.name = "TimeoutError";
    return e;
  };
  const doFetch = async () => {
    const r = await fetch(path, { ...fetchOpts, headers, ...(ctrl ? { signal: ctrl.signal } : {}) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !ctrl) return doFetch();
  let timer = null;
  try {
    const timeoutP = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ctrl.abort(); } catch { /* already settled: race below still rejects */ }
        reject(timeoutErr());
      }, timeoutMs);
    });
    try {
      return await Promise.race([doFetch(), timeoutP]);
    } catch (e) {
      if (e && e.name === "AbortError") throw timeoutErr();
      throw e;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  tab.addEventListener("click", () => {
    activateTab(tab.dataset.tab, true);
    // Runs refetch only where they are shown: actions skip them, so opening
    // the Research tab re-reads the log (+health for its noise line).
    if (tab.dataset.tab === "research") refreshTargets({ opportunities: false, experiments: false }).catch(() => {});
  });
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
// capital to start, and the brief's first next action. The list payload
// already carries the latest brief's first_steps per row (brief_first_steps),
// so the strip reads it directly with no detail fetch. The button deep-links
// into the drawer via openDrawer. When the top pick still carries UNREVIEWED,
// the strip also shows Vet/Kill reusing vetOpportunity / killOpportunity
// (same toasts + refresh); vetted picks keep the drawer link only.
function renderStartHere() {
  const el = $("#start-here");
  if (!el) return;
  const top = topOpportunity(state.opportunities);
  if (!top) {
    // A failed opps fetch must not wipe the last-good cached strip (painted
    // synchronously at boot): keep it until live data wins. Without a cache
    // the strip stays hidden, exactly as today.
    if ((state.apiFailures || []).includes("/api/opportunities")) return;
    el.classList.add("hidden"); el.innerHTML = ""; return;
  }
  const excerpt = firstStepsFirstLine({ first_steps: top.brief_first_steps });
  const nextAction = excerpt || "No brief yet — open the drawer for facts.";
  const needsReview = isNeedsReview(top);
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

// Review brief line: the latest brief summary under the decision line, so the
// vet-vs-kill call needs no drawer round-trip. Bare rows read "No brief yet"
// (unproven, not empty); the excerpt is null-safe from the list API.
const reviewBriefLine = (o) => {
  // Scope the excerpt temp to the render block below.
  {
    const s = String(o.brief_summary || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return `<div class="review-brief muted">${esc(s || "No brief yet")}</div>`;
};
};

function renderReview() {
  const rows = state.reviewList.filter((o) => !state.zeroOnly || isZeroSpend(o));
  const max = Math.max(1, ...rows.map((o) => o.score || 0));
  $("#ledger-body").innerHTML = rows.length ? rows.map((o, i) => `
    <tr class="row" data-id="${o.id}" tabindex="0" data-review-row="${o.id}" title="V vets this row · K opens the post-mortem">
      <td class="num rank">${i + 1}</td>
      <td><div class="opp-title">${esc(o.title)} <span class="cat muted">· ${esc(o.category)}</span></div>
        <div class="opp-sub">${esc(o.one_liner || "")}</div>
        ${reviewDecisionLine(o)}
        ${reviewBriefLine(o)}
        <div class="review-actions">
          <button class="btn small" data-vet="${o.id}" type="button">Vet</button>
          <button class="btn small" data-vet-starter="${o.id}" type="button">Vet &amp; log starter</button>
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
  document.querySelectorAll("[data-vet-starter]").forEach((b) => {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); vetAndLogStarter(Number(b.dataset.vetStarter)); });
  });
  document.querySelectorAll("[data-kill]").forEach((b) => {
    b.addEventListener("click", (ev) => { ev.stopPropagation(); killOpportunity(Number(b.dataset.kill), b); });
  });
}

// Review queue derivation (pure): the main list payload already carries every
// field the chip needs (needs_review, created_at), so the oldest-first queue is
// filtered + sorted client-side with no second fetch. Rows without a parseable
// date sort first, matching the server's oldest ASC on empty strings.
// Review-bit check (F2): list rows carry needs_review (0/1) instead of full
// notes. The bit wins when present; notes are the fallback for detail rows
// and pre-change payloads still in flight.
const isNeedsReview = (o) =>
  o && o.needs_review !== undefined && o.needs_review !== null
    ? Number(o.needs_review) === 1
    : String((o && o.notes) || "").includes("UNREVIEWED");

const deriveReviewList = (opps) =>
  (opps || []).filter(isNeedsReview).sort((a, b) => (Date.parse(a.created_at || "") || 0) - (Date.parse(b.created_at || "") || 0));

async function refreshReview() {
  // Client-side first: identical rows with no round-trip. The unreviewed
  // endpoint stays only as a fallback when the main list hit its limit=200
  // and may hide unreviewed rows past the truncation point.
  let rows = deriveReviewList(state.opportunities);
  try {
    if (state.opportunities.length >= 200) {
      const r = await api("/api/opportunities?unreviewed=1&sort=oldest&limit=200");
      rows = r.opportunities || rows;
    }
  } catch { /* keep the client-side rows */ }
  state.reviewList = rows;
  const el = $("#review-count");
  // On an opps-fetch failure the shell keeps its … placeholder (a 0 here
  // would fabricate an empty queue); the error banner names the failure.
  if (el && !(state.apiFailures || []).includes("/api/opportunities")) el.textContent = state.reviewList.length;
  const ageEl = $("#review-age");
  // Mirror the count guard above: on an opps-fetch failure keep the last-good
  // cached age instead of wiping it to "".
  if (ageEl && !(state.apiFailures || []).includes("/api/opportunities")) ageEl.textContent = oldestReviewAge();
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

// Backlog pill bit (pure, self-contained for tests): "N to review · oldest
// Xd" from a health-shaped object. "" when the backend never reported a
// count (old backends keep today's pill); the age hides at 0 or when the
// backend never reported it. Same age buckets as fmtAgeH.
const reviewBacklogBit = (health) => {
  const n = health && health.unreviewed;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  const h = health && health.oldest_unreviewed_age_h;
  const age = (n > 0 && typeof h === "number" && Number.isFinite(h))
    ? (h < 1 ? " · oldest <1h" : h < 24 ? ` · oldest ${Math.floor(h)}h` : ` · oldest ${Math.floor(h / 24)}d`)
    : "";
  return `${n} to review${age}`;
};

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
// Inline $ + one-line close-as-won row: mirrors inlinePostMortem with an added
// human-entered revenue input, so a win costs the same single click as a loss.
// Empty lines cancel with the row untouched; bad/negative $ clamps to 0
// exactly like the modal; the source truncates to 120 chars like the modal and
// empty renders exactly as today (no via bit). The optional spend mirrors the
// revenue input; empty leaves the row's existing spend untouched (no key sent,
// never clobbered with 0). Returns false when a row is already open.
function inlineWinClose(container, { label, placeholder, confirmText, onSubmit, cancelToast }) {
  if (!container) return false;
  if (container.querySelector("[data-pm-input]")) return false;
  const row = document.createElement("div");
  row.className = "pm-inline";
  const amount = document.createElement("input");
  amount.type = "text";
  amount.dataset.winAmount = "1";
  amount.placeholder = "Revenue $ (human-entered, e.g. 500)";
  amount.setAttribute("aria-label", "Revenue in dollars");
  amount.inputMode = "decimal";
  const spend = document.createElement("input");
  spend.type = "text";
  spend.dataset.winSpend = "1";
  spend.placeholder = "Spend $ (optional)";
  spend.setAttribute("aria-label", "Spend in dollars");
  spend.inputMode = "decimal";
  const source = document.createElement("input");
  source.type = "text";
  source.dataset.winSource = "1";
  source.placeholder = "Revenue source (optional)";
  source.setAttribute("aria-label", "Revenue source");
  source.maxLength = 120;
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
    const revenueCents = Math.max(0, Math.round(Number(amount.value.trim()) * 100) || 0);
    const revenueSource = source.value.trim().slice(0, 120);
    const spendRaw = spend.value.trim();
    const spentCents = spendRaw === "" ? null : Math.max(0, Math.round(Number(spendRaw) * 100) || 0);
    cleanup();
    onSubmit(pm, revenueCents, revenueSource, spentCents);
  };
  ok.addEventListener("click", (ev) => { ev.stopPropagation(); submit(); });
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); toast(cancelToast); }
  });
  amount.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); toast(cancelToast); }
  });
  spend.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); toast(cancelToast); }
  });
  source.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); submit(); }
    if (ev.key === "Escape") { ev.preventDefault(); cleanup(); toast(cancelToast); }
  });
  row.appendChild(amount);
  row.appendChild(spend);
  row.appendChild(source);
  row.appendChild(input);
  row.appendChild(ok);
  row.appendChild(cancel);
  container.appendChild(row);
  amount.focus();
  return true;
}

function cleanUnreviewed(notes) {
  return String(notes || "").replace(/UNREVIEWED,?\s*/g, "").trim();
}

// Shared vetted tag (finding 6): the [YYYY-MM-DD vetted] tag is the health
// contract vetted_last_7d counts, so both Vet paths build it here — one edit
// point, no silent divergence.
function vettedNotes(notes) {
  const day = new Date().toISOString().slice(0, 10);
  return `${cleanUnreviewed(notes)}\n[${day} vetted] Human vetted; cap lifted.`.trim().slice(-8000);
}

// Detail-before-write (F2): list rows no longer ship notes, so Vet, Starter,
// and Kill share one token-gated detail fetch that stashes full notes on the
// list row for the write below. Returns the row, or null (after the modal or
// a "<Action> failed" toast) when the caller must return early. Transient
// write-path cache — the post-write refresh replaces the row.
async function fetchDetailForWrite(id, actionLabel) {
  if (!state.token) { openAdminModal("Enter the admin token first."); return null; }
  try {
    const d = await api(`/api/opportunities/${id}`);
    const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
    if (o && d && d.opportunity) o.notes = d.opportunity.notes || "";
    return o || null;
  } catch (e) { toast(`${actionLabel} failed: ${e.message}`); return null; }
}

async function vetOpportunity(id) {
  if (!await fetchDetailForWrite(id, "Vet")) return;
  return vetOpportunityInner(id);
}

async function vetOpportunityInner(id) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
  if (!o) return;
  const notes = vettedNotes(o.notes);
  const orderBefore = state.reviewList.map((x) => x.id);
  try {
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    toast("Vetted — log the experiment or move to testing", { label: "Log experiment", onClick: () => openExperimentModal(null, id) });
    await refreshTargets({ experiments: false, runs: false });
    await refreshReview();
    if (state.reviewOnly) renderLedger();
    advanceReviewFocus(id, orderBefore);
  } catch (e) { toast(`Vet failed: ${e.message}`); }
}

// One-tap Vet & log starter: vets the row, POSTs a planned starter experiment
// prefilled from the row (name/hypothesis/metric; every field stays editable
// via Update), and flips the row to testing — the same three calls the human
// makes today (Vet PATCH, Log experiment POST, admin status PATCH), composed
// behind one tap. Token-gated like vetOpportunity; the toast carries a Start
// shortcut for the created experiment. Human-pressed, one decision.
async function vetAndLogStarter(id) {
  if (!await fetchDetailForWrite(id, "Starter")) return;
  return vetAndLogStarterInner(id);
}

async function vetAndLogStarterInner(id) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
  if (!o) return;
  const notes = vettedNotes(o.notes);
  const starterName = `Starter: ${o.title}`.slice(0, 200);
  const starterHypothesis = String(o.one_liner || firstStepsFirstLine({ first_steps: o.brief_first_steps }) || `Smallest paid test of ${o.title}`).slice(0, 8000);
  try {
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes }),
    });
    const created = await api("/api/experiments", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        opportunity_id: id, name: starterName, hypothesis: starterHypothesis,
        status: "planned", metric: "replies; revenue",
        target: `First $ toward ${money(o.est_monthly_low, o.est_monthly_high)}/mo`,
      }),
    });
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "testing" }),
    });
    toast("Vetted — starter logged, moved to testing", { label: "Start", onClick: () => startExperiment(created.id) });
    await refreshTargets({ runs: false });
    await refreshReview();
    if (state.reviewOnly) renderLedger();
  } catch (e) { toast(`Starter failed: ${e.message}`); }
}

async function killOpportunity(id, anchorEl) {
  if (!await fetchDetailForWrite(id, "Kill")) return;
  return killOpportunityInner(id, anchorEl);
}

async function killOpportunityInner(id, anchorEl) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  const killContainer = (anchorEl ? (anchorEl.closest(".review-actions") || anchorEl.closest(".card") || anchorEl.parentElement) : null) || document.querySelector("#ledger-body") || document.body;
  const doKill = async (pm) => {
  // (cancel handled by inline row: empty still cancels, row untouched)
  const o = state.reviewList.find((x) => x.id === id) || state.opportunities.find((x) => x.id === id);
  if (!o) return;
  const day = new Date().toISOString().slice(0, 10);
  const notes = `${cleanUnreviewed(o.notes)}\n[${day} killed] ${pm.trim()}`.trim().slice(-8000);
  const orderBefore = state.reviewList.map((x) => x.id);
  try {
    await api(`/api/opportunities/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "killed", notes }),
    });
    toast("Killed with post-mortem");
    await refreshTargets({ experiments: false, runs: false });
    await refreshReview();
    if (state.reviewOnly) renderLedger();
    advanceReviewFocus(id, orderBefore);
    if (state.detail) openDrawer(state.detail.opportunity.id);
  } catch (e) { toast(`Kill failed: ${e.message}`); }
  };
  inlinePostMortem(killContainer, { label: "One-line post-mortem (required to kill):", placeholder: "One-line post-mortem (required to kill):", confirmText: "Kill", onSubmit: (pm) => doKill(pm), cancelToast: "Kill cancelled — post-mortem required." });
}

/* ---- review triage mode: V/K + auto-advance (one human verdict per keypress) ---- */
// The queue drains one verdict at a time: V vets the focused review row and
// focuses the next unreviewed row; K opens the inline post-mortem on the
// focused row, and Confirm kills + advances while Cancel/Esc keeps the row
// (the inline row owns cancel). Both keys reuse vetOpportunity /
// killOpportunity, so the token gate, toasts, and refreshes are unchanged and
// the buttons and drawer paths are untouched. Nothing here vets without a
// keypress: no timer, no loop over the queue, no bulk call.
function focusedReviewId() {
  const el = document.activeElement;
  const tr = el && el.closest ? el.closest('#ledger-body tr.row[data-id]') : null;
  return tr ? Number(tr.dataset.id) : null;
}

// Next focus target after a verdict (pure over the refreshed review list):
// the first remaining row after the verdict id in the pre-verdict order,
// else the first remaining row, else null for the empty-queue line.
function nextReviewIdAfter(orderBefore, verdictId) {
  const ids = orderBefore || [];
  const remaining = new Set((state.reviewList || []).map((o) => o.id));
  const start = ids.indexOf(verdictId);
  for (let i = start + 1; i < ids.length; i++) {
    if (remaining.has(ids[i])) return ids[i];
  }
  for (const id of ids) {
    if (remaining.has(id)) return id;
  }
  return null;
}

function focusReviewRow(id) {
  if (id === null || id === undefined) {
    const cell = document.querySelector("#ledger-body td");
    if (cell) { cell.tabIndex = -1; cell.focus(); }
    return;
  }
  const tr = document.querySelector(`#ledger-body tr.row[data-id="${id}"]`);
  if (tr) tr.focus();
}

function advanceReviewFocus(verdictId, orderBefore) {
  if (!state.reviewOnly) return;
  focusReviewRow(nextReviewIdAfter(orderBefore, verdictId));
}

function handleReviewKey(ev) {
  if (!state.reviewOnly) return;
  if (!ev || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (t && t.closest && (t.closest(".pm-inline") || t.closest("dialog") || t.closest("#drawer"))) return;
  const key = String(ev.key || "").toLowerCase();
  if (key !== "v" && key !== "k") return;
  const id = focusedReviewId();
  if (id === null || id === undefined || Number.isNaN(id)) return;
  ev.preventDefault();
  if (key === "v") { vetOpportunity(id); return; }
  const tr = document.querySelector(`#ledger-body tr.row[data-id="${id}"]`);
  killOpportunity(id, (tr && tr.querySelector(".review-actions")) || tr);
}
document.addEventListener("keydown", handleReviewKey);

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

// Fallback decisions/week from the already-loaded experiments list (no new
// request): won/lost rows with ended_at inside 7d. Mirrors the API's
// decisions_last_7d window so the header stays honest when the decisions probe
// fails; health numbers win whenever present (see renderExperiments).
const fallbackDecisions = (exps) => {
  const cutoff = Date.now() - 7 * 86400000;
  let n = 0;
  for (const e of (exps || [])) {
    if (e.status !== "won" && e.status !== "lost") continue;
    const ms = Date.parse(String(e.ended_at || ""));
    if (Number.isFinite(ms) && ms >= cutoff) n++;
  }
  return n;
};

// Nudge deep-link (read-only): switch to the Experiments tab and
// highlight/scroll to the stalest card so the next move is one tap away.
// No auto-transitions — the human still presses Start.
function focusNudgeCard(nudge) {
  activateTab("experiments", true);
  const card = document.querySelector(`#board .card[data-id="${nudge.id}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest" });
  card.style.borderColor = "var(--green)";
  card.style.borderWidth = "2px";
}

// One-click Start for planned experiments: a single PATCH to running (the API
// stamps started_at; won/lost still require result + post-mortem). Token-gated
// like vetOpportunity; orphaned cards never render the button.
// First candidate to start: 'Spec-ad sprint: 10 brands, 10 free ads'
// (d1/seed.sql) — a human still presses it.
async function startExperiment(id) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  try {
    await api(`/api/experiments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    toast("Experiment started");
    await refreshTargets({ opportunities: false, runs: false });
  } catch (e) { toast(`Start failed: ${e.message}`); }
}

// One-click Lose for planned/running experiments: one inline input for the
// post-mortem line, then a single PATCH to lost sending that line as both
// result and post_mortem so the API closure gate holds unchanged. Token-gated
// like startExperiment; orphaned cards never render the button; an empty
// inline line cancels with the row untouched. Human-pressed, one decision.
async function loseExperiment(id, anchorEl) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  const loseContainer = (anchorEl ? (anchorEl.closest(".card") || anchorEl.closest(".review-actions") || anchorEl.parentElement) : null) || document.querySelector("#board") || document.body;
  const doLose = async (pm) => {
  // (cancel handled by inline row: empty still cancels, row untouched)
  try {
    await api(`/api/experiments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "lost", result: pm.trim(), post_mortem: pm.trim() }),
    });
    toast("Experiment closed as lost");
    await refreshTargets({ runs: false });
  } catch (e) { toast(`Close failed: ${e.message}`); }
  };
  inlinePostMortem(loseContainer, { label: "One-line post-mortem (required to close as lost):", placeholder: "One-line post-mortem (required to close as lost):", confirmText: "Lose", onSubmit: (pm) => doLose(pm), cancelToast: "Close cancelled — post-mortem required." });
}

// One-click Win for planned/running experiments: one inline $ amount, one
// optional spend, one optional source line, one inline line, then a single
// PATCH to won sending that line as both result and post_mortem, the
// human-entered amount as revenue_cents, and the source as revenue_source,
// so the API closure gate holds unchanged (ended_at stamped by the API).
// Token-gated like loseExperiment; orphaned cards never render the button;
// an empty inline line cancels with the row untouched; bad/negative $ clamps
// to 0 exactly like the modal. An empty spend sends no spent_cents key so the
// API keeps the row's existing value — a modal-entered spend is never
// clobbered with 0. Human-pressed, one decision.
async function winExperiment(id, anchorEl) {
  if (!state.token) return openAdminModal("Enter the admin token first.");
  const winContainer = (anchorEl ? (anchorEl.closest(".card") || anchorEl.closest(".review-actions") || anchorEl.parentElement) : null) || document.querySelector("#board") || document.body;
  const doWin = async (pm, revenueCents, revenueSource, spentCents) => {
  // (cancel handled by inline row: empty still cancels, row untouched)
  try {
    await api(`/api/experiments/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "won", result: pm.trim(), post_mortem: pm.trim(), revenue_cents: revenueCents, revenue_source: revenueSource, ...(spentCents === null || spentCents === undefined ? {} : { spent_cents: spentCents }) }),
    });
    toast("Experiment closed as won");
    await refreshTargets({ runs: false });
  } catch (e) { toast(`Close failed: ${e.message}`); }
  };
  inlineWinClose(winContainer, { label: "One-line post-mortem (required to close as won):", placeholder: "One-line post-mortem (required to close as won):", confirmText: "Win", onSubmit: (pm, revenueCents, revenueSource, spentCents) => doWin(pm, revenueCents, revenueSource, spentCents), cancelToast: "Win cancelled — post-mortem required." });
}

function renderExperiments() {
  const exps = state.experiments;
  $("#exp-count").textContent = exps.length || "";
  const running = exps.filter((e) => e.status === "running").length;
  const won = exps.filter((e) => e.status === "won").length;
  const healthDecisions = state.health && typeof state.health.decisions_last_7d === "number" ? state.health.decisions_last_7d : null;
  const vetted = state.health && typeof state.health.vetted_last_7d === "number" ? state.health.vetted_last_7d : null;
  const vettedNoExp = state.health && typeof state.health.vetted_no_experiment === "number" ? state.health.vetted_no_experiment : null;
  const revenue = state.health && typeof state.health.revenue_last_7d === "number" ? state.health.revenue_last_7d : null;
  const revenueTotal = state.health && typeof state.health.revenue_total === "number" ? state.health.revenue_total : null;
  // Fallback: when the decisions probe fails (null), count decisions from the
  // already-loaded list so the week line and the stall nudge survive the
  // outage. Health wins whenever present; no new request is made.
  const decisions = healthDecisions !== null ? healthDecisions : fallbackDecisions(exps);
  let summary = exps.length
    ? `${exps.length} experiments · ${running} running · ${won} won`
    : (state.apiFailures.includes("/api/experiments")
      ? "Could not load experiments — see the banner above and retry."
      : "No experiments yet.");
  if (decisions !== null && vetted !== null) {
    let conv = `${decisions} decisions this week · ${vetted} vetted this week → ${exps.length} total experiments`;
    if (revenue !== null) conv += ` · ${moneyCents(revenue)} revenue this week`;
    if (revenueTotal !== null) conv += ` · ${moneyCents(revenueTotal)} lifetime`;
    if (vettedNoExp !== null && vettedNoExp > 0) conv += ` · ${vettedNoExp} vetted, no experiment`;
    summary = `${summary} · ${conv}`;
  }
  // Stall nudge (read-only): when the week has zero decisions, name the
  // stalest open card with its age so the next move is one click away.
  // No auto-transitions — the human still owns every status move.
  const nudge = (decisions === 0) ? stalestOpenExp(exps) : null;
  const summaryEl = $("#exp-summary");
  if (nudge) {
    const startBtn = nudge.status === "planned" ? ` <button id="exp-nudge-start" class="btn small" type="button">Start it</button>` : "";
    summaryEl.innerHTML = `${esc(summary)} · <span class="nudge">Nudge: &ldquo;${esc(nudge.name)}&rdquo; has been ${esc(nudge.status)} ${nudge.days_in_status}d <button id="exp-nudge-open" class="btn small ghost" type="button">Show it</button>${startBtn}</span>`;
    $("#exp-nudge-open").addEventListener("click", () => focusNudgeCard(nudge));
    if (nudge.status === "planned") $("#exp-nudge-start").addEventListener("click", () => startExperiment(nudge.id));
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
          <p>${e.orphaned ? `<span class="pill st-killed">orphaned</span> ` : ""}${esc(e.opportunity_title || "(opportunity deleted)")}${e.metric ? ` · ${esc(e.metric)}` : ""}${ageChip(e)}${runningMismatchBadge(e)}${e.revenue_cents > 0 ? ` · <span class="mono">${moneyCents(e.revenue_cents)} rev</span>${e.revenue_source ? ` via ${esc(e.revenue_source)}` : ""}` : ""}${e.spent_cents > 0 ? ` · <span class="mono">${moneyCents(e.spent_cents)} spent</span>` : ""}</p>
          <div class="meta">${statusPill(e.status)}
            <span class="muted mono">${esc(e.result ? `→ ${e.result.slice(0, 40)}` : (e.target || ""))}</span></div>
          ${e.status === "planned" && !e.orphaned ? `<p style="margin:6px 0 0"><button class="btn small" data-start-exp="${e.id}" type="button">Start</button></p>` : ""}
          ${(e.status === "planned" || e.status === "running") && !e.orphaned ? `<p style="margin:6px 0 0"><button class="btn small" data-win-exp="${e.id}" type="button">Win</button> <button class="btn small ghost danger" data-lose-exp="${e.id}" type="button">Lose</button></p>` : ""}
        </div>`).join("") || `<p class="muted">—</p>`) + `</div>`;
  }).join("");
  document.querySelectorAll("#board .card").forEach((c) => {
    c.addEventListener("click", (ev) => {
      if (ev.target.closest("[data-start-exp]")) return;
      if (ev.target.closest("[data-lose-exp]")) return;
      if (ev.target.closest("[data-win-exp]")) return;
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
    const backlogBit = reviewBacklogBit(state.health);
    pill.title = noise !== null ? "Latest research run: +" + last.added + "/" + last.updated + " " + String.fromCharCode(183) + " " + noise + " noise" : "Latest research run";
    const probeFails = probeFailures();
    if (probeFails.length) pill.title += " · failing probes: " + probeFails.map((p) => probeLabel(p, probeDetailMap())).join(", ");
    if (backlogBit) pill.title += " · " + backlogBit;
    const when = last.finished_at || last.started_at || "";
    $("#agent-text").textContent =
      `agent: ${last.status} · +${last.added}/${last.updated}/${last.briefs} · ${when.slice(0, 16).replace("T", " ")}`;
    if (noise !== null) $("#agent-text").textContent += " " + String.fromCharCode(183) + " " + noise + " noise";
    if (backlogBit) $("#agent-text").textContent += " " + String.fromCharCode(183) + " " + backlogBit;
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

// Review jump: the pill mirrors the backlog count, so clicking it (or
// Enter/Space on the focused pill) opens the Needs-review filter on the
// Priority tab. Read-only: reuses the review chip's own click handler.
function jumpToReviewQueue() {
  activateTab("priority", true);
  const chip = document.querySelector('.filters .chip[data-review="1"]');
  if (chip) chip.click();
  else { state.reviewOnly = true; refreshReview().then(renderLedger); }
}
const agentPillJump = $("#agent-pill");
if (agentPillJump) {
  agentPillJump.addEventListener("click", jumpToReviewQueue);
  agentPillJump.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); jumpToReviewQueue(); }
  });
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
          <div class="meta">${statusPill(e.status)}<span class="muted mono">${esc(e.result || e.target || "")}</span> <span class="muted mono">${moneyCents(e.revenue_cents || 0)} rev / ${moneyCents(e.spent_cents || 0)} spent${e.revenue_source ? ` via ${esc(e.revenue_source)}` : ""}${e.ended_at ? ` · ended ${esc(String(e.ended_at).slice(0, 10))}` : ""}</span></div>
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
          await refreshTargets({ experiments: false, runs: false });
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
      await refreshTargets({ experiments: false, runs: false });
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
      await refreshTargets({ experiments: false, runs: false });
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
      await refreshTargets({ experiments: false, runs: false });
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
      <label>Revenue source<input id="m-source" maxlength="120" value="${esc(exp?.revenue_source || "")}"></label>
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
      revenue_source: $("#m-source").value.trim().slice(0, 120),
    };
    try {
      if (isNew) await api("/api/experiments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      else await api(`/api/experiments/${exp.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      $("#modal").close();
      toast(isNew ? "Experiment logged" : "Experiment updated");
      await refreshTargets({ runs: false });
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

// Delegated one-click Win: mirrors the Lose listener above (cards re-render
// on every refresh, so delegation covers all Win buttons the same way).
$("#board").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-win-exp]");
  if (!b) return;
  ev.stopPropagation();
  winExperiment(Number(b.dataset.winExp), b);
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
    // Delayed refresh only: /run returns 202 while the pass runs in waitUntil,
    // so an immediate refresh would re-paint pre-run state.
    setTimeout(refresh, 45000);
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

// Partial-health honesty (audit 2026-09-20-round2 Task 3): when the API
// isolates failing probes it names them in health_probe_failures; the pill
// tooltip and the error banner surface the names plus the missing columns and the migration one-liner, so a green pill with null
// money probes still explains itself. Read-only, no new fetch.
const probeFailures = () =>
  (state.health && Array.isArray(state.health.health_probe_failures) && state.health.health_probe_failures.length)
    ? state.health.health_probe_failures.slice()
    : [];

// Schema-drift disclosure (audit 2026-09-20-round2 Task 2): the health
// payload names the missing column per probe (health_probe_detail) plus the
// overall missing list and the one-line owner fix (schema_migration). The
// banner and pill tooltip surface all three so the owner finds the
// ALLOW_SCHEMA_MIGRATION=1 switch where he actually looks. Read-only.
const probeDetailMap = () =>
  (state.health && state.health.health_probe_detail && typeof state.health.health_probe_detail === "object")
    ? state.health.health_probe_detail : {};
const schemaMissingColumns = () =>
  (state.health && Array.isArray(state.health.schema_missing_columns))
    ? state.health.schema_missing_columns.filter((c) => typeof c === "string" && c) : [];
const schemaMigrationLine = () =>
  (state.health && typeof state.health.schema_migration === "string" && state.health.schema_migration)
    ? state.health.schema_migration : "";
// Pure: pair a failing probe with its missing column when the API named one.
const probeLabel = (name, detail) =>
  (detail && typeof detail[name] === "string" && detail[name]) ? `${name} (${detail[name]})` : name;

function renderApiErrors() {
  const el = $("#api-errors");
  if (!el) return;
  const fails = state.apiFailures || [];
  const probes = probeFailures();
  const migLine = schemaMigrationLine();
  if (!fails.length && !probes.length && !migLine) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  const parts = [];
  if (fails.length) parts.push(`API ${fails.length === 1 ? "error" : "errors"}: ${fails.map((f) => esc(f)).join(", ")} failed to load.`);
  if (probes.length) parts.push(`Health probes failing: ${probes.map((p) => esc(probeLabel(p, probeDetailMap()))).join(", ")}.`);
  const missingCols = schemaMissingColumns();
  if (missingCols.length) parts.push(`Missing columns: ${missingCols.map((c) => esc(c)).join(", ")}.`);
  if (migLine) parts.push(`Schema migration: ${esc(migLine)}`);
  el.innerHTML = `${parts.join(" ")} <button id="api-retry" class="btn small ghost" type="button">Retry</button> <button id="api-dismiss" class="btn small ghost" type="button" aria-label="Dismiss">Dismiss</button>`;
  const retry = $("#api-retry");
  if (retry) retry.addEventListener("click", () => refresh());
  const dismiss = $("#api-dismiss");
  if (dismiss) dismiss.addEventListener("click", () => el.classList.add("hidden"));
}

/* ---- last-good cache: instant first paint, live data always wins ---- */
// The owner's first five seconds used to be placeholders ("agent: …",
// "Needs review (…"). Each successful refresh now persists the painted
// surfaces (pill run, Start-here top pick, review count/age, health bits) to
// localStorage, and boot repaints them synchronously before the first fetch.
// Parts carry their own savedAt so a scoped refresh never re-stamps data it
// did not refetch; anything older than one 6h cron tick paints with a stale
// mark. Read-only: every live render overwrites unconditionally on success,
// and a failed refresh keeps the cache (marked) instead of blanking.
const LAST_GOOD_KEY = "aimoney_last_good";
const LAST_GOOD_MAX_AGE_MS = 6 * 3600000; // one cron tick
const LAST_GOOD_STALE_MARK = " · stale";
// Pure: unknown age reads stale (never paint undated data as fresh).
const isSnapshotStale = (savedAt, now) => !(typeof savedAt === "number" && Number.isFinite(savedAt)) || (Number(now) - savedAt) > LAST_GOOD_MAX_AGE_MS;

const readLastGood = () => {
  try {
    const snap = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) || "null");
    return snap && typeof snap === "object" ? snap : null;
  } catch { return null; }
};

// Merge only the parts this round actually refetched (fresh flags from
// refreshTargets); a part keeps its own savedAt so staleness stays honest.
function saveLastGood(fresh) {
  if (!fresh || (!fresh.opps && !fresh.health && !fresh.runs)) return;
  const snap = readLastGood() || {};
  const now = Date.now();
  if (fresh.health) {
    const h = state.health || {};
    snap.health = {
      noise_24h: (typeof h.noise_24h === "number" ? h.noise_24h : null),
      bare_without_brief: (typeof h.bare_without_brief === "number" ? h.bare_without_brief : null),
      unreviewed: (typeof h.unreviewed === "number" ? h.unreviewed : null),
      oldest_unreviewed_age_h: (typeof h.oldest_unreviewed_age_h === "number" ? h.oldest_unreviewed_age_h : null),
      savedAt: now,
    };
  }
  if (fresh.opps) {
    const top = topOpportunity(state.opportunities);
    snap.top = top ? {
      id: top.id, title: top.title,
      est_monthly_low: top.est_monthly_low, est_monthly_high: top.est_monthly_high,
      capital_needed: top.capital_needed, brief_first_steps: top.brief_first_steps,
      needs_review: isNeedsReview(top) ? 1 : 0, savedAt: now,
    } : { id: null, savedAt: now };
    snap.review = { count: state.reviewList.length, age: oldestReviewAge(), savedAt: now };
  }
  if (fresh.runs) {
    const last = (state.runs || [])[0] || null;
    snap.run = last ? {
      status: last.status, added: last.added, updated: last.updated, briefs: last.briefs,
      finished_at: last.finished_at || "", started_at: last.started_at || "", savedAt: now,
    } : { status: null, savedAt: now };
  }
  try { localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(snap)); } catch { /* private mode: boot just paints placeholders */ }
}

function paintLastGood() {
  const snap = readLastGood();
  if (!snap) return;
  // Pill: same shape as renderRuns, stale-marked past one tick.
  const run = snap.run;
  if (run && run.status && $("#agent-text")) {
    const when = String(run.finished_at || run.started_at || "").slice(0, 16).replace("T", " ");
    const noise = snap.health && typeof snap.health.noise_24h === "number" ? snap.health.noise_24h : null;
    const cachedBacklog = reviewBacklogBit(snap.health || {});
    $("#agent-text").textContent =
      `agent: ${run.status} · +${run.added}/${run.updated}/${run.briefs} · ${when}` +
      (noise !== null ? ` · ${noise} noise` : "") +
      (cachedBacklog ? ` · ${cachedBacklog}` : "") +
      (isSnapshotStale(run.savedAt, Date.now()) ? LAST_GOOD_STALE_MARK : "");
    const pill = $("#agent-pill");
    if (pill) pill.title = (noise !== null ? `Latest research run: +${run.added}/${run.updated} · ${noise} noise` : "Latest research run") +
      (cachedBacklog ? ` · ${cachedBacklog}` : "") +
      (isSnapshotStale(run.savedAt, Date.now()) ? LAST_GOOD_STALE_MARK : "");
  }
  // Review chip: count + age + tooltip, stale-marked past one tick.
  const review = snap.review;
  if (review && typeof review.count === "number") {
    const staleMark = isSnapshotStale(review.savedAt, Date.now()) ? LAST_GOOD_STALE_MARK : "";
    if ($("#review-count")) $("#review-count").textContent = review.count;
    if ($("#review-age")) $("#review-age").textContent = String(review.age || "") + staleMark;
    const chip = document.querySelector('.filters .chip[data-review="1"]');
    if (chip) {
      const bare = snap.health && typeof snap.health.bare_without_brief === "number" ? snap.health.bare_without_brief : null;
      chip.title = `${review.count} need review` + (bare !== null ? ` · ${bare} without briefs` : "") + staleMark;
    }
  }
  // Strip: same copy and actions as renderStartHere, stale-marked past one
  // tick. Vet/Kill re-fetch detail before writing, so a cached id is safe.
  const cachedTop = snap.top;
  const el = $("#start-here");
  if (cachedTop && cachedTop.id !== null && cachedTop.id !== undefined && el) {
    const staleMark = isSnapshotStale(cachedTop.savedAt, Date.now()) ? LAST_GOOD_STALE_MARK : "";
    const excerpt = firstStepsFirstLine({ first_steps: cachedTop.brief_first_steps });
    const nextAction = excerpt || "No brief yet — open the drawer for facts.";
    const needsReview = Number(cachedTop.needs_review) === 1;
    el.classList.remove("hidden");
    el.innerHTML =
      `<div style="background:var(--green-wash);border:1px solid var(--green);border-radius:8px;padding:10px 12px;margin-bottom:12px">` +
      `<p style="margin:0 0 4px"><b>Start here today:</b> ${esc(cachedTop.title)}${staleMark}</p>` +
      `<p class="muted" style="margin:0 0 8px;font-size:13px"><span class="mono">${money(cachedTop.est_monthly_low, cachedTop.est_monthly_high)}/mo</span>` +
      ` · <span>Capital: ${esc(cachedTop.capital_needed || "—")}</span>` +
      ` · <span>Next: ${esc(nextAction)}</span></p>` +
      `<p style="margin:0"><button id="start-here-open" class="btn small" type="button">Open in drawer</button>` +
      (needsReview ? ` <button id="start-here-vet" class="btn small" type="button">Vet</button> <button id="start-here-kill" class="btn small ghost danger" type="button">Kill</button>` : "") +
      `</p>` +
      `</div>`;
    $("#start-here-open").addEventListener("click", () => openDrawer(cachedTop.id));
    if (needsReview) {
      $("#start-here-vet").addEventListener("click", () => vetOpportunity(cachedTop.id));
      $("#start-here-kill").addEventListener("click", (ev) => killOpportunity(cachedTop.id, ev.currentTarget));
    }
  }
}

/* ---- boot ---- */
// refresh() stays the full repaint (boot, banner Retry, delayed post-triage
// refresh): it delegates to refreshTargets with every endpoint enabled.
async function refresh() {
  return refreshTargets({});
}
// Targeted refresh: every phone action refetches only the endpoints its write
// can dirty — vet/kill/add/save/rescore touch opportunities+health, Start
// touches experiments+health, win/lose and experiment saves also touch
// opportunities (closing appends the outcome-ledger line to parent notes;
// new rows shift parent experiment counts), and runs change only on cron
// ticks or the manual trigger. Flags default to true; renders always run
// (cheap and idempotent) so a scoped fetch never leaves a stale section.
async function refreshTargets(want = {}) {
  const fetchOpps = want.opportunities !== false;
  const fetchExps = want.experiments !== false;
  const fetchRuns = want.runs !== false;
  const fetchHealth = want.health !== false;
  // Clear stale failure flags only for endpoints about to be fetched, so a
  // scoped refresh never hides an unrelated still-failing section.
  const refetching = new Set([
    ...(fetchOpps ? ["/api/opportunities"] : []),
    ...(fetchExps ? ["/api/experiments"] : []),
    ...(fetchRuns ? ["/api/runs"] : []),
    ...(fetchHealth ? ["/api/health"] : []),
  ]);
  state.apiFailures = (state.apiFailures || []).filter((f) => !refetching.has(f));
  const [opps, exps, runs, health] = await Promise.all([
    fetchOpps ? api("/api/opportunities?limit=200").catch(() => { state.apiFailures.push("/api/opportunities"); return { opportunities: [] }; }) : null,
    fetchExps ? api("/api/experiments").catch(() => { state.apiFailures.push("/api/experiments"); return { experiments: [] }; }) : null,
    fetchRuns ? api("/api/runs?limit=20").catch(() => { state.apiFailures.push("/api/runs"); return { runs: [] }; }) : null,
    fetchHealth ? api("/api/health").catch(() => { state.apiFailures.push("/api/health"); return {}; }) : null,
  ]);
  if (opps) state.opportunities = opps.opportunities || [];
  if (exps) state.experiments = exps.experiments || [];
  if (runs) state.runs = runs.runs || [];
  if (health) state.health = health || {};
  if (!metaLoaded) {
    try { state.meta = await api("/api/meta"); metaLoaded = true; }
    catch { state.meta = {}; }
  }
  await refreshReview().catch(() => {});
  if (health) $("#rev").textContent = health.rev ? `rev ${health.rev}` : "";
  renderApiErrors();
  renderLedger();
  renderExperiments();
  renderRuns();
  // Persist the painted surfaces for the next boot's instant paint. Only the
  // parts this round actually refetched are saved (scoped refreshes merge).
  saveLastGood({
    opps: fetchOpps && !(state.apiFailures || []).includes("/api/opportunities"),
    health: fetchHealth && !(state.apiFailures || []).includes("/api/health"),
    runs: fetchRuns && !(state.apiFailures || []).includes("/api/runs"),
  });
}
// Instant first paint from the last-good cache (placeholders stay when there
// is no cache); the live refresh below always wins.
paintLastGood();
refresh().catch((e) => {
  $("#ledger-body").innerHTML = `<tr><td colspan="10">API unreachable: ${esc(e.message)} — is the D1 binding attached?</td></tr>`;
});
