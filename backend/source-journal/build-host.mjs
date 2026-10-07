import ts from "typescript";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const hostOutput = resolve(here, "../.private-host");

export async function buildPrivateHost() {
  const loaded = ts.readConfigFile(resolve(here, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, here, {
    noEmit: false, rootDir: resolve(here, "../.."), outDir: hostOutput,
    sourceMap: false, declaration: false, noEmitOnError: true,
  });
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => here, getNewLine: () => "\n",
  }));
  const outputs = [];
  const emitted = program.emit(undefined, (name, content) => outputs.push({ name, content }));
  if (emitted.emitSkipped) throw new Error("Private host build failed.");
  for (const { name, content } of outputs) {
    await mkdir(dirname(name), { recursive: true });
    // Node ESM requires explicit extensions; TypeScript's Bundler resolver does not.
    const nodeCode = content.replace(/(\bfrom\s+["'])(\.[^"']+)(["'])/gu,
      (_, start, specifier, end) => start + (/\.[a-z]+$/iu.test(specifier) ? specifier : `${specifier}.js`) + end);
    await writeFile(name, nodeCode);
  }
  return outputs.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify({ status: "HOST_BUILD_READY", files: await buildPrivateHost() })); }
  catch { console.error("Private host build failed. Run npm run source:check for diagnostics."); process.exitCode = 1; }
}
