// Copies the version from package.json to the plugin manifest and src/version.ts.
// Runs as npm's `version` hook, so `npm version patch --no-git-tag-version`
// updates all places at once (npm itself updates package.json and the lockfile).
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const { version } = JSON.parse(read("package.json"));

function replace(path, pattern, value) {
  const text = read(path);
  if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
  writeFileSync(new URL(path, root), text.replace(pattern, value));
}

replace("plugin/.claude-plugin/plugin.json", /"version": "[^"]*"/, `"version": "${version}"`);
replace("src/version.ts", /VERSION = "[^"]*"/, `VERSION = "${version}"`);
console.log(`Version ${version} in package.json, package-lock.json, plugin.json and src/version.ts`);
