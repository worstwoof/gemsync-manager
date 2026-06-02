import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
loadLocalEnv(ROOT);
const APP_ROOT = path.join(ROOT, "app");
const DEFAULT_MANAGER_PORT = normalizePort(process.env.GEMSYNC_MANAGER_PORT_FALLBACK, 5188);
const REQUESTED_PORT = normalizePort(process.env.GEMSYNC_MANAGER_PORT, DEFAULT_MANAGER_PORT);
const HOST = "127.0.0.1";

const NODE = process.env.GEMSYNC_NODE || process.execPath || "node";
const PYTHON = process.env.GEMSYNC_PYTHON || "python";
const PDFINFO = process.env.GEMSYNC_PDFINFO || "pdfinfo";
const PDFTOPPM = process.env.GEMSYNC_PDFTOPPM || "pdftoppm";
const CHROME = process.env.GEMSYNC_CHROME || firstExisting([
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
]) || "chrome.exe";
const AUTOMATION_SCRIPTS_ROOT = process.env.GEMSYNC_AUTOMATION_SCRIPTS || path.join(ROOT, "scripts");
const LEGACY_SKILL_ROOT = process.env.GEMSYNC_SKILL_ROOT || "";
const DEFAULT_EXTENSION_ROOT = process.env.GEMSYNC_EXTENSION_ROOT || path.join(ROOT, "extension");
const APP_NAME = "DeckSync";
const COURSE_DATA_DIR = "DeckSync";
const SCREENSHOTS_DIR = "shots";
const LEGACY_SCREENSHOTS_DIR = "gemini_ppt_screenshots_full";
const DEFAULT_WORKSPACE = process.env.GEMSYNC_DEFAULT_WORKSPACE || "";
const DEFAULT_SUBJECT_ID = process.env.GEMSYNC_DEFAULT_SUBJECT_ID || "";
const DEFAULT_SUBJECT_TITLE = process.env.GEMSYNC_DEFAULT_SUBJECT_TITLE || "";
const DEFAULT_PROMPT = process.env.GEMSYNC_DEFAULT_PROMPT || "请详细讲解这一面PPT";
const DEFAULT_PRE_PROMPT = process.env.GEMSYNC_DEFAULT_PRE_PROMPT || "";
const DEFAULT_PAGES_PER_PROMPT = normalizePagesPerPrompt(process.env.GEMSYNC_DEFAULT_PAGES_PER_PROMPT || 1);
const DEFAULT_PROVIDER = normalizeProvider(process.env.GEMSYNC_DEFAULT_PROVIDER || "gemini");
const DEFAULT_GEMINI_MODEL = "pro";
const DEFAULT_CHATGPT_MODEL = normalizeChatGptModel(process.env.GEMSYNC_DEFAULT_CHATGPT_MODEL || "5.5");
const DEFAULT_CHATGPT_THINKING = normalizeChatGptThinking(process.env.GEMSYNC_DEFAULT_CHATGPT_THINKING || "thinking");
const DEFAULT_CHATGPT_THINKING_EFFORT = normalizeChatGptThinkingEffort(process.env.GEMSYNC_DEFAULT_CHATGPT_THINKING_EFFORT || "advanced");
const DEFAULT_PRO_FALLBACK = "flash";
const DEFAULT_GEMINI_CHROME_PORT = Number(process.env.GEMSYNC_GEMINI_CHROME_PORT || process.env.GEMSYNC_CHROME_PORT || 9222);
const DEFAULT_CHATGPT_CHROME_PORT = Number(process.env.GEMSYNC_CHATGPT_CHROME_PORT || 9223);
const GEMINI_CHROME_DEBUG_URL = process.env.GEMINI_CHROME_DEBUG_URL || process.env.GEMSYNC_CHROME_DEBUG_URL || `http://127.0.0.1:${DEFAULT_GEMINI_CHROME_PORT}`;
const CHATGPT_CHROME_DEBUG_URL = process.env.CHATGPT_CHROME_DEBUG_URL || `http://127.0.0.1:${DEFAULT_CHATGPT_CHROME_PORT}`;
const CHROME_DEBUG_URL = GEMINI_CHROME_DEBUG_URL;
const GEMINI_URL = "https://gemini.google.com/app";
const CHATGPT_URL = "https://chatgpt.com/";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".pdf", "application/pdf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
]);

const jobs = new Map();
const commands = new Map();
const commandQueues = new Map();
let jobSeq = 0;
let commandSeq = 0;
let activePort = REQUESTED_PORT;

function loadLocalEnv(root) {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || "";
}

function normalizePort(value, fallback = DEFAULT_MANAGER_PORT) {
  const port = Math.floor(Number(value));
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return fallback;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function notFound(res) {
  sendJson(res, 404, { ok: false, error: "Not found" });
}

function badRequest(res, error) {
  sendJson(res, 400, { ok: false, error });
}

async function readJsonBody(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

async function readJsonOrBackupInvalid(file, fallback, backupDir) {
  try {
    return {
      value: JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, "")),
      backup: "",
    };
  } catch (error) {
    if (error.code !== "ENOENT" && fs.existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      await fsp.mkdir(backupDir, { recursive: true });
      const backup = path.join(backupDir, `${path.basename(file, ".json")}.invalid-${stamp}.json`);
      await fsp.copyFile(file, backup);
      return { value: fallback, backup };
    }
    return { value: fallback, backup: "" };
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await cleanupStaleJsonTemps(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fsp.rename(temp, file);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupStaleJsonTemps(file, maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const cutoff = Date.now() - maxAgeMs;
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
    .map(async (entry) => {
      const temp = path.join(dir, entry.name);
      try {
        const stat = await fsp.stat(temp);
        if (stat.mtimeMs < cutoff) await fsp.rm(temp, { force: true });
      } catch {
        // Ignore cleanup races.
      }
    }));
}

function stableHash(input) {
  let hash = 2166136261;
  for (const char of String(input || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function resolveAutomationScript(name) {
  const candidates = [
    path.join(AUTOMATION_SCRIPTS_ROOT, name),
  ];
  if (LEGACY_SKILL_ROOT) {
    candidates.push(path.join(LEGACY_SKILL_ROOT, "scripts", name));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(`Automation script not found: ${name}. Set GEMSYNC_AUTOMATION_SCRIPTS to the scripts folder.`);
}

function commandLooksLikePath(command) {
  const value = String(command || "");
  return path.isAbsolute(value) || /[\\/]/.test(value);
}

function commandPathMissing(command) {
  return commandLooksLikePath(command) && !fs.existsSync(command);
}

function folderTitleFromPath(input) {
  const resolved = path.resolve(String(input || ""));
  return path.basename(resolved) || "";
}

function sanitizeId(input, fallback = "subject") {
  const raw = String(input || fallback || "subject").trim();
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `course-${stableHash(raw)}`;
}

function normalizeTitle(input, fallback = "未命名学科") {
  return String(input || fallback).trim() || fallback;
}

function normalizeProvider(input, fallback = "gemini") {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/_/g, "-");
  if (["gemini", "chatgpt"].includes(value)) return value;
  return fallback || "";
}

function utf8Base64(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function providerLabel(provider) {
  return normalizeProvider(provider) === "chatgpt" ? "ChatGPT" : "Gemini";
}

function subjectTitleForProvider(title, provider) {
  return normalizeProvider(provider) === "chatgpt" ? `${title} (ChatGPT)` : title;
}

function subjectIdForProvider(subjectId, provider) {
  const clean = sanitizeId(subjectId, "subject");
  if (normalizeProvider(provider) !== "chatgpt") return clean;
  return clean.endsWith("-chatgpt") ? clean : `${clean}-chatgpt`;
}

function normalizeModel(input, fallback = DEFAULT_GEMINI_MODEL) {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/_/g, "-");
  if (["pro", "flash", "flash-lite"].includes(value)) return value;
  return fallback;
}

function normalizeChatGptModel(input, fallback = "5.5") {
  const raw = String(input || fallback || "").trim().toLowerCase();
  if (!raw) return "5.5";
  const value = raw.replace(/^gpt[-_\s]*/i, "");
  if (["5.5", "5.4", "5.3", "5.2", "o3"].includes(value)) return value;
  return fallback;
}

function normalizeChatGptThinking(input, fallback = "thinking") {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value === "o3") return "instant";
  if (["thinking", "instant"].includes(value)) return value;
  if (value.startsWith("thinking-")) return "thinking";
  return fallback;
}

function normalizeChatGptThinkingEffort(input, fallback = "advanced") {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["advanced", "standard"].includes(value)) return value;
  if (value.includes("standard")) return "standard";
  if (value.includes("advanced")) return "advanced";
  if (["进阶", "進階"].includes(String(input || "").trim())) return "advanced";
  if (String(input || "").trim() === "标准") return "standard";
  return fallback;
}

function normalizeProviderModel(provider, input) {
  return normalizeProvider(provider) === "chatgpt"
    ? normalizeChatGptModel(input, DEFAULT_CHATGPT_MODEL)
    : normalizeModel(input, DEFAULT_GEMINI_MODEL);
}

function chromeDebugUrlForProvider(provider) {
  return normalizeProvider(provider) === "chatgpt" ? CHATGPT_CHROME_DEBUG_URL : GEMINI_CHROME_DEBUG_URL;
}

function chromeDebugPort(debugUrl) {
  try {
    const parsed = new URL(debugUrl);
    return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  } catch {
    return 9222;
  }
}

function normalizeProFallback(input, fallback = DEFAULT_PRO_FALLBACK) {
  const value = String(input || fallback || "").trim().toLowerCase().replace(/_/g, "-");
  if (["wait", "stop", "flash", "flash-lite"].includes(value)) return value;
  return fallback;
}

function bodyString(body, key, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(body || {}, key)) {
    return String(body[key] || "").trim();
  }
  return String(fallback || "").trim();
}

function normalizePagesPerPrompt(value, fallback = 1) {
  const number = Math.floor(Number(value) || Number(fallback) || 1);
  return Math.max(1, Math.min(3, number));
}

function deckIdFromNumber(number) {
  return `deck${String(number).padStart(2, "0")}`;
}

function providerProgressFileName(provider) {
  return normalizeProvider(provider) === "chatgpt" ? "chatgpt_progress.json" : "gemini_progress.json";
}

function providerConversationFoldersFileName(provider) {
  return normalizeProvider(provider) === "chatgpt" ? "chatgpt_conversation_folders.json" : "conversation_folders.json";
}

function providerTranscriptDirName(provider) {
  return normalizeProvider(provider) === "chatgpt" ? "chatgpt_transcripts" : "";
}

function courseDataRoot(workspace) {
  return path.join(path.resolve(workspace || ""), COURSE_DATA_DIR);
}

function newScreenshotRoot(workspace) {
  return path.join(courseDataRoot(workspace), SCREENSHOTS_DIR);
}

function legacyScreenshotRoot(workspace) {
  return path.join(path.resolve(workspace || ""), LEGACY_SCREENSHOTS_DIR);
}

function screenshotRootForWorkspace(workspace) {
  const next = newScreenshotRoot(workspace);
  const legacy = legacyScreenshotRoot(workspace);
  if (!fs.existsSync(next) && fs.existsSync(legacy)) return legacy;
  return next;
}

function courseLogsRoot(workspace) {
  return path.join(courseDataRoot(workspace), "logs");
}

function chromeProfileRoot(workspace, provider) {
  return path.join(courseDataRoot(workspace), "profiles", normalizeProvider(provider));
}

async function moveIfExists(source, target, label, result) {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(target)) {
    result.skipped.push({ label, source, target, reason: "target exists" });
    return;
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.rename(source, target);
  result.moved.push({ label, source, target });
}

function providerProgressPath(screenshotRoot, provider) {
  return path.join(screenshotRoot, providerProgressFileName(provider));
}

function providerConversationFoldersPath(screenshotRoot, provider) {
  return path.join(screenshotRoot, providerConversationFoldersFileName(provider));
}

function deckNumberFromName(name) {
  return Number(/^deck(\d+)/i.exec(name || "")?.[1] || 0);
}

function titleFromDeckFolder(name) {
  return String(name || "")
    .replace(/^deck\d+[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .trim()
    || String(name || "Deck");
}

function safeFolderPart(input) {
  return String(input || "deck")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    || "deck";
}

function comparableName(input) {
  return String(input || "")
    .replace(/\.[^.]+$/u, "")
    .replace(/^deck\d+[_-]?/i, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}（）【】《》,，.。:：;；]/g, "");
}

function isIgnoredOfficeTemp(file) {
  return path.basename(file || "").startsWith("~$");
}

function manifestItemsFromValue(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (Array.isArray(manifest?.decks)) return manifest.decks;
  if (Array.isArray(manifest?.items)) return manifest.items;
  return [];
}

function findUnscreenedPpts(ppts, manifestItems, decks) {
  const exactSourcePaths = new Set(
    manifestItems
      .map((item) => String(item?.sourcePath || "").trim())
      .filter(Boolean)
      .map((file) => path.resolve(file).toLowerCase()),
  );
  const legacyNameAllowances = new Map();
  const manifestDeckNumbers = new Set();
  const seenManifestSources = new Set();

  for (const item of manifestItems) {
    if (!item || item.sourcePath) continue;
    const source = String(item.source || "").trim();
    const key = comparableName(path.basename(source));
    if (!key) continue;
    const deckKey = String(item.deckIndex || item.deck || item.folder || source);
    const unique = `${deckKey}:${key}`;
    if (seenManifestSources.has(unique)) continue;
    seenManifestSources.add(unique);
    legacyNameAllowances.set(key, (legacyNameAllowances.get(key) || 0) + 1);
    if (String(item.deckIndex || "").match(/^\d+$/)) manifestDeckNumbers.add(Number(item.deckIndex));
  }

  if (!manifestItems.length) {
    for (const deck of decks) {
      const key = comparableName(deck.title || deck.folder || "");
      if (!key) continue;
      legacyNameAllowances.set(key, (legacyNameAllowances.get(key) || 0) + 1);
    }
  } else {
    for (const deck of decks) {
      if (manifestDeckNumbers.has(Number(deck.deckNumber || 0))) continue;
      const key = comparableName(deck.title || deck.folder || "");
      if (!key) continue;
      legacyNameAllowances.set(key, (legacyNameAllowances.get(key) || 0) + 1);
    }
  }

  return ppts.filter((file) => {
    if (exactSourcePaths.has(path.resolve(file).toLowerCase())) return false;
    const key = comparableName(path.basename(file));
    const allowance = legacyNameAllowances.get(key) || 0;
    if (allowance > 0) {
      legacyNameAllowances.set(key, allowance - 1);
      return false;
    }
    return true;
  });
}

function conversationIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/^\/app\/([^/?#]+)/)?.[1]
      || parsed.pathname.match(/^\/c\/([^/?#]+)/)?.[1]
      || "";
  } catch {
    return "";
  }
}

function withZh(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("hl")) parsed.searchParams.set("hl", "zh");
    return parsed.toString();
  } catch {
    return url;
  }
}

function isPathWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shouldSkipSourceDir(name) {
  const lower = String(name || "").toLowerCase();
  return lower === LEGACY_SCREENSHOTS_DIR.toLowerCase()
    || lower === COURSE_DATA_DIR.toLowerCase()
    || lower === "chrome-gemini-automation-profile"
    || lower === "chrome-chatgpt-automation-profile"
    || lower === "node_modules"
    || lower === ".git";
}

async function listFiles(dir, extensions, options = {}) {
  const root = path.resolve(dir || "");
  const recursive = !!options.recursive;
  const excludeDirNames = new Set((options.excludeDirNames || []).map((name) => String(name).toLowerCase()));
  const excludeDirs = (options.excludeDirs || []).map((item) => path.resolve(item));
  const results = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        const lower = entry.name.toLowerCase();
        const excluded = excludeDirNames.has(lower)
          || excludeDirs.some((excludedDir) => file === excludedDir || isPathWithin(excludedDir, file));
        if (excluded) continue;
        await walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.includes(path.extname(file).toLowerCase())) continue;
      if (isIgnoredOfficeTemp(file)) continue;
      results.push(file);
    }
  }

  await walk(root);
  return results.sort((a, b) => {
    const relativeA = path.relative(root, a) || path.basename(a);
    const relativeB = path.relative(root, b) || path.basename(b);
    return relativeA.localeCompare(relativeB, "zh-Hans-CN", { numeric: true });
  });
}

async function workspaceSourceFiles(workspace, extensions) {
  return listFiles(workspace, extensions, {
    recursive: true,
    excludeDirNames: [
      LEGACY_SCREENSHOTS_DIR,
      COURSE_DATA_DIR,
      "chrome-gemini-automation-profile",
      "chrome-chatgpt-automation-profile",
      "node_modules",
      ".git",
    ],
  });
}

async function workspacePptFiles(workspace) {
  return workspaceSourceFiles(workspace, [".ppt", ".pptx"]);
}

async function workspaceUserPdfFiles(workspace) {
  return workspaceSourceFiles(workspace, [".pdf"]);
}

async function listFilesFlat(dir, extensions) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dir, entry.name))
      .filter((file) => extensions.includes(path.extname(file).toLowerCase()))
      .filter((file) => !isIgnoredOfficeTemp(file))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));
  } catch {
    return [];
  }
}

async function workspacePdfFiles(workspace) {
  const root = path.resolve(workspace || "");
  const screenshotRoot = screenshotRootForWorkspace(root);
  const pdfs = [
    ...(await workspaceUserPdfFiles(root)),
    ...(await listFiles(path.join(screenshotRoot, "_pdf"), [".pdf"])),
  ];
  return Array.from(new Set(pdfs))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));
}

async function screenshotDecks(workspace) {
  const root = screenshotRootForWorkspace(workspace);
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    const decks = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^deck\d+_/i.test(entry.name)) continue;
      const folder = path.join(root, entry.name);
      const pngs = await listFiles(folder, [".png"]);
      if (!pngs.length) continue;
      decks.push({
        folder: entry.name,
        folderPath: folder,
        deckNumber: deckNumberFromName(entry.name),
        title: titleFromDeckFolder(entry.name),
        slides: pngs.length,
      });
    }
    return decks.sort((a, b) => a.deckNumber - b.deckNumber);
  } catch {
    return [];
  }
}

async function countPdfPages(file) {
  if (commandPathMissing(PDFINFO)) return 0;
  return new Promise((resolve) => {
    const child = spawn(PDFINFO, [file], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const match = /^Pages:\s+(\d+)/m.exec(output);
      resolve(match ? Number(match[1]) : 0);
    });
  });
}

async function subjectCacheSummary(workspace, body = {}) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const title = normalizeTitle(body.title, folderTitleFromPath(workspace) || DEFAULT_SUBJECT_TITLE);
  const requestedSubjectId = subjectIdForProvider(body.subjectId || title, provider);
  const extension = await extensionSubjects(DEFAULT_EXTENSION_ROOT);
  const subjectEntryTitle = subjectTitleForProvider(title, provider);
  const requestedTitleKey = subjectTitleKey(subjectEntryTitle);
  const subject = extension.subjects.find((item) => subjectTitleKey(item.title) === requestedTitleKey)
    || extension.subjects.find((item) => item.id === requestedSubjectId)
    || null;
  const subjectId = subject?.id || requestedSubjectId;
  const configPath = subject ? configPathForSubject(DEFAULT_EXTENSION_ROOT, subject) : path.join(DEFAULT_EXTENSION_ROOT, "pdf-panel", "subjects", subjectId, "config.json");
  const rawConfig = await readJson(configPath, null);
  const config = rawConfig && normalizeProvider(rawConfig.provider || "gemini") === provider ? rawConfig : null;
  const decks = Array.isArray(config?.decks) ? config.decks : [];
  let transcriptDeckCount = 0;
  let recordCount = 0;
  let interactiveViewCount = 0;
  const deckSummaries = [];

  for (const deck of decks) {
    const transcriptPath = deck.transcriptUrl ? path.resolve(path.dirname(configPath), deck.transcriptUrl) : "";
    const transcript = transcriptPath ? await readJson(transcriptPath, null) : null;
    const records = Array.isArray(transcript?.records) ? transcript.records : [];
    const deckInteractiveViews = Number(transcript?.interactiveViewCount || 0)
      || records.reduce((total, record) => total + (Array.isArray(record.interactiveViews) ? record.interactiveViews.length : 0), 0);
    const cacheExists = !!transcript;

    if (cacheExists) {
      transcriptDeckCount += 1;
      recordCount += records.length;
      interactiveViewCount += deckInteractiveViews;
    }

    deckSummaries.push({
      id: deck.id || "",
      title: deck.title || deck.id || "",
      provider: deck.provider || config?.provider || provider,
      totalPages: Number(deck.totalPages || 0),
      geminiUrl: deck.geminiUrl || "",
      chatgptUrl: deck.chatgptUrl || "",
      conversationUrl: deck.geminiUrl || deck.chatgptUrl || "",
      conversationId: deck.conversationId || conversationIdFromUrl(deck.geminiUrl),
      transcriptUrl: deck.transcriptUrl || "",
      cacheExists,
      recordCount: records.length,
      interactiveViewCount: deckInteractiveViews,
      cacheUrl: cacheExists
        ? `/pdf-panel/cached-split.html#subject=${encodeURIComponent(subjectId)}&deck=${encodeURIComponent(deck.id || "")}`
        : "",
    });
  }

  return {
    subjectId,
    provider,
    configExists: !!config,
    totalDecks: decks.length,
    transcriptDeckCount,
    recordCount,
    interactiveViewCount,
    openCacheUrl: deckSummaries.find((deck) => deck.cacheExists)?.cacheUrl || "",
    decks: deckSummaries,
  };
}

async function workspaceSummary(workspace, body = {}) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const root = path.resolve(workspace || "");
  const pdfs = await workspacePdfFiles(root);
  const sourcePdfs = await workspaceUserPdfFiles(root);
  const ppts = await workspacePptFiles(root);
  const screenshotRoot = screenshotRootForWorkspace(root);
  const decks = await screenshotDecks(root);
  const progress = await readJson(providerProgressPath(screenshotRoot, provider), {});
  const conversationFolders = await readJson(providerConversationFoldersPath(screenshotRoot, provider), null);
  const manifest = await readJson(path.join(screenshotRoot, "manifest.json"), null);
  const manifestItems = manifestItemsFromValue(manifest);
  const unscreenedPpts = findUnscreenedPpts(ppts, manifestItems, decks);
  const unscreenedSet = new Set(unscreenedPpts);
  const sent = progress?.sent || {};
  const completedDeckCount = decks.filter((deck) => {
    const sentSlides = Number(sent[deck.folder] || 0);
    return deck.slides > 0 && sentSlides >= deck.slides;
  }).length;
  const sentSlides = decks.reduce((total, deck) => total + Number(sent[deck.folder] || 0), 0);
  const totalSlides = decks.reduce((total, deck) => total + Number(deck.slides || 0), 0);
  const cache = await subjectCacheSummary(root, body);
  const cacheByDeck = new Map((cache.decks || []).map((deck) => [deck.id, deck]));
  const decksWithState = decks.map((deck, index) => {
    const id = deckIdFromNumber(deck.deckNumber || index + 1);
    const rawConversationUrl = findConversationForDeck(deck, index, progress, conversationFolders);
    const conversationUrl = provider === "gemini" ? withZh(rawConversationUrl) : rawConversationUrl;
    const cached = cacheByDeck.get(id) || null;
    const sentSlides = Number(sent[deck.folder] || 0);
    return {
      ...deck,
      id,
      sentSlides,
      complete: deck.slides > 0 && sentSlides >= deck.slides,
      conversationUrl,
      provider,
      geminiUrl: provider === "gemini" ? (cached?.geminiUrl || conversationUrl) : (cached?.geminiUrl || ""),
      chatgptUrl: cached?.chatgptUrl || (provider === "chatgpt" ? conversationUrl : ""),
      conversationId: cached?.conversationId || conversationIdFromUrl(conversationUrl),
      cache: cached,
    };
  });

  return {
    workspace: root,
    provider,
    exists: fs.existsSync(root),
    pdfs: pdfs.map((file) => ({ name: path.basename(file), path: file })),
    sourcePdfs: sourcePdfs.map((file) => ({ name: path.basename(file), path: file })),
    ppts: ppts.map((file) => ({
      name: path.basename(file),
      path: file,
      screened: !unscreenedSet.has(file),
    })),
    unscreenedPpts: unscreenedPpts.map((file) => ({ name: path.basename(file), path: file })),
    screenedPptCount: Math.max(0, ppts.length - unscreenedPpts.length),
    screenshotRoot,
    screenshotRootExists: fs.existsSync(screenshotRoot),
    decks: decksWithState,
    progress: {
      provider,
      sentCount: progress?.sent ? Object.keys(progress.sent).length : 0,
      completedDeckCount,
      incompleteDeckCount: Math.max(0, decks.length - completedDeckCount),
      sentSlides,
      totalSlides,
      conversationCount: progress?.conversations ? Object.keys(progress.conversations).length : 0,
      last: progress?.last || null,
      quotaWaiting: !!progress?.quotaWaiting,
      quotaReason: progress?.quotaReason || "",
      quotaMessage: progress?.quotaMessage || "",
      quotaPhase: progress?.quotaPhase || "",
      quotaResetHint: progress?.quotaResetHint || "",
      quotaResetAt: progress?.quotaResetAt || "",
      quotaResumeAfter: progress?.quotaResumeAfter || "",
      quotaDetectedAt: progress?.quotaDetectedAt || progress?.quotaLastCheckedAt || "",
      lastQuotaSlide: progress?.lastQuotaSlide || null,
    },
    conversationFoldersCount: Array.isArray(conversationFolders?.folders) ? conversationFolders.folders.length : 0,
    manifestCount: manifestItems.length,
    cache,
  };
}

async function workspaceProgress(workspace, body = {}) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const root = path.resolve(workspace || "");
  const screenshotRoot = screenshotRootForWorkspace(root);
  const decks = await screenshotDecks(root);
  const progress = await readJson(providerProgressPath(screenshotRoot, provider), {});
  const conversationFolders = await readJson(providerConversationFoldersPath(screenshotRoot, provider), null);
  const sent = progress?.sent || {};
  const completedDeckCount = decks.filter((deck) => {
    const sentSlides = Number(sent[deck.folder] || 0);
    return deck.slides > 0 && sentSlides >= deck.slides;
  }).length;
  const sentSlides = decks.reduce((total, deck) => total + Number(sent[deck.folder] || 0), 0);
  const totalSlides = decks.reduce((total, deck) => total + Number(deck.slides || 0), 0);
  return {
    decks,
    progress: {
      provider,
      sentCount: progress?.sent ? Object.keys(progress.sent).length : 0,
      completedDeckCount,
      incompleteDeckCount: Math.max(0, decks.length - completedDeckCount),
      sentSlides,
      totalSlides,
      conversationCount: progress?.conversations ? Object.keys(progress.conversations).length : 0,
      last: progress?.last || null,
      quotaWaiting: !!progress?.quotaWaiting,
      quotaReason: progress?.quotaReason || "",
      quotaMessage: progress?.quotaMessage || "",
      quotaPhase: progress?.quotaPhase || "",
      quotaResetHint: progress?.quotaResetHint || "",
      quotaResetAt: progress?.quotaResetAt || "",
      quotaResumeAfter: progress?.quotaResumeAfter || "",
      quotaDetectedAt: progress?.quotaDetectedAt || progress?.quotaLastCheckedAt || "",
      lastQuotaSlide: progress?.lastQuotaSlide || null,
    },
    conversationFoldersCount: Array.isArray(conversationFolders?.folders) ? conversationFolders.folders.length : 0,
  };
}

async function extensionSubjects(extensionRoot) {
  const subjectsPath = path.join(extensionRoot, "pdf-panel", "subjects.json");
  const subjects = await readJson(subjectsPath, { version: 1, defaultSubject: "", subjects: [] });
  return {
    extensionRoot,
    subjectsPath,
    subjects: subjects.subjects || [],
    defaultSubject: subjects.defaultSubject || "",
  };
}

function makeJob(type, title) {
  const id = `${Date.now().toString(36)}-${++jobSeq}`;
  const job = {
    id,
    type,
    title,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    log: "",
    pid: null,
    child: null,
  };
  jobs.set(id, job);
  return job;
}

function makeCommand(body) {
  const payload = body?.payload || {};
  const conversationId = String(payload.conversationId || conversationIdFromUrl(payload.geminiUrl || payload.chatgptUrl || "") || "").trim();
  if (!conversationId) throw new Error("缺少 conversationId，无法发送同步命令");

  const id = `${Date.now().toString(36)}-${++commandSeq}`;
  const command = {
    id,
    type: String(body.type || ""),
    payload,
    conversationId,
    createdAt: Date.now(),
    result: null,
  };
  if (!bridgeEvents.has(command.type)) throw new Error(`未知同步命令：${command.type}`);

  commands.set(id, command);
  const queue = commandQueues.get(conversationId) || [];
  queue.push(id);
  commandQueues.set(conversationId, queue);
  cleanupCommands();
  return command;
}

const COMMAND_TTL_MS = 10 * 60 * 1000;
const bridgeEvents = new Set([
  "gemsync:sync-page",
  "gemsync:bind-page",
  "gemsync:open-gemini",
]);

function cleanupCommands() {
  const cutoff = Date.now() - COMMAND_TTL_MS;
  for (const [id, command] of commands) {
    if (command.createdAt < cutoff) commands.delete(id);
  }
  for (const [conversationId, queue] of commandQueues) {
    const next = queue.filter((id) => commands.has(id));
    if (next.length) commandQueues.set(conversationId, next);
    else commandQueues.delete(conversationId);
  }
}

function appendJob(job, text) {
  job.log += text;
  if (job.log.length > 200000) job.log = job.log.slice(-200000);
}

function runJob({ type, title, command, args, cwd, env = {}, logFiles = [] }) {
  const job = makeJob(type, title);
  job.workspace = cwd;
  job.provider = normalizeProvider(env.GEMSYNC_PROVIDER || env.CHATGPT_PROVIDER || (type === "chatgpt" ? "chatgpt" : "gemini"), "");
  appendJob(job, `WORKDIR ${cwd}\nRUN ${command} ${args.join(" ")}\n\n`);
  const outStreams = logFiles.map((file) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fs.createWriteStream(file, { flags: "a" });
  });

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    windowsHide: true,
  });
  job.child = child;
  job.pid = child.pid;

  const record = (chunk) => {
    const text = chunk.toString();
    appendJob(job, text);
    for (const stream of outStreams) stream.write(text);
  };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.on("error", (error) => {
    appendJob(job, `\nERROR ${error.message}\n`);
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    for (const stream of outStreams) stream.end();
  });
  child.on("close", (code) => {
    job.exitCode = code;
    job.status = code === 0 ? "complete" : "failed";
    job.finishedAt = new Date().toISOString();
    appendJob(job, `\nEXIT ${code}\n`);
    for (const stream of outStreams) stream.end();
  });
  return job;
}

async function prepareScreenshotsJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  const ppts = await workspacePptFiles(workspace);
  const pdfs = await workspaceUserPdfFiles(workspace);
  const decks = await screenshotDecks(workspace);
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  const manifest = await readJson(path.join(screenshotRoot, "manifest.json"), null);
  const unscreenedPpts = findUnscreenedPpts(ppts, manifestItemsFromValue(manifest), decks);
  const requestedPdfs = requestedExistingFiles(body, "pdfs", pdfs);
  const selectedPpts = Array.isArray(body.ppts)
    ? requestedExistingFiles(body, "ppts", ppts)
    : null;

  if (requestedPdfs.length && (selectedPpts?.length || (!selectedPpts && ppts.length))) {
    return prepareMixedScreenshotsJob(workspace, requestedPdfs, ppts, decks, body, unscreenedPpts);
  }
  if (requestedPdfs.length && (selectedPpts?.length === 0 || !ppts.length)) return preparePdfScreenshotsJob(workspace, requestedPdfs, decks, body);

  const script = resolveAutomationScript("add_new_ppts_to_screenshots.py");
  const args = [script, "--workspace", workspace, "--root", screenshotRoot];
  if (body.dryRun) args.push("--dry-run");
  const requestedPpts = selectedPpts
    ? selectedPpts
    : (!decks.length ? ppts : unscreenedPpts);
  if (!requestedPpts.length) throw new Error("No PDF/PPT files selected for screenshots.");
  for (const ppt of requestedPpts) args.push("--ppt", ppt);
  return runJob({
    type: "prepare",
    title: "准备 PPT 截图",
    command: PYTHON,
    args,
    cwd: workspace,
  });
}

function pptPrepareArgs(workspace, screenshotRoot, body, requestedPpts) {
  const script = resolveAutomationScript("add_new_ppts_to_screenshots.py");
  const args = [script, "--workspace", workspace, "--root", screenshotRoot];
  if (body.dryRun) args.push("--dry-run");
  for (const ppt of requestedPpts) args.push("--ppt", ppt);
  return args;
}

function requestedExistingFiles(body, key, discovered) {
  if (!Array.isArray(body?.[key])) return discovered;
  const allowed = new Map(discovered.map((file) => [path.resolve(file).toLowerCase(), file]));
  return body[key]
    .map((file) => allowed.get(path.resolve(String(file || "")).toLowerCase()))
    .filter(Boolean);
}

function runProcess(job, command, args, cwd) {
  appendJob(job, `RUN ${command} ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    job.child = child;
    job.pid = child.pid;
    let output = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      appendJob(job, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      appendJob(job, text);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed with exit ${code}${output.trim() ? `: ${output.trim().slice(-800)}` : ""}`));
    });
  });
}

async function renamePdfImages(deckDir, deckId, prefix) {
  const files = (await listFiles(deckDir, [".png"]))
    .filter((file) => path.basename(file).startsWith(path.basename(prefix)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN", { numeric: true }));

  for (let index = 0; index < files.length; index += 1) {
    const target = path.join(deckDir, `${deckId}_slide${String(index + 1).padStart(3, "0")}.png`);
    if (files[index] !== target) await fsp.rename(files[index], target);
  }
  return files.length;
}

function nextAvailableDeckNumber(decks) {
  const used = new Set(decks.map((deck) => Number(deck.deckNumber || 0)).filter(Boolean));
  let number = 1;
  while (used.has(number)) number += 1;
  return number;
}

function existingDeckForPdf(decks, pdfFile, index = -1) {
  const deckNumber = index + 1;
  const title = comparableName(path.basename(pdfFile, ".pdf"));
  return (deckNumber > 0 ? decks.find((deck) => deck.deckNumber === deckNumber) : null)
    || decks.find((deck) => {
      const deckTitle = comparableName(deck.title || deck.folder);
      return title && (deckTitle.includes(title) || title.includes(deckTitle));
    });
}

async function preparePdfScreenshotsInJob(job, workspace, pdfs, decks, body = {}) {
  if (commandPathMissing(PDFTOPPM)) throw new Error(`pdftoppm not found: ${PDFTOPPM}`);

  const screenshotRoot = screenshotRootForWorkspace(workspace);
  const manifestPath = path.join(screenshotRoot, "manifest.json");
  const manifestItems = manifestItemsFromValue(await readJson(manifestPath, []));
  let nextOrder = maxOrderFromManifest(manifestItems) + 1;
  const currentDecks = [...decks];
  const createdEntries = [];

  await fsp.mkdir(screenshotRoot, { recursive: true });
  appendJob(job, `WORKDIR ${workspace}\n`);
  appendJob(job, `PDFS ${pdfs.length}\n\n`);

  let created = 0;
  let skipped = 0;
  for (const pdf of pdfs) {
    const existing = existingDeckForPdf(currentDecks, pdf);
    if (existing?.slides > 0) {
      skipped += 1;
      appendJob(job, `SKIP ${path.basename(pdf)} -> ${existing.folder} (${existing.slides} screenshots)\n`);
      continue;
    }

    const deckNumber = nextAvailableDeckNumber(currentDecks);
    const deckId = deckIdFromNumber(deckNumber);
    const deckTitle = safeFolderPart(path.basename(pdf, ".pdf"));
    const deckFolder = `${deckId}_${deckTitle}`;
    const deckDir = path.join(screenshotRoot, deckFolder);
    await fsp.mkdir(deckDir, { recursive: true });

    if (body.dryRun) {
      appendJob(job, `DRY_RUN PDF ${path.basename(pdf)} -> ${deckFolder}\n`);
      currentDecks.push({ folder: deckFolder, folderPath: deckDir, deckNumber, title: deckTitle, slides: 0 });
      continue;
    }

    const oldPngs = await listFiles(deckDir, [".png"]);
    for (const file of oldPngs) await fsp.unlink(file);

    appendJob(job, `PDF ${created + skipped + 1}/${pdfs.length}: ${path.basename(pdf)}\n`);
    const prefix = path.join(deckDir, `${deckId}_raw`);
    await runProcess(job, PDFTOPPM, ["-png", "-r", "150", pdf, prefix], workspace);
    const pages = await renamePdfImages(deckDir, deckId, prefix);
    if (!pages) throw new Error(`No pages were generated from ${path.basename(pdf)}. Check whether the PDF is valid and readable.`);
    appendJob(job, `DONE ${deckFolder}: ${pages} pages\n\n`);
    created += 1;

    currentDecks.push({ folder: deckFolder, folderPath: deckDir, deckNumber, title: deckTitle, slides: pages });
    let sourceRelativePath = path.basename(pdf);
    try {
      sourceRelativePath = path.relative(workspace, pdf);
    } catch {
      // Keep basename fallback.
    }
    for (let slide = 1; slide <= pages; slide += 1) {
      const slidePath = path.join(deckDir, `${deckId}_slide${String(slide).padStart(3, "0")}.png`);
      createdEntries.push({
        order: nextOrder++,
        deckIndex: deckNumber,
        source: path.basename(pdf),
        sourcePath: path.resolve(pdf),
        sourceRelativePath,
        slide,
        totalSlidesInDeck: pages,
        path: path.resolve(slidePath),
        bytes: fs.statSync(slidePath).size,
      });
    }
  }

  if (!body.dryRun && createdEntries.length) {
    await writeJson(manifestPath, [...manifestItems, ...createdEntries]);
  }
  appendJob(job, `SUMMARY pdfCreated=${created} pdfSkipped=${skipped}\n`);
}

function maxOrderFromManifest(manifestItems) {
  return Math.max(0, ...manifestItems.map((item) => Number(item?.order || 0)).filter(Number.isFinite));
}

function preparePdfScreenshotsJob(workspace, pdfs, decks, body = {}) {
  const job = makeJob("prepare", "准备 PDF 截图");
  job.workspace = workspace;

  (async () => {
    try {
      await preparePdfScreenshotsInJob(job, workspace, pdfs, decks, body);
      job.status = "complete";
      job.exitCode = 0;
    } catch (error) {
      appendJob(job, `ERROR ${error.message}\n`);
      job.status = "failed";
      job.exitCode = 1;
    } finally {
      job.child = null;
      job.pid = null;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function prepareMixedScreenshotsJob(workspace, pdfs, ppts, decks, body, unscreenedPpts) {
  const job = makeJob("prepare", "准备课件截图");
  job.workspace = workspace;
  const screenshotRoot = screenshotRootForWorkspace(workspace);

  (async () => {
    try {
      appendJob(job, "MIXED course folder: preparing PDFs first, then PPT/PPTX files.\n\n");
      await preparePdfScreenshotsInJob(job, workspace, pdfs, decks, body);

      const refreshedDecks = await screenshotDecks(workspace);
      const requestedPpts = Array.isArray(body.ppts)
        ? requestedExistingFiles(body, "ppts", ppts)
        : (!refreshedDecks.length ? ppts : unscreenedPpts);
      if (requestedPpts.length) {
        const args = pptPrepareArgs(workspace, screenshotRoot, body, requestedPpts);
        appendJob(job, `\nPPTS ${requestedPpts.length}\n`);
        await runProcess(job, PYTHON, args, workspace);
      } else {
        appendJob(job, "\nPPTS 0\nNo new PPT/PPTX files detected.\n");
      }

      job.status = "complete";
      job.exitCode = 0;
    } catch (error) {
      appendJob(job, `ERROR ${error.message}\n`);
      job.status = "failed";
      job.exitCode = 1;
    } finally {
      job.child = null;
      job.pid = null;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

async function startGeminiJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  await assertAskPreflight(workspace, "gemini");
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  await fsp.mkdir(screenshotRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const log = path.join(courseLogsRoot(workspace), `gemini-${stamp}.log`);
  const script = resolveAutomationScript("gemini_ppt_one_by_one.mjs");
  const env = {
    GEMINI_PPT_ROOT: screenshotRoot,
    GEMINI_PPT_PROMPT: body.prompt || DEFAULT_PROMPT,
    GEMINI_PPT_PROMPT_B64: utf8Base64(body.prompt || DEFAULT_PROMPT),
    GEMINI_PAGES_PER_PROMPT: String(normalizePagesPerPrompt(body.pagesPerPrompt, DEFAULT_PAGES_PER_PROMPT)),
    GEMINI_MODEL: normalizeModel(body.model),
    GEMINI_PRO_FALLBACK: normalizeProFallback(body.proFallback),
    GEMINI_CHROME_DEBUG_URL: chromeDebugUrlForProvider("gemini"),
    GEMSYNC_PROVIDER: "gemini",
  };
  if (body.autoCacheDecks) {
    env.DECKSYNC_AUTO_CACHE_AFTER_DECK = "1";
    env.DECKSYNC_MANAGER_URL = `http://${HOST}:${activePort}`;
    env.DECKSYNC_AUTO_CACHE_PAYLOAD_B64 = utf8Base64(JSON.stringify({ ...body, provider: "gemini", workspace }));
  }
  if (String(body.prePrompt || "").trim()) {
    env.GEMINI_PRE_PROMPT = String(body.prePrompt).trim();
    env.GEMINI_PRE_PROMPT_B64 = utf8Base64(String(body.prePrompt).trim());
  }
  if (body.maxSlides) env.MAX_SLIDES = String(body.maxSlides);
  return runJob({
    type: "gemini",
    title: "Gemini 自动提问",
    command: NODE,
    args: [script],
    cwd: workspace,
    env,
    logFiles: [log],
  });
}

async function startChatGptJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  await assertAskPreflight(workspace, "chatgpt");
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  await fsp.mkdir(screenshotRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const log = path.join(courseLogsRoot(workspace), `chatgpt-${stamp}.log`);
  const script = resolveAutomationScript("chatgpt_ppt_one_by_one.mjs");
  const env = {
    CHATGPT_PPT_ROOT: screenshotRoot,
    CHATGPT_PPT_PROMPT: body.prompt || DEFAULT_PROMPT,
    CHATGPT_PPT_PROMPT_B64: utf8Base64(body.prompt || DEFAULT_PROMPT),
    CHATGPT_PAGES_PER_PROMPT: String(normalizePagesPerPrompt(body.pagesPerPrompt, DEFAULT_PAGES_PER_PROMPT)),
    CHATGPT_MODEL: normalizeChatGptModel(body.model, DEFAULT_CHATGPT_MODEL),
    CHATGPT_THINKING_MODE: normalizeChatGptThinking(body.chatgptThinking, DEFAULT_CHATGPT_THINKING),
    CHATGPT_THINKING_EFFORT: normalizeChatGptThinkingEffort(body.chatgptThinkingEffort || body.chatgptThinking, DEFAULT_CHATGPT_THINKING_EFFORT),
    CHATGPT_CHROME_DEBUG_URL: chromeDebugUrlForProvider("chatgpt"),
    GEMSYNC_PROVIDER: "chatgpt",
    CHATGPT_PROVIDER: "chatgpt",
  };
  if (body.autoCacheDecks) {
    env.DECKSYNC_AUTO_CACHE_AFTER_DECK = "1";
    env.DECKSYNC_MANAGER_URL = `http://${HOST}:${activePort}`;
    env.DECKSYNC_AUTO_CACHE_PAYLOAD_B64 = utf8Base64(JSON.stringify({ ...body, provider: "chatgpt", workspace }));
  }
  if (String(body.prePrompt || "").trim()) {
    env.CHATGPT_PRE_PROMPT = String(body.prePrompt).trim();
    env.CHATGPT_PRE_PROMPT_B64 = utf8Base64(String(body.prePrompt).trim());
  }
  if (body.maxSlides) env.MAX_SLIDES = String(body.maxSlides);
  return runJob({
    type: "chatgpt",
    title: "ChatGPT 自动提问",
    command: NODE,
    args: [script],
    cwd: workspace,
    env,
    logFiles: [log],
  });
}

async function startAskJob(body) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  return provider === "chatgpt" ? startChatGptJob(body) : startGeminiJob(body);
}

async function assertAskPreflight(workspace, provider) {
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  const decks = await screenshotDecks(workspace);
  if (!fs.existsSync(screenshotRoot) || !decks.length) {
    throw new Error("还没有截图 Deck。请先扫描课程文件夹并点击“准备截图”，再启动自动问。");
  }
  const chrome = await chromeStatus(provider);
  if (!chrome.ok) {
    const label = normalizeProvider(provider) === "chatgpt" ? "ChatGPT" : "Gemini";
    throw new Error(`${label} 自动化 Chrome 端口未打开。请先点击“打开标签页”，确认已登录后再启动自动问。`);
  }
}

async function backupJsonIfExists(file, backupDir, stamp) {
  if (!fs.existsSync(file)) return "";
  await fsp.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file, ".json")}-${stamp}.json`);
  await fsp.copyFile(file, backup);
  return backup;
}

async function resetGeminiProgress(body) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  if (!fs.existsSync(screenshotRoot)) throw new Error("还没有截图目录，不能重置提问进度");

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = path.join(screenshotRoot, "archives", "progress-backups");
  const progressPath = providerProgressPath(screenshotRoot, provider);
  const foldersPath = providerConversationFoldersPath(screenshotRoot, provider);
  const backups = [
    await backupJsonIfExists(progressPath, backupDir, stamp),
    await backupJsonIfExists(foldersPath, backupDir, stamp),
  ].filter(Boolean);

  const now = new Date().toISOString();
  const decks = await screenshotDecks(workspace);
  await writeJson(progressPath, {
    provider,
    sent: {},
    conversations: {},
    responseIds: {},
    renamedTitles: {},
    renameResults: {},
    resetAt: now,
    updatedAt: now,
  });
  await writeJson(foldersPath, {
    version: 1,
    provider,
    root: screenshotRoot,
    updatedAt: now,
    folders: decks.map((deck) => ({
      deck: deck.folder,
      folder: deck.folder,
      folderPath: deck.folderPath,
      title: deck.title,
      conversationUrl: "",
      responseId: "",
      sent: 0,
      totalSlides: deck.slides,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })),
  });

  return {
    workspace,
    provider,
    screenshotRoot,
    decks: decks.length,
    backups,
    summary: await workspaceSummary(workspace),
  };
}

function findConversationForDeck(deck, index, progress, conversationFolders) {
  const folders = Array.isArray(conversationFolders?.folders) ? conversationFolders.folders : [];
  const byFolder = folders.find((item) => item.folder === deck.folder || item.deck === deck.folder);
  if (byFolder?.conversationUrl) return byFolder.conversationUrl;

  const conversations = progress?.conversations || {};
  if (conversations[deck.folder]) return conversations[deck.folder];

  const entries = Object.entries(conversations).sort(([a], [b]) => {
    const an = deckNumberFromName(a);
    const bn = deckNumberFromName(b);
    return an - bn;
  });
  const byDeckNumber = entries.find(([key]) => deckNumberFromName(key) === deck.deckNumber);
  if (byDeckNumber) return byDeckNumber[1];
  return entries[index]?.[1] || "";
}

async function findPdfForDeck(pdfs, deck, index, job = null) {
  const deckNumber = deck.deckNumber || index + 1;
  const expectedPages = Number(deck.slides || 0);
  const validateCandidate = async (file, source) => {
    if (!file) return "";
    if (!expectedPages) return file;
    const pages = await countPdfPages(file);
    if (!pages || pages === expectedPages) return file;
    if (job) appendJob(job, `WARN PDF page mismatch for ${deck.folder}: ${path.basename(file)} has ${pages} pages, screenshots have ${expectedPages} pages (${source})\n`);
    return "";
  };

  const deckTitle = comparableName(deck.title || deck.folder);
  const byTitle = pdfs.find((file) => {
    const name = comparableName(path.basename(file, ".pdf"));
    return deckTitle && (name.includes(deckTitle) || deckTitle.includes(name));
  });
  const titleMatch = await validateCandidate(byTitle, "title");
  if (titleMatch) return titleMatch;

  const numberPattern = new RegExp(`(?:^|[^0-9])0*${deckNumber}(?:[^0-9]|$)`);
  const byNumber = pdfs.find((file) => numberPattern.test(path.basename(file, ".pdf")));
  const numberMatch = await validateCandidate(byNumber, "number");
  if (numberMatch) return numberMatch;

  const fallbackMatch = await validateCandidate(pdfs[index] || "", "position");
  return fallbackMatch || "";
}

function subjectTitleKey(input) {
  return String(input || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function configPathForSubject(extensionRoot, subject) {
  const configUrl = String(subject?.configUrl || "").replace(/^\.\//, "");
  if (!configUrl) return "";
  const file = path.resolve(path.join(extensionRoot, "pdf-panel"), configUrl);
  const subjectRoot = path.resolve(path.join(extensionRoot, "pdf-panel", "subjects"));
  const relative = path.relative(subjectRoot, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? file : "";
}

function comparablePluginConfig(config) {
  return {
    provider: normalizeProvider(config?.provider || "gemini"),
    model: String(config?.model || "").trim(),
    course: subjectTitleKey(config?.course || ""),
    pagePrompt: String(config?.pagePrompt || "").trim(),
    prePrompt: String(config?.prePrompt || "").trim(),
    promptStartIndex: Number(config?.promptStartIndex || 1),
    pagesPerPrompt: normalizePagesPerPrompt(config?.pagesPerPrompt || 1),
    decks: (config?.decks || []).map((deck) => ({
      id: deck.id || "",
      title: String(deck.title || "").trim(),
      pdfUrl: deck.pdfUrl || "",
      provider: normalizeProvider(deck.provider || config?.provider || "gemini"),
      geminiUrl: deck.geminiUrl || "",
      chatgptUrl: deck.chatgptUrl || "",
      conversationId: deck.conversationId || "",
      transcriptUrl: deck.transcriptUrl || "",
      totalPages: Number(deck.totalPages || 0),
    })),
  };
}

function samePluginConfig(a, b) {
  return JSON.stringify(comparablePluginConfig(a)) === JSON.stringify(comparablePluginConfig(b));
}

function mergeSubjectEntry(subjects, entry) {
  const next = [];
  const removed = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  const entryTitleKey = subjectTitleKey(entry.title);
  let inserted = false;

  for (const item of subjects || []) {
    const itemTitleKey = subjectTitleKey(item.title);
    const sameEntry = item.id === entry.id || (entryTitleKey && itemTitleKey === entryTitleKey);
    const duplicate = seenIds.has(item.id) || (itemTitleKey && seenTitles.has(itemTitleKey));

    if (sameEntry) {
      if (!inserted) {
        next.push({ ...item, ...entry });
        inserted = true;
        seenIds.add(entry.id);
        if (entryTitleKey) seenTitles.add(entryTitleKey);
      } else {
        removed.push(item.id || item.title || "");
      }
      continue;
    }

    if (duplicate) {
      removed.push(item.id || item.title || "");
      continue;
    }

    next.push(item);
    if (item.id) seenIds.add(item.id);
    if (itemTitleKey) seenTitles.add(itemTitleKey);
  }

  if (!inserted) next.push(entry);
  return { subjects: next, removed };
}

async function ensureConversationFolders(screenshotRoot, decks, progress, conversationFolders, provider = "gemini") {
  if (!fs.existsSync(screenshotRoot) || !decks.length) return conversationFolders;

  const now = new Date().toISOString();
  const oldFolders = Array.isArray(conversationFolders?.folders) ? conversationFolders.folders : [];
  const oldByDeck = new Map();
  for (const item of oldFolders) {
    if (item?.folder) oldByDeck.set(item.folder, item);
    if (item?.deck) oldByDeck.set(item.deck, item);
  }

  const folders = decks.map((deck, index) => {
    const old = oldByDeck.get(deck.folder) || {};
    const conversationUrl = findConversationForDeck(deck, index, progress, conversationFolders);
    const totalSlides = deck.slides || old.totalSlides || 0;
    const sent = Number(progress?.sent?.[deck.folder] ?? old.sent ?? 0);
    const status = totalSlides > 0 && sent >= totalSlides
      ? "complete"
      : conversationUrl
        ? "in_progress"
        : "pending";
    return {
      deck: deck.folder,
      folder: deck.folder,
      folderPath: deck.folderPath || path.join(screenshotRoot, deck.folder),
      title: deck.title || titleFromDeckFolder(deck.folder),
      provider: normalizeProvider(provider),
      conversationUrl,
      responseId: old.responseId || "",
      sent,
      totalSlides,
      status,
      createdAt: old.createdAt || now,
      updatedAt: now,
    };
  });

  const next = {
    version: 1,
    provider: normalizeProvider(provider),
    root: screenshotRoot,
    updatedAt: now,
    folders,
  };
  await writeJson(providerConversationFoldersPath(screenshotRoot, provider), next);
  return next;
}

async function copyChatGptTranscriptIfExists({ screenshotRoot, subjectRoot, deckId, sourceDeck }) {
  const transcriptDir = providerTranscriptDirName("chatgpt");
  const sourceTranscript = path.join(screenshotRoot, transcriptDir, `${deckId}.json`);
  if (!fs.existsSync(sourceTranscript)) return "";

  const targetTranscript = path.join(subjectRoot, "transcripts", `${deckId}.json`);
  await fsp.mkdir(path.dirname(targetTranscript), { recursive: true });
  await fsp.copyFile(sourceTranscript, targetTranscript);

  const targetScreenshotDir = path.join(subjectRoot, "screenshots", deckId);
  await fsp.mkdir(targetScreenshotDir, { recursive: true });
  const pngs = await listFiles(sourceDeck.folderPath, [".png"]);
  for (const file of pngs) {
    await fsp.copyFile(file, path.join(targetScreenshotDir, path.basename(file)));
  }
  return `./transcripts/${deckId}.json`;
}

async function buildPluginSubject(body) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const workspace = path.resolve(body.workspace || "");
  const extensionRoot = DEFAULT_EXTENSION_ROOT;
  const title = normalizeTitle(body.title, folderTitleFromPath(workspace) || DEFAULT_SUBJECT_TITLE);
  const subjectEntryTitle = subjectTitleForProvider(title, provider);
  const requestedSubjectId = subjectIdForProvider(body.subjectId || title, provider);
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  if (!fs.existsSync(extensionRoot)) throw new Error("插件目录不存在");

  const summary = await workspaceSummary(workspace, { ...body, provider });
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  const progress = await readJson(providerProgressPath(screenshotRoot, provider), {});
  const pagePrompt = bodyString(body, "prompt", progress.modelSettings?.prompt || DEFAULT_PROMPT) || DEFAULT_PROMPT;
  const prePrompt = bodyString(body, "prePrompt", progress.modelSettings?.prePrompt || DEFAULT_PRE_PROMPT);
  const pagesPerPrompt = normalizePagesPerPrompt(body.pagesPerPrompt, progress.modelSettings?.pagesPerPrompt || DEFAULT_PAGES_PER_PROMPT);
  const promptStartIndex = prePrompt ? 2 : 1;
  let conversationFolders = await readJson(providerConversationFoldersPath(screenshotRoot, provider), null);
  const pdfs = await workspacePdfFiles(workspace);
  const decks = summary.decks.length
    ? summary.decks
    : pdfs.map((file, index) => ({
        folder: `${deckIdFromNumber(index + 1)}_${path.basename(file, ".pdf")}`,
        folderPath: "",
        deckNumber: index + 1,
        title: path.basename(file, ".pdf"),
        slides: 0,
      }));

  if (!decks.length) throw new Error("没有找到 PDF 或截图 deck");
  conversationFolders = await ensureConversationFolders(screenshotRoot, decks, progress, conversationFolders, provider);

  const invalidConfigBackupDir = path.join(extensionRoot, "pdf-panel", "archives", "invalid-configs");
  const subjectsPath = path.join(extensionRoot, "pdf-panel", "subjects.json");
  const subjectsRead = await readJsonOrBackupInvalid(
    subjectsPath,
    { version: 1, defaultSubject: requestedSubjectId, subjects: [] },
    invalidConfigBackupDir,
  );
  const subjectsConfig = subjectsRead.value;
  const existingSubjects = Array.isArray(subjectsConfig.subjects) ? subjectsConfig.subjects : [];
  const requestedTitleKey = subjectTitleKey(subjectEntryTitle);
  const existingSubject = existingSubjects.find((item) => subjectTitleKey(item.title) === requestedTitleKey)
    || existingSubjects.find((item) => item.id === requestedSubjectId);
  const subjectId = existingSubject?.id || requestedSubjectId;
  const subjectRoot = path.join(extensionRoot, "pdf-panel", "subjects", subjectId);
  const pdfDir = path.join(subjectRoot, "pdfs");
  const configPath = path.join(subjectRoot, "config.json");
  const existingConfigPath = configPathForSubject(extensionRoot, existingSubject);
  const existingConfigRead = existingConfigPath
    ? await readJsonOrBackupInvalid(existingConfigPath, null, invalidConfigBackupDir)
    : { value: null, backup: "" };
  const rawExistingConfig = existingConfigRead.value;
  const existingConfig = rawExistingConfig && normalizeProvider(rawExistingConfig.provider || "gemini") === provider
    ? rawExistingConfig
    : null;

  const configDecks = [];
  const pdfCopies = [];
  for (let index = 0; index < decks.length; index += 1) {
    const deck = decks[index];
    const deckId = deckIdFromNumber(deck.deckNumber || index + 1);
    const existingDeck = (existingConfig?.decks || []).find((item) => item.id === deckId);
    const sourcePdf = await findPdfForDeck(pdfs, deck, index, body.job || null);
    if (!sourcePdf) {
      appendJob(body.job || { log: "" }, `WARN no PDF for ${deck.folder}\n`);
      continue;
    }
    const targetPdf = path.join(pdfDir, `${deckId}.pdf`);
    pdfCopies.push({ sourcePdf, targetPdf });
    const totalPages = deck.slides || await countPdfPages(sourcePdf);
    const conversationUrl = findConversationForDeck(deck, index, progress, conversationFolders);
    const geminiUrl = provider === "gemini" ? withZh(conversationUrl) : "";
    const chatgptUrl = provider === "chatgpt" ? conversationUrl : "";
    const chatgptTranscriptUrl = provider === "chatgpt"
      ? await copyChatGptTranscriptIfExists({ screenshotRoot, subjectRoot, deckId, sourceDeck: deck })
      : "";
    configDecks.push({
      id: deckId,
      provider,
      title: deck.title || path.basename(sourcePdf, ".pdf"),
      pdfUrl: `./pdfs/${deckId}.pdf`,
      geminiUrl,
      ...(chatgptUrl ? { chatgptUrl } : {}),
      conversationId: provider === "chatgpt" ? String(progress?.responseIds?.[deck.folder] || "").trim() : conversationIdFromUrl(geminiUrl),
      totalPages,
      ...(chatgptTranscriptUrl || existingDeck?.transcriptUrl ? { transcriptUrl: chatgptTranscriptUrl || existingDeck.transcriptUrl } : {}),
    });
  }

  if (!configDecks.length) throw new Error("没有可写入插件的 PDF");

  const config = {
    version: 1,
    provider,
    model: normalizeProviderModel(provider, body.model || progress.modelSettings?.requestedModel),
    ...(provider === "chatgpt" ? {
      thinkingMode: normalizeChatGptThinking(body.chatgptThinking || progress.modelSettings?.thinkingMode, DEFAULT_CHATGPT_THINKING),
      thinkingEffort: normalizeChatGptThinkingEffort(body.chatgptThinkingEffort || body.chatgptThinking || progress.modelSettings?.thinkingEffort, DEFAULT_CHATGPT_THINKING_EFFORT),
    } : {}),
    course: title,
    pagePrompt,
    prePrompt,
    promptStartIndex,
    pagesPerPrompt,
    decks: configDecks,
  };
  const missingPromptMetadata = !!existingConfig && (
    !Object.prototype.hasOwnProperty.call(existingConfig, "prePrompt")
    || !Object.prototype.hasOwnProperty.call(existingConfig, "promptStartIndex")
    || !Object.prototype.hasOwnProperty.call(existingConfig, "pagesPerPrompt")
  );
  const alreadyImported = !!existingConfig && samePluginConfig(existingConfig, config) && !missingPromptMetadata;
  const entry = {
    id: subjectId,
    title: subjectEntryTitle,
    configUrl: `./subjects/${subjectId}/config.json`,
  };
  const merged = mergeSubjectEntry(existingSubjects, entry);
  subjectsConfig.version = 1;
  if (!subjectsConfig.defaultSubject || subjectsConfig.defaultSubject === requestedSubjectId || !merged.subjects.some((item) => item.id === subjectsConfig.defaultSubject)) {
    subjectsConfig.defaultSubject = subjectId;
  }
  subjectsConfig.subjects = merged.subjects;
  await writeJson(subjectsPath, subjectsConfig);

  if (!alreadyImported) {
    await fsp.mkdir(pdfDir, { recursive: true });
    for (const item of pdfCopies) await fsp.copyFile(item.sourcePdf, item.targetPdf);
    await writeJson(configPath, config);
  }

  return {
    subjectId,
    requestedSubjectId,
    provider,
    title,
    subjectRoot,
    configPath,
    conversationFoldersPath: providerConversationFoldersPath(screenshotRoot, provider),
    decks: configDecks.length,
    pagePrompt,
    prePrompt,
    promptStartIndex,
    pagesPerPrompt,
    missingGeminiUrls: provider === "gemini" ? configDecks.filter((deck) => !deck.geminiUrl).length : 0,
    missingChatGptTranscripts: provider === "chatgpt" ? configDecks.filter((deck) => !deck.transcriptUrl).length : 0,
    recoveredInvalidConfigs: [subjectsRead.backup, existingConfigRead.backup].filter(Boolean),
    alreadyImported,
    reusedExistingSubject: !!existingSubject && existingSubject.id !== requestedSubjectId,
    removedDuplicateSubjects: merged.removed,
  };
}

async function updatePluginJob(body) {
  const job = makeJob("plugin", "更新插件学科库");
  job.workspace = path.resolve(body.workspace || "");
  job.provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  try {
    const result = await buildPluginSubject({ ...body, job });
    if (result.alreadyImported) {
      appendJob(job, `ALREADY_IMPORTED ${result.title} -> ${result.subjectId}\n`);
    } else if (result.reusedExistingSubject) {
      appendJob(job, `UPDATED_EXISTING ${result.title} -> ${result.subjectId}\n`);
    } else {
      appendJob(job, `UPDATED ${result.configPath}\n`);
    }
    if (result.removedDuplicateSubjects?.length) {
      appendJob(job, `DEDUPED subjects: ${result.removedDuplicateSubjects.join(", ")}\n`);
    }
    appendJob(job, `DECKS ${result.decks}\n`);
    if (result.missingGeminiUrls) appendJob(job, `WARN missing Gemini URLs: ${result.missingGeminiUrls}\n`);
    if (result.missingChatGptTranscripts) appendJob(job, `WARN missing ChatGPT transcripts: ${result.missingChatGptTranscripts}\n`);
    for (const backup of result.recoveredInvalidConfigs || []) {
      appendJob(job, `RECOVERED invalid config backup: ${backup}\n`);
    }
    job.status = "complete";
    job.exitCode = 0;
    job.result = result;
  } catch (error) {
    appendJob(job, `ERROR ${error.message}\n`);
    job.status = "failed";
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

async function cacheGeminiTranscriptsJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");
  const selectedDecks = Array.isArray(body.cacheDecks)
    ? body.cacheDecks.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const requestedDecks = selectedDecks.length
    ? selectedDecks
    : (body.onlyDeck ? [String(body.onlyDeck).trim()].filter(Boolean) : []);
  if (Array.isArray(body.cacheDecks) && !selectedDecks.length) {
    throw new Error("请先勾选至少一个要生成离线缓存的对话");
  }

  const existingCacheSummary = await subjectCacheSummary(workspace, body);
  if (existingCacheSummary.configExists) {
    const existingById = new Map((existingCacheSummary.decks || []).map((deck) => [deck.id, deck]));
    const requestedForExisting = requestedDecks.length
      ? requestedDecks
      : (existingCacheSummary.decks || []).filter((deck) => deck.geminiUrl).map((deck) => deck.id);
    const stillNeedsCache = requestedForExisting.filter((id) => {
      const deck = existingById.get(id);
      return !deck || (deck.geminiUrl && !deck.cacheExists);
    });
    if (requestedForExisting.length && !stillNeedsCache.length) {
      throw new Error("已全部缓存，没有未缓存的 Gemini 对话需要生成");
    }
  }

  const pluginResult = await buildPluginSubject(body);
  const cacheSummary = await subjectCacheSummary(workspace, { ...body, subjectId: pluginResult.subjectId, title: pluginResult.title });
  const uncachedIds = new Set((cacheSummary.decks || [])
    .filter((deck) => deck.geminiUrl && !deck.cacheExists)
    .map((deck) => deck.id));
  const deckIdsToGenerate = requestedDecks.length
    ? requestedDecks.filter((id) => uncachedIds.has(id))
    : [...uncachedIds];
  if (!deckIdsToGenerate.length) {
    throw new Error("已全部缓存，没有未缓存的 Gemini 对话需要生成");
  }
  const screenshotRoot = screenshotRootForWorkspace(workspace);
  await fsp.mkdir(screenshotRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const log = path.join(courseLogsRoot(workspace), `cache-${stamp}.log`);
  const script = resolveAutomationScript("cache_gemini_subject.mjs");

  const job = runJob({
    type: "cache",
    title: "生成离线缓存",
    command: NODE,
    args: [
      script,
      "--workspace",
      workspace,
      "--root",
      screenshotRoot,
      "--subject-id",
      pluginResult.subjectId,
      "--title",
      pluginResult.title,
      "--extension-root",
      DEFAULT_EXTENSION_ROOT,
      "--chrome",
      CHROME_DEBUG_URL,
      "--prompt",
      bodyString(body, "prompt", DEFAULT_PROMPT) || DEFAULT_PROMPT,
      "--pre-prompt",
      pluginResult.prePrompt || "",
      "--prompt-start-index",
      String(pluginResult.promptStartIndex || 1),
      "--pages-per-prompt",
      String(pluginResult.pagesPerPrompt || 1),
      ...(deckIdsToGenerate.length ? ["--only-decks", deckIdsToGenerate.join(",")] : []),
    ],
    cwd: ROOT,
    logFiles: [log],
  });
  job.result = {
    subjectId: pluginResult.subjectId,
    title: pluginResult.title,
    subjectRoot: pluginResult.subjectRoot,
    configPath: pluginResult.configPath,
    selectedDecks: deckIdsToGenerate,
    cacheUrl: `/pdf-panel/cached-split.html#subject=${encodeURIComponent(pluginResult.subjectId)}${deckIdsToGenerate[0] ? `&deck=${encodeURIComponent(deckIdsToGenerate[0])}` : ""}`,
    log,
  };
  appendJob(job, `PLUGIN_READY ${pluginResult.title} -> ${pluginResult.subjectId}\n`);
  return job;
}

async function cacheChatGptTranscriptsJob(body) {
  const job = makeJob("cache", "生成 ChatGPT 离线缓存");
  job.workspace = path.resolve(body.workspace || "");
  job.provider = "chatgpt";
  try {
    const pluginResult = await buildPluginSubject({ ...body, provider: "chatgpt", job });
    const cacheSummary = await subjectCacheSummary(body.workspace, {
      ...body,
      provider: "chatgpt",
      subjectId: pluginResult.subjectId,
      title: pluginResult.title,
    });
    appendJob(job, `PLUGIN_READY ${pluginResult.title} -> ${pluginResult.subjectId}\n`);
    appendJob(job, `TRANSCRIPTS ${cacheSummary.transcriptDeckCount}/${cacheSummary.totalDecks}\n`);
    if (pluginResult.missingChatGptTranscripts) {
      appendJob(job, `WARN missing ChatGPT transcripts: ${pluginResult.missingChatGptTranscripts}\n`);
    }
    job.status = "complete";
    job.exitCode = 0;
    job.result = {
      subjectId: pluginResult.subjectId,
      title: pluginResult.title,
      subjectRoot: pluginResult.subjectRoot,
      configPath: pluginResult.configPath,
      cacheUrl: cacheSummary.openCacheUrl || `/pdf-panel/cached-split.html#subject=${encodeURIComponent(pluginResult.subjectId)}`,
    };
  } catch (error) {
    appendJob(job, `ERROR ${error.message}\n`);
    job.status = "failed";
    job.exitCode = 1;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

async function cacheTranscriptsJob(body) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  return provider === "chatgpt" ? cacheChatGptTranscriptsJob(body) : cacheGeminiTranscriptsJob(body);
}

async function chromeStatus(provider = DEFAULT_PROVIDER) {
  const debugUrl = chromeDebugUrlForProvider(provider);
  try {
    const response = await fetch(`${debugUrl}/json/version`);
    const data = await response.json();
    return { ok: true, browser: data.Browser || "", debugUrl };
  } catch {
    return { ok: false, debugUrl };
  }
}

async function waitForChromeStatus(provider = DEFAULT_PROVIDER, timeoutMs = 15000) {
  const started = Date.now();
  let last = await chromeStatus(provider);
  while (!last.ok && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    last = await chromeStatus(provider);
  }
  return last;
}

async function openChromeDebugTab(url = GEMINI_URL, provider = DEFAULT_PROVIDER) {
  const debugUrl = chromeDebugUrlForProvider(provider);
  const response = await fetch(`${debugUrl}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  });
  if (!response.ok) throw new Error(`无法在自动化 Chrome 里打开新标签页：${response.status}`);
  const target = await response.json();
  return {
    id: target.id || "",
    title: target.title || "",
    url: target.url || url,
  };
}

async function startChromeDebug(body) {
  const provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const targetUrl = provider === "chatgpt" ? CHATGPT_URL : GEMINI_URL;
  const debugUrl = chromeDebugUrlForProvider(provider);
  const status = await chromeStatus(provider);
  if (status.ok) {
    const tab = await openChromeDebugTab(targetUrl, provider);
    return { alreadyRunning: true, openedTab: true, tab, ...status };
  }
  const workspace = path.resolve(body.workspace || ROOT);
  const profile = chromeProfileRoot(workspace, provider);
  const port = chromeDebugPort(debugUrl);
  if (commandPathMissing(CHROME)) throw new Error(`Chrome not found: ${CHROME}`);
  spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--profile-directory=Default",
    "--no-first-run",
    targetUrl,
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  }).unref();
  const launchedStatus = await waitForChromeStatus(provider);
  return {
    alreadyRunning: false,
    openedTab: false,
    launched: true,
    profile,
    debugUrl,
    ...launchedStatus,
    ready: launchedStatus.ok,
    message: launchedStatus.ok
      ? "Chrome DevTools endpoint is ready"
      : "Chrome was launched, but the DevTools endpoint did not become ready yet. Wait a few seconds and refresh state.",
  };
}

async function organizeWorkspaceJob(body) {
  const workspace = path.resolve(body.workspace || "");
  if (!fs.existsSync(workspace)) throw new Error("学科文件夹不存在");

  const job = makeJob("organize", "整理课程目录");
  job.workspace = workspace;
  job.provider = normalizeProvider(body.provider, DEFAULT_PROVIDER);
  const result = { workspace, dataRoot: courseDataRoot(workspace), moved: [], skipped: [] };

  try {
    await fsp.mkdir(courseDataRoot(workspace), { recursive: true });
    await moveIfExists(legacyScreenshotRoot(workspace), newScreenshotRoot(workspace), "shots", result);
    await moveIfExists(
      path.join(workspace, "chrome-gemini-automation-profile"),
      chromeProfileRoot(workspace, "gemini"),
      "gemini-profile",
      result,
    );
    await moveIfExists(
      path.join(workspace, "chrome-chatgpt-automation-profile"),
      chromeProfileRoot(workspace, "chatgpt"),
      "chatgpt-profile",
      result,
    );
    await moveIfExists(
      path.join(workspace, "gemini_ppt_one_by_one.mjs"),
      path.join(courseDataRoot(workspace), "old", "gemini_ppt_one_by_one.mjs"),
      "old-runner",
      result,
    );

    for (const log of await listFilesFlat(workspace, [".log"])) {
      if (!/^manager_|^gemini_|^chatgpt_|^cache-/i.test(path.basename(log))) continue;
      await moveIfExists(log, path.join(courseLogsRoot(workspace), path.basename(log)), "log", result);
    }

    appendJob(job, `DATA_ROOT ${result.dataRoot}\n`);
    for (const item of result.moved) appendJob(job, `MOVED ${item.label}: ${item.source} -> ${item.target}\n`);
    for (const item of result.skipped) appendJob(job, `SKIP ${item.label}: ${item.target} (${item.reason})\n`);
    job.status = "complete";
    job.exitCode = 0;
    job.result = result;
  } catch (error) {
    appendJob(job, `ERROR ${error.message}\n`);
    job.status = "failed";
    job.exitCode = 1;
    job.result = result;
  } finally {
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

async function pickFolder(body) {
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:GEMSYNC_PICKER_TITLE
$dialog.ShowNewFolderButton = $true
if ($env:GEMSYNC_PICKER_INITIAL -and (Test-Path -LiteralPath $env:GEMSYNC_PICKER_INITIAL)) {
  $dialog.SelectedPath = $env:GEMSYNC_PICKER_INITIAL
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
$owner.ShowInTaskbar = $false
$owner.Show()
$owner.Hide()
$result = $dialog.ShowDialog($owner)
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      env: {
        ...process.env,
        GEMSYNC_PICKER_TITLE: body.title || "选择文件夹",
        GEMSYNC_PICKER_INITIAL: body.initialPath || "",
      },
      windowsHide: false,
    });

    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `文件夹选择器退出失败：${code}`));
        return;
      }
      resolve(output.trim());
    });
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/state") {
    const extension = await extensionSubjects(DEFAULT_EXTENSION_ROOT);
    const chromeByProvider = {
      gemini: await chromeStatus("gemini"),
      chatgpt: await chromeStatus("chatgpt"),
    };
    sendJson(res, 200, {
      ok: true,
      defaults: {
        appName: APP_NAME,
        dataDirName: COURSE_DATA_DIR,
        shotsDirName: SCREENSHOTS_DIR,
        managerPort: activePort,
        requestedManagerPort: REQUESTED_PORT,
        workspace: DEFAULT_WORKSPACE,
        subjectId: DEFAULT_SUBJECT_ID,
        subjectTitle: DEFAULT_SUBJECT_TITLE,
        provider: DEFAULT_PROVIDER,
        prePrompt: DEFAULT_PRE_PROMPT,
        prompt: DEFAULT_PROMPT,
        pagesPerPrompt: DEFAULT_PAGES_PER_PROMPT,
        model: DEFAULT_PROVIDER === "chatgpt" ? DEFAULT_CHATGPT_MODEL : DEFAULT_GEMINI_MODEL,
        geminiModel: DEFAULT_GEMINI_MODEL,
        chatgptModel: DEFAULT_CHATGPT_MODEL,
        chatgptThinking: DEFAULT_CHATGPT_THINKING,
        chatgptThinkingEffort: DEFAULT_CHATGPT_THINKING_EFFORT,
        proFallback: DEFAULT_PRO_FALLBACK,
        extensionRoot: DEFAULT_EXTENSION_ROOT,
        automationScriptsRoot: AUTOMATION_SCRIPTS_ROOT,
        nodePath: NODE,
        pythonPath: PYTHON,
        pdfinfoPath: PDFINFO,
        pdftoppmPath: PDFTOPPM,
        chromePath: CHROME,
        geminiChromeDebugUrl: GEMINI_CHROME_DEBUG_URL,
        chatgptChromeDebugUrl: CHATGPT_CHROME_DEBUG_URL,
      },
      extension,
      jobs: [...jobs.values()].map(publicJob),
      chrome: chromeByProvider[DEFAULT_PROVIDER] || chromeByProvider.gemini,
      chromeByProvider,
    });
    return;
  }

  if (url.pathname === "/api/pick-folder" && req.method === "POST") {
    const folderPath = await pickFolder(await readJsonBody(req));
    sendJson(res, 200, { ok: true, path: folderPath, canceled: !folderPath });
    return;
  }

  if (url.pathname === "/api/scan" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, summary: await workspaceSummary(body.workspace, body) });
    return;
  }

  if (url.pathname === "/api/progress/current" && req.method === "POST") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { ok: true, result: await workspaceProgress(body.workspace, body) });
    return;
  }

  if (url.pathname === "/api/chrome/start" && req.method === "POST") {
    sendJson(res, 200, { ok: true, result: await startChromeDebug(await readJsonBody(req)) });
    return;
  }

  if (url.pathname === "/api/jobs/prepare" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await prepareScreenshotsJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/gemini" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await startGeminiJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/chatgpt" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await startChatGptJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/ask" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await startAskJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/progress/reset" && req.method === "POST") {
    sendJson(res, 200, { ok: true, result: await resetGeminiProgress(await readJsonBody(req)) });
    return;
  }

  if (url.pathname === "/api/jobs/plugin" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await updatePluginJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/cache" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await cacheTranscriptsJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/jobs/organize" && req.method === "POST") {
    sendJson(res, 200, { ok: true, job: publicJob(await organizeWorkspaceJob(await readJsonBody(req))) });
    return;
  }

  if (url.pathname === "/api/command" && req.method === "POST") {
    const command = makeCommand(await readJsonBody(req));
    sendJson(res, 200, { ok: true, id: command.id });
    return;
  }

  if (url.pathname === "/api/command") {
    cleanupCommands();
    const conversationId = String(url.searchParams.get("conversationId") || "").trim();
    const queue = commandQueues.get(conversationId) || [];
    const id = queue.shift();
    if (queue.length) commandQueues.set(conversationId, queue);
    else commandQueues.delete(conversationId);
    const command = id ? commands.get(id) : null;
    sendJson(res, 200, { ok: true, command: command ? { id: command.id, type: command.type, payload: command.payload } : null });
    return;
  }

  if (url.pathname === "/api/result" && req.method === "POST") {
    const body = await readJsonBody(req);
    const command = commands.get(String(body.id || ""));
    if (!command) return notFound(res);
    command.result = {
      ok: body.ok !== false,
      error: body.error || "",
      ...body,
    };
    sendJson(res, 200, { ok: true });
    return;
  }

  const commandResultMatch = /^\/api\/result\/([^/]+)$/.exec(url.pathname);
  if (commandResultMatch) {
    cleanupCommands();
    const command = commands.get(decodeURIComponent(commandResultMatch[1]));
    if (!command) return notFound(res);
    sendJson(res, 200, { ok: true, pending: !command.result, result: command.result || null });
    return;
  }

  if (url.pathname === "/api/jobs/clear-finished" && req.method === "POST") {
    let removed = 0;
    for (const [id, job] of jobs) {
      if (job.status !== "running") {
        jobs.delete(id);
        removed += 1;
      }
    }
    sendJson(res, 200, { ok: true, removed, jobs: [...jobs.values()].map(publicJob) });
    return;
  }

  if (url.pathname === "/api/jobs") {
    sendJson(res, 200, { ok: true, jobs: [...jobs.values()].map(publicJob) });
    return;
  }

  const logMatch = /^\/api\/jobs\/([^/]+)\/log$/.exec(url.pathname);
  if (logMatch) {
    const job = jobs.get(decodeURIComponent(logMatch[1]));
    if (!job) return notFound(res);
    sendJson(res, 200, { ok: true, job: publicJob(job), log: job.log });
    return;
  }

  const clearLogMatch = /^\/api\/jobs\/([^/]+)\/log\/clear$/.exec(url.pathname);
  if (clearLogMatch && req.method === "POST") {
    const job = jobs.get(decodeURIComponent(clearLogMatch[1]));
    if (!job) return notFound(res);
    job.log = "";
    sendJson(res, 200, { ok: true, job: publicJob(job), log: job.log });
    return;
  }

  const stopMatch = /^\/api\/jobs\/([^/]+)\/stop$/.exec(url.pathname);
  if (stopMatch && req.method === "POST") {
    const job = jobs.get(decodeURIComponent(stopMatch[1]));
    if (!job) return notFound(res);
    if (job.child && job.status === "running") {
      job.child.kill();
      appendJob(job, "\nSTOP requested\n");
    }
    sendJson(res, 200, { ok: true, job: publicJob(job) });
    return;
  }

  notFound(res);
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    title: job.title,
    provider: job.provider || "",
    workspace: job.workspace || "",
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    pid: job.pid,
    result: job.result || null,
  };
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/favicon.ico") {
    send(res, 204, "");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const panelPrefix = "/pdf-panel/";
  const servingPdfPanel = pathname.startsWith(panelPrefix);
  const staticRoot = servingPdfPanel ? path.join(DEFAULT_EXTENSION_ROOT, "pdf-panel") : APP_ROOT;
  const relativePath = servingPdfPanel ? pathname.slice(panelPrefix.length - 1) : pathname;
  const file = path.resolve(staticRoot, `.${relativePath}`);
  if (!file.startsWith(staticRoot)) return notFound(res);
  fs.readFile(file, (error, data) => {
    if (error) return notFound(res);
    send(res, 200, data, {
      "Content-Type": MIME.get(path.extname(file).toLowerCase()) || "application/octet-stream",
    });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${activePort}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((error) => {
      const status = error instanceof SyntaxError ? 400 : 500;
      sendJson(res, status, { ok: false, error: error.message });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return badRequest(res, "Unsupported method");
  serveStatic(req, res, url);
});

function listenWithPortFallback(port, remainingAttempts = 99) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && remainingAttempts > 0) {
      const nextPort = port + 1;
      console.warn(`${APP_NAME} port ${port} is busy, trying ${nextPort}`);
      listenWithPortFallback(nextPort, remainingAttempts - 1);
      return;
    }
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

  activePort = port;
  server.listen(port, HOST, () => {
    console.log(`${APP_NAME} running at http://${HOST}:${port}`);
  });
}

listenWithPortFallback(REQUESTED_PORT);
