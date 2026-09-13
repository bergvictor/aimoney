// AIMoney shared pure helpers (worker). Imported by src/index.js so the
// scoring/triage math is unit-testable without Workers bindings.

export const clamp10 = (v, d = 5) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : d;
};

export const slugify = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80);

// Priority score. MUST match functions/api/[[path]].js scoreOf and the README:
//   score = 100 * (value * confidence * fit) / (effort + 1)
export const scoreOf = (o) =>
  Math.round(100 * ((o.value * o.confidence * o.fit) / (o.effort + 1)) * 10) / 10;

// The triage model is instructed to reply with ONLY a JSON array, but models
// wrap output in prose anyway — extract the first [...] block, [] on failure.
export function parseJsonArray(text) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
