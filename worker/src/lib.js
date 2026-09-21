// AIMoney shared pure helpers (worker). Imported by src/index.js so the
// scoring/triage math is unit-testable without Workers bindings.

export const clamp10 = (v, d = 5) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : d;
};

export const slugify = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);

// Priority score. MUST match the README formula via effectiveScore below
// (the API imports effectiveScore from here; its scoreOf copy is deduped):
//   score = 100 * (value * confidence * fit) / (effort + 1)
export const scoreOf = (o) =>
  Math.round(100 * ((o.value * o.confidence * o.fit) / (o.effort + 1)) * 10) / 10;

// Honest agent cap (F3): while a row carries the UNREVIEWED marker its
// EFFECTIVE score is clamped below the human seeds that matter. Single
// shared implementation used by both the worker and the API.
export const UNREVIEWED_MARKER = "UNREVIEWED";
export const UNREVIEWED_SCORE_CAP = 6000;

export function isUnreviewed(opp) {
  const notes = typeof opp === "string" ? opp : (opp && opp.notes) || "";
  return String(notes).includes(UNREVIEWED_MARKER);
}

export function effectiveScore(o) {
  const s = scoreOf(o);
  return isUnreviewed(o) ? Math.min(s, UNREVIEWED_SCORE_CAP) : s;
}

// Constant-time admin-token compare (F8): the same ADMIN_TOKEN value guards
// the API and the worker, so both import this shared implementation instead of
// `!==` (which leaks timing information about the secret). Lengths compare
// first, then every charCode pair XORs into one accumulator.
export function tokensMatch(got, want) {
  const g = String(got || "");
  const w = String(want || "");
  if (!g || !w || g.length !== w.length) return false;
  let diff = 0;
  for (let i = 0; i < w.length; i++) diff |= w.charCodeAt(i) ^ g.charCodeAt(i);
  return diff === 0;
}

// Evidence append (F4): keep the NEWEST max chars, not the oldest.
// Mirrors the SQL fix `substr(notes || ?, -8000)` in worker/src/index.js.
// Pinned JS spec of that SQL idiom (no shipped importer; the lib suite pins the rule).
export function appendKeepNewest(notes, addition, max = 8000) {
  const combined = String(notes || "") + String(addition || "");
  return combined.length <= max ? combined : combined.slice(-max);
}

// The triage model replies with one JSON object per line (NDJSON). A hard
// token cap truncates ARRAY output into unparseable garbage (proven live:
// every verdict lost); with NDJSON a cut tail only loses the last lines.
// Mistral escapes underscores in keys (opportunity\_id) — invalid JSON that
// fails every parse. `\_` can never be valid JSON, so stripping the slash is
// always safe and strictly increases parseability.
export const repairJson = (s) => String(s || "").replace(/\\_/g, "_");

export function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    // Extract the first {...} span per line: models number ("1. {...}"),
    // bullet ("- {...}"), fence, or trail prose after the object.
    const m = line.match(/\{.*\}/);
    if (!m) continue;
    try {
      const v = JSON.parse(repairJson(m[0]));
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      continue; // truncated tail line: drop it, keep the rest
    }
  }
  return out;
}
