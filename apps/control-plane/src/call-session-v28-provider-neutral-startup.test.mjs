import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "call-session-v28.ts"), "utf8");

test("V28 does not own startup provider policy", () => {
  assert.equal(
    /\basync\s+fetch\s*\(/.test(source),
    false,
    "V28 must not reintroduce a /start fetch override",
  );
  assert.equal(
    /type:\s*["']session\.update["']/.test(source),
    false,
    "V28 must not emit provider-specific session policy wire",
  );
});
