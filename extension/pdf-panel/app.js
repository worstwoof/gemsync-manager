import * as pdfjsLib from "./pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.mjs", import.meta.url).toString();

const $ = (id) => document.getElementById(id);

const elements = {
  deckTitle: $("deckTitle"),
  subjectSelect: $("subjectSelect"),
  deckSelect: $("deckSelect"),
  prevPage: $("prevPage"),
  nextPage: $("nextPage"),
  pageInput: $("pageInput"),
  totalPages: $("totalPages"),
  autoSync: $("autoSync"),
  syncPage: $("syncPage"),
  deepSyncPage: $("deepSyncPage"),
  bindPage: $("bindPage"),
  openGemini: $("openGemini"),
  status: $("status"),
  pageRail: $("pageRail"),
  viewer: $("viewer"),
  pages: $("pages"),
};

const state = {
  subjects: [],
  subject: null,
  config: null,
  configUrl: "",
  deck: null,
  pdf: null,
  pageCount: 0,
  currentPage: 1,
  scale: 1,
  embedded: false,
  cachedOnly: false,
  rendered: new Set(),
  rendering: new Map(),
  observer: null,
  syncTimer: 0,
  bridgeSeq: 0,
  bridgeWaiters: new Map(),
  parentSeq: 0,
  parentWaiters: new Map(),
  lastSent: "",
  syncBusy: false,
  queuedAutoPage: null,
  visiblePageRaf: 0,
  estimatedFrameHeight: 0,
  deckSwitchSeq: 0,
  suppressAutoSyncUntil: 0,
  suppressParentNotifyUntil: 0,
  userPdfScrollSeq: 0,
  pdfInputGuardsInstalled: false,
};

const bridgeEvents = {
  sync: "gemsync:sync-page",
  bind: "gemsync:bind-page",
  open: "gemsync:open-gemini",
};

function setStatus(text, tone = "neutral") {
  elements.status.textContent = text;
  elements.status.className = `status ${tone}`;
}

function notifyParentState() {
  if (!state.embedded) return;
  if (Date.now() < state.suppressParentNotifyUntil) return;
  window.parent.postMessage({
    source: "gemsync-app-iframe",
    type: "gemsync:pdf-state",
    payload: {
      deckId: state.deck?.id || "",
      deckTitle: state.deck?.title || "",
      subjectId: state.subject?.id || "",
      subjectTitle: state.subject?.title || "",
      conversationId: state.deck?.conversationId || "",
      geminiUrl: state.deck?.geminiUrl || "",
      chatgptUrl: state.deck?.chatgptUrl || "",
      provider: state.deck?.provider || state.config?.provider || "gemini",
      pageNumber: state.currentPage || 1,
      pagePrompt: state.config?.pagePrompt || "",
      promptStartIndex: configuredPromptStartIndex(),
      pagesPerPrompt: configuredPagesPerPrompt(),
      targetPromptIndex: state.deck ? promptIndexForPageNumber(state.currentPage || 1) : 1,
      hasPromptMapping: state.deck ? promptIndexForPageNumber(state.currentPage || 1) !== null : true,
      binding: state.deck ? getBindingForPage(state.currentPage || 1) : null,
      autoSyncEnabled: !!elements.autoSync.checked,
    },
  }, "*");
}

function suppressPdfFeedback(ms = 2400) {
  const until = Date.now() + ms;
  state.suppressAutoSyncUntil = Math.max(state.suppressAutoSyncUntil, until);
  state.suppressParentNotifyUntil = Math.max(state.suppressParentNotifyUntil, until);
  clearTimeout(state.syncTimer);
}

function noteUserPdfInteraction() {
  state.userPdfScrollSeq += 1;
  state.suppressParentNotifyUntil = 0;
  state.suppressAutoSyncUntil = 0;
}

function clampPage(page) {
  return Math.max(1, Math.min(state.pageCount || 1, Number(page) || 1));
}

function getSubjectId() {
  return state.subject?.id || "default";
}

function getStorageKey(deckId, pageNumber) {
  return `gemsync:${getSubjectId()}:${deckId}:page:${pageNumber}`;
}

function getLegacyStorageKey(deckId, pageNumber) {
  return `gemsync:${deckId}:page:${pageNumber}`;
}

function getPromptStorageKey(deckId, promptIndex) {
  return `gemsync:${getSubjectId()}:${deckId}:prompt:${promptIndex}`;
}

function getExactBinding(pageNumber = state.currentPage) {
  const keys = [
    getStorageKey(state.deck.id, pageNumber),
    getLegacyStorageKey(state.deck.id, pageNumber),
  ];
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const binding = JSON.parse(raw);
      if (binding?.autoLearned) continue;
      return binding;
    } catch {
      // Ignore bad calibration records; the default sequential mapping still works.
    }
  }
  return null;
}

function getBindingForPage(pageNumber = state.currentPage) {
  const exact = getExactBinding(pageNumber);
  if (!exact) return null;
  return {
    ...exact,
    fixedPageMapping: true,
    targetPromptIndex: exact.promptIndex || null,
    targetImagePromptIndex: exact.imagePromptIndex || null,
  };
}

function setLocalBinding(pageNumber, binding) {
  localStorage.setItem(getStorageKey(state.deck.id, pageNumber), JSON.stringify(binding));
  const promptIndex = Number(binding?.promptIndex || binding?.targetPromptIndex) || 0;
  if (promptIndex) {
    localStorage.setItem(getPromptStorageKey(state.deck.id, promptIndex), JSON.stringify({
      ...binding,
      promptIndex,
      pageNumber,
      fixedPageMapping: true,
    }));
  }
}

function setAutoSyncEnabled(enabled, statusText = "") {
  elements.autoSync.checked = enabled;
  localStorage.setItem("gemsync:autoSync", enabled ? "true" : "false");
  if (!enabled) {
    clearTimeout(state.syncTimer);
    state.queuedAutoPage = null;
  }
  if (statusText) {
    setStatus(statusText, enabled ? "ok" : "warn");
  }
  notifyParentState();
}

function updateControls() {
  const provider = state.deck?.provider || state.config?.provider || "gemini";
  elements.deckTitle.textContent = state.deck?.title || "算法导论";
  elements.pageInput.value = state.currentPage;
  elements.pageInput.max = state.pageCount || 1;
  elements.totalPages.textContent = state.pageCount || 0;
  elements.prevPage.disabled = state.currentPage <= 1;
  elements.nextPage.disabled = state.currentPage >= state.pageCount;
  if (elements.openGemini) {
    const targetUrl = provider === "chatgpt" ? state.deck?.chatgptUrl : state.deck?.geminiUrl;
    elements.openGemini.textContent = provider === "chatgpt" ? "打开 ChatGPT" : "打开 Gemini";
    elements.openGemini.disabled = !targetUrl;
    elements.openGemini.title = targetUrl
      ? (provider === "chatgpt" ? "打开 ChatGPT 网页原对话" : "打开 Gemini 原对话")
      : "这个章节还没有原对话链接";
  }

  for (const button of elements.pageRail.querySelectorAll(".rail-page")) {
    const page = Number(button.dataset.page);
    const isActive = page === state.currentPage;
    button.classList.toggle("active", isActive);
    if (isActive) {
      button.scrollIntoView({ block: "nearest" });
    }
    button.title = getExactBinding(page) ? `第 ${page} 页：已有校准` : `第 ${page} 页`;
  }
  notifyParentState();
}

function postToExtension(kind, payload, timeoutMs = 7000) {
  const id = ++state.bridgeSeq;
  const eventType = bridgeEvents[kind];
  if (!eventType) {
    return Promise.reject(new Error(`Unknown bridge event: ${kind}`));
  }

  const message = {
    source: "gemsync-app",
    id,
    type: eventType,
    payload,
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.bridgeWaiters.delete(id);
      reject(new Error("没有收到 Chrome 插件回应，请确认 Gemini Reading Marker 插件已重新加载。"));
    }, timeoutMs);

    state.bridgeWaiters.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    window.postMessage(message, window.location.origin);
  });
}

function postToRuntime(kind, payload, timeoutMs = 7000) {
  const type = bridgeEvents[kind];
  const runtime = globalThis.chrome?.runtime;
  if (!type || !runtime?.id || !runtime?.sendMessage) return null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("没有收到 Chrome 插件回应，请确认 Gemini Reading Marker 插件已重新加载。"));
    }, timeoutMs);

    runtime.sendMessage({ type, payload }, (response) => {
      clearTimeout(timer);
      const error = runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response?.ok) {
        resolve(response);
      } else {
        reject(new Error(response?.error || "插件执行失败。"));
      }
    });
  });
}

async function postCommand(kind, payload) {
  const type = bridgeEvents[kind];
  if (!type) throw new Error(`Unknown command kind: ${kind}`);
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, payload }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `发送同步任务失败：${response.status}`);
  }
  return data.id;
}

async function waitForCommandResult(id, timeoutMs = 12000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`/api/result/${encodeURIComponent(id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `读取同步结果失败：${response.status}`);
    }
    if (!data.pending) {
      const result = data.result || {};
      if (!result.ok) {
        throw new Error(result.error || "Gemini 执行同步失败。");
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  throw new Error("已发送同步任务，但 Gemini 还没回报执行结果。请刷新 Gemini 页或重新加载扩展。");
}

async function sendModelCommand(kind, payload, timeoutMs = 12000, parentOptions = {}) {
  if (state.embedded) {
    return postToParent(kind, payload, timeoutMs, parentOptions);
  }

  const runtimeResult = postToRuntime(kind, payload, timeoutMs);
  if (runtimeResult) return runtimeResult;

  try {
    return await postToExtension(kind, payload, timeoutMs);
  } catch (error) {
    if (!/没有收到 Chrome 插件回应|Extension context expired|context invalidated/i.test(error.message || "")) {
      throw error;
    }
  }

  return waitForCommandResult(await postCommand(kind, payload), timeoutMs);
}

window.addEventListener("message", (event) => {
  if (event.source === window && event.origin === window.location.origin) {
    const data = event.data;
    if (data?.source !== "gemsync-extension" || !data.id) return;

    const waiter = state.bridgeWaiters.get(data.id);
    if (!waiter) return;
    state.bridgeWaiters.delete(data.id);

    if (data.ok) {
      waiter.resolve(data);
    } else {
      waiter.reject(new Error(data.error || "插件执行失败。"));
    }
    return;
  }

  const data = event.data;
  if (data?.source !== "gemsync-parent") return;
  if (data.type === "gemsync:gemini-visible-page") {
    handleGeminiVisiblePage(data.payload).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
    return;
  }
  if (!data.id) return;

  const waiter = state.parentWaiters.get(data.id);
  if (!waiter) return;
  state.parentWaiters.delete(data.id);

  if (data.ok) {
    waiter.resolve(data);
  } else {
    waiter.reject(new Error(data.error || "插件执行失败。"));
  }
});

function postToParent(kind, payload, timeoutMs = 90000, options = {}) {
  const id = ++state.parentSeq;
  const eventType = bridgeEvents[kind];
  if (!eventType) {
    return Promise.reject(new Error(`Unknown parent event: ${kind}`));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.parentWaiters.delete(id);
      if (options.resolveOnTimeout) {
        resolve({ ok: true, pending: true });
        return;
      }
      reject(new Error("左侧 Gemini 没有回应。请刷新 Gemini 页面；如果刚更新过扩展，也要在 chrome://extensions 里重新加载扩展。"));
    }, timeoutMs);

    state.parentWaiters.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    window.parent.postMessage({
      source: "gemsync-app-iframe",
      id,
      type: eventType,
      payload,
    }, "*");
  });
}

function syncPayload(pageNumber = state.currentPage, reason = "manual", options = {}) {
  const binding = getBindingForPage(pageNumber);
  const targetPromptIndex = promptIndexForPageNumber(pageNumber);
  return {
    subjectId: state.subject?.id || "",
    subjectTitle: state.subject?.title || "",
    deckId: state.deck.id,
    deckTitle: state.deck.title,
    conversationId: state.deck.conversationId,
    geminiUrl: state.deck.geminiUrl,
    chatgptUrl: state.deck.chatgptUrl,
    provider: state.deck.provider || state.config.provider || "gemini",
    pagePrompt: state.config.pagePrompt,
    promptStartIndex: configuredPromptStartIndex(),
    pagesPerPrompt: configuredPagesPerPrompt(),
    targetPromptIndex,
    hasPromptMapping: targetPromptIndex !== null,
    pageNumber,
    totalPages: state.pageCount,
    reason,
    deep: !!options.deep,
    binding,
  };
}

function bindingEntriesForCurrentDeck() {
  if (!state.deck?.id) return [];
  const pagePrefixes = [
    { prefix: `gemsync:${getSubjectId()}:${state.deck.id}:page:`, type: "page" },
    { prefix: `gemsync:${state.deck.id}:page:`, type: "page" },
    { prefix: `gemsync:${getSubjectId()}:${state.deck.id}:prompt:`, type: "prompt" },
  ];
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = pagePrefixes.find((item) => key?.startsWith(item.prefix));
    if (!match) continue;
    try {
      const binding = JSON.parse(localStorage.getItem(key) || "{}");
      if (binding.autoLearned) continue;
      const keyNumber = Number(key.slice(match.prefix.length));
      const pageNumber = match.type === "page" ? keyNumber : Number(binding.pageNumber);
      const promptIndex = Number(binding.promptIndex || binding.targetPromptIndex || (match.type === "prompt" ? keyNumber : 0)) || null;
      if (!pageNumber) continue;
      const seenKey = `${pageNumber}:${promptIndex || ""}:${binding.savedAt || ""}`;
      if (seen.has(seenKey)) continue;
      seen.add(seenKey);
      entries.push({ ...binding, pageNumber, promptIndex });
    } catch {
      // Ignore bad calibration records; the fallback index still works.
    }
  }
  return entries;
}

function pageFromCalibratedIndex(kind, index) {
  const value = Number(index) || 0;
  if (!value) return null;

  const exact = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry[kind]) === value)
    .sort((a, b) => b.pageNumber - a.pageNumber)[0];

  return exact?.pageNumber || null;
}

function isBetweenSamePageCalibrations(kind, index) {
  const value = Number(index) || 0;
  if (!value) return false;

  const entries = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry[kind]) > 0)
    .sort((a, b) => Number(a[kind]) - Number(b[kind]) || a.pageNumber - b.pageNumber);
  const previous = [...entries].reverse().find((entry) => Number(entry[kind]) < value);
  const next = entries.find((entry) => Number(entry[kind]) > value);

  return Boolean(previous && next && Number(previous.pageNumber) === Number(next.pageNumber));
}

function configuredPromptStartIndex() {
  if (state.deck?.id) {
    const pageOne = getExactBinding(1);
    const pageOnePrompt = Number(pageOne?.promptIndex || pageOne?.targetPromptIndex || 0);
    if (pageOnePrompt > 1) return Math.floor(pageOnePrompt);
  }

  const configured = Number(state.config?.promptStartIndex || state.deck?.promptStartIndex || 0);
  if (Number.isFinite(configured) && configured > 1) return Math.floor(configured);
  const prePrompt = String(state.config?.prePrompt || state.deck?.prePrompt || "").trim();
  return prePrompt ? 2 : 1;
}

function configuredPagesPerPrompt() {
  const configured = Number(state.config?.pagesPerPrompt || state.deck?.pagesPerPrompt || 1);
  if (Number.isFinite(configured)) return Math.max(1, Math.min(3, Math.floor(configured)));
  return 1;
}

function pageIfInRange(page) {
  const value = Number(page) || 0;
  if (value < 1 || value > (state.pageCount || 1)) return null;
  return Math.floor(value);
}

function promptOffsetForPage(page) {
  const pages = configuredPagesPerPrompt();
  return Math.floor((Math.max(1, Number(page) || 1) - 1) / pages);
}

function firstPageForPromptOffset(offset) {
  const pages = configuredPagesPerPrompt();
  return Math.floor(Math.max(0, Number(offset) || 0)) * pages + 1;
}

function promptIndexForPageNumber(pageNumber) {
  const page = clampPage(pageNumber);
  const exact = getExactBinding(page);
  const exactPromptIndex = Number(exact?.promptIndex || exact?.targetPromptIndex || 0);
  if (exactPromptIndex > 0) return Math.floor(exactPromptIndex);

  const entries = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry.pageNumber) > 0 && Number(entry.promptIndex) > 0)
    .sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber) || Number(a.promptIndex) - Number(b.promptIndex));
  const previous = [...entries].reverse().find((entry) => Number(entry.pageNumber) < page);
  const next = entries.find((entry) => Number(entry.pageNumber) > page);
  if (previous && next) {
    const pageDelta = Number(next.pageNumber) - Number(previous.pageNumber);
    const promptDelta = Number(next.promptIndex) - Number(previous.promptIndex);
    const expectedPromptDelta = promptOffsetForPage(next.pageNumber) - promptOffsetForPage(previous.pageNumber);
    if (pageDelta <= 0 || promptDelta !== expectedPromptDelta) return null;
    return Math.floor(Number(previous.promptIndex) + (promptOffsetForPage(page) - promptOffsetForPage(previous.pageNumber)));
  }
  if (previous) {
    return Math.floor(Number(previous.promptIndex) + (promptOffsetForPage(page) - promptOffsetForPage(previous.pageNumber)));
  }

  return configuredPromptStartIndex() + promptOffsetForPage(page);
}

function pageFromPromptIndex(promptIndex) {
  const index = Number(promptIndex) || 0;
  if (!index) return null;

  const exact = pageFromCalibratedIndex("promptIndex", index);
  if (exact) return pageIfInRange(exact);

  const previous = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry.promptIndex) > 0 && Number(entry.promptIndex) <= index)
    .sort((a, b) => Number(b.promptIndex) - Number(a.promptIndex))[0];
  const next = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry.promptIndex) > index)
    .sort((a, b) => Number(a.promptIndex) - Number(b.promptIndex))[0];
  if (previous && next) {
    const promptDelta = Number(next.promptIndex) - Number(previous.promptIndex);
    const pageDelta = Number(next.pageNumber) - Number(previous.pageNumber);
    const expectedPromptDelta = promptOffsetForPage(next.pageNumber) - promptOffsetForPage(previous.pageNumber);
    if (pageDelta <= 0 || promptDelta !== expectedPromptDelta) return null;
    const offset = promptOffsetForPage(previous.pageNumber) + (index - Number(previous.promptIndex));
    return pageIfInRange(firstPageForPromptOffset(offset));
  }
  if (previous) {
    const offset = promptOffsetForPage(previous.pageNumber) + (index - Number(previous.promptIndex));
    return pageIfInRange(firstPageForPromptOffset(offset));
  }

  return pageIfInRange(firstPageForPromptOffset(index - configuredPromptStartIndex()));
}

function resolvePageFromGeminiPosition(payload = {}) {
  const promptIndex = Number(payload.promptIndex) || 0;
  return pageFromPromptIndex(promptIndex);
}

function enableGeminiFollowAfterPositioning(pageNumber, actionText = "已同步") {
  notifyParentState();
  if (elements.autoSync.checked) {
    setStatus(`${actionText}第 ${pageNumber} 页；现在滚动 Gemini 会同步 PDF`, "ok");
    return;
  }
  setStatus(`${actionText}第 ${pageNumber} 页；自动同步仍然关闭`, "ok");
}

async function sendSync(reason = "manual", options = {}) {
  if (!state.deck) return;
  if (reason === "auto" && !elements.autoSync.checked) return;
  const pageNumber = state.currentPage;
  const deep = !!options.deep;

  if (state.syncBusy) {
    if (reason === "auto") {
      state.queuedAutoPage = pageNumber;
      setStatus(`同步中，已记住第 ${pageNumber} 页`, "busy");
      return;
    }
    setStatus("正在同步，先等这次结束", "busy");
    return;
  }

  const signature = `${state.deck.id}:${pageNumber}:${reason}:${deep ? "deep" : "quick"}`;
  if (reason === "auto" && state.lastSent === signature) return;
  state.lastSent = signature;

  setStatus(deep ? `深度同步第 ${pageNumber} 页` : `同步第 ${pageNumber} 页`, "busy");
  state.syncBusy = true;
  try {
    const payload = syncPayload(pageNumber, reason, { deep });
    if (!payload.hasPromptMapping) {
      if (reason !== "auto") {
        setStatus(`Page ${pageNumber} has no mapped Gemini turn. Calibrate it from the matching Gemini message first.`, "warn");
      }
      return;
    }
    const result = await sendModelCommand(
      "sync",
      payload,
      deep ? 310000 : (state.embedded ? 2000 : 12000),
      { resolveOnTimeout: !deep },
    );
    if (result.pending) {
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已发送同步");
      } else {
        setStatus(`已发送同步第 ${pageNumber} 页`, "ok");
      }
      return;
    }
    if (result.usedBinding) {
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已到校准位置");
      } else {
        setStatus(`已到校准位置：第 ${pageNumber} 页`, "ok");
      }
    } else {
      if (reason !== "auto") {
        enableGeminiFollowAfterPositioning(pageNumber, "已同步");
      } else {
        setStatus(`已同步第 ${pageNumber} 页`, "ok");
      }
    }
  } catch (error) {
    if (reason === "auto") {
      setAutoSyncEnabled(false, "自动同步已暂停，不影响翻 PDF。");
    } else {
      setStatus(error.message, "warn");
    }
  } finally {
    state.syncBusy = false;
    if (state.queuedAutoPage && state.queuedAutoPage !== pageNumber) {
      const queuedPage = state.queuedAutoPage;
      state.queuedAutoPage = null;
      if (elements.autoSync.checked) {
        goToPage(queuedPage, "auto");
        setTimeout(() => sendSync("auto"), 150);
      }
    } else {
      state.queuedAutoPage = null;
    }
  }
}

function scheduleAutoSync() {
  if (!elements.autoSync.checked) return;
  if (Date.now() < state.suppressAutoSyncUntil) return;
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => {
    if (!elements.autoSync.checked) return;
    sendSync("auto");
  }, 900);
}

async function handleGeminiVisiblePage(payload = {}) {
  const forceManual = !!payload.forceManual;
  if (!state.embedded || (!elements.autoSync.checked && !forceManual) || !state.config) return;
  const deckId = payload.deckId || state.deck?.id;
  const page = resolvePageFromGeminiPosition(payload);
  if (!page) return;

  suppressPdfFeedback();

  if (deckId && deckId !== state.deck?.id) {
    await loadDeck(deckId, page, { fromGemini: true });
    setStatus(`Gemini -> PDF 第 ${page} 页`, "ok");
    return;
  }

  if (page !== state.currentPage) {
    goToPage(page, "auto", { fromGemini: true });
    setStatus(`Gemini -> PDF 第 ${page} 页`, "ok");
  }
}

async function bindCurrentPage() {
  if (!state.deck) return;
  const pageNumber = state.currentPage;
  setStatus(`校准第 ${pageNumber} 页`, "busy");
  try {
    const result = await sendModelCommand("bind", syncPayload(pageNumber, "bind"), 15000);
    const binding = {
      ...result.binding,
      deckId: state.deck.id,
      conversationId: state.deck.conversationId,
      pageNumber,
      savedAt: new Date().toISOString(),
    };
    setLocalBinding(pageNumber, binding);
    updateControls();
    enableGeminiFollowAfterPositioning(pageNumber, "已校准");
  } catch (error) {
    setStatus(error.message, "warn");
  }
}

async function openGemini() {
  if (!state.deck) return;
  await switchGeminiForDeck(state.currentPage, "open");
}

async function switchGeminiForDeck(pageNumber = 1, reason = "deck-change") {
  const provider = state.deck?.provider || state.config?.provider || "gemini";
  const providerName = provider === "chatgpt" ? "ChatGPT" : "Gemini";
  const targetUrl = provider === "chatgpt" ? state.deck?.chatgptUrl : state.deck?.geminiUrl;
  if (!targetUrl) {
    setStatus(`${providerName} 原对话链接为空`, "warn");
    return;
  }
  const page = Math.max(1, Number(pageNumber) || 1);
  const payload = syncPayload(page, reason);

  if (state.embedded) {
    await postToParent("open", payload, 7000);
    setStatus(`${providerName} 原对话已切换`, "ok");
    return;
  }

  window.open(targetUrl, provider === "chatgpt" ? "gemsync-chatgpt" : "gemsync-gemini");
  setStatus(`${providerName} 原对话已打开`, "ok");
}

function buildRail() {
  const fragment = document.createDocumentFragment();
  for (let page = 1; page <= state.pageCount; page += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-page";
    button.dataset.page = String(page);
    button.textContent = String(page);
    button.addEventListener("click", () => goToPage(page));
    fragment.append(button);
  }
  elements.pageRail.replaceChildren(fragment);
}

function buildPageShells() {
  const fragment = document.createDocumentFragment();
  const estimatedFrameHeight = state.estimatedFrameHeight || 360;
  for (let page = 1; page <= state.pageCount; page += 1) {
    const shell = document.createElement("section");
    shell.className = "page-shell";
    shell.id = `page-${page}`;
    shell.dataset.page = String(page);
    shell.style.minHeight = `${estimatedFrameHeight + 32}px`;

    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `第 ${page} 页`;

    const frame = document.createElement("div");
    frame.className = "page-frame";
    frame.dataset.page = String(page);
    frame.style.minHeight = `${estimatedFrameHeight}px`;

    const skeleton = document.createElement("div");
    skeleton.className = "skeleton";
    frame.append(skeleton);

    shell.append(label, frame);
    fragment.append(shell);
  }
  elements.pages.replaceChildren(fragment);
}

async function estimatePageHeight() {
  try {
    const page = await state.pdf.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = computeScale(baseViewport);
    const viewport = page.getViewport({ scale });
    state.estimatedFrameHeight = Math.max(320, Math.floor(viewport.height));
  } catch {
    state.estimatedFrameHeight = 360;
  }
}

function getVisiblePage() {
  let best = null;
  const rootRect = elements.viewer.getBoundingClientRect();
  const rootTop = rootRect.top;
  const rootBottom = rootRect.bottom;
  const rootHeight = rootRect.height || elements.viewer.clientHeight;
  const anchor = rootTop + Math.min(140, rootHeight * 0.18);

  for (const shell of elements.pages.querySelectorAll(".page-shell")) {
    const rect = shell.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, rootBottom) - Math.max(rect.top, rootTop);
    if (visibleHeight <= 0) continue;
    const containsAnchor = rect.top <= anchor && rect.bottom >= anchor;
    const distance = Math.abs(rect.top - rootTop);
    const score = containsAnchor
      ? 100000 - distance
      : (visibleHeight / Math.max(1, rect.height)) * 1000 - Math.abs(rect.top - anchor);
    if (!best || score > best.score) {
      best = { page: Number(shell.dataset.page), score };
    }
  }
  return best?.page || null;
}

function syncCurrentPageFromViewport() {
  const page = getVisiblePage();
  if (!page || page === state.currentPage) return;
  state.currentPage = page;
  updateControls();
  renderAround(page);
  scheduleAutoSync();
}

function requestVisiblePageUpdate() {
  if (state.visiblePageRaf) return;
  state.visiblePageRaf = requestAnimationFrame(() => {
    state.visiblePageRaf = 0;
    syncCurrentPageFromViewport();
  });
}

function installObserver() {
  state.observer?.disconnect();
  state.observer = new IntersectionObserver(() => {
    requestVisiblePageUpdate();
  }, {
    root: elements.viewer,
    threshold: [0.08, 0.18, 0.32, 0.48, 0.62, 0.78],
  });

  for (const shell of elements.pages.querySelectorAll(".page-shell")) {
    state.observer.observe(shell);
  }
}

function installPdfInputGuards() {
  if (state.pdfInputGuardsInstalled) return;
  state.pdfInputGuardsInstalled = true;
  const options = { passive: true };
  elements.viewer.addEventListener("wheel", noteUserPdfInteraction, options);
  elements.viewer.addEventListener("pointerdown", noteUserPdfInteraction, options);
  elements.viewer.addEventListener("touchstart", noteUserPdfInteraction, options);
}

function computeScale(viewport) {
  const maxWidth = Math.min(1080, Math.max(360, elements.viewer.clientWidth - 60));
  return Math.max(0.45, Math.min(2.2, maxWidth / viewport.width));
}

async function renderPage(pageNumber) {
  if (!state.pdf || state.rendered.has(pageNumber)) return;
  if (state.rendering.has(pageNumber)) return state.rendering.get(pageNumber);

  const task = (async () => {
    try {
      const page = await state.pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = computeScale(baseViewport);
      const viewport = page.getViewport({ scale });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);

      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const context = canvas.getContext("2d", { alpha: false });
      await page.render({
        canvasContext: context,
        viewport,
        transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
      }).promise;

      const frame = elements.pages.querySelector(`.page-frame[data-page="${pageNumber}"]`);
      if (frame) {
        frame.style.minHeight = `${Math.floor(viewport.height)}px`;
        frame.replaceChildren(canvas);
      }
      state.rendered.add(pageNumber);
    } catch (error) {
      const frame = elements.pages.querySelector(`.page-frame[data-page="${pageNumber}"]`);
      if (frame) {
        frame.textContent = `第 ${pageNumber} 页加载失败：${error.message}`;
      }
    } finally {
      state.rendering.delete(pageNumber);
    }
  })();

  state.rendering.set(pageNumber, task);
  return task;
}

function renderAround(pageNumber) {
  const targets = [];
  for (let page = pageNumber - 2; page <= pageNumber + 2; page += 1) {
    if (page >= 1 && page <= state.pageCount) targets.push(page);
  }
  for (const page of targets) {
    renderPage(page);
  }
}

function scrollViewerToShell(shell) {
  const targetTop = shell.offsetTop - elements.pages.offsetTop;
  elements.viewer.scrollTop = Math.max(0, targetTop - 2);
}

function scrollViewerToPage(page, scrollSeq = null) {
  if (scrollSeq !== null && scrollSeq !== state.userPdfScrollSeq) return;
  if (state.currentPage !== page) return;
  const shell = elements.pages.querySelector(`#page-${page}`);
  if (shell) scrollViewerToShell(shell);
}

function goToPage(pageNumber, behavior = "smooth", options = {}) {
  const page = clampPage(pageNumber);
  const shell = elements.pages.querySelector(`#page-${page}`);
  if (!shell) return;
  if (options.fromGemini) {
    suppressPdfFeedback();
  }
  const scrollSeq = state.userPdfScrollSeq;
  state.currentPage = page;
  updateControls();
  scrollViewerToShell(shell);
  requestAnimationFrame(() => scrollViewerToPage(page, scrollSeq));
  setTimeout(() => scrollViewerToPage(page, scrollSeq), 80);
  setTimeout(() => scrollViewerToPage(page, scrollSeq), 250);
  renderAround(page);
  renderPage(page).then(() => {
    scrollViewerToPage(page, scrollSeq);
  });
  if (!options.fromGemini) {
    scheduleAutoSync();
  }
}

function normalizeSubjectConfig(config, configUrl) {
  const baseUrl = new URL(configUrl, location.href);
  const decks = (config.decks || [])
    .filter((deck) => !state.cachedOnly || deck.transcriptUrl)
    .map((deck) => ({
      ...deck,
      provider: deck.provider || config.provider || "gemini",
      pdfUrl: new URL(deck.pdfUrl, baseUrl).toString(),
      transcriptUrl: deck.transcriptUrl ? new URL(deck.transcriptUrl, baseUrl).toString() : "",
    }));
  return { ...config, decks };
}

async function loadSubject(subjectId, options = {}) {
  const subject = state.subjects.find((item) => item.id === subjectId) || state.subjects[0];
  if (!subject) throw new Error("没有可用学科配置");

  state.subject = subject;
  elements.subjectSelect.value = subject.id;
  elements.deckSelect.replaceChildren();

  const configUrl = new URL(subject.configUrl, location.href).toString();
  setStatus("读取学科配置", "busy");
  const response = await fetch(configUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`配置读取失败：${response.status}`);

  state.configUrl = configUrl;
  state.config = normalizeSubjectConfig(await response.json(), configUrl);
  if (!state.config.decks.length) throw new Error("这个学科还没有可用的离线缓存章节");

  for (const deck of state.config.decks) {
    const option = document.createElement("option");
    option.value = deck.id;
    option.textContent = deck.title;
    elements.deckSelect.append(option);
  }

  const deckId = options.deckId || state.config.decks[0]?.id;
  await loadDeck(deckId, options.initialPage || 1, options);
}

async function loadDeck(deckId, initialPage = 1, options = {}) {
  const runId = ++state.deckSwitchSeq;
  const deck = state.config.decks.find((item) => item.id === deckId) || state.config.decks[0];
  state.deck = deck;
  state.pdf = null;
  state.rendered.clear();
  state.rendering.clear();
  state.lastSent = "";
  state.currentPage = 1;
  state.pageCount = deck.totalPages || 0;
  state.observer?.disconnect();
  elements.viewer.scrollTop = 0;
  elements.pages.replaceChildren();
  elements.pageRail.replaceChildren();
  elements.subjectSelect.value = state.subject?.id || "";
  elements.deckSelect.value = deck.id;
  history.replaceState(null, "", `#subject=${encodeURIComponent(state.subject?.id || "")}&deck=${encodeURIComponent(deck.id)}&page=${Math.max(1, Number(initialPage) || 1)}${state.embedded ? "&embed=1" : ""}${state.cachedOnly ? "&cached=1" : ""}`);

  setStatus("加载 PDF", "busy");
  const loadingTask = pdfjsLib.getDocument({
    url: new URL(deck.pdfUrl, location.href).toString(),
    cMapUrl: new URL("./pdfjs/cmaps/", location.href).toString(),
    cMapPacked: true,
    standardFontDataUrl: new URL("./pdfjs/standard_fonts/", location.href).toString(),
  });
  state.pdf = await loadingTask.promise;
  state.pageCount = state.pdf.numPages;
  await estimatePageHeight();

  buildRail();
  buildPageShells();
  installObserver();
  updateControls();
  renderAround(clampPage(initialPage));
  goToPage(clampPage(initialPage), "auto", { fromGemini: !!options.fromGemini });
  if (options.switchGemini && runId === state.deckSwitchSeq) {
    try {
      await switchGeminiForDeck(clampPage(initialPage), "deck-change");
      return;
    } catch (error) {
      setStatus(error.message, "warn");
      return;
    }
  }
  setStatus("就绪", "ok");
}

async function initSubjects() {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  state.embedded = window.parent !== window || hash.get("embed") === "1";
  state.cachedOnly = hash.get("cached") === "1";
  document.body.classList.toggle("embedded", state.embedded);

  setStatus("读取学科列表", "busy");
  const response = await fetch("./subjects.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`学科列表读取失败：${response.status}`);
  const subjectsConfig = await response.json();
  state.subjects = uniqueSubjects(subjectsConfig.subjects || []);

  for (const subject of state.subjects) {
    const option = document.createElement("option");
    option.value = subject.id;
    option.textContent = subject.title;
    elements.subjectSelect.append(option);
  }

  elements.subjectSelect.addEventListener("change", () => {
    loadSubject(elements.subjectSelect.value, { initialPage: 1, switchGemini: true }).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
  });

  elements.deckSelect.addEventListener("change", () => {
    loadDeck(elements.deckSelect.value, 1, { switchGemini: true }).catch((error) => {
      console.error(error);
      setStatus(error.message, "warn");
    });
  });
  elements.prevPage.addEventListener("click", () => goToPage(state.currentPage - 1));
  elements.nextPage.addEventListener("click", () => goToPage(state.currentPage + 1));
  elements.pageInput.addEventListener("change", () => goToPage(elements.pageInput.value));
  elements.pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.currentTarget.blur();
      goToPage(elements.pageInput.value);
    }
  });
  elements.syncPage.addEventListener("click", () => sendSync("manual"));
  elements.deepSyncPage.addEventListener("click", () => sendSync("manual", { deep: true }));
  elements.bindPage.addEventListener("click", bindCurrentPage);
  elements.openGemini.addEventListener("click", openGemini);
  elements.autoSync.checked = localStorage.getItem("gemsync:autoSync") === "true";
  elements.autoSync.addEventListener("change", () => {
    if (elements.autoSync.checked) {
      setAutoSyncEnabled(true);
      scheduleAutoSync();
    } else {
      setAutoSyncEnabled(false, "自动同步已关闭");
    }
  });
  elements.viewer.addEventListener("scroll", () => {
    renderAround(state.currentPage);
    requestVisiblePageUpdate();
  }, { passive: true });
  installPdfInputGuards();

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.rendered.clear();
      for (const frame of elements.pages.querySelectorAll(".page-frame")) {
        const page = Number(frame.dataset.page);
        if (Math.abs(page - state.currentPage) <= 2) {
          frame.replaceChildren(Object.assign(document.createElement("div"), { className: "skeleton" }));
        }
      }
      renderAround(state.currentPage);
    }, 180);
  });

  const subjectId = hash.get("subject") || subjectsConfig.defaultSubject || state.subjects[0]?.id;
  const deckId = hash.get("deck") || "";
  const page = Number(hash.get("page") || 1);
  await loadSubject(subjectId, { deckId, initialPage: page });
}

function subjectTitleKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function uniqueSubjects(subjects) {
  const result = [];
  const seenIds = new Set();
  const seenTitles = new Set();
  for (const subject of subjects) {
    const titleKey = subjectTitleKey(subject.title);
    if ((subject.id && seenIds.has(subject.id)) || (titleKey && seenTitles.has(titleKey))) continue;
    result.push(subject);
    if (subject.id) seenIds.add(subject.id);
    if (titleKey) seenTitles.add(titleKey);
  }
  return result;
}

initSubjects().catch((error) => {
  console.error(error);
  setStatus(error.message, "warn");
});
