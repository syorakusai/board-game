import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import vm from "node:vm";
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = resolve(root, "dist");
const read = path => readFile(resolve(dist, path), "utf8");
async function walk(path = "") {
  const files = [];
  for (const entry of await readdir(resolve(dist, path), { withFileTypes: true })) {
    const next = path ? `${path}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(next)); else files.push(next);
  }
  return files;
}
function browser(path, declaration = "") {
  const storage = new Map(); const badges = [];
  const context = { location: { pathname: path }, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, document: { title: "", querySelector: () => null, createElement: () => ({ setAttribute() {} }), head: { append() {} }, body: { prepend: badge => badges.push(badge) } }, window: { addEventListener() {} }, setTimeout() {} };
  vm.createContext(context);vm.runInContext(declaration, context);
  return { context, storage, badges };
}
function worker(source, scope) {
  const context = { URL, self: { registration: { scope }, addEventListener() {} }, importScripts() {} };
  context.self = Object.assign(context, context.self);
  vm.createContext(context);vm.runInContext(source, context);
  return vm.runInContext('({ development, CACHE_PREFIX, APP_SHELL, explicitEnvironment })', context);
}
for (const branch of ["main", "develop", "feature/preview", ""]) {
  execFileSync(process.execPath, ["scripts/build-cloudflare.mjs"], { cwd: root, env: { ...process.env, CF_PAGES_BRANCH: branch }, stdio: "pipe" });
  const dev = branch !== "main";
  const files = await walk();
  assert(!files.includes("stale-marker"));
  for (const path of ["index.html", "manifest.webmanifest", "service-worker.js", "firebase-config.js", "assets", "cards", "data"]) await stat(resolve(dist, path));
  for (const path of files) assert(!/(^|\/)(\.git|\.github|docs|tests|scripts|README\.md|package\.json|firebase-rules\.json|firebase-config\.(prod|dev)\.js|manifest\.dev\.webmanifest)(\/|$)/.test(path), path);
  const config = await read("firebase-config.js");
  assert.match(config, dev ? /projectId:\s*"hisomegoto"/ : /projectId:\s*"pj-hisomegoto"/);
  assert(!config.includes(dev ? "pj-hisomegoto" : 'projectId: "hisomegoto"'));
  const manifest = JSON.parse(await read("manifest.webmanifest"));
  for (const key of ["id", "start_url", "scope"]) assert.equal(manifest[key], "/");
  assert.equal(manifest.name, dev ? "貴族のひそめごと DEV" : "貴族のひそめごと");
  const html = await read("index.html");
  assert(html.includes(`<title>${manifest.name}</title>`));
  assert(html.indexOf('src="deployment-env.js"') < html.indexOf('src="environment.js"'));
  const declaration = await read("deployment-env.js");
  const { context, storage, badges } = browser(dev ? "/" : "/board-game/dev/", declaration);
  vm.runInContext(await read("environment.js"), context);
  context.localStorage.setItem("word-card-players", "test");
  assert(storage.has(`board-game:${dev ? "dev" : "prod"}:word-card-players`));
  assert.equal(badges.length, dev ? 1 : 0);
  const runtime = (await read("runtime-environment.js")).replaceAll("export ", "");
  vm.runInContext(runtime, context);
  assert.equal(vm.runInContext("isDevelopment()", context), dev);
  assert.equal(vm.runInContext("isDeploymentEnabled()", context), true);
  const sw = worker(await read("service-worker.js"), "https://example.test/");
  assert.equal(sw.development, dev); assert(sw.CACHE_PREFIX.includes(dev ? "-dev-" : "-prod-"));
  assert.equal(sw.explicitEnvironment, true);
  for (const path of sw.APP_SHELL.filter(path => path !== "./")) assert(files.includes(path), path);
  // Check HTML, relative module imports, literal fetches, and CSS URLs against the artifact.
  for (const path of files.filter(path => /\.(js|html|css)$/.test(path))) {
    const source = await read(path);
    const pattern = /(?:\bfrom\s*|\bimport\s*\(|\bfetch\s*\(|\bsrc=|\bhref=|\burl\()\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const ref = match[1];
      if (/^(https?:|data:|#)/.test(ref) || ref.includes("${")) continue;
      assert(files.includes(resolve(dirname(path), ref.split("?")[0]).slice(process.cwd().length + 1)), `${path}: ${ref}`);
    }
  }
  await writeFile(resolve(dist, "stale-marker"), "old");
  console.log(`PASS Cloudflare branch=${branch || "unset"}: ${dev ? "DEV" : "PROD"}`);
}
const originalEnv = await readFile(resolve(root, "environment.js"), "utf8");
const originalSw = await readFile(resolve(root, "service-worker.js"), "utf8");
for (const dev of [false, true]) {
  const path = dev ? "/board-game/dev/" : "/board-game/";
  const state = browser(path);vm.runInContext(originalEnv, state.context);
  assert.equal(state.badges.length, dev ? 1 : 0);
  assert.equal(worker(originalSw, `https://example.test${path}`).development, dev);
}
await rm(dist, { recursive: true, force: true });
console.log("PASS GitHub Pages fallback");
