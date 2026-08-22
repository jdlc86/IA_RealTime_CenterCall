import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sourceDirectory = new URL("./", import.meta.url);
const ACTIVE_ROOT = "call-session-v54-close-confirmation-authority";
const MAX_ACTIVE_CALL_SESSION_CLASSES = 49;

function activeInheritancePath() {
  const path = [];
  const seen = new Set();
  let current = ACTIVE_ROOT;

  while (current) {
    assert.equal(seen.has(current), false, `CallSession inheritance cycle at ${current}`);
    seen.add(current);
    path.push(current);
    const source = readFileSync(new URL(`./${current}.ts`, sourceDirectory), "utf8");
    const parent = source.match(/import\s*\{\s*CallSession\s+as\s+\w+\s*\}\s*from\s*"\.\/(call-session-v[^"]+)"/);
    current = parent?.[1] ?? "";
  }

  return path;
}

test("active CallSession inheritance contains no behaviorless compatibility layer", () => {
  const path = activeInheritancePath();
  const emptyLayers = path.filter((name) => {
    const source = readFileSync(new URL(`./${name}.ts`, sourceDirectory), "utf8");
    return /export\s+class\s+CallSession\s+extends\s+BaseConstructor\s*\{\s*\}/.test(source);
  });

  assert.deepEqual(emptyLayers, []);
  assert.equal(path.at(-1), "call-session-v2");
  assert.equal(path.includes("call-session-v20"), false);
  assert.equal(path.includes("call-session-v47"), false);
  assert.equal(path.includes("call-session-v52"), false);
  assert.ok(
    path.length <= MAX_ACTIVE_CALL_SESSION_CLASSES,
    `active inheritance grew to ${path.length} classes; compose capabilities instead of adding a layer`,
  );
});
