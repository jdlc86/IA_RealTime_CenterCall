import assert from "node:assert/strict";
import test from "node:test";

import {
  checkRepositoryBoundaryPolicy,
  loadBoundaryManifest,
  validateBoundaryManifest,
  validateFunctionDeclaration,
} from "./check-database-function-boundaries.mjs";

test("horizontal policy activates secure defaults without rechecking legacy verticals", () => {
  assert.deepEqual(checkRepositoryBoundaryPolicy(), { managedFunctions: 0, profiles: 5 });
});

test("a future function must declare a fixed path and the exact profile grant", () => {
  const manifest = loadBoundaryManifest();
  const profile = manifest.policy.profiles.internal_server;
  const entry = {
    signature: "perform_business_action(text)",
    profile: "internal_server",
    securityMode: "invoker",
    businessCapability: "example-vertical",
  };
  const validSql = `
    create or replace function public.perform_business_action(p_tenant_id text)
    returns void language sql security invoker set search_path = ''
    as $$ select null $$;
    revoke execute on function public.perform_business_action(text)
      from public, anon, authenticated, service_role;
    grant execute on function public.perform_business_action(text) to service_role;
  `;
  assert.doesNotThrow(() => validateFunctionDeclaration(entry, profile, manifest.policy, validSql));
  assert.throws(
    () => validateFunctionDeclaration(entry, profile, manifest.policy, validSql.replace(" set search_path = ''", "")),
    /empty search_path/,
  );
  assert.throws(
    () => validateFunctionDeclaration(entry, profile, manifest.policy, validSql.replace("to service_role", "to authenticated")),
    /instead of profile/,
  );
  assert.throws(
    () => validateFunctionDeclaration(entry, profile, manifest.policy, validSql.replace(/revoke[\s\S]*?service_role;\s*/, "")),
    /must revoke every managed role/,
  );
});

test("manifest changes fail closed when activation policy drifts", () => {
  const manifest = loadBoundaryManifest();
  const unsafe = structuredClone(manifest);
  unsafe.policy.deniedByDefaultRoles = ["public"];
  assert.throws(() => validateBoundaryManifest(unsafe), /deniedByDefaultRoles/);

  const forgottenLegacy = structuredClone(manifest);
  forgottenLegacy.legacyFunctionNames.pop();
  assert.throws(() => validateBoundaryManifest(forgottenLegacy), /pre-activation repository baseline/);
});
