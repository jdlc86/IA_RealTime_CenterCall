import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const projectRoot = new URL("../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("wrangler.jsonc", projectRoot), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("package.json", projectRoot), "utf8"));

function assertBindings(environment) {
  assert.deepEqual(environment.kv_namespaces, [{ binding: "TENANT_CONFIG" }]);
  assert.deepEqual(environment.durable_objects, {
    bindings: [{ name: "CALL_SESSIONS", class_name: "CallSession" }],
  });
  assert.deepEqual(environment.version_metadata, { binding: "CF_VERSION_METADATA" });
  assert.deepEqual(environment.exports, {
    CallSession: { type: "durable-object", storage: "sqlite" },
  });
}

test("default Wrangler profile is the existing production Worker", () => {
  assert.equal(config.name, "ia-realtime-centercall");
  assert.equal(config.vars.ENVIRONMENT, "production");
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, true);
  assertBindings(config);
});

test("preview and dev profiles use isolated Worker names and explicit non-inherited bindings", () => {
  assert.equal(config.env.preview.name, "ia-realtime-centercall-preview");
  assert.equal(config.env.preview.vars.ENVIRONMENT, "preview");
  assert.equal(config.env.preview.preview_urls, true);
  assertBindings(config.env.preview);

  assert.equal(config.env.dev.name, "ia-realtime-centercall-dev");
  assert.equal(config.env.dev.vars.ENVIRONMENT, "dev");
  assert.equal(config.env.dev.preview_urls, false);
  assertBindings(config.env.dev);

  assert.notEqual(config.env.preview.name, config.name);
  assert.notEqual(config.env.dev.name, config.name);
  assert.notEqual(config.env.preview.name, config.env.dev.name);
});

test("CI check dry-runs every declared Wrangler profile", () => {
  assert.equal(
    packageJson.scripts.check,
    "npm run check:production && npm run check:preview && npm run check:dev",
  );
  assert.equal(packageJson.scripts["check:production"], "wrangler deploy --dry-run --env=\"\"");
  assert.equal(packageJson.scripts["check:preview"], "wrangler deploy --dry-run --env preview");
  assert.equal(packageJson.scripts["check:dev"], "wrangler deploy --dry-run --env dev");
  assert.equal(packageJson.scripts["upload:production"], "wrangler versions upload --env=\"\"");
  assert.equal(packageJson.scripts["upload:preview"], "wrangler versions upload --env preview");
  assert.equal(packageJson.scripts["upload:dev"], "wrangler versions upload --env dev");
  assert.equal(packageJson.scripts["test:e2e:health"], "node scripts/verify-health.mjs");

  const verifier = readFileSync(new URL("scripts/verify-health.mjs", projectRoot), "utf8");
  assert.match(verifier, /body\.runtime_config\?\.tenant_config_binding/);
  assert.match(verifier, /body\.runtime_config\?\.call_sessions_binding/);
  assert.match(verifier, /body\.worker_version\?\.id/);
  assert.ok(
    verifier.indexOf("assert.equal(response.status") < verifier.indexOf("await response.json()"),
    "the E2E verifier must reject HTTP errors before parsing the body",
  );
});
