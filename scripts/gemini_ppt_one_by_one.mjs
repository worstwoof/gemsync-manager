import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function asImportSpecifier(candidate) {
  if (!candidate) return null;
  if (/^[a-z]+:\/\//i.test(candidate) || (!candidate.includes('\\') && !candidate.includes('/'))) return candidate;
  return pathToFileURL(candidate).href;
}

async function addPnpmPlaywrightCandidates(candidates, nodeModules) {
  const pnpmDir = path.join(nodeModules, '.pnpm');
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
        candidates.push(pathToFileURL(path.join(pnpmDir, entry, 'node_modules', packageName, 'index.mjs')).href);
      });
  };

  addPackages('playwright-core@', 'playwright-core');
  addPackages('playwright@', 'playwright');
}

async function importPlaywright() {
  const candidates = [
    asImportSpecifier(process.env.PLAYWRIGHT_IMPORT_PATH),
    'playwright',
    'playwright-core',
  ].filter(Boolean);

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    const runtimeNodeModules = path.join(
      userProfile,
      '.cache',
      'codex-runtimes',
      'codex-primary-runtime',
      'dependencies',
      'node',
      'node_modules',
    );
    await addPnpmPlaywrightCandidates(candidates, runtimeNodeModules);
    candidates.push(pathToFileURL(path.join(runtimeNodeModules, 'playwright', 'index.mjs')).href);
    candidates.push(pathToFileURL(path.join(runtimeNodeModules, 'playwright-core', 'index.mjs')).href);
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
    `Unable to import Playwright. Set PLAYWRIGHT_IMPORT_PATH to playwright/index.mjs or playwright-core/index.mjs. Tried:\n${errors.join('\n')}`,
  );
}

const { chromium } = await importPlaywright();

const chromeDebugUrl = process.env.GEMINI_CHROME_DEBUG_URL || 'http://127.0.0.1:9222';
const root = path.resolve(process.env.GEMINI_PPT_ROOT || path.join(process.cwd(), 'gemini_ppt_screenshots_full'));
const progressPath = path.resolve(process.env.GEMINI_PROGRESS_PATH || path.join(root, 'gemini_progress.json'));
const conversationFoldersPath = path.resolve(process.env.GEMINI_CONVERSATION_FOLDERS_PATH || path.join(root, 'conversation_folders.json'));
const promptText = process.env.GEMINI_PPT_PROMPT || '\u8bf7\u8be6\u7ec6\u8bb2\u89e3\u8fd9\u4e00\u9762PPT';
const prePromptText = String(process.env.GEMINI_PRE_PROMPT || '').trim();
const pagesPerPrompt = Math.max(1, Math.min(3, Math.floor(Number(process.env.GEMINI_PAGES_PER_PROMPT || '1') || 1)));
const maxSlides = Number(process.env.MAX_SLIDES || '0');
const quotaCheckIntervalMs = Number(process.env.QUOTA_CHECK_INTERVAL_MS || '300000');
const quotaRefreshBufferMs = Number(process.env.QUOTA_REFRESH_BUFFER_MS || '60000');
const maxSendAttempts = Number(process.env.GEMINI_SEND_RETRY_LIMIT || '3');
const uploadSettleMs = Number(process.env.GEMINI_UPLOAD_SETTLE_MS || '12000');
const submitTimeoutMs = Number(process.env.GEMINI_SUBMIT_TIMEOUT_MS || '120000');
const composerReadyTimeoutMs = Number(process.env.GEMINI_COMPOSER_READY_TIMEOUT_MS || '120000');
const firstSlideUploadSettleMs = Number(process.env.GEMINI_FIRST_SLIDE_UPLOAD_SETTLE_MS || '45000');
const preSendSettleMs = Number(process.env.GEMINI_PRE_SEND_SETTLE_MS || '8000');
const firstSlidePreSendSettleMs = Number(process.env.GEMINI_FIRST_SLIDE_PRE_SEND_SETTLE_MS || '30000');
const requestedModel = normalizeModelChoice(process.env.GEMINI_MODEL || 'pro');
const proFallback = normalizeProFallback(process.env.GEMINI_PRO_FALLBACK || 'flash');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizePromptText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function promptMatches(actual, expected) {
  return normalizePromptText(actual) === normalizePromptText(expected);
}

function normalizeModelChoice(input) {
  const value = String(input || '').trim().toLowerCase().replace(/_/g, '-');
  if (['pro', 'flash', 'flash-lite'].includes(value)) return value;
  return 'pro';
}

function normalizeProFallback(input) {
  const value = String(input || '').trim().toLowerCase().replace(/_/g, '-');
  if (['wait', 'stop', 'flash', 'flash-lite'].includes(value)) return value;
  return 'flash';
}

function modelDisplayName(model) {
  if (model === 'flash-lite') return 'Flash-Lite';
  if (model === 'flash') return 'Flash';
  return 'Pro';
}

async function readProgress() {
  try {
    const text = (await fs.readFile(progressPath, 'utf8')).replace(/^\uFEFF/, '');
    const raw = JSON.parse(text);
    if (raw.sent && raw.conversations) return raw;
    const sent = {};
    const conversations = {};
    if (raw.deck && raw.slide) sent[raw.deck] = raw.slide;
    if (raw.deck && raw.url) conversations[raw.deck] = raw.url;
    return { sent, conversations, updatedAt: raw.updatedAt };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return { sent: {}, conversations: {} };
  }
}

async function writeProgress(progress) {
  progress.updatedAt = new Date().toISOString();
  await fs.writeFile(progressPath, JSON.stringify(progress, null, 2), 'utf8');
}

async function readConversationFolders() {
  try {
    const text = (await fs.readFile(conversationFoldersPath, 'utf8')).replace(/^\uFEFF/, '');
    const data = JSON.parse(text);
    if (data && Array.isArray(data.folders)) return data;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return { version: 1, root, folders: [] };
}

async function updateConversationFolderIndex(progress, deck, slides, conversationUrl) {
  const data = await readConversationFolders();
  const now = new Date().toISOString();
  const sent = progress.sent?.[deck] || 0;
  const totalSlides = slides.length;
  const index = data.folders.findIndex((entry) => entry.deck === deck);
  const prior = index >= 0 ? data.folders[index] : {};
  const entry = {
    ...prior,
    deck,
    folder: deck,
    folderPath: path.join(root, deck),
    title: deckTitle(deck),
    conversationUrl: conversationUrl || progress.conversations?.[deck] || prior.conversationUrl || '',
    sent,
    totalSlides,
    status: sent >= totalSlides ? 'complete' : (conversationUrl || progress.conversations?.[deck] ? 'in_progress' : 'pending'),
    createdAt: prior.createdAt || now,
    updatedAt: now,
  };
  if (index >= 0) data.folders[index] = entry;
  else data.folders.push(entry);
  data.root = root;
  data.updatedAt = now;
  data.folders.sort((a, b) => a.deck.localeCompare(b.deck));
  await fs.writeFile(conversationFoldersPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function listDecks() {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^deck\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function listSlides(deck) {
  const deckPath = path.join(root, deck);
  const files = await fs.readdir(deckPath);
  return files
    .filter((name) => /^deck\d+_slide\d+\.png$/.test(name))
    .sort()
    .map((name) => path.join(deckPath, name));
}

async function getGeminiPage() {
  const browser = await chromium.connectOverCDP(chromeDebugUrl, { timeout: 90000 });
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('gemini.google.com')) ?? context.pages()[0] ?? await context.newPage();
  await page.bringToFront();
  return { browser, page };
}

async function waitForInput(page, timeout = composerReadyTimeoutMs) {
  await page.locator('div[role="textbox"][contenteditable="true"]').last().waitFor({ state: 'visible', timeout });
}

async function gotoGemini(page, url, label) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`NAV_WARN ${label} domcontentloaded_timeout current="${page.url()}" message="${message.replace(/\s+/g, ' ').slice(0, 240)}"`);
  }

  if (!page.url().includes('gemini.google.com')) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      console.log(`NAV_RECOVER ${label} committed current="${page.url()}"`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`NAV_RECOVER_FAILED ${label} current="${page.url()}" message="${message.replace(/\s+/g, ' ').slice(0, 240)}"`);
    }
  }
}

async function openNewChat(page) {
  await gotoGemini(page, 'https://gemini.google.com/app', 'new_chat');
  await waitForInput(page);
}

async function visibleButtonSummary(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };
    return Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"]'))
      .filter(visible)
      .slice(-40)
      .map((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''}`;
        return label.replace(/\s+/g, ' ').trim().slice(0, 100);
      })
      .filter(Boolean)
      .join(' | ');
  }).catch(() => '');
}

async function hasLocalUploadMenuItem(page) {
  const localUpload = page.locator('[data-test-id="local-images-files-uploader-button"]').first();
  if (await localUpload.isVisible().catch(() => false)) return true;

  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return Array.from(document.querySelectorAll('button, [role="menuitem"], [data-test-id]'))
      .filter(visible)
      .some((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''}`;
        const isLocalUpload = label.includes('local-images-files-uploader-button')
          || label.includes('\u4e0a\u4f20\u6587\u4ef6')
          || /\bupload\s+files?\b/i.test(label);
        const isCloudUpload = label.includes('\u4e91\u7aef\u786c\u76d8') || /\bdrive\b/i.test(label);
        return isLocalUpload && !isCloudUpload;
      });
  }).catch(() => false);
}

async function clickUploadToolsButton(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && rect.bottom >= 0
        && rect.top <= window.innerHeight;
    };

    const textbox = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'))
      .filter(visible)
      .at(-1);
    const textboxRect = textbox?.getBoundingClientRect();
    const nearTextbox = (element) => {
      if (!textboxRect) return true;
      const rect = element.getBoundingClientRect();
      return Math.abs(rect.bottom - textboxRect.bottom) < 280 || rect.top > window.innerHeight - 360;
    };

    const labelFor = (element) => {
      const iconText = Array.from(element.querySelectorAll('mat-icon, gem-icon, .material-symbols-outlined, .google-symbols'))
        .map((icon) => (icon.textContent || '').trim())
        .filter(Boolean)
        .join(' ');
      return `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''} ${iconText}`
        .replace(/\s+/g, ' ')
        .trim();
    };

    const candidates = Array.from(document.querySelectorAll('button'))
      .filter((element) => visible(element) && nearTextbox(element))
      .map((element) => {
        const label = labelFor(element);
        const lower = label.toLowerCase();
        const forbidden = label.includes('\u8bbe\u7f6e')
          || label.includes('\u9ea6\u514b\u98ce')
          || label.includes('\u53d1\u9001')
          || label.includes('\u6a21\u5f0f')
          || /\b(settings?|microphone|send|mode)\b/i.test(label);
        if (forbidden) return null;

        let score = 0;
        if (label.includes('\u4e0a\u4f20\u548c\u5de5\u5177')) score += 120;
        if (label.includes('\u4e0a\u4f20')) score += 70;
        if (label.includes('\u5de5\u5177')) score += 50;
        if (label.includes('\u6dfb\u52a0') || label.includes('\u9644\u52a0')) score += 25;
        if (label.includes('\u56fe\u7247') || label.includes('\u6587\u4ef6')) score += 20;
        if (/\bupload\b/i.test(label)) score += 70;
        if (/\btools?\b/i.test(label)) score += 45;
        if (/\b(add|attach|file|image)\b/i.test(label)) score += 20;
        if (element.getAttribute('aria-haspopup')) score += 15;
        if (lower.includes('mat-mdc-menu-trigger') || String(element.className || '').includes('mat-mdc-menu-trigger')) score += 10;

        return score > 0 ? { element, label, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    const target = candidates[0]?.element;
    if (!target) {
      const visibleLabels = Array.from(document.querySelectorAll('button'))
        .filter(visible)
        .slice(-25)
        .map(labelFor)
        .filter(Boolean)
        .join(' | ');
      throw new Error(`No upload/tools button found. Visible buttons: ${visibleLabels}`);
    }
    target.click();
    return candidates[0].label;
  });
}

async function clickLocalUploadMenuItem(page) {
  await ensureUploadMenuOpen(page);

  const localUpload = page.locator('[data-test-id="local-images-files-uploader-button"]').first();
  if (await localUpload.isVisible().catch(() => false)) {
    await localUpload.click({ timeout: 15000 });
    return;
  }

  await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const target = Array.from(document.querySelectorAll('button, [role="menuitem"], [data-test-id]'))
      .filter(visible)
      .find((element) => {
        const label = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''}`;
        const isLocalUpload = label.includes('local-images-files-uploader-button')
          || label.includes('\u4e0a\u4f20\u6587\u4ef6')
          || /\bupload\s+files?\b/i.test(label);
        const isCloudUpload = label.includes('\u4e91\u7aef\u786c\u76d8') || /\bdrive\b/i.test(label);
        return isLocalUpload && !isCloudUpload;
      });
    if (!target) throw new Error('No local upload menu item found.');
    target.click();
  });
}

async function ensureUploadMenuOpen(page) {
  await waitForInput(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await hasLocalUploadMenuItem(page)) return;
    if (attempt > 0) await closeMenus(page);

    const oldUploadButton = page.locator('button.upload-card-button').first();
    if (await oldUploadButton.isVisible().catch(() => false)) {
      await oldUploadButton.click({ timeout: 15000 });
    } else {
      await clickUploadToolsButton(page);
    }

    await sleep(800 + attempt * 350);
    if (await hasLocalUploadMenuItem(page)) return;
  }

  const buttons = await visibleButtonSummary(page);
  throw new Error(`Upload menu opened, but local file upload did not appear. Visible buttons: ${buttons}`);
}

async function uploadOne(page, filePath) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 30000 }),
        clickLocalUploadMenuItem(page),
      ]);
      await chooser.setFiles(filePath);
      await sleep(uploadSettleMs);
      return;
    } catch (error) {
      lastError = error;
      await closeMenus(page);
      await sleep(1000 + attempt * 500);
    }
  }
  throw new Error(`Upload file chooser failed: ${lastError?.message || lastError}`);
}

async function typePrompt(page, text) {
  await closeMenus(page);
  const box = page.locator('div[role="textbox"][contenteditable="true"]').last();
  try {
    await box.click({ timeout: 15000 });
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(500);
    await box.click({ timeout: 15000 }).catch(async () => {
      await page.evaluate(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const textbox = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'))
          .filter(visible)
          .at(-1);
        if (!textbox) throw new Error('No visible Gemini textbox found.');
        textbox.focus();
      });
    });
  }
  await page.keyboard.type(text, { delay: 0 });
}

async function getComposerState(page) {
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textbox = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'))
      .filter(visible)
      .at(-1);
    const textboxRect = textbox?.getBoundingClientRect();
    const nearTextbox = (element) => {
      if (!textboxRect) return false;
      const rect = element.getBoundingClientRect();
      const verticallyNear = rect.bottom >= textboxRect.top - 320 && rect.top <= textboxRect.bottom + 100;
      const horizontallyNear = rect.right >= textboxRect.left - 80 && rect.left <= textboxRect.right + 80;
      return verticallyNear && horizontallyNear;
    };
    const buttonLabel = (button) => `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
    const sendButton = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .find((button) => {
        const label = buttonLabel(button);
        const send = label.includes('\u53d1\u9001') || /\bsend\b/i.test(label);
        const microphone = label.includes('\u9ea6\u514b\u98ce') || /\bmic(?:rophone)?\b/i.test(label);
        return send && !microphone;
      });
    const previewImages = Array.from(document.querySelectorAll('img[data-test-id="image-preview"], img[src^="blob:"], img[src^="data:image"]'))
      .filter((image) => visible(image) && (image.getAttribute('data-test-id') === 'image-preview' || nearTextbox(image)));
    const removeButtons = Array.from(document.querySelectorAll([
      'button[data-test-id="cancel-button"]',
      'button[aria-label*="Remove"]',
      'button[aria-label*="remove"]',
      'button[aria-label*="\u79fb\u9664"]',
      'button[aria-label*="\u5220\u9664"]',
      'button[aria-label*="\u53d6\u6d88"]',
    ].join(', ')))
      .filter((button) => visible(button) && nearTextbox(button));
    const imagePreviewCount = Math.max(previewImages.length, removeButtons.length);
    const hasImagePreview = imagePreviewCount > 0;
    const sendReady = !!sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true';
    return {
      text: textbox ? (textbox.innerText || textbox.textContent || '').trim() : '',
      hasImagePreview,
      imagePreviewCount,
      previewImageCount: previewImages.length,
      removeButtonCount: removeButtons.length,
      sendReady,
      sendButtonText: sendButton
        ? buttonLabel(sendButton).trim()
        : '',
    };
  });
}

async function waitForSendReady(page) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const state = await getComposerState(page);
    if (state.sendReady) return;
    await sleep(500);
  }
  throw new Error('Send button did not become ready.');
}

async function waitForComposerImageCount(page, expectedCount, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await getComposerState(page);
    if (state.imagePreviewCount === expectedCount) return state;
    if (state.imagePreviewCount > expectedCount) return state;
    await sleep(500);
  }
  return await getComposerState(page);
}

async function waitForPreparedComposer(page, prompt, { timeoutMs = composerReadyTimeoutMs, stableTarget = 8, expectedImageCount = 1 } = {}) {
  const started = Date.now();
  let lastState = null;
  let stableCount = 0;
  while (Date.now() - started < timeoutMs) {
    lastState = await getComposerState(page);
    if (lastState.imagePreviewCount > expectedImageCount) {
      return { ok: false, reason: 'too_many_images', state: lastState };
    }
    if (lastState.imagePreviewCount === expectedImageCount && promptMatches(lastState.text, prompt) && lastState.sendReady) {
      stableCount += 1;
      if (stableCount >= stableTarget) return { ok: true, state: lastState, stableCount };
    } else {
      stableCount = 0;
    }
    await sleep(500);
  }
  return { ok: false, reason: 'composer_not_ready', state: lastState || await getComposerState(page) };
}

async function waitForComposerSubmitted(page, timeoutMs = submitTimeoutMs) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    lastState = await getComposerState(page);
    if (!lastState.text && lastState.imagePreviewCount === 0) {
      return { ok: true, state: lastState };
    }
    await sleep(500);
  }
  return { ok: false, reason: 'composer_not_cleared_after_send', state: lastState || await getComposerState(page) };
}

async function waitForUploadPreviewStable(page, expectedCount, { timeoutMs = 90000, stableTarget = 8 } = {}) {
  const started = Date.now();
  let lastState = null;
  let stableCount = 0;
  while (Date.now() - started < timeoutMs) {
    lastState = await getComposerState(page);
    if (lastState.imagePreviewCount > expectedCount) return lastState;
    if (lastState.imagePreviewCount === expectedCount) {
      stableCount += 1;
      if (stableCount >= stableTarget) return { ...lastState, stableCount };
    } else {
      stableCount = 0;
    }
    await sleep(500);
  }
  return lastState || await getComposerState(page);
}

async function reloadCurrentConversation(page) {
  const url = page.url();
  await gotoGemini(page, url, 'reload_current_conversation');
  await waitForInput(page);
  await sleep(1500);
}

function shouldReloadBeforeRetry(reason) {
  return /^upload_preview_count_/.test(reason || '')
    || reason === 'too_many_images'
    || reason === 'composer_not_ready'
    || String(reason || '').startsWith('upload_file_chooser_failed')
    || String(reason || '').startsWith('composer_not_clean')
    || String(reason || '').startsWith('final_composer_not_ready')
    || reason === 'composer_not_cleared_after_send';
}

async function reloadAndAuditLatestAnswer(page, prompt, deck, slideNumber, totalSlides, reason, expectedImageCount = 1) {
  console.log(`RECOVER_RELOAD_AFTER_SEND ${deck} slide ${slideNumber}/${totalSlides} reason=${reason || 'unknown'}`);
  await reloadCurrentConversation(page);
  const answerAudit = await inspectLatestAnswer(page, prompt);
  console.log(`SELF_CHECK after_reload ${deck} slide ${slideNumber}/${totalSlides} hasAnswer=${answerAudit.hasAnswer} hasUserImage=${answerAudit.hasUserImage} userImages=${answerAudit.userImageCount || 0} missingImage=${answerAudit.missingImage}`);

  if (answerAudit.hasAnswer && answerAudit.hasUserImage && !answerAudit.missingImage && Number(answerAudit.userImageCount || 0) >= expectedImageCount) {
    return { done: true, quotaWait: false, recoveredByReload: true };
  }

  if (answerAudit.hasAnswer && (!answerAudit.hasUserImage || answerAudit.missingImage || Number(answerAudit.userImageCount || 0) < expectedImageCount)) {
    return { done: false, quotaWait: false, retry: true, reason: 'gemini_missing_image_after_reload' };
  }

  return null;
}

async function clickSendButton(page) {
  await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const buttonLabel = (button) => `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
    const button = Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .find((candidate) => {
        const label = buttonLabel(candidate);
        const send = label.includes('\u53d1\u9001') || /\bsend\b/i.test(label);
        const microphone = label.includes('\u9ea6\u514b\u98ce') || /\bmic(?:rophone)?\b/i.test(label);
        return send && !microphone && !candidate.disabled && candidate.getAttribute('aria-disabled') !== 'true';
      });
    if (!button) throw new Error('No enabled send button found.');
    button.click();
  });
}

async function clearComposer(page) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    const preview = page.locator('img[data-test-id="image-preview"], img[src^="blob:"], img[src^="data:image"]').last();
    if (await preview.isVisible().catch(() => false)) {
      await preview.hover({ timeout: 3000 }).catch(() => {});
      await sleep(250);
    }
    const box = page.locator('div[role="textbox"][contenteditable="true"]').last();
    await box.click({ timeout: 15000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await sleep(250);
    const removed = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textbox = Array.from(document.querySelectorAll('div[role="textbox"][contenteditable="true"]'))
        .filter(visible)
        .at(-1);
      const textboxRect = textbox?.getBoundingClientRect();
      const nearTextbox = (element) => {
        if (!textboxRect) return false;
        const rect = element.getBoundingClientRect();
        const verticallyNear = rect.bottom >= textboxRect.top - 320 && rect.top <= textboxRect.bottom + 100;
        const horizontallyNear = rect.right >= textboxRect.left - 80 && rect.left <= textboxRect.right + 80;
        return verticallyNear && horizontallyNear;
      };
      const buttons = Array.from(document.querySelectorAll([
        'button[data-test-id="cancel-button"]',
        'button[aria-label*="Remove"]',
        'button[aria-label*="remove"]',
        'button[aria-label*="\u79fb\u9664"]',
        'button[aria-label*="\u5220\u9664"]',
        'button[aria-label*="\u53d6\u6d88"]',
      ].join(', ')))
        .filter((button) => visible(button) && nearTextbox(button));
      for (const button of buttons) button.click();
      const previewImages = Array.from(document.querySelectorAll('img[data-test-id="image-preview"], img[src^="blob:"], img[src^="data:image"]'))
        .filter((image) => visible(image) && nearTextbox(image));
      let ancestorButtonClicks = 0;
      for (const image of previewImages) {
        let current = image.parentElement;
        for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
          const candidates = Array.from(current.querySelectorAll('button, [role="button"]'));
          for (const candidate of candidates) {
            const label = `${candidate.getAttribute('aria-label') || ''} ${(candidate.innerText || candidate.textContent || '').trim()}`;
            const blocked = label.includes('\u53d1\u9001')
              || /\bsend\b/i.test(label)
              || label.includes('\u9ea6\u514b\u98ce')
              || /\bmic(?:rophone)?\b/i.test(label)
              || label.includes('\u4e0a\u4f20')
              || /\bupload\b/i.test(label);
            if (blocked) continue;
            candidate.click();
            ancestorButtonClicks += 1;
          }
          if (ancestorButtonClicks) break;
        }
      }
      return buttons.length + ancestorButtonClicks;
    }).catch(() => 0);
    if (removed) await sleep(700);
    const state = await getComposerState(page);
    if (!state.text && state.imagePreviewCount === 0) return state;
  }
  const state = await getComposerState(page);
  throw new Error(`Composer did not clear. text_len=${state.text.length} images=${state.imagePreviewCount}`);
}

async function getInputMode(page) {
  return await page.evaluate(() => {
    const button = document.querySelector('button.input-area-switch');
    if (!button) return { found: false, text: '' };
    const text = `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
    return { found: true, text: text.trim() };
  });
}

function isFastMode(mode) {
  return mode.found && ['flash', 'flash-lite'].includes(modelFromText(mode.text));
}

function isProMode(mode) {
  return mode.found && modelFromText(mode.text) === 'pro';
}

function isRequestedModelMode(mode, model) {
  return mode.found && modelFromText(mode.text) === model;
}

function modelFromText(text) {
  const raw = String(text || '');
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (compact.includes('flashlite') || compact.includes('lite') || raw.includes('\u8f7b\u91cf')) return 'flash-lite';
  if (compact.includes('flash') || compact.includes('fast') || raw.includes('\u5feb\u901f')) return 'flash';
  if (compact.includes('pro')) return 'pro';
  return '';
}

function optionMatchesModel(option, model) {
  const text = `${option?.text || ''} ${option?.dataTestId || ''} ${option?.modeId || ''}`;
  const detected = modelFromText(text);
  if (model === 'flash' && detected === 'flash-lite') return false;
  return detected === model;
}

function shouldPauseForFastMode(mode) {
  return requestedModel === 'pro' && proFallback === 'wait' && isFastMode(mode);
}

async function closeMenus(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(250);
}

function parseResetTime(text, now = new Date()) {
  const monthDay = /(\d{1,2})\u6708(\d{1,2})\u65e5\s*(\d{1,2}):(\d{2})/.exec(text);
  if (monthDay) {
    const [, month, day, hour, minute] = monthDay;
    const candidate = new Date(now.getFullYear(), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0);
    if (candidate.getTime() < now.getTime() - 60_000) {
      candidate.setFullYear(candidate.getFullYear() + 1);
    }
    return candidate;
  }
  const timeOnly = /(\d{1,2}):(\d{2})/.exec(text);
  if (timeOnly) {
    const [, hour, minute] = timeOnly;
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hour), Number(minute), 0, 0);
    if (candidate.getTime() < now.getTime() - 60_000) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }
  return null;
}

async function openModeMenu(page) {
  await closeMenus(page);
  await page.locator('button.input-area-switch').first().click({ timeout: 15000 });
  await sleep(800);
}

async function readModeOptions(page) {
  await openModeMenu(page);
  const options = await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const optionSelector = [
      'gem-menu-item',
      'gem-menu [role="menuitem"]',
      '[data-test-id^="bard-mode-option-"]',
      '.cdk-overlay-container button',
      '.cdk-overlay-container [role="menuitem"]',
      '.cdk-overlay-container [role="menuitemradio"]',
      '.cdk-overlay-container [role="option"]',
    ].join(', ');
    return Array.from(document.querySelectorAll(optionSelector))
      .filter(visible)
      .map((element) => {
        const text = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()}`.trim();
        return {
          text,
          disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
          selected: element.classList.contains('is-selected') || element.getAttribute('aria-selected') === 'true',
          dataTestId: element.getAttribute('data-test-id') || '',
          modeId: element.getAttribute('data-mode-id') || '',
        };
      });
  });
  await closeMenus(page);
  return options;
}

function getModelOption(options, model) {
  return options.find((option) => optionMatchesModel(option, model));
}

function getProOption(options) {
  return getModelOption(options, 'pro');
}

async function readQuotaResetInfo(page) {
  const options = await readModeOptions(page);
  const proOption = getProOption(options);
  const resetAt = proOption ? parseResetTime(proOption.text) : null;
  return {
    options,
    proOption,
    resetAtIso: resetAt ? resetAt.toISOString() : null,
    resetAtMs: resetAt ? resetAt.getTime() : null,
  };
}

async function selectProMode(page) {
  return await selectModelMode(page, 'pro');
}

async function selectModelMode(page, model) {
  await openModeMenu(page);
  const result = await page.evaluate((targetModel) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const modelFromText = (text) => {
      const raw = String(text || '');
      const compact = raw.toLowerCase().replace(/[\s_-]+/g, '');
      if (compact.includes('flashlite') || compact.includes('lite') || raw.includes('\u8f7b\u91cf')) return 'flash-lite';
      if (compact.includes('flash') || compact.includes('fast') || raw.includes('\u5feb\u901f')) return 'flash';
      if (compact.includes('pro')) return 'pro';
      return '';
    };
    const optionSelector = [
      'gem-menu-item',
      'gem-menu [role="menuitem"]',
      '[data-test-id^="bard-mode-option-"]',
      '.cdk-overlay-container button',
      '.cdk-overlay-container [role="menuitem"]',
      '.cdk-overlay-container [role="menuitemradio"]',
      '.cdk-overlay-container [role="option"]',
    ].join(', ');
    const options = Array.from(document.querySelectorAll(optionSelector)).filter(visible);
    const target = options.find((element) => {
      const text = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''} ${element.getAttribute('data-mode-id') || ''}`;
      const dataTestId = element.getAttribute('data-test-id') || '';
      const detected = modelFromText(`${text} ${dataTestId}`);
      if (targetModel === 'flash' && detected === 'flash-lite') return false;
      return detected === targetModel;
    });
    if (!target) return { selected: false, reason: `missing_${targetModel}_option` };
    const text = `${target.getAttribute('aria-label') || ''} ${(target.innerText || target.textContent || '').trim()}`.trim();
    const disabled = target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true';
    if (disabled) return { selected: false, reason: `${targetModel}_disabled`, text };
    target.click();
    return { selected: true, text };
  }, model);
  await sleep(1500);
  const mode = await getInputMode(page);
  if (!result.selected) await closeMenus(page);
  return { ...result, mode };
}

async function sleepUntil(targetMs, progress, reason, resetInfo) {
  while (Date.now() < targetMs) {
    const waitMs = Math.min(targetMs - Date.now(), quotaCheckIntervalMs);
    progress.quotaWaiting = true;
    progress.quotaReason = reason;
    progress.quotaResetAt = resetInfo?.resetAtIso ?? null;
    progress.quotaResumeAfter = new Date(targetMs).toISOString();
    progress.quotaLastCheckedAt = new Date().toISOString();
    await writeProgress(progress);
    console.log(`QUOTA_SLEEP_UNTIL reason=${reason} reset_at=${progress.quotaResetAt || 'unknown'} resume_after=${progress.quotaResumeAfter} sleep_ms=${Math.max(0, Math.round(waitMs))}`);
    await sleep(Math.max(0, waitMs));
  }
}

async function reloadAndTryPro(page, progress, reason) {
  const targetUrl = page.url() && page.url() !== 'about:blank' ? page.url() : 'https://gemini.google.com/app';
  let navigationError = null;
  for (const action of ['reload', 'goto']) {
    try {
      if (action === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      else await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      navigationError = null;
      break;
    } catch (error) {
      navigationError = error;
      console.log(`QUOTA_REFRESH_NAV_FAILED action=${action} message="${error instanceof Error ? error.message : String(error)}"`);
      await sleep(5000);
    }
  }
  try {
    await waitForInput(page);
  } catch (error) {
    progress.quotaRefreshError = error instanceof Error ? error.message : String(error);
    progress.quotaRefreshNavigationError = navigationError instanceof Error ? navigationError.message : (navigationError ? String(navigationError) : null);
    progress.quotaLastCheckedAt = new Date().toISOString();
    await writeProgress(progress);
    console.log(`QUOTA_REFRESH_INPUT_FAILED reason=${reason} message="${progress.quotaRefreshError}"`);
    return { selected: false, reason: 'input_unavailable_after_refresh', mode: await getInputMode(page).catch(() => ({ found: false, text: '' })) };
  }
  const selected = await selectProMode(page);
  progress.quotaMode = selected.mode;
  progress.quotaLastCheckedAt = new Date().toISOString();
  await writeProgress(progress);
  console.log(`QUOTA_AFTER_REFRESH reason=${reason} selected=${selected.selected} mode="${selected.mode?.text || 'unknown'}" note=${selected.reason || 'ok'}`);
  return selected;
}

async function confirmFastMode(page, attempts = 3, delayMs = 4000) {
  let mode = await getInputMode(page);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isFastMode(mode)) return { fast: false, mode };
    if (attempt < attempts - 1) {
      await sleep(delayMs);
      mode = await getInputMode(page);
    }
  }
  return { fast: isFastMode(mode), mode };
}

async function stopGenerationIfPresent(page) {
  return await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const stopButton = buttons.find((button) => {
      const text = `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
      return /stop/i.test(text) || text.includes('\u505c\u6b62');
    });
    if (!stopButton) return false;
    stopButton.click();
    return true;
  });
}

async function ensureConfiguredModel(page, progress, reason) {
  await waitForInput(page);
  const current = await getInputMode(page);
  const target = requestedModel;
  if (isRequestedModelMode(current, target)) {
    return { waited: false, reloaded: false, mode: current, target, fallbackUsed: false };
  }

  if (target !== 'pro') {
    const selected = await selectModelMode(page, target);
    if (selected.selected || isRequestedModelMode(selected.mode, target)) {
      progress.modelSelection = {
        requestedModel: target,
        activeModel: target,
        fallback: proFallback,
        reason,
        updatedAt: new Date().toISOString(),
        mode: selected.mode,
      };
      await writeProgress(progress);
      console.log(`MODEL_SELECT requested=${target} selected=${selected.selected} mode="${selected.mode?.text || 'unknown'}"`);
      return { waited: false, reloaded: false, mode: selected.mode, target, fallbackUsed: false };
    }
    throw new Error(`Cannot select Gemini model ${modelDisplayName(target)}: ${selected.reason || 'unknown'}`);
  }

  const proAttempt = await selectProMode(page);
  if (proAttempt.selected || isProMode(proAttempt.mode)) {
    progress.modelSelection = {
      requestedModel: 'pro',
      activeModel: 'pro',
      fallback: proFallback,
      reason,
      updatedAt: new Date().toISOString(),
      mode: proAttempt.mode,
    };
    await writeProgress(progress);
    console.log(`MODEL_SELECT requested=pro selected=${proAttempt.selected} mode="${proAttempt.mode?.text || 'unknown'}"`);
    return { waited: false, reloaded: false, mode: proAttempt.mode, target: 'pro', fallbackUsed: false };
  }

  if (proFallback === 'flash' || proFallback === 'flash-lite') {
    const fallbackAttempt = await selectModelMode(page, proFallback);
    if (fallbackAttempt.selected || isRequestedModelMode(fallbackAttempt.mode, proFallback)) {
      progress.modelSelection = {
        requestedModel: 'pro',
        activeModel: proFallback,
        fallback: proFallback,
        reason,
        proUnavailableReason: proAttempt.reason || 'pro_unavailable',
        updatedAt: new Date().toISOString(),
        mode: fallbackAttempt.mode,
      };
      progress.quotaWaiting = false;
      progress.quotaReason = null;
      await writeProgress(progress);
      console.log(`MODEL_FALLBACK requested=pro fallback=${proFallback} pro_reason=${proAttempt.reason || 'unknown'} mode="${fallbackAttempt.mode?.text || 'unknown'}"`);
      return { waited: false, reloaded: false, mode: fallbackAttempt.mode, target: proFallback, fallbackUsed: true };
    }
    throw new Error(`Pro unavailable, and fallback ${modelDisplayName(proFallback)} could not be selected: ${fallbackAttempt.reason || 'unknown'}`);
  }

  if (proFallback === 'stop') {
    throw new Error(`Pro quota appears unavailable and fallback is set to stop: ${proAttempt.reason || 'unknown'}`);
  }

  return await waitForProQuota(page, progress, reason);
}

async function waitForProQuota(page, progress, reason) {
  let waited = false;
  let reloaded = false;
  while (true) {
    try {
      await waitForInput(page);
    } catch (error) {
      progress.quotaInputError = error instanceof Error ? error.message : String(error);
      progress.quotaLastCheckedAt = new Date().toISOString();
      await writeProgress(progress);
      console.log(`QUOTA_INPUT_WAIT_FAILED reason=${reason} message="${progress.quotaInputError}"`);
      await sleep(5000);
      await reloadAndTryPro(page, progress, reason);
      waited = true;
      reloaded = true;
      continue;
    }
    const mode = await getInputMode(page);

    if (isProMode(mode)) {
      if (progress.quotaWaiting) {
        progress.quotaWaiting = false;
        progress.quotaRecoveredAt = new Date().toISOString();
        progress.quotaMode = mode;
        await writeProgress(progress);
        console.log(`QUOTA_RECOVERED mode="${mode.text || 'unknown'}"`);
      }
      return { waited, reloaded, mode };
    }

    if (!isFastMode(mode)) {
      const selected = await selectProMode(page);
      if (selected.selected || isProMode(selected.mode)) {
        if (progress.quotaWaiting) {
          progress.quotaWaiting = false;
          progress.quotaRecoveredAt = new Date().toISOString();
          progress.quotaMode = selected.mode;
          await writeProgress(progress);
          console.log(`QUOTA_RECOVERED mode="${selected.mode?.text || 'unknown'}"`);
        }
        return { waited, reloaded, mode: selected.mode };
      }
    }

    const confirmed = await confirmFastMode(page);
    if (!confirmed.fast && isProMode(confirmed.mode)) {
      if (progress.quotaWaiting) {
        progress.quotaWaiting = false;
        progress.quotaRecoveredAt = new Date().toISOString();
        progress.quotaMode = confirmed.mode;
        await writeProgress(progress);
        console.log(`QUOTA_RECOVERED mode="${confirmed.mode.text || 'unknown'}"`);
      }
      return { waited, reloaded, mode: confirmed.mode };
    }

    const proAttempt = await selectProMode(page);
    if (proAttempt.selected || isProMode(proAttempt.mode)) {
      if (progress.quotaWaiting) {
        progress.quotaWaiting = false;
        progress.quotaRecoveredAt = new Date().toISOString();
        progress.quotaMode = proAttempt.mode;
        await writeProgress(progress);
        console.log(`QUOTA_RECOVERED mode="${proAttempt.mode?.text || 'unknown'}"`);
      }
      return { waited, reloaded, mode: proAttempt.mode };
    }

    const stopped = await stopGenerationIfPresent(page);
    let resetInfo = null;
    const attemptResetAt = proAttempt.text ? parseResetTime(proAttempt.text) : null;
    if (attemptResetAt) {
      resetInfo = {
        options: [],
        proOption: { text: proAttempt.text, disabled: true },
        resetAtIso: attemptResetAt.toISOString(),
        resetAtMs: attemptResetAt.getTime(),
      };
    } else {
      resetInfo = await readQuotaResetInfo(page).catch((error) => {
        console.log(`QUOTA_RESET_READ_FAILED ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    }
    const targetMs = resetInfo?.resetAtMs
      ? Math.max(Date.now() + 1000, resetInfo.resetAtMs + quotaRefreshBufferMs)
      : Date.now() + quotaCheckIntervalMs;
    progress.quotaWaiting = true;
    progress.quotaReason = reason;
    progress.quotaMode = confirmed.mode;
    progress.quotaResetAt = resetInfo?.resetAtIso ?? null;
    progress.quotaResumeAfter = new Date(targetMs).toISOString();
    progress.quotaLastCheckedAt = new Date().toISOString();
    await writeProgress(progress);
    console.log(`QUOTA_WAIT reason=${reason} mode="${confirmed.mode.text || 'unknown'}" stopped=${stopped}; reset_at=${progress.quotaResetAt || 'unknown'} resume_after=${progress.quotaResumeAfter}`);
    waited = true;
    await sleepUntil(targetMs, progress, reason, resetInfo);
    await reloadAndTryPro(page, progress, reason);
    reloaded = true;
  }
}

async function waitForAnswerDone(page) {
  const started = Date.now();
  let sawStop = false;
  while (Date.now() - started < 360000) {
    const mode = await getInputMode(page);
    if (shouldPauseForFastMode(mode)) {
      const confirmed = await confirmFastMode(page);
      if (confirmed.fast) {
        const stopped = await stopGenerationIfPresent(page);
        return { done: false, quotaWait: true, stopped, mode: confirmed.mode };
      }
    }
    const state = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button')).map((button) => {
        return `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
      });
      const stop = buttons.some((text) => /stop/i.test(text) || text.includes('\u505c\u6b62'));
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const sendButton = Array.from(document.querySelectorAll('button'))
        .filter(visible)
        .find((button) => {
          const label = `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
          const send = label.includes('\u53d1\u9001') || /\bsend\b/i.test(label);
          const microphone = label.includes('\u9ea6\u514b\u98ce') || /\bmic(?:rophone)?\b/i.test(label);
          return send && !microphone;
        });
      return { stop, sendReady: !!sendButton && !sendButton.disabled };
    });
    if (state.stop) sawStop = true;
    if (sawStop && !state.stop) return { done: true, quotaWait: false };
    if (!sawStop && Date.now() - started > 60000 && state.sendReady) return { done: true, quotaWait: false };
    await sleep(2000);
  }
  if (await hasAnswerAfterLastPrompt(page)) return { done: true, quotaWait: false };
  return { done: false, quotaWait: false };
}

async function alignLatestUserTurnAtTop(page, deck, slideNumber) {
  try {
    const result = await page.evaluate((prompt) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textOf = (element) => (element.innerText || element.textContent || '').trim();
      const promptElements = Array.from(document.querySelectorAll('div, p, span'))
        .filter((element) => visible(element) && textOf(element).includes(prompt))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.top + window.scrollY) - (ar.top + window.scrollY);
        });
      const promptElement = promptElements[0];
      if (!promptElement) return { aligned: false, reason: 'prompt_not_found' };

      const promptRect = promptElement.getBoundingClientRect();
      const promptCenterX = (promptRect.left + promptRect.right) / 2;
      const images = Array.from(document.querySelectorAll('img'))
        .filter((image) => {
          if (!visible(image)) return false;
          const rect = image.getBoundingClientRect();
          const centerX = (rect.left + rect.right) / 2;
          return rect.width >= 40
            && rect.height >= 40
            && rect.bottom <= promptRect.top + 30
            && promptRect.top - rect.bottom < 650
            && Math.abs(centerX - promptCenterX) < 520;
        })
        .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);
      const target = images[0] || promptElement;

      const findScroller = (element) => {
        let current = element;
        while (current && current !== document.body && current !== document.documentElement) {
          const style = getComputedStyle(current);
          if (current.scrollHeight > current.clientHeight + 20 && /(auto|scroll)/.test(style.overflowY)) return current;
          current = current.parentElement;
        }
        return document.scrollingElement || document.documentElement;
      };
      const scroller = findScroller(target);
      const scrollerTop = scroller === document.scrollingElement || scroller === document.documentElement
        ? 0
        : scroller.getBoundingClientRect().top;
      const targetTop = target.getBoundingClientRect().top - scrollerTop + scroller.scrollTop;
      scroller.scrollTo({ top: Math.max(0, targetTop - 24), behavior: 'instant' });
      return {
        aligned: true,
        usedImage: target !== promptElement,
        promptTop: Math.round(promptRect.top),
        targetTop: Math.round(target.getBoundingClientRect().top),
      };
    }, promptText);
    console.log(`ALIGN_VIEW ${deck} slide ${slideNumber} aligned=${result.aligned} usedImage=${result.usedImage || false} reason=${result.reason || 'ok'}`);
    await sleep(300);
  } catch (error) {
    console.log(`ALIGN_VIEW_FAILED ${deck} slide ${slideNumber} message="${error instanceof Error ? error.message : String(error)}"`);
  }
}

function lessonLabel(deck) {
  const match = /^deck(\d+)_/.exec(deck);
  return match ? `Deck ${Number(match[1])}` : deck;
}

function deckTitle(deck) {
  return deck
    .replace(/^deck\d+_/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPrompt(deck, slideNumber, totalSlides, endSlideNumber = slideNumber) {
  const start = Math.max(1, Number(slideNumber) || 1);
  const end = Math.max(start, Number(endSlideNumber) || start);
  if (end <= start) return promptText;
  return `${promptText}\n\n本次上传的是第 ${start}-${end} 页 PPT，请按页码顺序分别讲解。`;
}

async function sendPrePrompt(page, deck, progress) {
  if (!prePromptText) return { done: true, skipped: true };
  await waitForInput(page);
  await ensureConfiguredModel(page, progress, 'before_pre_prompt');

  const existingComposer = await getComposerState(page);
  console.log(`PRE_PROMPT composer_before ${deck} text_len=${existingComposer.text.length} images=${existingComposer.imagePreviewCount}`);
  if (existingComposer.text || existingComposer.imagePreviewCount > 0) {
    await clearComposer(page);
  }

  const clearedComposer = await getComposerState(page);
  if (clearedComposer.text || clearedComposer.imagePreviewCount > 0) {
    return { done: false, retry: true, reason: `pre_prompt_composer_not_clean text_len=${clearedComposer.text.length} images=${clearedComposer.imagePreviewCount}` };
  }

  await typePrompt(page, prePromptText);
  const beforeSend = await ensureConfiguredModel(page, progress, 'before_pre_prompt_send');
  if (beforeSend.waited || beforeSend.reloaded) {
    return { done: false, retry: true, reason: 'quota_wait_before_pre_prompt_send' };
  }

  const prepared = await waitForPreparedComposer(page, prePromptText, { stableTarget: 10, expectedImageCount: 0 });
  console.log(`PRE_PROMPT before_send ${deck} ok=${prepared.ok} reason=${prepared.reason || 'ok'} text_len=${prepared.state?.text?.length || 0} images=${prepared.state?.imagePreviewCount ?? 0}`);
  if (!prepared.ok) {
    await clearComposer(page).catch(() => {});
    return { done: false, retry: true, reason: prepared.reason || 'pre_prompt_not_ready' };
  }

  const finalPrepared = await getComposerState(page);
  if (finalPrepared.imagePreviewCount !== 0 || !promptMatches(finalPrepared.text, prePromptText) || !finalPrepared.sendReady) {
    await clearComposer(page).catch(() => {});
    return { done: false, retry: true, reason: `pre_prompt_final_not_ready text_len=${finalPrepared.text.length} images=${finalPrepared.imagePreviewCount} sendReady=${finalPrepared.sendReady || false}` };
  }

  await clickSendButton(page);
  const submitted = await waitForComposerSubmitted(page);
  console.log(`PRE_PROMPT after_send ${deck} ok=${submitted.ok} reason=${submitted.reason || 'ok'}`);
  if (!submitted.ok) {
    await clearComposer(page).catch(() => {});
    return { done: false, retry: true, reason: submitted.reason || 'pre_prompt_not_submitted' };
  }

  return waitForAnswerDone(page);
}

async function ensurePrePromptSent(page, deck, progress) {
  if (!prePromptText) return;
  progress.prePrompts ??= {};
  const prior = progress.prePrompts[deck];
  if (prior?.done && prior.text === prePromptText) {
    console.log(`PRE_PROMPT skip ${deck}`);
    return;
  }

  for (let attempt = 1; attempt <= maxSendAttempts + 1; attempt += 1) {
    console.log(`PRE_PROMPT send ${deck} attempt=${attempt}/${maxSendAttempts + 1}`);
    progress.lastPrePrompt = {
      deck,
      done: false,
      text: prePromptText,
      attempt,
      updatedAt: new Date().toISOString(),
      url: page.url(),
    };
    await writeProgress(progress);

    const result = await sendPrePrompt(page, deck, progress);
    if (result.retry) {
      console.log(`PRE_PROMPT retry ${deck} reason=${result.reason || 'unknown'}`);
      if (attempt > maxSendAttempts) {
        throw new Error(`Pre-prompt self-check failed too many times on ${deck}: ${result.reason || 'unknown'}`);
      }
      if (shouldReloadBeforeRetry(result.reason)) {
        await reloadCurrentConversation(page);
      }
      continue;
    }

    if (result.quotaWait) {
      progress.quotaWaiting = true;
      progress.quotaReason = 'pre_prompt';
      progress.quotaMode = result.mode;
      await writeProgress(progress);
      console.log(`PRE_PROMPT quota_pause ${deck} mode="${result.mode?.text || 'unknown'}"`);
      await ensureConfiguredModel(page, progress, 'resume_after_pre_prompt_quota');
      continue;
    }

    if (!result.done) {
      throw new Error(`Timed out waiting for Gemini pre-prompt answer on ${deck}.`);
    }

    progress.prePrompts[deck] = {
      done: true,
      text: prePromptText,
      url: page.url(),
      sentAt: new Date().toISOString(),
    };
    progress.lastPrePrompt = {
      deck,
      done: true,
      text: prePromptText,
      updatedAt: new Date().toISOString(),
      url: page.url(),
    };
    await writeProgress(progress);
    console.log(`PRE_PROMPT done ${deck}`);
    return;
  }
}

async function clickConversationActions(page) {
  const primarySelectors = [
    '[aria-label*="\u5bf9\u8bdd\u64cd\u4f5c\u83dc\u5355"]',
    '[data-test-id="conversation-actions-menu-icon-button"]',
    '[aria-label*="Conversation"][aria-label*="action" i]',
  ];
  for (const selector of primarySelectors) {
    const button = page.locator(selector).first();
    if (await button.waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false)) {
      await button.click({ timeout: 15000 });
      return true;
    }
  }

  const selectors = [
    '[aria-label*="More"][aria-label*="option" i]',
    '[aria-label*="更多"]',
    '[aria-label*="选项"]',
    '[aria-label*="菜单"]',
  ];
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) {
      await button.click({ timeout: 15000 });
      return true;
    }
  }
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const target = buttons.find((element) => {
      const label = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''}`;
      return /conversation.*action|more.*option|more/i.test(label)
        || label.includes('conversation-actions')
        || label.includes('\u66f4\u591a')
        || label.includes('\u9009\u9879')
        || label.includes('\u83dc\u5355');
    });
    if (!target) return false;
    target.click();
    return true;
  });
}

async function clickRenameMenuItem(page) {
  const selectors = [
    '[data-test-id="rename-button"]',
    '[aria-label*="Rename" i]',
    '[aria-label*="\u91cd\u547d\u540d"]',
  ];
  for (const selector of selectors) {
    const item = page.locator(selector).first();
    if (await item.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)) {
      await item.click({ timeout: 15000 });
      return true;
    }
  }
  return await page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden';
    };
    const items = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]')).filter(visible);
    const target = items.find((element) => {
      const label = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()} ${element.getAttribute('data-test-id') || ''}`;
      return /rename/i.test(label) || label.includes('\u91cd\u547d\u540d') || label.includes('rename-button');
    });
    if (!target) return false;
    target.click();
    return true;
  });
}

async function renameCurrentConversation(page, title) {
  try {
    await waitForInput(page);
    const actionsOpened = await clickConversationActions(page);
    if (!actionsOpened) return { ok: false, changed: false, reason: 'actions_menu_not_found' };
    await sleep(600);
    const renameClicked = await clickRenameMenuItem(page);
    if (!renameClicked) {
      const buttons = await visibleButtonSummary(page);
      return { ok: false, changed: false, reason: `rename_menu_item_not_found buttons="${buttons}"` };
    }
    const input = page.locator('[data-test-id="edit-title-input"], input[type="text"], textarea').first();
    await input.waitFor({ state: 'visible', timeout: 15000 });
    const currentTitle = (await input.inputValue({ timeout: 15000 })).trim();
    if (currentTitle === title) {
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: true, changed: false, reason: 'already_named', currentTitle };
    }
    await input.fill(title, { timeout: 15000 });
    await page.locator('[data-test-id="save-button"]').click({ timeout: 5000 }).catch(async () => {
      await page.evaluate(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
        };
        const saveButton = Array.from(document.querySelectorAll('[data-test-id="save-button"], button'))
          .filter(visible)
          .find((element) => {
            const text = `${element.getAttribute('aria-label') || ''} ${(element.innerText || element.textContent || '').trim()}`;
            return element.getAttribute('data-test-id') === 'save-button' || text.includes('\u4fdd\u5b58') || /\bsave\b/i.test(text);
          });
        if (!saveButton) throw new Error('No visible save button found.');
        saveButton.click();
      });
    });
    await sleep(1500);
    return { ok: true, changed: true, reason: 'saved', currentTitle };
  } catch (error) {
    console.log(`RENAME_FAILED title="${title}" message="${error instanceof Error ? error.message : String(error)}"`);
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, changed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function isConversationRenameVerified(progress, deck, title = deckTitle(deck)) {
  const result = progress.renameResults?.[deck];
  return !!result?.ok && result.title === title;
}

async function ensureConversationRenamed(page, deck, progress, reason) {
  const title = deckTitle(deck);
  progress.renameResults ??= {};
  progress.renamedTitles ??= {};
  if (isConversationRenameVerified(progress, deck, title)) {
    console.log(`RENAME skip ${deck} title="${title}" verified=true reason=${reason}`);
    return { ok: true, changed: false, skipped: true, reason: 'already_verified' };
  }

  const result = await renameCurrentConversation(page, title);
  progress.renameResults[deck] = {
    ...result,
    title,
    reason,
    url: page.url(),
    updatedAt: new Date().toISOString(),
  };
  if (result.ok) progress.renamedTitles[deck] = title;
  else if (progress.renamedTitles[deck] === title) delete progress.renamedTitles[deck];
  await writeProgress(progress);
  console.log(`RENAME ${deck} title="${title}" ok=${result.ok} changed=${result.changed || false} reason="${result.reason || reason}"`);
  return result;
}

async function hasAnswerAfterLastPrompt(page) {
  return await page.evaluate((prompt) => {
    const bodyText = document.body.innerText || '';
    const promptIndex = bodyText.lastIndexOf(prompt);
    if (promptIndex < 0) return false;
    const afterPrompt = bodyText.slice(promptIndex + prompt.length);
    const answerMarkerIndex = afterPrompt.lastIndexOf('Gemini \u8bf4');
    if (answerMarkerIndex < 0) return false;
    const answerText = afterPrompt.slice(answerMarkerIndex);
    const buttons = Array.from(document.querySelectorAll('button')).map((button) => {
      return `${button.getAttribute('aria-label') || ''} ${(button.innerText || button.textContent || '').trim()}`;
    });
    const generating = buttons.some((text) => /stop/i.test(text) || text.includes('\u505c\u6b62'));
    return !generating && answerText.length > 200;
  }, buildPrompt());
}

async function inspectLatestAnswer(page, prompt) {
  return await page.evaluate((expectedPrompt) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = (element) => (element.innerText || element.textContent || '').trim();
    const promptElements = Array.from(document.querySelectorAll('div, p, span'))
      .filter((element) => visible(element) && textOf(element).includes(expectedPrompt))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.top + window.scrollY) - (ar.top + window.scrollY);
      });
    const promptElement = promptElements[0] || null;
    let userImageCount = 0;
    if (promptElement) {
      const promptRect = promptElement.getBoundingClientRect();
      const promptCenterX = (promptRect.left + promptRect.right) / 2;
      const containers = [];
      let current = promptElement;
      for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
        containers.push(current);
      }
      const inAncestor = new Set();
      for (const container of containers) {
        for (const image of Array.from(container.querySelectorAll('img'))) {
          if (visible(image)) inAncestor.add(image);
        }
      }
      const nearby = Array.from(document.querySelectorAll('img'))
        .filter((image) => {
          if (!visible(image)) return false;
          const rect = image.getBoundingClientRect();
          const centerX = (rect.left + rect.right) / 2;
          const bigEnough = rect.width >= 35 && rect.height >= 35;
          const nearPrompt = rect.bottom <= promptRect.top + 80
            && promptRect.top - rect.bottom < 700
            && Math.abs(centerX - promptCenterX) < 560;
          return bigEnough && nearPrompt;
        });
      userImageCount = new Set([...inAncestor, ...nearby]).size;
    }

    const bodyText = document.body.innerText || '';
    const promptIndex = bodyText.lastIndexOf(expectedPrompt);
    if (promptIndex < 0) return { hasPrompt: false, hasAnswer: false, missingImage: false, userImageCount, hasUserImage: false, answerText: '' };
    const afterPrompt = bodyText.slice(promptIndex + expectedPrompt.length);
    const markerIndex = afterPrompt.lastIndexOf('Gemini \u8bf4');
    const answerText = (markerIndex >= 0 ? afterPrompt.slice(markerIndex) : afterPrompt).trim();
    const lower = answerText.toLowerCase();
    const missingPhrases = [
      '\u6ca1\u6709\u770b\u5230',
      '\u672a\u770b\u5230',
      '\u65e0\u6cd5\u76f4\u63a5\u770b\u5230',
      '\u65e0\u6cd5\u770b\u5230',
      '\u76ee\u524d\u65e0\u6cd5\u76f4\u63a5\u770b\u5230',
      '\u597d\u50cf\u5fd8\u8bb0\u4e0a\u4f20',
      '\u4f3c\u4e4e\u6ca1\u6709\u770b\u5230',
      '\u6ca1\u6709\u4e0a\u4f20',
      '\u6ca1\u6709\u9644\u4e0a',
      '\u6ca1\u6709\u63d0\u4f9b',
      '\u5185\u5bb9\u5206\u4eab\u7ed9\u6211',
      '\u8bf7\u63d0\u4f9b',
      '\u901a\u8fc7\u4ee5\u4e0b',
      '\u8bf7\u4e0a\u4f20',
      '\u9700\u8981\u4e0a\u4f20',
      'did not receive',
      "can't see",
      'cannot see',
      'please upload',
      'upload the image',
    ];
    const strongMissingImagePhrases = [
      '\u6ca1\u6709\u770b\u5230\u56fe\u7247',
      '\u6ca1\u770b\u5230\u56fe\u7247',
      '\u672a\u770b\u5230\u56fe\u7247',
      '\u6ca1\u6709\u770b\u5230\u56fe\u50cf',
      '\u65e0\u6cd5\u770b\u5230\u56fe\u7247',
      '\u65e0\u6cd5\u67e5\u770b\u56fe\u7247',
      '\u6ca1\u6709\u6536\u5230\u56fe\u7247',
      '\u6ca1\u6709\u4e0a\u4f20\u56fe\u7247',
      '\u6ca1\u6709\u9644\u4e0a\u56fe\u7247',
      '\u8bf7\u4e0a\u4f20\u56fe\u7247',
      '\u8bf7\u63d0\u4f9b\u56fe\u7247',
      '\u6ca1\u6709\u770b\u5230ppt',
      '\u672a\u770b\u5230ppt',
      '\u6ca1\u6709\u770b\u5230\u5e7b\u706f\u7247',
      'did not receive the image',
      "can't see the image",
      'cannot see the image',
      'please upload the image',
    ];
    const imageWords = /ppt|\u56fe\u7247|\u56fe\u50cf|\u5e7b\u706f\u7247|image|slide|upload/i.test(answerText);
    const broadMissing = missingPhrases.some((phrase) => lower.includes(phrase.toLowerCase()));
    const strongMissing = strongMissingImagePhrases.some((phrase) => lower.includes(phrase.toLowerCase()));
    const missingImage = imageWords && (userImageCount === 0 ? broadMissing : strongMissing);
    return {
      hasPrompt: true,
      hasAnswer: answerText.length > 80,
      hasUserImage: userImageCount > 0,
      userImageCount,
      missingImage,
      answerText: answerText.slice(0, 500),
    };
  }, prompt);
}

async function sendSlideBatch(page, deck, slidePaths, slideNumber, endSlideNumber, totalSlides) {
  const expectedImageCount = slidePaths.length;
  const rangeLabel = slideNumber === endSlideNumber ? `${slideNumber}` : `${slideNumber}-${endSlideNumber}`;
  const prompt = buildPrompt(deck, slideNumber, totalSlides, endSlideNumber);
  await waitForInput(page);
  await ensureConfiguredModel(page, progress, 'before_upload');
  const existingComposer = await getComposerState(page);
  console.log(`SELF_CHECK composer_before ${deck} slides ${rangeLabel}/${totalSlides} text_len=${existingComposer.text.length} images=${existingComposer.imagePreviewCount}`);
  if (existingComposer.text || existingComposer.imagePreviewCount > 0) {
    console.log(`SELF_CHECK clear_stale_composer ${deck} slides ${rangeLabel}/${totalSlides} text_len=${existingComposer.text.length} images=${existingComposer.imagePreviewCount}`);
    await clearComposer(page);
  }
  const clearedComposer = await getComposerState(page);
  if (clearedComposer.text || clearedComposer.imagePreviewCount > 0) {
    return { done: false, quotaWait: false, retry: true, reason: `composer_not_clean text_len=${clearedComposer.text.length} images=${clearedComposer.imagePreviewCount}` };
  }
  for (let index = 0; index < slidePaths.length; index += 1) {
    try {
      await uploadOne(page, slidePaths[index]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { done: false, quotaWait: false, retry: true, reason: `upload_file_chooser_failed ${message.replace(/\s+/g, ' ').slice(0, 180)}` };
    }
  }
  if (slideNumber === 1 && firstSlideUploadSettleMs > 0) {
    console.log(`FIRST_SLIDE_UPLOAD_BUFFER ${deck} slides ${rangeLabel}/${totalSlides} wait_ms=${firstSlideUploadSettleMs}`);
    await sleep(firstSlideUploadSettleMs);
  }
  const uploadState = await waitForUploadPreviewStable(page, expectedImageCount, {
    stableTarget: slideNumber === 1 ? 16 : 8,
  });
  console.log(`SELF_CHECK upload ${deck} slides ${rangeLabel}/${totalSlides} images=${uploadState.imagePreviewCount} previewImages=${uploadState.previewImageCount} removeButtons=${uploadState.removeButtonCount} stable=${uploadState.stableCount || 0}`);
  if (uploadState.imagePreviewCount !== expectedImageCount) {
    await clearComposer(page).catch(() => {});
    return { done: false, quotaWait: false, retry: true, reason: `upload_preview_count_${uploadState.imagePreviewCount}` };
  }
  await typePrompt(page, prompt);
  const beforeSend = await ensureConfiguredModel(page, progress, 'before_send');
  if (beforeSend.waited || beforeSend.reloaded) {
    return { done: false, quotaWait: false, retry: true, reason: 'quota_wait_before_send' };
  }
  const prepared = await waitForPreparedComposer(page, prompt, {
    stableTarget: slideNumber === 1 ? 20 : 10,
    expectedImageCount,
  });
  console.log(`SELF_CHECK before_send ${deck} slides ${rangeLabel}/${totalSlides} ok=${prepared.ok} reason=${prepared.reason || 'ok'} stable=${prepared.stableCount || 0} text_len=${prepared.state?.text?.length || 0} images=${prepared.state?.imagePreviewCount ?? 0} sendReady=${prepared.state?.sendReady || false}`);
  if (!prepared.ok) {
    await clearComposer(page).catch(() => {});
    return { done: false, quotaWait: false, retry: true, reason: prepared.reason || 'composer_not_ready' };
  }
  const beforeClickWaitMs = slideNumber === 1 ? firstSlidePreSendSettleMs : preSendSettleMs;
  if (beforeClickWaitMs > 0) {
    console.log(`PRE_SEND_BUFFER ${deck} slides ${rangeLabel}/${totalSlides} wait_ms=${beforeClickWaitMs}`);
    await sleep(beforeClickWaitMs);
  }
  const finalPrepared = await getComposerState(page);
  console.log(`SELF_CHECK final_before_send ${deck} slides ${rangeLabel}/${totalSlides} text_len=${finalPrepared.text.length} images=${finalPrepared.imagePreviewCount} sendReady=${finalPrepared.sendReady || false}`);
  if (finalPrepared.imagePreviewCount !== expectedImageCount || !promptMatches(finalPrepared.text, prompt) || !finalPrepared.sendReady) {
    await clearComposer(page).catch(() => {});
    return { done: false, quotaWait: false, retry: true, reason: `final_composer_not_ready text_len=${finalPrepared.text.length} images=${finalPrepared.imagePreviewCount} sendReady=${finalPrepared.sendReady || false}` };
  }
  await clickSendButton(page);
  const submitted = await waitForComposerSubmitted(page);
  console.log(`SELF_CHECK after_send ${deck} slides ${rangeLabel}/${totalSlides} ok=${submitted.ok} reason=${submitted.reason || 'ok'} text_len=${submitted.state?.text?.length || 0} images=${submitted.state?.imagePreviewCount ?? 0}`);
  if (!submitted.ok) {
    const recovered = await reloadAndAuditLatestAnswer(page, prompt, deck, slideNumber, totalSlides, submitted.reason || 'composer_not_submitted', expectedImageCount)
      .catch((error) => {
        console.log(`RECOVER_RELOAD_FAILED ${deck} slides ${rangeLabel}/${totalSlides} message="${error instanceof Error ? error.message : String(error)}"`);
        return null;
      });
    if (recovered) return recovered;
    await clearComposer(page).catch(() => {});
    return { done: false, quotaWait: false, retry: true, reason: submitted.reason || 'composer_not_submitted' };
  }
  const answerResult = await waitForAnswerDone(page);
  if (answerResult.done) {
    const answerAudit = await inspectLatestAnswer(page, prompt);
    console.log(`SELF_CHECK answer ${deck} slides ${rangeLabel}/${totalSlides} hasAnswer=${answerAudit.hasAnswer} hasUserImage=${answerAudit.hasUserImage} userImages=${answerAudit.userImageCount || 0} missingImage=${answerAudit.missingImage}`);
    if (!answerAudit.hasUserImage || answerAudit.missingImage || Number(answerAudit.userImageCount || 0) < expectedImageCount) {
      return { done: false, quotaWait: false, retry: true, reason: 'gemini_missing_image' };
    }
  }
  if (!answerResult.done && !answerResult.quotaWait) {
    const recovered = await reloadAndAuditLatestAnswer(page, prompt, deck, slideNumber, totalSlides, 'answer_timeout', expectedImageCount)
      .catch((error) => {
        console.log(`RECOVER_RELOAD_FAILED ${deck} slides ${rangeLabel}/${totalSlides} message="${error instanceof Error ? error.message : String(error)}"`);
        return null;
      });
    if (recovered) return recovered;
  }
  return answerResult;
}

const progress = await readProgress();
progress.renamedTitles ??= {};
progress.renameResults ??= {};
progress.modelSettings = {
  requestedModel,
  proFallback,
  prompt: promptText,
  prePrompt: prePromptText,
  pagesPerPrompt,
  updatedAt: new Date().toISOString(),
};
await writeProgress(progress);
console.log(`MODEL_SETTINGS requested=${requestedModel} pro_fallback=${proFallback} pages_per_prompt=${pagesPerPrompt} prompt="${promptText}" pre_prompt_len=${prePromptText.length}`);
const decks = await listDecks();
const { browser, page } = await getGeminiPage();

let processed = 0;
const retryCounts = new Map();
try {
  for (const deck of decks) {
    const slides = await listSlides(deck);
    let sent = progress.sent[deck] || 0;
    if (progress.last?.deck === deck && progress.last.done === false) {
      const retryFrom = Math.max(0, Number(progress.last.slideStart || progress.last.slide || sent + 1) - 1);
      if (retryFrom < sent) {
        sent = retryFrom;
        progress.sent[deck] = sent;
        await writeProgress(progress);
      }
      console.log(`REWIND incomplete ${deck} to slide ${sent + 1}/${slides.length}`);
    }
    if (progress.last?.deck === deck && progress.last.done === false && progress.last.slide === sent) {
      sent = Math.max(0, sent - 1);
      progress.sent[deck] = sent;
      await writeProgress(progress);
      console.log(`REWIND incomplete ${deck} to slide ${sent + 1}/${slides.length}`);
    }
    if (sent >= slides.length) {
      console.log(`SKIP complete ${deck} (${sent}/${slides.length})`);
      if (progress.conversations[deck] && !isConversationRenameVerified(progress, deck)) {
        await gotoGemini(page, progress.conversations[deck], `rename_complete_${deck}`);
        await waitForInput(page);
        await ensureConversationRenamed(page, deck, progress, 'complete_deck_verify');
      }
      await updateConversationFolderIndex(progress, deck, slides, progress.conversations[deck]);
      continue;
    }

    if (progress.conversations[deck]) {
      console.log(`RESUME ${deck} at slide ${sent + 1}/${slides.length}`);
      await gotoGemini(page, progress.conversations[deck], `resume_${deck}`);
      await waitForInput(page);
      await updateConversationFolderIndex(progress, deck, slides, progress.conversations[deck]);
    } else {
      console.log(`NEW_CHAT ${deck}`);
      await openNewChat(page);
      progress.conversations[deck] = page.url();
      await writeProgress(progress);
      await updateConversationFolderIndex(progress, deck, slides, page.url());
      console.log(`FOLDER_INDEX ${deck} -> ${conversationFoldersPath}`);
    }

    if (sent <= 0) {
      await ensurePrePromptSent(page, deck, progress);
      if (prePromptText) await ensureConversationRenamed(page, deck, progress, 'after_pre_prompt');
    } else {
      await ensureConversationRenamed(page, deck, progress, 'resume_started_deck');
    }

    for (let index = sent; index < slides.length;) {
      if (maxSlides > 0 && processed >= maxSlides) {
        console.log(`MAX_SLIDES reached (${processed}).`);
        await writeProgress(progress);
        await browser.close();
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
        await browser.close();
        process.exit(0);
      }
      const slideNumber = index + 1;
      const endSlideNumber = index + batchSize;
      const slideBatch = slides.slice(index, endSlideNumber);
      const rangeLabel = slideNumber === endSlideNumber ? `${slideNumber}` : `${slideNumber}-${endSlideNumber}`;
      if (progress.last?.deck === deck && progress.last.done === false) {
        const lastStart = Number(progress.last.slideStart || progress.last.slide || 0);
        const lastEnd = Number(progress.last.slideEnd || progress.last.slide || lastStart);
        if (lastStart === slideNumber && lastEnd === endSlideNumber) {
          const answerAudit = await inspectLatestAnswer(page, buildPrompt(deck, slideNumber, slides.length, endSlideNumber));
          if (answerAudit.hasAnswer && answerAudit.hasUserImage && !answerAudit.missingImage && Number(answerAudit.userImageCount || 0) >= slideBatch.length) {
            progress.last = { deck, slide: endSlideNumber, slideStart: slideNumber, slideEnd: endSlideNumber, totalSlides: slides.length, done: true, url: page.url() };
            progress.sent[deck] = endSlideNumber;
            await alignLatestUserTurnAtTop(page, deck, slideNumber);
            await writeProgress(progress);
            console.log(`RECOVER answered ${deck} slides ${rangeLabel}/${slides.length}`);
            index = endSlideNumber;
            continue;
          }
          if (answerAudit.hasAnswer && (!answerAudit.hasUserImage || answerAudit.missingImage || Number(answerAudit.userImageCount || 0) < slideBatch.length)) {
            console.log(`RECOVER_REJECTED_MISSING_IMAGE ${deck} slides ${rangeLabel}/${slides.length} userImages=${answerAudit.userImageCount || 0}`);
          }
        }
      }
      console.log(`SEND ${deck} slides ${rangeLabel}/${slides.length}`);
      progress.last = { deck, slide: endSlideNumber, slideStart: slideNumber, slideEnd: endSlideNumber, totalSlides: slides.length, pagesPerPrompt, done: false, url: page.url() };
      await writeProgress(progress);
      const result = await sendSlideBatch(page, deck, slideBatch, slideNumber, endSlideNumber, slides.length);
      if (result.retry) {
        const retryKey = `${deck}:${slideNumber}-${endSlideNumber}`;
        const retryCount = (retryCounts.get(retryKey) || 0) + 1;
        retryCounts.set(retryKey, retryCount);
        progress.lastRetry = {
          deck,
          slide: endSlideNumber,
          slideStart: slideNumber,
          slideEnd: endSlideNumber,
          totalSlides: slides.length,
          reason: result.reason || 'unknown',
          retryCount,
          retryLimit: maxSendAttempts,
          updatedAt: new Date().toISOString(),
        };
        await writeProgress(progress);
        console.log(`RETRY ${deck} slides ${rangeLabel}/${slides.length} attempt=${retryCount}/${maxSendAttempts} reason=${result.reason || 'unknown'}`);
        if (retryCount > maxSendAttempts) {
          throw new Error(`Self-check failed too many times on ${deck} slides ${rangeLabel}: ${result.reason || 'unknown'}`);
        }
        await clearComposer(page).catch((error) => {
          console.log(`RETRY_CLEAR_FAILED ${deck} slides ${rangeLabel}/${slides.length} message="${error instanceof Error ? error.message : String(error)}"`);
        });
        if (shouldReloadBeforeRetry(result.reason)) {
          console.log(`RETRY_RELOAD ${deck} slides ${rangeLabel}/${slides.length} reason=${result.reason || 'unknown'}`);
          await reloadCurrentConversation(page);
        }
        continue;
      }
      if (result.quotaWait) {
        progress.quotaWaiting = true;
        progress.quotaReason = 'during_answer';
        progress.quotaMode = result.mode;
        progress.lastQuotaSlide = { deck, slide: endSlideNumber, slideStart: slideNumber, slideEnd: endSlideNumber, totalSlides: slides.length, url: page.url(), stopped: result.stopped };
        await writeProgress(progress);
        console.log(`QUOTA_PAUSE ${deck} slides ${rangeLabel}/${slides.length} mode="${result.mode?.text || 'unknown'}" stopped=${result.stopped}`);
        await ensureConfiguredModel(page, progress, 'resume_after_fast_mode');
        continue;
      }
      const done = result.done;
      const currentUrl = page.url();
      progress.conversations[deck] = currentUrl;
      progress.last = { deck, slide: endSlideNumber, slideStart: slideNumber, slideEnd: endSlideNumber, totalSlides: slides.length, pagesPerPrompt, done, url: currentUrl };
      if (done) {
        progress.sent[deck] = endSlideNumber;
        if (slideNumber === 1 || !isConversationRenameVerified(progress, deck)) {
          await ensureConversationRenamed(page, deck, progress, `after_slide_${slideNumber}`);
        }
        await alignLatestUserTurnAtTop(page, deck, slideNumber);
      }
      await writeProgress(progress);
      await updateConversationFolderIndex(progress, deck, slides, currentUrl);
      processed += slideBatch.length;
      retryCounts.delete(`${deck}:${slideNumber}-${endSlideNumber}`);
      console.log(`DONE ${deck} slides ${rangeLabel}/${slides.length} answerDone=${done}`);
      if (!done) {
        throw new Error(`Timed out waiting for Gemini answer on ${deck} slides ${rangeLabel}.`);
      }
      index = endSlideNumber;
    }
  }
  console.log('ALL_DONE');
} finally {
  await browser.close();
}
