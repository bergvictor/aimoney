// Board-widget regression test: the decisions chip (round2 Task 1) and the
// API-failure banner (round2 Task 3) stay wired — markup in index.html,
// render logic in app.js, light-only styles in styles.css.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(ROOT, "index.html"), "utf8");
const js = readFileSync(join(ROOT, "app.js"), "utf8");
const css = readFileSync(join(ROOT, "styles.css"), "utf8");

describe("decisions chip", () => {
  it("experiments toolbar carries a decisions chip element", () => {
    assert.ok(html.includes('id="decisions-chip"'), "index.html lost #decisions-chip");
  });

  it("dashboard renders the chip from /api/health decisions_7d", () => {
    assert.ok(js.includes("decisions_7d"), "app.js no longer reads decisions_7d");
    assert.ok(js.includes("#decisions-chip"), "app.js no longer renders #decisions-chip");
    assert.ok(
      js.includes("decision") && js.includes("this week"),
      "chip copy lost 'N decisions this week'"
    );
  });
});

describe("api failure banner", () => {
  it("board has one alert banner element, hidden by default", () => {
    assert.ok(html.includes('id="api-banner"'), "index.html lost #api-banner");
    assert.ok(html.includes('role="alert"'), "banner lost role=alert");
    assert.ok(
      html.includes('id="api-banner" class="api-banner hidden"'),
      "banner must start hidden"
    );
  });

  it("dashboard names failed sections instead of silent empty states", () => {
    assert.ok(js.includes("renderApiBanner"), "app.js lost renderApiBanner");
    assert.ok(js.includes("API unreachable"), "banner copy lost 'API unreachable'");
    for (const section of ["opportunities", "experiments", "runs", "health", "meta", "review queue"]) {
      assert.ok(
        js.includes(`failed.push("${section}")`),
        `app.js no longer reports failed ${section}`
      );
    }
  });

  it("banner and chip styles stay in the light palette", () => {
    assert.ok(css.includes(".api-banner"), "styles.css lost .api-banner");
    assert.ok(css.includes(".exp-summary-wrap"), "styles.css lost .exp-summary-wrap");
  });
});
