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

function activeCallSessionFiles() {
  return readdirSync(here).filter(
    (name) => /^call-session-v(?:[2-9]|[12]\d|3\d|4\d|5[0-4])(?:-|\.)/.test(name) && name.endsWith(".ts"),
  );
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

function hasDirectBeginClosing(source) {
  const receiver = "(?:this|session|self|\\(this as any\\)|[A-Za-z_$][\\w$]*Prototype)";
  return new RegExp(`${receiver}(?:\\?|)\\.beginClosing\\b`).test(source);
}

test("active V2-V54 layers do not read private state owned by another CallSession generation", () => {
  const violations = new Set();

  for (const file of activeCallSessionFiles()) {
    const ownVersion = versionFromFile(file);
    if (ownVersion == null) continue;
    const source = readFileSync(join(here, file), "utf8");
    for (const ref of crossVersionStateReferences(source)) {
      if (ref.version === ownVersion) continue;
      // Imports/types are allowed. Instance and inherited-prototype access are not.
      if (hasCrossGenerationInstanceAccess(source, ref.symbol)) violations.add(`${file}: ${ref.symbol}`);
    }
  }

  assert.deepEqual([...violations], [], `cross-generation private state access is forbidden:\n${[...violations].join("\n")}`);
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

test("active layers commit terminal closure through lifecycle authority after the legacy owner boundary", () => {
  const compatibilityOwners = new Set(["call-session-v2.ts", "call-session-v18.ts"]);
  const violations = [];
  for (const file of activeCallSessionFiles()) {
    const source = readFileSync(join(here, file), "utf8");
    if (!compatibilityOwners.has(file) && hasDirectBeginClosing(source)) violations.push(file);
  }
  assert.deepEqual(violations, [], `direct beginClosing bypass is forbidden:\n${violations.join("\n")}`);
});

test("terminal closure guard catches direct compatibility bypasses", () => {
  assert.equal(hasDirectBeginClosing("(this as any).beginClosing?.('reason', 'source')"), true);
  assert.equal(hasDirectBeginClosing("session.beginClosing('reason', 'source')"), true);
  assert.equal(hasDirectBeginClosing("BasePrototype.beginClosing.call(this, 'reason', 'source')"), true);
});

test("no CallSession generation may be added beyond v54", () => {
  const forbidden = readdirSync(here).filter((name) => /^call-session-v(?:5[5-9]|[6-9]\d|\d{3,})/.test(name));
  assert.deepEqual(forbidden, []);
});
