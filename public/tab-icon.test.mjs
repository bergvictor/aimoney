// Tab-icon regression test: every served page links the SVG favicon.
// Run: npm test (node --test, no framework)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Served root is public/ (wrangler.toml pages_build_output_dir); this test
// lives next to the files it guards so it follows them if they move.
const ROOT = dirname(fileURLToPath(import.meta.url));

function servedHtmlFiles() {
  return readdirSync(ROOT).filter((f) => f.endsWith(".html")).sort();
}

// Minimal well-formedness check (no XML deps): balanced tags, single root.
function assertWellFormedXml(text, label) {
  const tags = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][\w:.-]*)[^<>]*?(\/?)>/g;
  let m;
  let root = null;
  let rootCount = 0;
  while ((m = re.exec(text)) !== null) {
    if (m[0].startsWith("<!--") || m[0].startsWith("<?")) continue;
    const [full, closing, name, selfClosing] = m;
    if (full.startsWith("</")) {
      assert.equal(tags.pop(), name, `${label}: unbalanced closing </${name}>`);
    } else if (selfClosing === "/" || full.endsWith("/>")) {
      if (tags.length === 0) {
        rootCount += 1;
        root = root ?? name;
      }
    } else {
      if (tags.length === 0) {
        rootCount += 1;
        root = root ?? name;
      }
      tags.push(name);
    }
    void closing;
  }
  assert.deepEqual(tags, [], `${label}: unclosed tags: ${tags.join(", ")}`);
  assert.equal(rootCount, 1, `${label}: expected a single root element`);
  return root;
}

describe("tab icon", () => {
  it("favicon.svg exists at the served root and is under 2 KB", () => {
    const size = statSync(join(ROOT, "favicon.svg")).size;
    assert.ok(size > 0, "favicon.svg is empty");
    assert.ok(size < 2048, `favicon.svg is ${size} bytes, must stay under 2 KB`);
  });

  it("favicon.svg parses as XML with an <svg> root", () => {
    const text = readFileSync(join(ROOT, "favicon.svg"), "utf8");
    const root = assertWellFormedXml(text, "favicon.svg");
    assert.equal(root, "svg", "favicon.svg root element must be <svg>");
    assert.ok(text.includes('viewBox="0 0 32 32"'), "favicon.svg must use viewBox 0 0 32 32");
  });

  it("every served HTML page links /favicon.svg and sets theme-color", () => {
    const files = servedHtmlFiles();
    assert.ok(files.length > 0, "expected at least one served *.html");
    for (const f of files) {
      const html = readFileSync(join(ROOT, f), "utf8");
      assert.ok(
        html.includes('rel="icon"') && html.includes('href="/favicon.svg"'),
        `${f}: missing <link rel="icon" ... href="/favicon.svg">`
      );
      assert.ok(
        html.includes('name="theme-color"'),
        `${f}: missing <meta name="theme-color">`
      );
    }
  });
});
