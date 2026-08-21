import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function callSessionFiles() {
  return readdirSync(here).filter(
    (name) => /^call-session-v(?:[2-9]|[12]\d|3\d|4\d|5[0-4])(?:-|\.)/.test(name) && name.endsWith(".ts"),
  );
}

const forbidden = [
  ["concrete persistence provider", /\b(?:SupabaseAdapter|SupabaseMarketingConsentStore|CallerSecurityService|HumanHandoffStore)\b/],
  ["Supabase credentials", /\bSUPABASE_(?:URL|SECRET_KEY)\b/],
  ["PostgREST wire path", /\/rest\/v1\//],
];

test("V2-V54 CallSession layers consume persistence only through neutral capability ports", () => {
  const violations = [];
  for (const file of callSessionFiles()) {
    const source = readFileSync(join(here, file), "utf8");
    for (const [label, pattern] of forbidden) {
      if (pattern.test(source)) violations.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(violations, [], `persistence provider leakage is forbidden:\n${violations.join("\n")}`);
});

test("persistence boundary guard covers credential, adapter and REST regressions", () => {
  const samples = [
    "new SupabaseAdapter(env)",
    "const key = env.SUPABASE_SECRET_KEY",
    "https://project.supabase.co/rest/v1/rpc/example",
  ];
  for (const sample of samples) {
    assert.equal(forbidden.some(([, pattern]) => pattern.test(sample)), true, sample);
  }
});
