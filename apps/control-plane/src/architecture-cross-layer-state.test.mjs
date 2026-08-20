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

function hasCrossGenerationInstanceAccess(source, symbol) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const directReceiver = "(?:this|session|self|\\(this as any\\))";
  const prototypeReceiver = "(?:[A-Za-z_$][\\w$]*Prototype)";
  return new RegExp(`(?:${directReceiver}|${prototypeReceiver})(?:\\?|)\\.${escaped}\\b`).test(source);
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
      // Imports/types are allowed. Instance and inherited-prototype access are not.
      if (hasCrossGenerationInstanceAccess(source, ref.symbol)) violations.push(`${file}: ${ref.symbol}`);
    }
  }

  assert.deepEqual(violations, [], `cross-generation private state access is forbidden:\n${violations.join("\n")}`);
});

test("cross-layer guard catches inherited prototype bypasses", () => {
  assert.equal(
    hasCrossGenerationInstanceAccess("BasePrototype.authorizePublicRestaurantToolV29.call(this, event)", "authorizePublicRestaurantToolV29"),
    true,
  );
  assert.equal(
    hasCrossGenerationInstanceAccess("session.releaseSemanticGateV29?.('tool')", "releaseSemanticGateV29"),
    true,
  );
});

test("no CallSession generation may be added beyond v54", () => {
  const forbidden = readdirSync(here).filter((name) => /^call-session-v(?:5[5-9]|[6-9]\d|\d{3,})/.test(name));
  assert.deepEqual(forbidden, []);
});
