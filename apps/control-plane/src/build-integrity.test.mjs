import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, projectRoot), "utf8"));
}

test("test gate generates bindings and typechecks the complete active TypeScript graph", async () => {
  const packageJson = await readJson("package.json");
  const scripts = packageJson.scripts ?? {};
  const testBuild = scripts["test:build"] ?? "";

  assert.match(scripts.types, /^wrangler types --include-runtime=false$/);
  assert.match(scripts.typecheck, /tsc -p tsconfig\.json --noEmit/);
  assert.match(testBuild, /tsc -p tsconfig\.test-build\.json/);
  assert.match(scripts.pretest, /npm run types && npm run typecheck && npm run test:build/);
  assert.doesNotMatch(testBuild, /tsc\s+src\//);
  assert.doesNotMatch(testBuild, /rm -rf/);
});

test("typecheck consumes official Workers runtime types and generated bindings", async () => {
  const tsconfig = await readJson("tsconfig.json");

  assert.deepEqual(tsconfig.compilerOptions?.types, ["@cloudflare/workers-types"]);
  assert.ok(tsconfig.include?.includes("worker-configuration.d.ts"));
  assert.equal(typeof (await readJson("package.json")).devDependencies?.["@cloudflare/workers-types"], "string");
});

test("CI installs the committed lockfile reproducibly", async () => {
  const packageJson = await readJson("package.json");
  const nodeVersion = (await readFile(new URL(".node-version", projectRoot), "utf8")).trim();
  const workflow = await readFile(new URL("../../.github/workflows/control-plane-ci.yml", projectRoot), "utf8");

  assert.equal(nodeVersion, "24.18.0");
  assert.equal(packageJson.packageManager, "npm@10.9.2");
  assert.match(workflow, /node-version-file: apps\/control-plane\/\.node-version/);
  assert.match(
    workflow,
    /run: npx --yes npm@10\.9\.2 clean-install --progress=false --no-audit --no-fund/,
  );
  assert.doesNotMatch(workflow, /run: npm install(?:\s|$)/);
});
