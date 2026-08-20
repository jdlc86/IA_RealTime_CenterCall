import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

function versionFromFile(name) {
  const match = name.match(/^call-session-v(\d+)(?:-|\.)/);
  return match ? Number(match[1]) : null;
}

function crossVersionStateReferences(source) {
  const refs = [];
  const pattern = /\b([A-Za-z_$][\w$]*V(\d+))\b/g;
  for (const match of source.matchAll(pattern)) {
    refs.push({ symbol: match[1], version: Number(match[2]) });
  }
  return refs;
}

test("active consolidation layers do not read private state owned by another CallSession generation", () => {
  const files = readdirSync(here).filter((name) => /^call-session-v(?:3[6-9]|4\d|5[0-4])(?:-|\.)/.test(name) && name.endsWith(".ts"));
  const violations = [];

  for (const file of files) {
    const ownVersion = versionFromFile(file);
    if (ownVersion == null) continue;
    const source = readFileSync(join(here, file), "utf8");
    for (const ref of crossVersionStateReferences(source)) {
      if (ref.version === ownVersion) continue;
      // Import/type names are allowed. Cross-generation instance state access is not.
      const stateAccess = new RegExp(`(?:this|session|self|\\(this as any\\))\\.${ref.symbol}\\b`);
      if (stateAccess.test(source)) violations.push(`${file}: ${ref.symbol}`);
    }
  }

  assert.deepEqual(violations, [], `cross-generation private state access is forbidden:\n${violations.join("\n")}`);
});

test("no CallSession generation may be added beyond v54", () => {
  const forbidden = readdirSync(here).filter((name) => /^call-session-v(?:5[5-9]|[6-9]\d|\d{3,})/.test(name));
  assert.deepEqual(forbidden, []);
});
