import assert from "node:assert/strict";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const baseUrl = option("url") ?? process.env.E2E_BASE_URL;
const expectedEnvironment = option("environment") ?? process.env.E2E_EXPECTED_ENVIRONMENT;
const expectedVersionId = option("version-id") ?? process.env.E2E_EXPECTED_VERSION_ID;

assert.ok(baseUrl, "Provide --url or E2E_BASE_URL");
assert.ok(expectedEnvironment, "Provide --environment or E2E_EXPECTED_ENVIRONMENT");

const healthUrl = new URL("/health", baseUrl);
const response = await fetch(healthUrl, {
  method: "GET",
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});

assert.equal(response.status, 200, `health returned HTTP ${response.status}`);
assert.match(
  response.headers.get("content-type") ?? "",
  /application\/json/i,
  "health did not return JSON",
);
const body = await response.json();

assert.equal(body.ok, true);
assert.equal(body.service, "IA_RealTime_CenterCall");
assert.equal(body.environment, expectedEnvironment);
assert.equal(body.runtime_config?.tenant_config_binding, true);
assert.equal(body.runtime_config?.call_sessions_binding, true);
assert.match(body.worker_version?.id ?? "", /^[0-9a-f-]{36}$/i);
assert.match(body.worker_version?.timestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
if (expectedVersionId) assert.equal(body.worker_version.id, expectedVersionId);

console.log(JSON.stringify({
  ok: true,
  url: healthUrl.href,
  environment: body.environment,
  phase: body.phase,
  worker_version: body.worker_version,
}));
