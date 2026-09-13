import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function discoverTests(directory, extension, namePattern, requiredFiles = []) {
  const discovered = readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        return discoverTests(absolutePath, extension, namePattern);
      }
      return entry.name.endsWith(extension) && namePattern.test(entry.name)
        ? [absolutePath]
        : [];
    });

  return [...new Set([...discovered, ...requiredFiles.map((file) => join(directory, file))])]
    .sort((left, right) => left.localeCompare(right));
}
const mediaEdgeRoot = join(repositoryRoot, "apps", "gemini-media-edge");
const controlPlaneRoot = join(repositoryRoot, "apps", "gemini-control-plane");

const suites = Object.freeze({
  "media-edge": Object.freeze({
    root: mediaEdgeRoot,
    files: discoverTests(
      join(mediaEdgeRoot, "src"),
      ".test.mjs",
      /(security|authorization|credential|bootstrap|handoff|transfer|diagnostic)/i,
      [
        "fast-audio-bridge.test.mjs",
        "fast-runtime.test.mjs",
        "fast-tool-executor.test.mjs",
        "server-fast.test.mjs",
      ],
    ),
    command(files) {
      return [process.execPath, ["--test", ...files.map((file) => relative(mediaEdgeRoot, file))]];
    },
  }),
  "control-plane": Object.freeze({
    root: controlPlaneRoot,
    files: discoverTests(
      join(controlPlaneRoot, "src"),
      ".test.ts",
      /(security|admission|identity|tenant|handoff|transfer|diagnostic|preflight|call-control|canary-route|bootstrap)/i,
    ),
    command(files) {
      return [
        process.execPath,
        [join(controlPlaneRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...files.map((file) => relative(controlPlaneRoot, file))],
      ];
    },
  }),
});

function parseRequestedScopes(arguments_) {
  const scopeIndex = arguments_.indexOf("--scope");
  if (scopeIndex === -1) return Object.keys(suites);
  const scope = arguments_[scopeIndex + 1];
  if (!scope || !Object.hasOwn(suites, scope)) {
    throw new Error(`Unknown security regression scope: ${scope ?? "<missing>"}`);
  }
  return [scope];
}

for (const scope of parseRequestedScopes(process.argv.slice(2))) {
  const suite = suites[scope];
  if (suite.files.length === 0) throw new Error(`No security regression tests discovered for ${scope}`);
  const missing = suite.files.filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Security regression manifest references missing files:\n${missing.join("\n")}`);
  }

  console.log(`\n[security-regression] ${scope}: ${suite.files.length} files`);
  for (const file of suite.files) console.log(`  - ${relative(repositoryRoot, file)}`);

  const [command, args] = suite.command(suite.files);
  const result = spawnSync(command, args, { cwd: suite.root, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
