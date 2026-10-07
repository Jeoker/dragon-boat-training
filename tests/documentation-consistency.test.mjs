import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const documentationDirectories = ["backend", "cloudflare", "contracts", "epics", "tests"];
const generatedDirectories = new Set(["node_modules", "dist", "coverage"]);

// The repository uses ATX headings. Ignore fenced examples and retain duplicate
// heading suffixes so an existing file alone cannot hide a broken fragment link.
function headingAnchors(markdown) {
  const anchors = new Set();
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const slug = heading[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "").replace(/ /g, "-");
    let anchor = slug;
    for (let suffix = 1; anchors.has(anchor); suffix++) anchor = `${slug}-${suffix}`;
    anchors.add(anchor);
  }
  return anchors;
}

async function documentationFiles() {
  const topLevel = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(root, entry.name));
  async function walk(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Dirent checks do not follow symlinks/junctions. Hidden directories include
      // private state and Wrangler output; generated/vendor trees are not docs.
      if (entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(filename);
      else if (entry.isDirectory() && !entry.name.startsWith(".") && !generatedDirectories.has(entry.name)) {
        files.push(...await walk(filename));
      }
    }
    return files;
  }
  const nested = await Promise.all(documentationDirectories.map((directory) => walk(path.join(root, directory))));
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

test("local Markdown links point to existing files and heading anchors", async () => {
  const headings = new Map();
  for (const file of await documentationFiles()) {
    const markdown = await readFile(file, "utf8");
    for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      let target = match[1].trim();
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      const [filename, fragment] = target.split("#", 2);
      const resolved = filename ? path.resolve(path.dirname(file), decodeURIComponent(filename)) : file;
      await assert.doesNotReject(access(resolved), `${path.relative(root, file)} links to missing ${target}`);
      if (fragment && resolved.endsWith(".md")) {
        if (!headings.has(resolved)) headings.set(resolved, headingAnchors(await readFile(resolved, "utf8")));
        assert.ok(headings.get(resolved).has(decodeURIComponent(fragment)), `${path.relative(root, file)} links to missing heading ${target}`);
      }
    }
  }
});
