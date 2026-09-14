import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
const development = process.env.CF_PAGES_BRANCH !== "main";
const environment = development ? "dev" : "prod";
const files = ["index.html", "styles.css", "app.js", "environment.js", "runtime-environment.js", "app-version.js", "card-data.js", "game-rules.js", "game-state.js", "round-candidates.js", "roulette.js", "set-picker.js", "firebase-client.js", "multiplayer-phase1.js", "multiplayer-parallel-preparation.js", "service-worker.js", "card-sets.json"];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of [...files, "assets", "cards", "data"]) {
  await cp(resolve(root, path), resolve(output, path), { recursive: true });
}
const configuration = await readFile(resolve(root, `firebase-config.${environment}.js`), "utf8");
const expectedProject = development ? "hisomegoto" : "pj-hisomegoto";
if (!new RegExp(`projectId\\s*:\\s*["']${expectedProject}["']`).test(configuration)) throw Error("Firebase projectId mismatch");
await writeFile(resolve(output, "firebase-config.js"), configuration);
const declaration = `globalThis.HISOMEGOTO_DEPLOY_ENV = ${JSON.stringify(environment)};\n`;
await writeFile(resolve(output, "deployment-env.js"), declaration);
const manifest = JSON.parse(await readFile(resolve(root, development ? "manifest.dev.webmanifest" : "manifest.webmanifest"), "utf8"));
Object.assign(manifest, { id: "/", start_url: "/", scope: "/" });
await writeFile(resolve(output, "manifest.webmanifest"), JSON.stringify(manifest, null, 2) + "\n");
const label = development ? "貴族のひそめごと DEV" : "貴族のひそめごと";
const scripts = '<script src="deployment-env.js"></script>\n<script src="environment.js"></script>\n' + ["firebase-client.js", "multiplayer-phase1.js", "multiplayer-parallel-preparation.js", "app.js"].map(path => `<script type="module" src="${path}"></script>`).join("\n");
let html = await readFile(resolve(output, "index.html"), "utf8");
html = html.replace(/<title>[^<]*<\/title>/, `<title>${label}</title>`)
  .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*/, `$1${label}`)
  .replace('<script type="module" src="app.js"></script>', scripts);
await writeFile(resolve(output, "index.html"), html);
// Embed the same immutable build selection in the worker; no optional-file fetch on GitHub Pages.
const worker = await readFile(resolve(output, "service-worker.js"), "utf8");
await writeFile(resolve(output, "service-worker.js"), declaration + worker.replace('"environment.js",', '"environment.js",\n  "deployment-env.js",'));
console.log(`Cloudflare artifact: ${environment}, projectId=${expectedProject}, dist/`);
