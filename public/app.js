/* AIMoney Lab dashboard. Reads are public; writes need the admin token
   (Pages env ADMIN_TOKEN), kept in localStorage after one entry. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const state = {
  opportunities: [], experiments: [], runs: [], meta: {},
  statusFilter: "", detail: null, reviewOnly: false, reviewList: [],
  health: {},
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

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add("hidden"), 3200);
}

const money = (lo, hi) => {
  if (!lo && !hi) return "—";
  const f = (n) => n >= 1000 ? `$${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : `$${n}`;
  return lo && hi && lo !== hi ? `${f(lo)}–${f(hi)}` : f(hi || lo);
};

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

/* ---- priority list ---- */
function renderLedger() {
  if (state.reviewOnly) return renderReview();
  const rows = state.opportunities.filter((o) =>
    !state.statusFilter || o.status === state.statusFilter);
  const max = Math.max(1, ...state.opportunities.map((o) => o.score || 0));
  $("#ledger-body").innerHTML = rows.length ? rows.map((o, i) => `
    <tr class="row" data-id="${o.id}">
      <td class="num rank">${i + 1}</td>
      <td><div class="opp-title">${esc(o.title)} <span class="cat muted">· ${esc(o.category)}</span></div>
        <div class="opp-sub">${esc(o.one_liner || "")}</div></td>
      <td>${statusPill(o.status)}</td>
      <td class="score-cell"><span class="score-num">${esc(o.score)}</span>
        <div class="score-bar"><i style="width:${Math.round(100 * (o.score || 0) / max)}%"></i></div></td>
      <td>${meter(o.value)}</td><td>${meter(o.effort)}</td>
      <td>${meter(o.confidence)}</td><td>${meter(o.fit)}</td>
      <td class="num money">${money(o.est_monthly_low, o.est_monthly_high)}</td>
      <td class="muted">${esc(o.time_to_first_dollar || "—")}</td>
    </tr>`).join("")
    : `<tr><td colspan="10" class="muted">Nothing here. The next agent run may add some — or add one yourself.</td></tr>`;
  document.querySelectorAll("#ledger-body tr.row").forEach((tr) => {
    tr.addEventListener("click", () => openDrawer(Number(tr.dataset.id)));
  });
}

function renderReview() {
  const rows = state.reviewList;
  const max = Math.max(1, ...rows.map((o) => o.score || 0));
  $("#ledger-body").innerHTML = rows.length ? rows.map((o, i) => `
    <tr class="row" data-id="${o.id}">
      <td class="num rank">${i + 1}</td>
      <td><div class="opp-title">${esc(o.title)} <span class="cat muted">· ${esc(o.category)}</span></div>
        <div class="opp-sub">${esc(o.one_liner || "")}</div>
        <div class="review-actions">
          <button class="btn small" data-vet="${o.id}" type="button">Vet</button>
          <button class="btn small ghost danger" data-kill="${o.id}" type="button">Kill</button>
        </div></td>
      <td>${statusPill(o.status)}</td>
      <td class="score-cell"><span class="score-num">${esc(o.score)}</span>
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
    b.addEventListener("click", (ev) => { ev.stopPropagation(); killOpportunity(Number(b.dataset.kill)); });
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

function cleanUnreviewed(notes) {
  return String(notes || "").replace(/UNREVIEWED,?\s*/g, "").replace(/UNREVIEWED/g, "").trim();
}

async function vetOpportunity(id) {
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
    toast("Vetted — cap lifted");
    await refresh();
    await refreshReview();
    if (state.reviewOnly) renderLedger();
  } catch (e) { toast(`Vet failed: ${e.message}`); }
}

async function killOpportunity(id) {
  if (!state.token) return toast("Enter the admin token first.");
  const pm = prompt("One-line post-mortem (required to kill):");
  if (!pm || !pm.trim()) return toast("Kill cancelled — post-mortem required.");
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
  } catch (e) { toast(`Kill failed: ${e.message}`); }
}

document.querySelectorAll(".filters .chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    document.querySelectorAll(".filters .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
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

function renderExperiments() {
  const exps = state.experiments;
  $("#exp-count").textContent = exps.length || "";
  const running = exps.filter((e) => e.status === "running").length;
  const won = exps.filter((e) => e.status === "won").length;
  $("#exp-summary").textContent = exps.length
    ? `${exps.length} experiments · ${running} running · ${won} won`
    : "No experiments yet.";
  $("#board").innerHTML = EXP_COLS.map(([st, label]) => {
    const list = exps.filter((e) => e.status === st)
      .sort((a, b) => (b.days_in_status ?? -1) - (a.days_in_status ?? -1));
    return `<div class="column"><h3>${label} (${list.length})</h3>` +
      (list.map((e) => `
        <div class="card" data-id="${e.id}" data-opp="${e.opportunity_id}"${e.orphaned ? ` data-orphan="1"` : ""}>
          <h4>${esc(e.name)}</h4>
          <p>${e.orphaned ? `<span class="pill st-killed">orphaned</span> ` : ""}${esc(e.opportunity_title || "(opportunity deleted)")}${e.metric ? ` · ${esc(e.metric)}` : ""}${ageChip(e)}</p>
          <div class="meta">${statusPill(e.status)}
            <span class="muted mono">${esc(e.result ? `→ ${e.result.slice(0, 40)}` : (e.target || ""))}</span></div>
        </div>`).join("") || `<p class="muted">—</p>`) + `</div>`;
  }).join("");
  document.querySelectorAll("#board .card").forEach((c) => {
    c.addEventListener("click", () => {
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
  if (last) {
    const when = last.finished_at || last.started_at || "";
    $("#agent-text").textContent =
      `agent: ${last.status} · +${last.added}/${last.updated}/${last.briefs} · ${when.slice(0, 16).replace("T", " ")}`;
    pill.classList.toggle("ok", last.status === "ok");
    pill.classList.toggle("bad", last.status === "error");
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
    : `<tr><td colspan="10" class="muted">No agent runs yet — the first cron pass lands within 6h of deploy.</td></tr>`;
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
      <p>${statusPill(o.status)} <span class="muted">· ${esc(o.category)} · score </span><b class="mono">${esc(o.score)}</b></p>
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
          <div class="meta">${statusPill(e.status)}<span class="muted mono">${esc(e.result || e.target || "")}</span></div>
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

function renderAdminZone() {
  const z = $("#admin-zone");
  if (!z || !state.detail) return;
  const o = state.detail.opportunity;
  z.innerHTML = state.token ? `
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
}

/* ---- modals ---- */
function showModal(html) {
  const f = $("#modal-form");
  f.innerHTML = html;
  $("#modal").showModal();
  return f;
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
      await api("/api/opportunities", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80),
          title, one_liner: $("#m-one").value.trim(), category: $("#m-cat").value.trim(),
          status: $("#m-status").value, value: Number($("#m-v").value),
          effort: Number($("#m-e").value), confidence: Number($("#m-c").value),
          fit: Number($("#m-f").value), source: "manual",
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

/* ---- manual research trigger ---- */
$("#btn-run").addEventListener("click", async () => {
  if (!state.token) return toast("Enter the admin token first.");
  const worker = state.meta.worker_url;
  if (!worker) return toast("Worker URL not configured (RESEARCH_WORKER_URL).");
  const btn = $("#btn-run");
  btn.disabled = true;
  btn.textContent = "Researching…";
  try {
    const r = await fetch(`${worker}/run`, {
      method: "POST", headers: { authorization: `Bearer ${state.token}` },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    toast("Research pass started — watch the Research log tab for results.");
    setTimeout(refresh, 45000);
    await refresh();
  } catch (e) { toast(`Research failed: ${e.message}`); }
  btn.disabled = false;
  btn.textContent = "Run research now";
});

/* ---- boot ---- */
async function refresh() {
  const [opps, exps, runs, health] = await Promise.all([
    api("/api/opportunities?limit=200").catch(() => ({ opportunities: [] })),
    api("/api/experiments").catch(() => ({ experiments: [] })),
    api("/api/runs?limit=20").catch(() => ({ runs: [] })),
    api("/api/health").catch(() => ({})),
  ]);
  state.opportunities = opps.opportunities || [];
  state.experiments = exps.experiments || [];
  state.runs = runs.runs || [];
  state.health = health || {};
  state.meta = await api("/api/meta").catch(() => ({}));
  await refreshReview().catch(() => {});
  $("#rev").textContent = health.rev ? `rev ${health.rev}` : "";
  renderLedger();
  renderExperiments();
  renderRuns();
}
refresh().catch((e) => {
  $("#ledger-body").innerHTML = `<tr><td colspan="10">API unreachable: ${esc(e.message)} — is the D1 binding attached?</td></tr>`;
});

