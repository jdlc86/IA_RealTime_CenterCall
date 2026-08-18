import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = async (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

test("hangup controller prefers the physical Telnyx source leg when available", async () => {
  const controller = await source("hangup-controller.ts");
  const v22 = await source("call-session-v22.ts");

  assert.match(controller, /getSourceCallControlId\?\(\): string \| null/);
  assert.match(controller, /getTelnyxApiKey\?\(\): string/);
  assert.match(controller, /TELNYX_SOURCE_LEG/);
  assert.match(controller, /OPENAI_REALTIME_FALLBACK/);
  assert.match(controller, /api\.telnyx\.com\/v2\/calls\/\$\{encodeURIComponent\(sourceCallControlId\)\}\/actions\/hangup/);
  assert.match(controller, /if \(sourceCallControlId && this\.host\.getTelnyxApiKey\)/);
  assert.match(v22, /session\.telnyxCallControlIdV37/);
  assert.match(v22, /getTelnyxApiKey: \(\) => session\.env\?\.TELNYX_API_KEY/);
});
