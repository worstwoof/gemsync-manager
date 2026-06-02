import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function readArgs() {
  const out = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const item = process.argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = process.argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

function optional(args, key, fallback) {
  return args.get(key) || fallback;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

function deckNumberFromId(value) {
  return Number(/^deck(\d+)/i.exec(String(value || ""))?.[1] || 0);
}

function deckNumberFromFolder(value) {
  return Number(/^deck(\d+)/i.exec(String(value || ""))?.[1] || 0);
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.[^.]+$/u, "")
    .replace(/^deck\d+[_-]?/i, "")
    .replace(/[\s_-]+/g, "")
    .trim();
}

async function listFiles(dir, extensions) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
      .filter((file) => extensions.includes(path.extname(file).toLowerCase()))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));
  } catch {
    return [];
  }
}

async function screenshotDecks(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const decks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^deck\d+_/i.test(entry.name)) continue;
      const folderPath = path.join(root, entry.name);
      const pngs = await listFiles(folderPath, [".png"]);
      decks.push({
        folder: entry.name,
        folderPath,
        deckNumber: deckNumberFromFolder(entry.name),
        titleKey: normalizeTitle(entry.name),
        slides: pngs.length,
      });
    }
    return decks.sort((a, b) => a.deckNumber - b.deckNumber);
  } catch {
    return [];
  }
}

function findScreenshotDeck(configDeck, decks, index) {
  const number = deckNumberFromId(configDeck.id) || index + 1;
  const byNumber = decks.find((deck) => deck.deckNumber === number);
  if (byNumber) return byNumber;

  const titleKey = normalizeTitle(configDeck.title || configDeck.id);
  return decks.find((deck) => titleKey && (deck.titleKey.includes(titleKey) || titleKey.includes(deck.titleKey))) || null;
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(args[0])} exited with ${code}`));
    });
  });
}

const args = readArgs();
const workspace = path.resolve(required(args, "workspace"));
const screenshotRoot = path.resolve(optional(args, "root", path.join(workspace, "DeckSync", "shots")));
const extensionRoot = path.resolve(optional(args, "extension-root", path.join(repoRoot, "extension")));
const subjectId = required(args, "subject-id");
const chrome = optional(args, "chrome", "http://127.0.0.1:9222");
const prompt = optional(args, "prompt", "请详细讲解这一面PPT");
const prePrompt = optional(args, "pre-prompt", "");
const onlyDeck = optional(args, "only-deck", "");
const onlyDecks = optional(args, "only-decks", "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
if (onlyDeck) onlyDecks.push(onlyDeck);
const selectedDecks = new Set(onlyDecks);
const subjectDir = path.join(extensionRoot, "pdf-panel", "subjects", subjectId);
const configPath = path.join(subjectDir, "config.json");
const config = await readJson(configPath, null);

if (!config) {
  throw new Error(`Subject config not found: ${configPath}. Please write the plugin config first.`);
}

const pagesPerPrompt = Math.max(1, Math.min(3, Math.floor(Number(optional(args, "pages-per-prompt", config.pagesPerPrompt || 1)) || 1)));

const decks = await screenshotDecks(screenshotRoot);
if (!decks.length) {
  throw new Error(`No screenshot decks found under ${screenshotRoot}`);
}

const exporter = path.join(__dirname, "export_gemini_cached_transcript.mjs");
if (!fss.existsSync(exporter)) throw new Error(`Exporter not found: ${exporter}`);

const configDecks = Array.isArray(config.decks) ? config.decks : [];
let exported = 0;
let skipped = 0;
let failed = 0;

console.log(`CACHE_SUBJECT ${config.course || subjectId} decks=${configDecks.length}`);

for (let index = 0; index < configDecks.length; index += 1) {
  const deck = configDecks[index];
  if (selectedDecks.size && !selectedDecks.has(deck.id)) {
    skipped += 1;
    continue;
  }
  if (!deck.geminiUrl) {
    console.warn(`SKIP ${deck.id} no Gemini URL`);
    skipped += 1;
    continue;
  }

  const screenshotDeck = findScreenshotDeck(deck, decks, index);
  if (!screenshotDeck || !screenshotDeck.slides) {
    console.warn(`SKIP ${deck.id} no screenshot folder`);
    skipped += 1;
    continue;
  }

  const totalPages = Number(deck.totalPages || screenshotDeck.slides || 0);
  if (!totalPages) {
    console.warn(`SKIP ${deck.id} total pages is 0`);
    skipped += 1;
    continue;
  }

  console.log(`CACHE_DECK ${deck.id} title=${JSON.stringify(deck.title || deck.id)} pages=${totalPages}`);
  try {
    await runNode([
      exporter,
      "--chrome",
      chrome,
      "--url",
      deck.geminiUrl,
      "--deck",
      deck.id,
      "--title",
      deck.title || deck.id,
      "--total-pages",
      String(totalPages),
      "--screenshots",
      screenshotDeck.folderPath,
      "--subject-dir",
      subjectDir,
      "--prompt",
      prompt || config.pagePrompt || "请详细讲解这一面PPT",
      "--pre-prompt",
      prePrompt || config.prePrompt || "",
      "--prompt-start-index",
      String(Number(config.promptStartIndex || (prePrompt || config.prePrompt ? 2 : 1)) || 1),
      "--pages-per-prompt",
      String(pagesPerPrompt || Number(config.pagesPerPrompt || 1) || 1),
    ], repoRoot);
    exported += 1;
  } catch (error) {
    failed += 1;
    console.error(`CACHE_FAILED ${deck.id} ${error.message}`);
  }
}

console.log(`CACHE_SUMMARY exported=${exported} skipped=${skipped} failed=${failed}`);
if (!exported || failed) process.exitCode = 1;
