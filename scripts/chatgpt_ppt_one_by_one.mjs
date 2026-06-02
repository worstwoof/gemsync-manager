import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function asImportSpecifier(candidate) {
  if (!candidate) return null;
  if (/^[a-z]+:\/\//i.test(candidate) || (!candidate.includes("\\") && !candidate.includes("/"))) return candidate;
  return pathToFileURL(candidate).href;
}

async function addPnpmPlaywrightCandidates(candidates, nodeModules) {
  const pnpmDir = path.join(nodeModules, ".pnpm");
  let entries = [];
  try {
    entries = await fs.readdir(pnpmDir, { withFileTypes: true });
  } catch {
    return;
  }

  const addPackages = (prefix, packageName) => {
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .forEach((entry) => {
        candidates.push(pathToFileURL(path.join(pnpmDir, entry, "node_modules", packageName, "index.mjs")).href);
      });
  };

  addPackages("playwright-core@", "playwright-core");
  addPackages("playwright@", "playwright");
}

async function importPlaywright() {
  const candidates = [
    asImportSpecifier(process.env.PLAYWRIGHT_IMPORT_PATH),
    "playwright",
    "playwright-core",
  ].filter(Boolean);

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    const runtimeNodeModules = path.join(
      userProfile,
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules",
    );
    await addPnpmPlaywrightCandidates(candidates, runtimeNodeModules);
    candidates.push(pathToFileURL(path.join(runtimeNodeModules, "playwright", "index.mjs")).href);
    candidates.push(pathToFileURL(path.join(runtimeNodeModules, "playwright-core", "index.mjs")).href);
  }

  const errors = [];
  for (const candidate of candidates) {
    try {
      return await import(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(
    `Unable to import Playwright. Set PLAYWRIGHT_IMPORT_PATH to playwright/index.mjs or playwright-core/index.mjs. Tried:\n${errors.join("\n")}`,
  );
}

const { chromium } = await importPlaywright();

const chromeDebugUrl = process.env.CHATGPT_CHROME_DEBUG_URL
  || process.env.GEMINI_CHROME_DEBUG_URL
  || "http://127.0.0.1:9222";
const root = path.resolve(process.env.CHATGPT_PPT_ROOT || path.join(process.cwd(), "DeckSync", "shots"));
const progressPath = path.resolve(process.env.CHATGPT_PROGRESS_PATH || path.join(root, "chatgpt_progress.json"));
const conversationFoldersPath = path.resolve(process.env.CHATGPT_CONVERSATION_FOLDERS_PATH || path.join(root, "chatgpt_conversation_folders.json"));
const transcriptRoot = path.resolve(process.env.CHATGPT_TRANSCRIPT_ROOT || path.join(root, "chatgpt_transcripts"));
function envUtf8(name, fallback = "") {
  const encoded = process.env[`${name}_B64`];
  if (encoded) {
    try {
      return Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      // Fall back to the plain environment variable.
    }
  }
  return process.env[name] || fallback;
}
const promptText = envUtf8("CHATGPT_PPT_PROMPT", "请详细讲解这一面PPT");
const prePromptText = String(envUtf8("CHATGPT_PRE_PROMPT", "")).trim();
const pagesPerPrompt = Math.max(1, Math.min(3, Math.floor(Number(process.env.CHATGPT_PAGES_PER_PROMPT || "1") || 1)));
const maxSlides = Number(process.env.MAX_SLIDES || "0");
const configOnly = /^(1|true|yes)$/i.test(String(process.env.CHATGPT_CONFIG_ONLY || ""));
const dryRun = /^(1|true|yes)$/i.test(String(process.env.DECKSYNC_AUTOMATION_DRY_RUN || process.env.CHATGPT_DRY_RUN || ""));
const autoCacheAfterDeck = /^(1|true|yes)$/i.test(String(process.env.DECKSYNC_AUTO_CACHE_AFTER_DECK || ""));
const managerUrl = String(process.env.DECKSYNC_MANAGER_URL || "").replace(/\/+$/g, "");
const autoCachePayload = readAutoCachePayload();
const model = normalizeChatGptWebModel(process.env.CHATGPT_MODEL || "5.5");
const thinkingMode = normalizeChatGptThinkingMode(process.env.CHATGPT_THINKING_MODE || "thinking");
const thinkingEffort = normalizeChatGptThinkingEffort(process.env.CHATGPT_THINKING_EFFORT || "advanced");
const uploadSettleMs = Number(process.env.CHATGPT_UPLOAD_SETTLE_MS || "12000");
const composerReadyTimeoutMs = Number(process.env.CHATGPT_COMPOSER_READY_TIMEOUT_MS || "120000");
const submitTimeoutMs = Number(process.env.CHATGPT_SUBMIT_TIMEOUT_MS || "120000");
const responseTimeoutMs = Number(process.env.CHATGPT_RESPONSE_TIMEOUT_MS || "900000");
const stableResponsePolls = Math.max(3, Number(process.env.CHATGPT_RESPONSE_STABLE_POLLS || "8"));

const CHATGPT_HOME = "https://chatgpt.com/";
const PROMPT_BOX_SELECTOR = [
  "#prompt-textarea",
  "[data-testid='prompt-textarea']",
  "textarea[placeholder*='Message']",
  "textarea[placeholder*='发送']",
  "textarea[placeholder*='询问']",
  "div[contenteditable='true'][role='textbox']",
  "div[contenteditable='true']",
].join(", ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readAutoCachePayload() {
  const encoded = process.env.DECKSYNC_AUTO_CACHE_PAYLOAD_B64 || "";
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function apiJson(pathname, options = {}) {
  if (!managerUrl) throw new Error("DeckSync manager URL is missing.");
  const response = await fetch(`${managerUrl}${pathname}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `DeckSync API ${pathname} failed with ${response.status}`);
  return data;
}

async function waitForManagerJob(jobId) {
  while (jobId) {
    const data = await apiJson(`/api/jobs/${encodeURIComponent(jobId)}/log`);
    if (data.job?.status !== "running") return data.job;
    await sleep(2000);
  }
  return null;
}

async function autoCacheDeck(deck, slides) {
  if (!autoCacheAfterDeck || !autoCachePayload || !managerUrl) return;
  const totalSlides = Array.isArray(slides) ? slides.length : Number(slides || 0);
  const sentSlides = Number(progress.sent?.[deck] || 0);
  const deckId = deckIdFromFolder(deck);
  if (!totalSlides || sentSlides < totalSlides) {
    console.log(`AUTO_CACHE_SKIP_INCOMPLETE ${deck} sent=${sentSlides}/${totalSlides || "unknown"}`);
    return;
  }
  try {
    console.log(`AUTO_CACHE_START ${deck} -> ${deckId}`);
    const data = await apiJson("/api/jobs/cache", {
      method: "POST",
      body: JSON.stringify({ ...autoCachePayload, provider: "chatgpt", cacheDecks: [deckId] }),
    });
    const job = await waitForManagerJob(data.job?.id);
    if (job?.status === "complete") console.log(`AUTO_CACHE_DONE ${deck} -> ${deckId}`);
    else console.log(`AUTO_CACHE_FAILED ${deck} -> ${deckId} status=${job?.status || "unknown"}`);
  } catch (error) {
    console.log(`AUTO_CACHE_FAILED ${deck} -> ${deckId} message="${error instanceof Error ? error.message : String(error)}"`);
  }
}

class ChatGptQuotaError extends Error {
  constructor(info = {}) {
    super(info.message || "ChatGPT web quota or rate limit is currently unavailable.");
    this.name = "ChatGptQuotaError";
    this.info = info;
  }
}

function quotaInfoFromText(text, phase = "unknown") {
  const sample = String(text || "").replace(/\s+/g, " ").trim();
  if (!sample) return null;
  const patterns = [
    { reason: "message_cap", regex: /you(?:'|’)?ve reached.{0,100}limit/i },
    { reason: "message_cap", regex: /message cap|usage cap|limit will reset|try again after|try again tomorrow/i },
    { reason: "rate_limited", regex: /rate limit|too many requests|slow down|temporarily unavailable|something went wrong/i },
    { reason: "upgrade_required", regex: /upgrade (?:to|your plan)|get plus|需要升级|升级.*套餐/i },
    { reason: "quota_wait", regex: /额度|上限|达到.*限制|稍后再试|明天再试|使用量|请求过多|暂时无法/i },
  ];
  const hit = patterns.find((item) => item.regex.test(sample));
  if (!hit) return null;
  const resetMatch = sample.match(/(?:after|at|until)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|tomorrow|later)/i);
  return {
    phase,
    reason: hit.reason,
    message: sample.slice(0, 500),
    resetHint: resetMatch?.[1] || "",
    detectedAt: new Date().toISOString(),
  };
}

async function detectChatGptQuotaState(page, phase = "unknown") {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const nodes = Array.from(document.querySelectorAll([
      "[role='alert']",
      "[data-testid*='toast']",
      "[data-testid*='error']",
      "[class*='toast']",
      "[class*='error']",
      "main",
      "body",
    ].join(","))).filter(visible);
    const text = nodes
      .map((node) => node.innerText || node.textContent || "")
      .join("\n")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);
    return { text, url: location.href };
  }).then((state) => {
    const info = quotaInfoFromText(state.text, phase);
    return info ? { ...info, url: state.url } : null;
  }).catch(() => null);
}

async function throwIfChatGptQuota(page, phase) {
  const quota = await detectChatGptQuotaState(page, phase);
  if (quota) throw new ChatGptQuotaError(quota);
}

if (/^(1|true|yes)$/i.test(String(process.env.CHATGPT_QUOTA_SELF_TEST || ""))) {
  const samples = [
    "You've reached the current GPT-5 message limit. Please try again later.",
    "You have hit the message cap. Try again after 8:00 PM.",
    "请求过多，请稍后再试。",
  ];
  for (const sample of samples) {
    if (!quotaInfoFromText(sample, "self_test")) throw new Error(`Quota self-test did not detect: ${sample}`);
  }
  console.log("CHATGPT_QUOTA_SELF_TEST passed");
  process.exit(0);
}

function normalizeChatGptWebModel(input) {
  const raw = String(input || "5.5").trim().toLowerCase();
  if (!raw) return "5.5";
  const value = raw.replace(/^gpt[-_\s]*/i, "");
  if (["5.5", "5.4", "5.3", "5.2", "o3"].includes(value)) return value;
  return "5.5";
}

function normalizeChatGptThinkingMode(input) {
  const value = String(input || "thinking").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (["thinking", "instant"].includes(value)) return value;
  if (value.startsWith("thinking-")) return "thinking";
  return "thinking";
}

function normalizeChatGptThinkingEffort(input) {
  const raw = String(input || "advanced").trim();
  const value = raw.toLowerCase().replace(/[\s_]+/g, "-");
  if (["advanced", "standard"].includes(value)) return value;
  if (value.includes("standard")) return "standard";
  if (value.includes("advanced")) return "advanced";
  if (["进阶", "進階"].includes(raw)) return "advanced";
  if (raw === "标准") return "standard";
  return "advanced";
}

function chatGptThinkingModeForModel(modelName, requestedMode) {
  const normalized = normalizeChatGptWebModel(modelName);
  if (normalized === "o3") return "";
  if (normalized === "5.3") return "instant";
  return normalizeChatGptThinkingMode(requestedMode);
}

function chatGptSupportsThinkingEffort(modelName, modeName) {
  const normalized = normalizeChatGptWebModel(modelName);
  return ["5.5", "5.4", "5.2"].includes(normalized) && modeName === "thinking";
}

function normalizePromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function promptMatches(actual, expected) {
  return normalizePromptText(actual) === normalizePromptText(expected);
}

function deckNumberFromName(name) {
  return Number(/^deck(\d+)/i.exec(name || "")?.[1] || 0);
}

function deckIdFromFolder(deck) {
  const number = deckNumberFromName(deck);
  return number ? `deck${String(number).padStart(2, "0")}` : String(deck || "deck");
}

function deckTitle(deck) {
  return String(deck || "")
    .replace(/^deck\d+_/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    || String(deck || "Deck");
}

function pageRangeLabel(start, end) {
  return start === end ? `${start}` : `${start}-${end}`;
}

function buildPrompt(slideNumber, endSlideNumber) {
  const start = Math.max(1, Number(slideNumber) || 1);
  const end = Math.max(start, Number(endSlideNumber) || start);
  if (end <= start) return promptText;
  return `${promptText}\n\n本次上传的是第 ${start}-${end} 页 PPT，请按页码顺序分别讲解。`;
}

function parseChatGptConversationId(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      const backup = await backupInvalidJson(file);
      console.log(`WARN invalid JSON backed up: ${backup}`);
    }
    return fallback;
  }
}

async function backupInvalidJson(file) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupDir = path.join(root, "archives", "invalid-json");
  await fs.mkdir(backupDir, { recursive: true });
  const backup = path.join(backupDir, `${path.basename(file, ".json")}.invalid-${stamp}.json`);
  await fs.copyFile(file, backup);
  return backup;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await cleanupStaleJsonTemps(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupStaleJsonTemps(file, maxAgeMs = 24 * 60 * 60 * 1000) {
  const dir = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const cutoff = Date.now() - maxAgeMs;
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(".tmp"))
    .map(async (entry) => {
      const temp = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(temp);
        if (stat.mtimeMs < cutoff) await fs.rm(temp, { force: true });
      } catch {
        // Ignore cleanup races.
      }
    }));
}

async function readProgress() {
  const progress = await readJson(progressPath, {
    sent: {},
    conversations: {},
    conversationIds: {},
    responseIds: {},
    prePromptSent: {},
    renamedTitles: {},
  });
  progress.sent ??= {};
  progress.conversations ??= {};
  progress.conversationIds ??= {};
  progress.responseIds ??= {};
  progress.prePromptSent ??= {};
  progress.renamedTitles ??= {};
  return progress;
}

async function writeProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  progress.provider = "chatgpt";
  progress.modelSettings = {
    provider: "chatgpt",
    requestedModel: model,
    thinkingMode,
    thinkingEffort,
    prompt: promptText,
    prePrompt: prePromptText,
    pagesPerPrompt,
    mode: "web",
    updatedAt: new Date().toISOString(),
  };
  await writeJson(progressPath, progress);
}

async function listDecks() {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^deck\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => deckNumberFromName(a) - deckNumberFromName(b));
}

async function listSlides(deck) {
  const deckPath = path.join(root, deck);
  const files = await fs.readdir(deckPath);
  return files
    .filter((name) => /^deck\d+_slide\d+\.png$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(deckPath, name));
}

async function readTranscript(deckId, title, totalPages) {
  const file = path.join(transcriptRoot, `${deckId}.json`);
  const transcript = await readJson(file, null);
  if (transcript?.version === 1 && Array.isArray(transcript.records)) return transcript;
  return {
    version: 1,
    title: `${title} - ChatGPT 全记录缓存`,
    deckId,
    totalPages,
    conversationUrl: "",
    provider: "chatgpt",
    model,
    thinkingMode,
    thinkingEffort,
    prompt: promptText,
    prePrompt: prePromptText,
    promptStartIndex: prePromptText ? 2 : 1,
    pagesPerPrompt,
    source: {
      type: "chatgpt-web",
      extractor: "decksync",
      note: "assistantText is captured from the logged-in ChatGPT web conversation in the automation Chrome profile.",
    },
    pageMapping: {
      pagesPerPrompt,
      rule: "Each ChatGPT web record with uploaded images consumes the matching PDF page range.",
    },
    records: [],
  };
}

async function writeTranscript(transcript) {
  transcript.updatedAt = new Date().toISOString();
  transcript.exportedAt ||= transcript.updatedAt;
  await writeJson(path.join(transcriptRoot, `${transcript.deckId}.json`), transcript);
}

async function readConversationFolders() {
  const data = await readJson(conversationFoldersPath, { version: 1, root, folders: [] });
  if (!Array.isArray(data.folders)) data.folders = [];
  return data;
}

async function updateConversationFolderIndex(progress, deck, slides, conversationUrl = "") {
  const data = await readConversationFolders();
  const now = new Date().toISOString();
  const sent = progress.sent?.[deck] || 0;
  const url = conversationUrl || progress.conversations?.[deck] || "";
  const conversationId = parseChatGptConversationId(url) || progress.conversationIds?.[deck] || progress.responseIds?.[deck] || "";
  const index = data.folders.findIndex((entry) => entry.deck === deck || entry.folder === deck);
  const prior = index >= 0 ? data.folders[index] : {};
  const entry = {
    ...prior,
    deck,
    folder: deck,
    folderPath: path.join(root, deck),
    title: deckTitle(deck),
    provider: "chatgpt",
    conversationUrl: url || prior.conversationUrl || "",
    conversationId: conversationId || prior.conversationId || "",
    responseId: conversationId || prior.responseId || "",
    sent,
    totalSlides: slides.length,
    status: sent >= slides.length ? "complete" : (url ? "in_progress" : "pending"),
    createdAt: prior.createdAt || now,
    updatedAt: now,
  };
  if (index >= 0) data.folders[index] = entry;
  else data.folders.push(entry);
  data.root = root;
  data.provider = "chatgpt";
  data.updatedAt = now;
  data.folders.sort((a, b) => String(a.deck || "").localeCompare(String(b.deck || ""), undefined, { numeric: true }));
  await writeJson(conversationFoldersPath, data);
}

async function gotoChatGpt(page, url, label) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`NAV_WARN ${label} domcontentloaded_timeout current="${page.url()}" message="${message.replace(/\s+/g, " ").slice(0, 240)}"`);
  }

  if (!/chatgpt\.com|chat\.openai\.com/i.test(page.url())) {
    await page.goto(url, { waitUntil: "commit", timeout: 30000 });
  }
}

async function getChatGptPage() {
  const browser = await chromium.connectOverCDP(chromeDebugUrl, { timeout: 90000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("没有找到自动化 Chrome 上下文，请先在管理器里打开 ChatGPT 标签页。");

  const page = await context.newPage();
  await page.bringToFront();
  await gotoChatGpt(page, CHATGPT_HOME, "chatgpt_home");
  await waitForComposer(page);
  return { browser, page };
}

async function waitForComposer(page, timeout = composerReadyTimeoutMs) {
  try {
    await page.locator(PROMPT_BOX_SELECTOR).last().waitFor({ state: "visible", timeout });
  } catch (error) {
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    const snippet = bodyText.replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(`ChatGPT 页面没有出现输入框。请先在自动化 Chrome 里完成网页登录，然后重试。当前页面：${page.url()} ${snippet ? `页面文字：${snippet}` : ""}`);
  }
}

async function openNewChat(page) {
  await gotoChatGpt(page, CHATGPT_HOME, "new_chat");
  await waitForComposer(page);
}

async function openConversation(page, conversationUrl) {
  if (conversationUrl && /^https?:\/\//i.test(conversationUrl)) {
    await gotoChatGpt(page, conversationUrl, "resume_conversation");
  } else {
    await openNewChat(page);
  }
  await waitForComposer(page);
}

async function getComposerLocator(page) {
  await waitForComposer(page);
  return page.locator(PROMPT_BOX_SELECTOR).last();
}

async function clearComposerText(page) {
  const box = await getComposerLocator(page);
  await box.click({ timeout: 15000 });
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await sleep(300);
}

async function typePrompt(page, text) {
  const box = await getComposerLocator(page);
  await box.click({ timeout: 15000 });
  try {
    await box.fill("");
    await box.fill(text);
    return;
  } catch {
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Backspace").catch(() => {});
    await page.keyboard.insertText(text);
  }
}

async function visibleButtonSummary(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };
    return Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem']"))
      .filter(visible)
      .slice(-50)
      .map((element) => {
        const label = `${element.getAttribute("aria-label") || ""} ${(element.innerText || element.textContent || "").trim()} ${element.getAttribute("data-testid") || ""}`;
        return label.replace(/\s+/g, " ").trim().slice(0, 100);
      })
      .filter(Boolean)
      .join(" | ");
  }).catch(() => "");
}

async function clickBestButton(page, matcher, errorPrefix) {
  const clicked = await page.evaluate((matcherText) => {
    const matcher = new RegExp(matcherText, "i");
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };
    const labelFor = (element) => `${element.getAttribute("aria-label") || ""} ${(element.innerText || element.textContent || "").trim()} ${element.getAttribute("data-testid") || ""}`
      .replace(/\s+/g, " ")
      .trim();
    const target = Array.from(document.querySelectorAll("button, [role='button'], [role='menuitem']"))
      .filter(visible)
      .find((element) => matcher.test(labelFor(element)));
    if (!target) return "";
    const label = labelFor(target);
    target.click();
    return label;
  }, matcher.source);
  if (!clicked) {
    const buttons = await visibleButtonSummary(page);
    throw new Error(`${errorPrefix}. Visible buttons: ${buttons}`);
  }
  return clicked;
}

async function clickLocatorCenter(page, locator, timeout = 10000) {
  await locator.waitFor({ state: "visible", timeout });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target has no visible bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function clickLocatorRightCenter(page, locator, timeout = 10000) {
  await locator.waitFor({ state: "visible", timeout });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Target has no visible bounding box");
  await page.mouse.click(Math.max(2, box.x + box.width - 4), box.y + box.height / 2);
}

async function clickComposerModePill(page) {
  const composerPill = page.locator("button.__composer-pill").last();
  if (await composerPill.isVisible().catch(() => false)) {
    const label = (await composerPill.innerText().catch(() => "")).trim();
    await composerPill.click({ timeout: 10000 });
    return label || "__composer-pill";
  }
  const point = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const labelFor = (element) => [
      element.innerText,
      element.textContent,
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid"),
    ].filter(Boolean).join(" ");
    const matches = Array.from(document.querySelectorAll("button"))
      .filter((element) => visible(element) && !element.closest("[role='menu'], [role='dialog']"))
      .filter((element) => /Instant|Thinking|进阶|标准|Advanced|Standard/i.test(labelFor(element)))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const classBonus = element.classList.contains("__composer-pill") ? 100000 : 0;
        return {
          x: rect.x + rect.width / 2,
          y: rect.y + rect.height / 2,
          score: classBonus + rect.y,
          label: labelFor(element).replace(/\s+/g, " ").trim(),
        };
      })
      .sort((a, b) => b.score - a.score);
    return matches[0] || null;
  });
  if (point) {
    await page.mouse.click(point.x, point.y);
    return point.label || "";
  }
  const pill = page.locator("button.__composer-pill, button[aria-haspopup='menu']").filter({ hasText: /Instant|Thinking|进阶|标准|Advanced|Standard/i }).last();
  if (!await pill.isVisible().catch(() => false)) return "";
  await clickLocatorCenter(page, pill);
  return (await pill.innerText().catch(() => "")).trim();
}

async function clickVisibleThinkingEffortButton(page) {
  await sleep(300);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const point = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const candidates = Array.from(document.querySelectorAll("button, [role='menuitem']"))
        .filter(visible)
        .filter((element) => {
          const testId = element.getAttribute("data-testid") || "";
          const aria = element.getAttribute("aria-label") || "";
          return testId.endsWith("thinking-effort") || /强度|effort/i.test(aria);
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            score: rect.y * 1000 + rect.x,
          };
        })
        .sort((a, b) => b.score - a.score);
      return candidates[0] || null;
    });
    if (point) {
      await page.mouse.click(point.x, point.y);
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function clickUploadMenuItem(page) {
  const directSelectors = [
    "[data-testid='upload-file-button']",
    "button[aria-label*='Upload']",
    "button[aria-label*='上传']",
    "[role='menuitem'][aria-label*='Upload']",
    "[role='menuitem'][aria-label*='上传']",
  ];
  for (const selector of directSelectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 10000 });
      return;
    }
  }
  await clickBestButton(page, /upload|attach|file|image|photo|上传|文件|图片|照片|计算机/, "No ChatGPT upload menu item found");
}

async function clickAttachButton(page) {
  const selectors = [
    "[data-testid='composer-plus-btn']",
    "[data-testid='paperclip-button']",
    "button[aria-label*='Attach']",
    "button[aria-label*='Add photos']",
    "button[aria-label*='上传']",
    "button[aria-label*='附加']",
    "button[aria-label*='添加']",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      await locator.click({ timeout: 10000 });
      return;
    }
  }
  await clickBestButton(page, /attach|add photos|add files|paperclip|plus|上传|附加|添加|文件|图片/, "No ChatGPT attach button found");
}

async function uploadFiles(page, files) {
  if (!files.length) return;
  await waitForComposer(page);

  const uploadFilesInput = page.locator("#upload-files").first();
  if (await uploadFilesInput.count().catch(() => 0)) {
    await uploadFilesInput.setInputFiles(files, { timeout: 30000 });
    await sleep(uploadSettleMs);
    return;
  }

  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 30000 }),
    (async () => {
      await clickAttachButton(page);
      await sleep(600);
      await clickUploadMenuItem(page);
    })(),
  ]);
  await chooser.setFiles(files);
  await sleep(uploadSettleMs);
}

async function getComposerState(page) {
  return await page.evaluate((promptSelector) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden";
    };
    const labelFor = (element) => `${element.getAttribute("aria-label") || ""} ${(element.innerText || element.textContent || "").trim()} ${element.getAttribute("data-testid") || ""}`
      .replace(/\s+/g, " ")
      .trim();
    const textbox = Array.from(document.querySelectorAll(promptSelector)).filter(visible).at(-1);
    const textboxRect = textbox?.getBoundingClientRect();
    const nearTextbox = (element) => {
      if (!textboxRect) return true;
      const rect = element.getBoundingClientRect();
      const verticallyNear = rect.bottom >= textboxRect.top - 360 && rect.top <= textboxRect.bottom + 180;
      const horizontallyNear = rect.right >= textboxRect.left - 140 && rect.left <= textboxRect.right + 140;
      return verticallyNear && horizontallyNear;
    };
    const buttons = Array.from(document.querySelectorAll("button, [role='button']")).filter(visible);
    const sendButton = buttons.find((button) => {
      const label = labelFor(button);
      const isSend = /send|submit|发送|提交|arrow-up|composer-submit-button|send-button/i.test(label);
      const forbidden = /stop|voice|mic|record|停止|语音|麦克风/i.test(label);
      return isSend && !forbidden;
    });
    const stopButton = buttons.find((button) => /stop|停止|cancel response|停止生成/i.test(labelFor(button)));
    const previewImages = Array.from(document.querySelectorAll([
      "img[src^='blob:']",
      "img[src^='data:image']",
      "img[src*='/backend-api/estuary/content']",
      "img[alt*='.png']",
      "img[alt*='.jpg']",
      "img[alt*='.jpeg']",
    ].join(", "))).filter((element) => visible(element) && nearTextbox(element));
    const removeButtons = buttons.filter((button) => /remove file|remove attachment|移除文件|移除附件|删除文件|删除附件/i.test(labelFor(button)) && nearTextbox(button));
    const attachmentCount = Math.max(previewImages.length, removeButtons.length);
    return {
      text: textbox ? ("value" in textbox ? textbox.value : (textbox.innerText || textbox.textContent || "")).trim() : "",
      attachmentCount,
      sendReady: !!sendButton && !sendButton.disabled && sendButton.getAttribute("aria-disabled") !== "true",
      sendButtonText: sendButton ? labelFor(sendButton) : "",
      generating: !!stopButton,
    };
  }, PROMPT_BOX_SELECTOR);
}

async function waitForPreparedComposer(page, prompt, expectedAttachmentCount = 0) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < composerReadyTimeoutMs) {
    lastState = await getComposerState(page);
    const promptReady = promptMatches(lastState.text, prompt);
    const attachmentsReady = expectedAttachmentCount <= 0
      || lastState.attachmentCount >= expectedAttachmentCount
      || Date.now() - started > uploadSettleMs + 15000;
    if (promptReady && attachmentsReady && lastState.sendReady) return lastState;
    if (promptReady && attachmentsReady && !lastState.sendReady) await throwIfChatGptQuota(page, "composer_send_disabled");
    await sleep(500);
  }
  await throwIfChatGptQuota(page, "composer_prepare_timeout");
  throw new Error(`ChatGPT 输入框没有准备好。text="${lastState?.text || ""}" attachments=${lastState?.attachmentCount || 0} sendReady=${!!lastState?.sendReady}`);
}

async function clickSend(page) {
  await throwIfChatGptQuota(page, "before_send_click");
  const selectors = [
    "button[data-testid='send-button']",
    "button[data-testid='composer-submit-button']",
    "button[aria-label*='Send']",
    "button[aria-label*='发送提示']",
    "button[aria-label*='发送']",
    "button[aria-label*='发送']",
    "button[aria-label*='Submit']",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).last();
    if (await locator.isVisible().catch(() => false)) {
      const clicked = await locator.click({ timeout: 10000, force: true })
        .then(() => true)
        .catch(async () => {
          try {
            await clickLocatorCenter(page, locator);
            return true;
          } catch {
            return false;
          }
        });
      if (clicked) return;
    }
  }
  try {
    await clickBestButton(page, /send|submit|发送|提交|arrow-up|composer-submit-button|send-button/, "No ChatGPT send button found");
  } catch {
    await page.keyboard.press("Enter");
  }
}

async function waitForComposerSubmitted(page, timeoutMs = submitTimeoutMs) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    lastState = await getComposerState(page);
    if (!lastState.text && lastState.attachmentCount === 0) return;
    await throwIfChatGptQuota(page, "submit_wait");
    await sleep(500);
  }
  console.log(`SUBMIT_WARN composer_not_cleared text="${lastState?.text || ""}" attachments=${lastState?.attachmentCount || 0}`);
}

async function assistantMessages(page) {
  return await page.evaluate(() => {
    const visibleEnough = (element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const selectors = [
      "[data-message-author-role='assistant']",
      "[data-testid^='conversation-turn-'] [data-message-author-role='assistant']",
      ".markdown.prose",
    ];
    const seen = new Set();
    return selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter((node) => {
        if (seen.has(node)) return false;
        seen.add(node);
        return visibleEnough(node);
      })
      .map((node, index) => ({
        index,
        text: (node.innerText || node.textContent || "").replace(/\s+\n/g, "\n").trim(),
      }))
      .filter((item) => item.text);
  }).catch(() => []);
}

async function isGenerating(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };
    return Array.from(document.querySelectorAll("button, [role='button']"))
      .filter(visible)
      .some((button) => {
        const label = `${button.getAttribute("aria-label") || ""} ${(button.innerText || button.textContent || "").trim()} ${button.getAttribute("data-testid") || ""}`;
        return /stop|停止|cancel response|停止生成/i.test(label);
      });
  }).catch(() => false);
}

async function waitForAssistantResponse(page, beforeMessages) {
  const started = Date.now();
  const beforeCount = beforeMessages.length;
  const beforeLast = beforeMessages.at(-1)?.text || "";
  let lastText = "";
  let stableCount = 0;
  let lastMessages = [];

  while (Date.now() - started < responseTimeoutMs) {
    await throwIfChatGptQuota(page, "assistant_wait");
    lastMessages = await assistantMessages(page);
    const candidate = lastMessages.length > beforeCount
      ? lastMessages.at(-1)?.text || ""
      : (lastMessages.at(-1)?.text || "");
    const isNew = lastMessages.length > beforeCount || (!!candidate && candidate !== beforeLast);
    const generating = await isGenerating(page);

    if (isNew && candidate) {
      if (candidate === lastText && !generating) stableCount += 1;
      else {
        stableCount = 0;
        lastText = candidate;
      }
      if (stableCount >= stableResponsePolls) {
        return {
          assistantText: candidate,
          messageCount: lastMessages.length,
        };
      }
    }

    await sleep(1000);
  }

  const snippet = (lastText || lastMessages.at(-1)?.text || "").slice(0, 240);
  await throwIfChatGptQuota(page, "assistant_timeout");
  throw new Error(`等待 ChatGPT 回复完成超时。最后看到的内容：${snippet}`);
}

async function scrollLastAssistantIntoView(page) {
  await page.evaluate(() => {
    const messages = Array.from(document.querySelectorAll("[data-message-author-role='assistant'], .markdown.prose"));
    messages.at(-1)?.scrollIntoView({ block: "start", behavior: "instant" });
  }).catch(() => {});
}

async function closeOpenMenus(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(150);
}

async function openChatGptConfigDialog(page) {
  await closeOpenMenus(page);
  await waitForComposer(page);
  const clicked = await clickComposerModePill(page);
  if (!clicked) {
    console.log("MODEL_CONFIG_WARN composer model button not found");
    return false;
  }
  await page.locator("[role='menu']").last().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

  const configItem = page.locator("[data-testid='model-configure-modal'], [role='menuitem']").filter({ hasText: /配置|Configure/i }).last();
  if (!await configItem.isVisible().catch(() => false)) {
    console.log("MODEL_CONFIG_WARN configure item not found");
    await closeOpenMenus(page);
    return false;
  }
  await clickLocatorCenter(page, configItem);
  await page.locator("[role='dialog']").filter({ hasText: /Instant|Thinking|模型|Model/i }).last().waitFor({ state: "visible", timeout: 8000 });
  return true;
}

async function chooseChatGptModel(page, desiredModel) {
  if (!desiredModel) return false;
  const dialog = page.locator("[role='dialog']").filter({ hasText: /Instant|Thinking|模型|Model/i }).last();
  const combo = dialog.locator("button[role='combobox']").first();
  if (!await combo.isVisible().catch(() => false)) {
    console.log(`MODEL_CONFIG_WARN model combobox not found for ${desiredModel}`);
    return false;
  }
  const current = ((await combo.innerText().catch(() => "")) || "").trim();
  if (current === desiredModel) return true;
  await clickLocatorCenter(page, combo);
  const option = page.locator("[role='option']").filter({ hasText: desiredModel }).first();
  if (!await option.isVisible().catch(() => false)) {
    const options = await page.locator("[role='option']").allTextContents().catch(() => []);
    console.log(`MODEL_CONFIG_WARN model ${desiredModel} not available; options=${options.join("|")}`);
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await clickLocatorCenter(page, option);
  await sleep(300);
  return true;
}

async function chooseChatGptThinkingMode(page, desiredMode) {
  if (!desiredMode) return false;
  const label = desiredMode === "instant" ? "Instant" : "Thinking";
  const dialog = page.locator("[role='dialog']").filter({ hasText: /Instant|Thinking|模型|Model/i }).last();
  const radio = dialog.locator("button[role='radio']").filter({ hasText: label }).first();
  if (!await radio.isVisible().catch(() => false)) {
    console.log(`MODEL_CONFIG_WARN thinking mode ${label} not available`);
    return false;
  }
  if ((await radio.getAttribute("aria-checked").catch(() => "")) === "true") return true;
  await clickLocatorCenter(page, radio);
  await sleep(300);
  return true;
}

async function chooseChatGptThinkingEffortInDialog(page, desiredEffort) {
  if (!desiredEffort) return false;
  const label = desiredEffort === "standard" ? "标准" : "进阶";
  const dialog = page.locator("[role='dialog']").filter({ hasText: /Instant|Thinking|模型|Model/i }).last();
  const combo = dialog.locator("button[role='combobox']").last();
  if (!await combo.isVisible().catch(() => false)) {
    console.log(`MODEL_CONFIG_WARN thinking effort combobox not found for ${label}`);
    return false;
  }
  const current = ((await combo.innerText().catch(() => "")) || "").trim();
  if (current === label) return true;
  await clickLocatorCenter(page, combo);
  const option = page.locator("[role='option'], [role='menuitemradio']").filter({ hasText: label }).last();
  await option.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (!await option.isVisible().catch(() => false)) {
    console.log(`MODEL_CONFIG_WARN thinking effort option ${label} not found in config dialog`);
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
  await clickLocatorCenter(page, option);
  await sleep(300);
  return true;
}

async function chooseChatGptThinkingEffort(page, desiredEffort) {
  if (!desiredEffort) return false;
  const label = desiredEffort === "standard" ? "标准" : "进阶";
  await closeOpenMenus(page);
  await waitForComposer(page);
  const clicked = await clickComposerModePill(page);
  if (!clicked) {
    console.log("MODEL_CONFIG_WARN thinking effort pill not found");
    return false;
  }
  await page.locator("[role='menu']").last().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (!await clickVisibleThinkingEffortButton(page)) {
    console.log(`MODEL_CONFIG_WARN effort button not found for ${label}`);
    await closeOpenMenus(page);
    return false;
  }
  await page.locator("[role='menuitemradio']").filter({ hasText: /标准|进阶/ }).last().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  const option = page.locator("[role='menuitemradio']").filter({ hasText: label }).last();
  if (!await option.isVisible().catch(() => false)) {
    console.log(`MODEL_CONFIG_WARN effort option ${label} not found`);
    await closeOpenMenus(page);
    return false;
  }
  if ((await option.getAttribute("aria-checked").catch(() => "")) !== "true") {
    await clickLocatorCenter(page, option);
  }
  await closeOpenMenus(page);
  await sleep(300);
  return true;
}

async function configureChatGptModelIfNeeded(page) {
  const desiredThinkingMode = chatGptThinkingModeForModel(model, thinkingMode);
  const shouldSetEffort = chatGptSupportsThinkingEffort(model, desiredThinkingMode);
  const opened = await openChatGptConfigDialog(page);
  let modelChanged = false;
  let thinkingChanged = false;
  let effortChanged = false;
  if (opened) {
    modelChanged = await chooseChatGptModel(page, model);
    thinkingChanged = desiredThinkingMode
      ? await chooseChatGptThinkingMode(page, desiredThinkingMode)
      : false;
    effortChanged = shouldSetEffort
      ? await chooseChatGptThinkingEffortInDialog(page, thinkingEffort)
      : false;
    const closeButton = page.locator("[role='dialog'] [data-testid='close-button'], [role='dialog'] button[aria-label='关闭'], [role='dialog'] button[aria-label='Close']").first();
    if (await closeButton.isVisible().catch(() => false)) {
      await clickLocatorCenter(page, closeButton).catch(() => page.keyboard.press("Escape"));
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  if (shouldSetEffort && !effortChanged) {
    effortChanged = await chooseChatGptThinkingEffort(page, thinkingEffort);
  }
  console.log(`MODEL_CONFIG model=${model} modelChanged=${modelChanged} requestedThinking=${thinkingMode} effectiveThinking=${desiredThinkingMode || "model-default"} thinkingChanged=${thinkingChanged} effort=${shouldSetEffort ? thinkingEffort : "n/a"} effortChanged=${effortChanged}`);
}

async function rememberConversation(progress, deck, page) {
  const url = page.url();
  const conversationId = parseChatGptConversationId(url);
  if (!conversationId) return "";
  progress.conversations[deck] = url;
  progress.conversationIds[deck] = conversationId;
  progress.responseIds[deck] = conversationId;
  return url;
}

async function renameConversationIfNeeded(page, progress, deck, title) {
  if (progress.renamedTitles?.[deck] === title) return;
  const conversationId = parseChatGptConversationId(page.url());
  if (!conversationId) return;
  try {
    await closeOpenMenus(page);
    const sidebarLink = page.locator(`a[href*='${conversationId}']`).first();
    if (await sidebarLink.isVisible().catch(() => false)) {
      await sidebarLink.hover().catch(() => {});
      await sleep(300);
    }
    let optionsButton = page.locator(`button[data-conversation-options-trigger='${conversationId}']`).first();
    if (!await optionsButton.isVisible().catch(() => false)) {
      const openSidebar = page.locator("button[aria-label*='打开边栏'], button[aria-label*='Open sidebar']").first();
      if (await openSidebar.isVisible().catch(() => false)) {
        await clickLocatorCenter(page, openSidebar).catch(() => {});
        await sleep(500);
      }
      const visibleSidebarLink = page.locator(`a[href*='${conversationId}']`).first();
      if (await visibleSidebarLink.isVisible().catch(() => false)) {
        await visibleSidebarLink.hover().catch(() => {});
        await sleep(300);
      }
      optionsButton = page.locator(`button[data-conversation-options-trigger='${conversationId}']`).first();
    }
    if (!await optionsButton.isVisible().catch(() => false)) {
      console.log(`RENAME_WARN ${deck} sidebar conversation menu not found`);
      return;
    }
    await clickLocatorRightCenter(page, optionsButton);
    await page.locator("[role='menu']").last().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    const renameItem = page.locator("[role='menuitem']").filter({ hasText: /重命名|Rename/i }).first();
    await renameItem.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
    if (!await renameItem.isVisible().catch(() => false)) {
      console.log(`RENAME_WARN ${deck} rename menu item not found`);
      await closeOpenMenus(page);
      return;
    }
    await clickLocatorCenter(page, renameItem);
    const editor = page.locator("input[name='title-editor'], input[aria-label*='聊天标题'], input[aria-label*='Chat title']").first();
    await editor.waitFor({ state: "visible", timeout: 5000 });
    await editor.fill(title, { timeout: 5000 });
    await editor.press("Enter", { timeout: 5000 });
    await sleep(800);
    progress.renamedTitles[deck] = title;
    console.log(`RENAMED ${deck} -> ${title}`);
  } catch (error) {
    console.log(`RENAME_WARN ${deck} ${error instanceof Error ? error.message : String(error)}`);
    await closeOpenMenus(page);
  }
}

async function sendPrompt(page, text, imagePaths = []) {
  await waitForComposer(page);
  const state = await getComposerState(page);
  if (promptMatches(state.text, text) && (imagePaths.length === 0 || state.attachmentCount >= imagePaths.length)) {
    console.log(`COMPOSER_REUSE text_ready attachments=${state.attachmentCount}`);
  } else if (!state.text && state.attachmentCount === 0) {
    await uploadFiles(page, imagePaths);
    await typePrompt(page, text);
  } else if (state.text && state.attachmentCount === 0) {
    console.log("COMPOSER_CLEAR stale_text_without_attachment");
    await clearComposerText(page);
    await uploadFiles(page, imagePaths);
    await typePrompt(page, text);
  } else if (imagePaths.length > 0 && state.attachmentCount >= imagePaths.length) {
    if (state.attachmentCount > imagePaths.length) {
      throw new Error(`ChatGPT 输入框里已有过多未发送附件，避免重复上传已停止。text="${state.text.slice(0, 120)}" attachments=${state.attachmentCount}`);
    }
    if (state.text) {
      console.log("COMPOSER_CLEAR stale_text_with_attachment");
      await clearComposerText(page);
    } else {
      console.log(`COMPOSER_REUSE attachment_draft attachments=${state.attachmentCount}`);
    }
    await typePrompt(page, text);
  } else {
    throw new Error(`ChatGPT 输入框里已有未发送内容，避免重复上传已停止。text="${state.text.slice(0, 120)}" attachments=${state.attachmentCount}`);
  }

  await waitForPreparedComposer(page, text, imagePaths.length);
  const before = await assistantMessages(page);
  await clickSend(page);
  await waitForComposerSubmitted(page);
  const result = await waitForAssistantResponse(page, before);
  await scrollLastAssistantIntoView(page);
  return result;
}

async function sendPrePromptIfNeeded(progress, deck, transcript, page, slides) {
  if (!prePromptText || progress.prePromptSent?.[deck]) return;
  console.log(`PRE_PROMPT ${deck}`);
  let result;
  try {
    result = await sendPrompt(page, prePromptText, []);
  } catch (error) {
    if (error instanceof ChatGptQuotaError) {
      await pauseForChatGptQuota({ progress, deck, slides, error });
      process.exit(0);
    }
    throw error;
  }
  const conversationUrl = await rememberConversation(progress, deck, page);
  progress.prePromptSent[deck] = true;
  transcript.conversationUrl = conversationUrl || transcript.conversationUrl || "";
  transcript.records.push({
    turn: transcript.records.length + 1,
    userText: prePromptText,
    assistantText: result.assistantText,
    missingImage: true,
    provider: "chatgpt",
    model,
    thinkingMode,
    thinkingEffort,
  });
  await writeTranscript(transcript);
  await writeProgress(progress);
  await updateConversationFolderIndex(progress, deck, slides, conversationUrl);
}

async function findExistingSentTurn(page, prompt, imageNames) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await sleep(500);
  return await page.evaluate(({ expectedPrompt, expectedImages }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const prompt = normalize(expectedPrompt);
    const turns = Array.from(document.querySelectorAll("[data-message-author-role]"));
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const user = turns[index];
      if (user.getAttribute("data-message-author-role") !== "user") continue;
      const labels = Array.from(user.querySelectorAll("img, button[aria-label], [aria-label], [alt]"))
        .map((node) => `${node.getAttribute("aria-label") || ""} ${node.getAttribute("alt") || ""} ${node.getAttribute("src") || ""}`)
        .join(" ");
      const hasImages = expectedImages.every((name) => labels.includes(name));
      if (!hasImages) continue;
      const userText = normalize(user.innerText || user.textContent || "");
      if (prompt && userText && userText !== prompt) continue;
      for (let next = index + 1; next < turns.length; next += 1) {
        const assistant = turns[next];
        if (assistant.getAttribute("data-message-author-role") !== "assistant") continue;
        const assistantText = (assistant.innerText || assistant.textContent || "").replace(/\s+\n/g, "\n").trim();
        if (assistantText.length < 20) continue;
        return {
          userText,
          assistantText,
          messageCount: turns.length,
          modelSlug: assistant.getAttribute("data-message-model-slug") || "",
        };
      }
    }
    return null;
  }, { expectedPrompt: prompt, expectedImages: imageNames }).catch(() => null);
}

async function recoverCompletedTurnIfPresent({ page, progress, transcript, deck, slides, slideBatch, slideNumber, endSlideNumber, batchSize, prompt, deckId }) {
  if (progress.last?.deck !== deck || progress.last?.done !== false) return false;
  if (Number(progress.last?.slideStart || 0) !== slideNumber || Number(progress.last?.slideEnd || 0) !== endSlideNumber) return false;
  const imageNames = slideBatch.map((item) => path.basename(item));
  const alreadyRecorded = (transcript.records || []).some((record) => (
    Number(record.pageStart || record.page || 0) === slideNumber
    && Number(record.pageEnd || record.page || 0) === endSlideNumber
    && imageNames.every((name) => (record.imageNames || [record.imageName]).includes(name))
  ));
  if (alreadyRecorded) return false;

  const existing = await findExistingSentTurn(page, prompt, imageNames);
  if (!existing) return false;

  const conversationUrl = await rememberConversation(progress, deck, page);
  progress.sent[deck] = endSlideNumber;
  progress.last = {
    ...progress.last,
    done: true,
    conversationUrl,
    conversationId: parseChatGptConversationId(conversationUrl),
    recovered: true,
  };
  transcript.conversationUrl = conversationUrl || transcript.conversationUrl || "";
  transcript.records.push({
    turn: transcript.records.length + 1,
    userText: prompt,
    assistantText: existing.assistantText,
    imageName: imageNames[0] || "",
    imageNames,
    missingImage: false,
    hasUserImage: true,
    page: slideNumber,
    pageStart: slideNumber,
    pageEnd: endSlideNumber,
    consumesSlides: batchSize,
    slideImageUrl: imageNames[0] ? `../screenshots/${deckId}/${imageNames[0]}` : "",
    provider: "chatgpt",
    model,
    thinkingMode,
    thinkingEffort,
    modelSlug: existing.modelSlug,
    conversationUrl,
    conversationId: parseChatGptConversationId(conversationUrl),
    messageCount: existing.messageCount,
    recovered: true,
  });
  await writeTranscript(transcript);
  await writeProgress(progress);
  await updateConversationFolderIndex(progress, deck, slides, conversationUrl);
  console.log(`RECOVER_SENT_TURN ${deck} slides ${pageRangeLabel(slideNumber, endSlideNumber)}/${slides.length}`);
  return true;
}

async function pauseForChatGptQuota({ progress, deck, slides, slideNumber = 0, endSlideNumber = 0, error }) {
  const info = error instanceof ChatGptQuotaError ? error.info : { reason: "unknown", message: String(error?.message || error || "") };
  progress.quotaWaiting = true;
  progress.quotaReason = info.reason || "chatgpt_quota";
  progress.quotaMessage = info.message || "";
  progress.quotaPhase = info.phase || "";
  progress.quotaResetHint = info.resetHint || "";
  progress.quotaDetectedAt = info.detectedAt || new Date().toISOString();
  progress.lastQuotaSlide = {
    deck,
    slide: endSlideNumber || slideNumber || 0,
    slideStart: slideNumber || 0,
    slideEnd: endSlideNumber || slideNumber || 0,
    totalSlides: slides.length,
    provider: "chatgpt",
    url: progress.conversations?.[deck] || "",
  };
  await writeProgress(progress);
  await updateConversationFolderIndex(progress, deck, slides, progress.conversations?.[deck] || "");
  console.log(`QUOTA_PAUSE provider=chatgpt deck=${deck} slides=${pageRangeLabel(slideNumber || 1, endSlideNumber || slideNumber || 1)}/${slides.length} reason=${progress.quotaReason} phase=${progress.quotaPhase} reset_hint="${progress.quotaResetHint}"`);
}

const progress = await readProgress();
if (!configOnly) {
  await writeProgress(progress);
}
console.log(`MODEL_SETTINGS provider=chatgpt mode=web model=${model} thinking=${thinkingMode} effort=${thinkingEffort} pages_per_prompt=${pagesPerPrompt} prompt="${promptText}" pre_prompt_len=${prePromptText.length}`);
console.log(`CHROME_CDP ${chromeDebugUrl}`);

if (dryRun) {
  const decks = await listDecks();
  let totalSlides = 0;
  for (const deck of decks) {
    const slides = await listSlides(deck);
    totalSlides += slides.length;
    await updateConversationFolderIndex(progress, deck, slides, progress.conversations?.[deck] || "");
    console.log(`DRY_RUN deck=${deck} slides=${slides.length} sent=${progress.sent?.[deck] || 0}`);
  }
  console.log(`DRY_RUN complete provider=chatgpt decks=${decks.length} slides=${totalSlides} root="${root}"`);
  process.exit(0);
}

const { browser, page } = await getChatGptPage();
try {
await configureChatGptModelIfNeeded(page);
if (configOnly) {
  console.log("CONFIG_ONLY complete; no slides sent.");
  process.exit(0);
}
const decks = await listDecks();
let processed = 0;

for (const deck of decks) {
  const slides = await listSlides(deck);
  const deckId = deckIdFromFolder(deck);
  const title = deckTitle(deck);
  const transcript = await readTranscript(deckId, title, slides.length);
  let sent = Number(progress.sent[deck] || 0);

  if (sent >= slides.length) {
    console.log(`SKIP complete ${deck} (${sent}/${slides.length})`);
    await updateConversationFolderIndex(progress, deck, slides, progress.conversations[deck] || "");
    continue;
  }

  await openConversation(page, progress.conversations?.[deck] || "");
  await sendPrePromptIfNeeded(progress, deck, transcript, page, slides);

  for (let index = sent; index < slides.length;) {
    if (maxSlides > 0 && processed >= maxSlides) {
      console.log(`MAX_SLIDES reached (${processed}).`);
      await writeProgress(progress);
      process.exit(0);
    }

    const batchSize = Math.min(
      pagesPerPrompt,
      slides.length - index,
      maxSlides > 0 ? maxSlides - processed : pagesPerPrompt,
    );
    if (batchSize <= 0) {
      console.log(`MAX_SLIDES reached (${processed}).`);
      await writeProgress(progress);
      process.exit(0);
    }

    const slideNumber = index + 1;
    const endSlideNumber = index + batchSize;
    const slideBatch = slides.slice(index, endSlideNumber);
    const rangeLabel = pageRangeLabel(slideNumber, endSlideNumber);
    const prompt = buildPrompt(slideNumber, endSlideNumber);
    if (await recoverCompletedTurnIfPresent({
      page,
      progress,
      transcript,
      deck,
      slides,
      slideBatch,
      slideNumber,
      endSlideNumber,
      batchSize,
      prompt,
      deckId,
    })) {
      if (!progress.renamedTitles?.[deck]) {
        await renameConversationIfNeeded(page, progress, deck, title);
        await writeProgress(progress);
      }
      processed += batchSize;
      index = endSlideNumber;
      sent = endSlideNumber;
      continue;
    }
    console.log(`SEND ${deck} slides ${rangeLabel}/${slides.length}`);
    progress.last = {
      deck,
      slide: endSlideNumber,
      slideStart: slideNumber,
      slideEnd: endSlideNumber,
      totalSlides: slides.length,
      pagesPerPrompt,
      done: false,
      provider: "chatgpt",
      mode: "web",
    };
    await writeProgress(progress);

    let result;
    try {
      result = await sendPrompt(page, prompt, slideBatch);
    } catch (error) {
      if (error instanceof ChatGptQuotaError) {
        await pauseForChatGptQuota({ progress, deck, slides, slideNumber, endSlideNumber, error });
        process.exit(0);
      }
      throw error;
    }
    const conversationUrl = await rememberConversation(progress, deck, page);
    progress.sent[deck] = endSlideNumber;
    progress.last = {
      ...progress.last,
      done: true,
      conversationUrl,
      conversationId: parseChatGptConversationId(conversationUrl),
    };

    if (!progress.renamedTitles?.[deck]) {
      await renameConversationIfNeeded(page, progress, deck, title);
    }

    const firstImageName = path.basename(slideBatch[0] || "");
    transcript.conversationUrl = conversationUrl || transcript.conversationUrl || "";
    transcript.records.push({
      turn: transcript.records.length + 1,
      userText: prompt,
      assistantText: result.assistantText,
      imageName: firstImageName,
      imageNames: slideBatch.map((item) => path.basename(item)),
      missingImage: false,
      hasUserImage: true,
      page: slideNumber,
      pageStart: slideNumber,
      pageEnd: endSlideNumber,
      consumesSlides: batchSize,
      slideImageUrl: firstImageName ? `../screenshots/${deckId}/${firstImageName}` : "",
      provider: "chatgpt",
      model,
      thinkingMode,
      thinkingEffort,
      conversationUrl,
      conversationId: parseChatGptConversationId(conversationUrl),
      messageCount: result.messageCount,
    });

    await writeTranscript(transcript);
    await writeProgress(progress);
    await updateConversationFolderIndex(progress, deck, slides, conversationUrl);
    processed += batchSize;
    console.log(`DONE ${deck} slides ${rangeLabel}/${slides.length}`);
    index = endSlideNumber;
    sent = endSlideNumber;
  }
  await autoCacheDeck(deck, slides);
}

console.log("ALL_DONE");
} finally {
  await browser.close().catch(() => {});
}
