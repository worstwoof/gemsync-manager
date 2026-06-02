import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readText(file) {
  return fsp.readFile(path.join(ROOT, file), "utf8");
}

function pngInfo(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  assert(signature === "89504e470d0a1a0a", "not a PNG file");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function checkTextBranding() {
  const packageJson = JSON.parse(await readText("package.json"));
  assert(packageJson.name === "decksync", "package.json name must be decksync");

  const appHtml = await readText("app/index.html");
  assert(appHtml.includes("<title>DeckSync</title>"), "app title must be DeckSync");
  assert(appHtml.includes('<div class="brand-mark">DS</div>'), "manager brand mark must be DS");
  assert(!appHtml.includes("GemSync Manager"), "app must not show legacy GemSync Manager title");
  assert(!appHtml.includes('<div class="brand-mark">GS</div>'), "app must not show legacy GS mark");

  const manifest = await readText("extension/manifest.json");
  assert(manifest.includes('"name": "DeckSync Marker"'), "extension manifest name must be DeckSync Marker");

  const exporter = await readText("scripts/export_gemini_cached_transcript.mjs");
  assert(exporter.includes("Mozilla/5.0 DeckSync/1.0"), "exporter User-Agent must use DeckSync");
  assert(!exporter.includes("GemSyncManager/1.0"), "exporter User-Agent must not use legacy GemSyncManager");
  assert(exporter.includes('extractor: "decksync"'), "Gemini exporter metadata must use decksync");
  assert(!exporter.includes('extractor: "gemsync-manager"'), "Gemini exporter metadata must not use legacy gemsync-manager");

  const chatgptRunner = await readText("scripts/chatgpt_ppt_one_by_one.mjs");
  assert(chatgptRunner.includes('extractor: "decksync"'), "ChatGPT runner metadata must use decksync");
  assert(!chatgptRunner.includes('extractor: "gemsync-manager"'), "ChatGPT runner metadata must not use legacy gemsync-manager");

  const appJs = await readText("app/app.js");
  assert(appJs.includes('"decksync-form"'), "manager form storage must use decksync-form");
  assert(appJs.includes('"decksync-hidden-jobs"'), "manager job storage must use decksync-hidden-jobs");

  const readme = await readText("README.md");
  for (const image of [
    "docs/screenshots/manager-overview.png",
    "docs/screenshots/offline-cache-selection.png",
    "docs/screenshots/offline-reader.png",
  ]) {
    assert(readme.includes(image), `README must reference ${image}`);
  }
}

async function checkScreenshot(file, minWidth, minHeight, minBytes) {
  const fullPath = path.join(ROOT, file);
  const buffer = await fsp.readFile(fullPath);
  const info = pngInfo(buffer);
  assert(buffer.byteLength >= minBytes, `${file} is unexpectedly small`);
  assert(info.width >= minWidth, `${file} width ${info.width} is below ${minWidth}`);
  assert(info.height >= minHeight, `${file} height ${info.height} is below ${minHeight}`);
}

async function main() {
  await checkTextBranding();
  await checkScreenshot("docs/screenshots/manager-overview.png", 1200, 800, 100_000);
  await checkScreenshot("docs/screenshots/offline-cache-selection.png", 500, 900, 40_000);
  await checkScreenshot("docs/screenshots/offline-reader.png", 1400, 850, 70_000);
  console.log("DeckSync brand/assets check passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
