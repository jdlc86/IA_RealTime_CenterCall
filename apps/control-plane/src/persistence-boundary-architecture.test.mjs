import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const controllerFiles = ["call-session-v23.ts", "call-session-v24.ts", "call-session-v31.ts"];
const forbidden = [
  ["concrete Supabase provider", /\bSupabase(?:Adapter|MarketingConsentStore)\b/],
  ["Supabase credentials", /\bSUPABASE_(?:URL|SECRET_KEY)\b/],
  ["PostgREST wire path", /\/rest\/v1\//],
  ["direct persistence fetch", /\bfetch\s*\(/],
];

test("restaurant controllers consume persistence only through neutral capability ports", () => {
  const violations = [];
  for (const file of controllerFiles) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(violations, [], `persistence provider leakage is forbidden:\n${violations.join("\n")}`);
});

test("persistence boundary guard covers credential, adapter, REST and fetch regressions", () => {
  const samples = [
    "new SupabaseAdapter(env)",
    "const key = env.SUPABASE_SECRET_KEY",
    "https://project.supabase.co/rest/v1/rpc/example",
    "fetch(endpoint)",
  ];
  for (const sample of samples) {
    assert.equal(forbidden.some(([, pattern]) => pattern.test(sample)), true, sample);
  }
});
