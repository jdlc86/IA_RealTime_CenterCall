import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const failures = [];

const canonicalDocuments = [
  "docs/README.md",
  "docs/MASTER_PROJECT_GUIDE.md",
  "docs/SESSION_HANDOFF.md",
  "docs/PROJECT_STATUS.md",
  "docs/DOCUMENTATION_MAINTENANCE.md",
  "docs/SYSTEM_OVERVIEW.md",
  "docs/architecture/DESIGN_RULES.md",
  "docs/architecture/SYSTEM_ARCHITECTURE.md",
];

function absolute(relativePath) {
  return resolve(repositoryRoot, relativePath);
}

function read(relativePath) {
  const path = absolute(relativePath);
  if (!existsSync(path)) {
    failures.push(`${relativePath}: missing canonical document`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function requireText(relativePath, content, expected) {
  if (!content.includes(expected)) failures.push(`${relativePath}: missing ${JSON.stringify(expected)}`);
}

function validateLocalLinks(relativePath, content) {
  const sourceDirectory = dirname(absolute(relativePath));
  const markdownLink = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(markdownLink)) {
    let target = match[1].trim();
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split("#", 1)[0];
    if (!target) continue;
    if (!existsSync(resolve(sourceDirectory, decodeURIComponent(target)))) {
      failures.push(`${relativePath}: broken local link ${match[1]}`);
    }
  }
}

const documents = new Map(canonicalDocuments.map((path) => [path, read(path)]));
for (const [path, content] of documents) validateLocalLinks(path, content);

for (const entry of ["docs/README.md", "docs/MASTER_PROJECT_GUIDE.md"]) {
  requireText(entry, documents.get(entry), "SESSION_HANDOFF.md");
  requireText(entry, documents.get(entry), "PROJECT_STATUS.md");
  requireText(entry, documents.get(entry), "DOCUMENTATION_MAINTENANCE.md");
}

const handoff = documents.get("docs/SESSION_HANDOFF.md");
for (const required of [
  "## INICIO DEL PROMPT",
  "## FIN DEL PROMPT",
  "rebuild/v39-stable-baseline",
  "PR #85",
  "### 3. Reglas arquitectónicas que no puedes violar",
  "### 6. Primera misión",
  "npm run docs:check",
  "npm test",
  "npm run check",
  "IMPLEMENTADO ≠ CI VERDE ≠ DESPLEGADO ≠ VALIDADO E2E",
]) requireText("docs/SESSION_HANDOFF.md", handoff, required);

const status = documents.get("docs/PROJECT_STATUS.md");
for (const required of ["Implementado", "CI", "Producción", "E2E", "Siguiente validación"]) {
  requireText("docs/PROJECT_STATUS.md", status, required);
}

const rules = documents.get("docs/architecture/DESIGN_RULES.md");
for (const required of ["RA-021", "RA-026", "RA-028", "RA-035"]) {
  requireText("docs/architecture/DESIGN_RULES.md", rules, required);
}

const packageJson = JSON.parse(readFileSync(absolute("apps/control-plane/package.json"), "utf8"));
assert.equal(packageJson.scripts?.["docs:check"], "node scripts/check-documentation.mjs");
if (!packageJson.scripts?.pretest?.includes("npm run docs:check")) {
  failures.push("apps/control-plane/package.json: pretest must run docs:check");
}

const workflow = readFileSync(absolute(".github/workflows/control-plane-ci.yml"), "utf8");
if (!workflow.includes('"docs/**"')) failures.push("control-plane-ci.yml: docs/** must trigger CI");

if (failures.length) {
  console.error("Documentation contract failed:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, canonical_documents: canonicalDocuments.length }));
}
