import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw Error(`${name} を指定してください。`);
  return resolve(process.argv[index + 1]);
}

async function configureIndex(path, development) {
  const html = await readFile(path, "utf8");
  const label = development ? "貴族のひそめごと DEV" : "貴族のひそめごと";
  await writeFile(path, html
    .replace("<title>貴族のひそめごと</title>", `<title>${label}</title>`)
    .replace('content="貴族のひそめごと"', `content="${label}"`)
    .replace('<script type="module" src="app.js"></script>', '<script src="environment.js"></script>\n<script type="module" src="app.js"></script>'));
}

async function configureDevelopmentApp(path) {
  const app = await readFile(path, "utf8");
  await writeFile(path, app.replace('document.title="貴族のひそめごと";', 'document.title="貴族のひそめごと DEV";'));
}

const prod = argument("--prod");
const dev = argument("--dev");
const output = argument("--output");
const copyOptions = { recursive: true, filter: source => basename(source) !== ".git" };

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(prod, output, copyOptions);
await cp(dev, `${output}/dev`, copyOptions);
await cp(`${dev}/manifest.dev.webmanifest`, `${output}/dev/manifest.webmanifest`);
await Promise.all([
  configureIndex(`${output}/index.html`, false),
  configureIndex(`${output}/dev/index.html`, true),
  configureDevelopmentApp(`${output}/dev/app.js`)
]);

console.log(`Pages成果物を作成しました: ${output}`);
