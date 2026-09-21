import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const documentationDirectories = ["backend", "cloudflare", "contracts", "epics", "tests"];

async function documentationFiles() {
  const topLevel = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(root, entry.name));
  const nested = await Promise.all(documentationDirectories.map(async (directory) =>
    (await readdir(path.join(root, directory), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(root, directory, entry.name))));
  return [...topLevel, ...nested.flat()];
}

test("documented npm scripts exist in package.json", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const file of await documentationFiles()) {
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)) {
      assert.ok(packageJson.scripts[match[1]], `${path.relative(root, file)} references missing npm script ${match[1]}`);
    }
  }
});

test("local Markdown links point to existing files", async () => {
  for (const file of await documentationFiles()) {
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim();
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      target = target.split("#", 1)[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      await assert.doesNotReject(access(resolved), `${path.relative(root, file)} links to missing ${target}`);
    }
  }
});
