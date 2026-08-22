import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const v33 = await readFile(new URL("./call-session-v33.ts", import.meta.url), "utf8");
const v34 = await readFile(new URL("./call-session-v34.ts", import.meta.url), "utf8");

test("v33 and v34 consume provider-neutral caller transcript events", () => {
  for (const source of [v33, v34]) {
    assert.match(source, /adaptRealtimeProviderEvents/);
    assert.match(source, /CALLER_TRANSCRIPT_COMPLETED/);
    assert.match(source, /conversationLifecyclePortFor/);
    assert.doesNotMatch(source, /conversation\.item\.input_audio_transcription\.completed/);
    assert.doesNotMatch(source, /readRealtimeText/);
    assert.doesNotMatch(source, /parseEvent/);
    assert.doesNotMatch(source, /TextDecoder/);
  }

  assert.match(v33, /inspectCallerTranscript/);
  assert.match(v34, /matchBlockedSecurityPhrase/);
  for (const source of [v33, v34]) {
    assert.match(source, /callerSecurityPortFor\(this\)/);
    assert.doesNotMatch(source, /CallerSecurityService/);
    assert.doesNotMatch(source, /SUPABASE_(?:URL|SECRET_KEY)/);
  }
});

test("v34 consumes the centrally validated tenant security policy", () => {
  assert.match(v34, /new KvTenantRepository\(kv\)\.getTenantConfiguration/);
  assert.match(v34, /config\?\.security\?\.blockedPhrases/);
  assert.doesNotMatch(v34, /JSON\.parse\(raw\)/);
  assert.doesNotMatch(v34, /parseTenantBlockedPhrases/);
});
