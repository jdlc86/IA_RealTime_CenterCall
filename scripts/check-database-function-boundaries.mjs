import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");
export const manifestPath = resolve(repositoryRoot, "Security", "database-function-boundaries.json");
const migrationsDirectory = resolve(repositoryRoot, "supabase", "migrations");
const clientRoles = new Set(["public", "anon", "authenticated"]);

function fail(message) {
  throw new Error(`Database function boundary policy: ${message}`);
}

function normalizedRoleList(roles) {
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string" || !role)) {
    fail("role lists must contain non-empty strings");
  }
  return [...roles].sort((left, right) => left.localeCompare(right));
}

function sameValues(left, right) {
  return JSON.stringify(normalizedRoleList(left)) === JSON.stringify(normalizedRoleList(right));
}

function functionName(signature) {
  const match = /^([a-z][a-z0-9_]*)\s*\(/.exec(signature);
  if (!match) fail(`invalid function signature ${JSON.stringify(signature)}`);
  return match[1];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readMigrations(directory = migrationsDirectory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(directory, name), "utf8") }));
}

export function loadBoundaryManifest(path = manifestPath) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function discoverManagedFunctionNames(manifest, migrations = readMigrations()) {
  const activationIndex = migrations.findIndex(({ name }) => name === manifest.activationMigration);
  if (activationIndex === -1) fail(`missing activation migration ${manifest.activationMigration}`);

  const allNames = new Set();
  const activatedNames = new Set();
  const unqualified = [];
  const pattern = /create\s+(?:or\s+replace\s+)?function\s+(?:"?([a-z_][a-z0-9_]*)"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const [migrationIndex, { name: migrationName, sql }] of migrations.entries()) {
    for (const match of sql.matchAll(pattern)) {
      const schema = match[1];
      const name = match[2].toLowerCase();
      if (!schema) unqualified.push(`${migrationName}:${name}`);
      else if (schema.toLowerCase() === manifest.policy.schema) {
        allNames.add(name);
        if (migrationIndex >= activationIndex) activatedNames.add(name);
      }
    }
  }
  if (unqualified.length) fail(`function declarations must qualify their schema: ${unqualified.join(", ")}`);
  const legacyNames = new Set(manifest.legacyFunctionNames);
  return [...allNames]
    .filter((name) => activatedNames.has(name) || !legacyNames.has(name))
    .sort();
}

export function validateFunctionDeclaration(entry, profile, policy, sql) {
  const name = functionName(entry.signature);
  const qualifiedName = `${escapeRegExp(policy.schema)}\\.${escapeRegExp(name)}`;
  const headerPattern = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+${qualifiedName}\\s*\\([\\s\\S]*?\\)\\s*[\\s\\S]*?\\bas\\s+\\$[a-z0-9_]*\\$`,
    "i",
  );
  const header = sql.match(headerPattern)?.[0];
  if (!header) fail(`${entry.signature} is not declared by ${entry.migration}`);
  if (!/\bset\s+search_path\s*=\s*''/i.test(header)) {
    fail(`${entry.signature} must declare an empty search_path in its function header`);
  }

  const actualMode = /\bsecurity\s+definer\b/i.test(header) ? "definer" : "invoker";
  if (actualMode !== entry.securityMode || !profile.securityModes.includes(actualMode)) {
    fail(`${entry.signature} security mode does not match profile ${entry.profile}`);
  }
  if (actualMode === "definer" && !entry.justification?.trim()) {
    fail(`${entry.signature} requires a SECURITY DEFINER justification`);
  }

  const grantPattern = new RegExp(
    `grant\\s+execute\\s+on\\s+function\\s+${qualifiedName}\\s*\\([^;]*?\\)\\s+to\\s+([^;]+);`,
    "ig",
  );
  const grantedRoles = [...sql.matchAll(grantPattern)]
    .flatMap((match) => match[1].split(","))
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  if (!sameValues(grantedRoles, profile.executeRoles)) {
    fail(`${entry.signature} grants [${grantedRoles.join(", ")}] instead of profile ${entry.profile}`);
  }
  if (grantedRoles.some((role) => clientRoles.has(role)) && !entry.clientAuthorization?.trim()) {
    fail(`${entry.signature} requires a client authorization model`);
  }

  const revokePattern = new RegExp(
    `revoke\\s+execute\\s+on\\s+function\\s+${qualifiedName}\\s*\\([^;]*?\\)\\s+from\\s+([^;]+);`,
    "ig",
  );
  const revokedRoles = [...sql.matchAll(revokePattern)]
    .flatMap((match) => match[1].split(","))
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
  const requiredRevocations = [...policy.deniedByDefaultRoles, "service_role"];
  if (!sameValues(revokedRoles, requiredRevocations)) {
    fail(`${entry.signature} must revoke every managed role before its explicit grants`);
  }
}

export function validateBoundaryManifest(manifest, migrations = readMigrations()) {
  if (manifest?.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!manifest.activationMigration || typeof manifest.activationMigration !== "string") {
    fail("activationMigration is required");
  }
  if (!manifest.schemaDefaultsMigration || typeof manifest.schemaDefaultsMigration !== "string") {
    fail("schemaDefaultsMigration is required");
  }
  const policy = manifest.policy;
  if (!policy || policy.schema !== "public" || policy.ownerRole !== "postgres") {
    fail("the first policy version supports the postgres-owned public schema");
  }
  if (!sameValues(policy.deniedByDefaultRoles, ["public", "anon", "authenticated"])) {
    fail("deniedByDefaultRoles must be public, anon and authenticated");
  }
  if (!Array.isArray(policy.newFunctionSearchPath) || policy.newFunctionSearchPath.length !== 0) {
    fail("new functions must use an empty search path");
  }
  if (!policy.profiles || typeof policy.profiles !== "object") fail("profiles are required");
  if (!Array.isArray(manifest.legacyFunctionNames)) fail("legacyFunctionNames must be an array");
  if (!Array.isArray(manifest.functions)) fail("functions must be an array");

  const orderedLegacy = [...manifest.legacyFunctionNames].sort();
  if (new Set(manifest.legacyFunctionNames).size !== manifest.legacyFunctionNames.length ||
      JSON.stringify(orderedLegacy) !== JSON.stringify(manifest.legacyFunctionNames)) {
    fail("legacyFunctionNames must be unique and sorted");
  }

  const activation = migrations.find(({ name }) => name === manifest.activationMigration);
  if (!activation) fail(`missing activation migration ${manifest.activationMigration}`);
  const activationIndex = migrations.findIndex(({ name }) => name === manifest.activationMigration);
  const historicalNames = new Set();
  const historicalPattern = /create\s+(?:or\s+replace\s+)?function\s+public\."?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const { sql } of migrations.slice(0, activationIndex)) {
    for (const match of sql.matchAll(historicalPattern)) historicalNames.add(match[1].toLowerCase());
  }
  if (!sameValues(manifest.legacyFunctionNames, [...historicalNames])) {
    fail("legacyFunctionNames must exactly match the pre-activation repository baseline");
  }
  for (const expected of [
    /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+revoke\s+execute\s+on\s+functions\s+from\s+public/i,
    /alter\s+default\s+privileges\s+for\s+role\s+postgres\s+revoke\s+execute\s+on\s+functions\s+from\s+anon,\s*authenticated/i,
  ]) {
    if (!expected.test(activation.sql)) fail("activation migration must revoke default client execution");
  }

  const schemaDefaults = migrations.find(({ name }) => name === manifest.schemaDefaultsMigration);
  if (!schemaDefaults) fail(`missing schema defaults migration ${manifest.schemaDefaultsMigration}`);
  if (!/alter\s+default\s+privileges\s+for\s+role\s+postgres\s+in\s+schema\s+public\s+revoke\s+execute\s+on\s+functions\s+from\s+public,\s*anon,\s*authenticated,\s*service_role/i.test(schemaDefaults.sql)) {
    fail("schema defaults migration must revoke every managed role in public");
  }

  const knownRoles = new Set(["service_role", "authenticated", "anon"]);
  for (const [profileName, profile] of Object.entries(policy.profiles)) {
    normalizedRoleList(profile.executeRoles);
    if (!Array.isArray(profile.securityModes) || profile.securityModes.some((mode) => !["invoker", "definer"].includes(mode))) {
      fail(`${profileName} has invalid securityModes`);
    }
    if (profile.executeRoles.some((role) => !knownRoles.has(role))) fail(`${profileName} grants an unknown role`);
  }

  const migrationsByName = new Map(migrations.map((migration) => [migration.name, migration.sql]));
  const seenNames = new Set();
  let previousSignature = "";
  for (const entry of manifest.functions) {
    const name = functionName(entry.signature);
    if (seenNames.has(name)) fail(`overloaded or duplicate public function ${name} is not supported`);
    if (previousSignature && previousSignature > entry.signature) fail("functions must be sorted by signature");
    previousSignature = entry.signature;
    seenNames.add(name);
    if (!entry.businessCapability?.trim()) fail(`${entry.signature} requires a business capability owner`);
    const profile = policy.profiles[entry.profile];
    if (!profile) fail(`${entry.signature} references unknown profile ${entry.profile}`);
    const sql = migrationsByName.get(entry.migration);
    if (!sql) {
      fail(`${entry.signature} references a missing migration`);
    }
    validateFunctionDeclaration(entry, profile, policy, sql);
  }

  const discoveredNames = discoverManagedFunctionNames(manifest, migrations);
  const missing = discoveredNames.filter((name) => !seenNames.has(name));
  const stale = [...seenNames].filter((name) => !discoveredNames.includes(name));
  if (missing.length || stale.length) {
    fail(`manifest drift; missing=[${missing.join(", ")}], stale=[${stale.join(", ")}]`);
  }
  return manifest;
}

export function checkRepositoryBoundaryPolicy() {
  const manifest = validateBoundaryManifest(loadBoundaryManifest());
  return {
    managedFunctions: manifest.functions.length,
    profiles: Object.keys(manifest.policy.profiles).length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkRepositoryBoundaryPolicy();
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
