const $ = (id) => document.getElementById(id);

const elements = {
  workspace: $("workspace"),
  subjectId: $("subjectId"),
  subjectTitle: $("subjectTitle"),
  providerSelect: $("providerSelect"),
  modelSelect: $("modelSelect"),
  chatgptThinkingField: $("chatgptThinkingField"),
  chatgptThinking: $("chatgptThinking"),
  proFallbackField: $("proFallbackField"),
  proFallback: $("proFallback"),
  pagesPerPrompt: $("pagesPerPrompt"),
  autoCacheDecks: $("autoCacheDecks"),
  promptText: $("promptText"),
  prePromptText: $("prePromptText"),
  status: $("status"),
  summaryCards: $("summaryCards"),
  details: $("details"),
  jobs: $("jobs"),
  log: $("log"),
  workflowHint: $("workflowHint"),
  stopJob: $("stopJob"),
  clearLog: $("clearLog"),
  clearFinishedJobs: $("clearFinishedJobs"),
  refreshState: $("refreshState"),
  pickWorkspace: $("pickWorkspace"),
  organizeWorkspace: $("organizeWorkspace"),
  openManagerWindow: $("openManagerWindow"),
  scan: $("scan"),
  prepare: $("prepare"),
  screenshotFileList: $("screenshotFileList"),
  chrome: $("chrome"),
  runGemini: $("runGemini"),
  resetProgress: $("resetProgress"),
  updatePlugin: $("updatePlugin"),
  cacheGemini: $("cacheGemini"),
  cacheDeckList: $("cacheDeckList"),
  openCache: $("openCache"),
};

const state = {
  selectedJobId: null,
  pollTimer: 0,
  summary: null,
  formLoaded: false,
  lastAutoSubjectId: "",
  lastAutoSubjectTitle: "",
  chromeOk: false,
  chromeByProvider: {},
  jobs: [],
  refreshedJobIds: new Set(),
  summaryRefreshInFlight: false,
  lastSentSlides: null,
  hiddenJobIds: new Set(readJsonStorage("decksync-hidden-jobs", readJsonStorage("gemsync-manager-hidden-jobs", []))),
};

function ensureScreenshotFileList() {
  if (elements.screenshotFileList) return elements.screenshotFileList;
  const host = elements.prepare?.closest(".step-item")?.querySelector(".step-copy");
  if (!host) return null;
  const list = document.createElement("div");
  list.id = "screenshotFileList";
  list.className = "screenshot-file-list";
  host.append(list);
  elements.screenshotFileList = list;
  list.addEventListener("change", updateWorkflowState);
  return list;
}

function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function workspaceStorageKey(workspace = elements.workspace?.value || "") {
  const key = String(workspace || "default").trim().toLowerCase() || "default";
  return `decksync-form:${stableHash(key)}`;
}

function legacyWorkspaceStorageKey(workspace = elements.workspace?.value || "") {
  const key = String(workspace || "default").trim().toLowerCase() || "default";
  return `gemsync-manager-form:${stableHash(key)}`;
}

function readSavedForm() {
  const workspace = elements.workspace?.value || "";
  const scoped = readJsonStorage(workspaceStorageKey(workspace), null)
    || readJsonStorage(legacyWorkspaceStorageKey(workspace), null);
  if (scoped) return scoped;
  return readJsonStorage("decksync-form", readJsonStorage("gemsync-manager-form", {}));
}

const PROVIDER_MODELS = {
  gemini: [
    { value: "pro", label: "Gemini Pro" },
    { value: "flash", label: "Gemini Flash" },
    { value: "flash-lite", label: "Gemini Flash-Lite" },
  ],
  chatgpt: [
    { value: "5.5", label: "ChatGPT 5.5" },
    { value: "5.4", label: "ChatGPT 5.4" },
    { value: "5.3", label: "ChatGPT 5.3" },
    { value: "5.2", label: "ChatGPT 5.2" },
    { value: "o3", label: "o3\uff08\u63a8\u7406\u6a21\u578b\uff09" },
  ],
};

const CHATGPT_MODE_OPTIONS = {
  default: [
    { value: "thinking-advanced", label: "Thinking \u8fdb\u9636" },
    { value: "thinking-standard", label: "Thinking \u6807\u51c6" },
    { value: "instant", label: "Instant" },
  ],
  "5.3": [
    { value: "instant", label: "Instant" },
  ],
  o3: [
    { value: "o3", label: "o3\uff08\u63a8\u7406\u6a21\u578b\uff09" },
  ],
};

function selectedProvider() {
  return elements.providerSelect?.value === "chatgpt" ? "chatgpt" : "gemini";
}

function providerLabel(provider = selectedProvider()) {
  return provider === "chatgpt" ? "ChatGPT" : "Gemini";
}

function defaultModelForProvider(provider) {
  return PROVIDER_MODELS[provider]?.[0]?.value || "pro";
}

function providerChromeStatus(provider = selectedProvider()) {
  return state.chromeByProvider?.[provider] || { ok: !!state.chromeOk };
}

function providerChromeOk(provider = selectedProvider()) {
  return !!providerChromeStatus(provider).ok;
}

function normalizeChatGptPreset(thinking = "thinking", effort = "advanced") {
  const mode = String(thinking || "thinking").trim().toLowerCase().replace(/[\s_]+/g, "-");
  const level = String(effort || "advanced").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (mode === "o3") return "o3";
  if (mode === "instant") return "instant";
  if (mode.includes("standard") || level === "standard") return "thinking-standard";
  return "thinking-advanced";
}

function chatGptSettingsFromPreset(value = elements.chatgptThinking?.value || "thinking-advanced") {
  const preset = String(value || "thinking-advanced").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (preset === "o3") return { thinking: "instant", effort: "advanced", preset: "o3" };
  if (preset === "instant") return { thinking: "instant", effort: "advanced", preset: "instant" };
  if (preset.includes("standard")) return { thinking: "thinking", effort: "standard", preset: "thinking-standard" };
  return { thinking: "thinking", effort: "advanced", preset: "thinking-advanced" };
}

function chatGptModeOptionsForModel(model = elements.modelSelect?.value || "") {
  return CHATGPT_MODE_OPTIONS[model] || CHATGPT_MODE_OPTIONS.default;
}

function updateChatGptModeOptions(preferredPreset = "") {
  if (!elements.chatgptThinking) return;
  const options = chatGptModeOptionsForModel();
  const current = preferredPreset || elements.chatgptThinking.value;
  elements.chatgptThinking.innerHTML = options
    .map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`)
    .join("");
  elements.chatgptThinking.value = options.some((option) => option.value === current)
    ? current
    : options[0]?.value || "thinking-advanced";
}

function updateModelOptions(preferredModel = "") {
  const provider = selectedProvider();
  const models = PROVIDER_MODELS[provider] || PROVIDER_MODELS.gemini;
  const current = preferredModel || elements.modelSelect.value;
  elements.modelSelect.innerHTML = models
    .map((model) => `<option value="${escapeHtml(model.value)}">${escapeHtml(model.label)}</option>`)
    .join("");
  elements.modelSelect.value = models.some((model) => model.value === current)
    ? current
    : defaultModelForProvider(provider);
  elements.proFallbackField?.classList.toggle("is-hidden", provider !== "gemini");
  elements.chatgptThinkingField?.classList.toggle("is-hidden", provider !== "chatgpt");
  updateChatGptModeOptions();
}

function setStatus(text) {
  elements.status.textContent = text;
}

function setWorkflowHint(text) {
  if (elements.workflowHint) elements.workflowHint.textContent = text;
}

function saveHiddenJobs() {
  writeJsonStorage("decksync-hidden-jobs", [...state.hiddenJobIds]);
}

function normalizePagesPerPrompt(value, fallback = 1) {
  const number = Math.floor(Number(value) || Number(fallback) || 1);
  return Math.max(1, Math.min(3, number));
}

function isJobVisible(job) {
  return job.status === "running" || !state.hiddenJobIds.has(job.id);
}

function visibleJobs(jobs) {
  return (jobs || []).filter(isJobVisible);
}

function pruneHiddenJobs(jobs) {
  const ids = new Set((jobs || []).map((job) => job.id));
  let changed = false;
  for (const id of state.hiddenJobIds) {
    if (!ids.has(id)) {
      state.hiddenJobIds.delete(id);
      changed = true;
    }
  }
  if (changed) saveHiddenJobs();
}

function saveForm() {
  const chatgptSettings = chatGptSettingsFromPreset();
  const value = {
    workspace: elements.workspace.value,
    subjectId: elements.subjectId.value,
    subjectTitle: elements.subjectTitle.value,
    provider: selectedProvider(),
    model: elements.modelSelect.value,
    chatgptThinking: chatgptSettings.thinking,
    chatgptThinkingEffort: chatgptSettings.effort,
    chatgptThinkingPreset: chatgptSettings.preset,
    proFallback: elements.proFallback.value,
    pagesPerPrompt: normalizePagesPerPrompt(elements.pagesPerPrompt?.value),
    autoCacheDecks: !!elements.autoCacheDecks?.checked,
    prompt: elements.promptText.value,
    prePrompt: elements.prePromptText.value,
  };
  writeJsonStorage("decksync-form", value);
  writeJsonStorage(workspaceStorageKey(elements.workspace.value), value);
}

function loadForm(defaults) {
  const saved = readSavedForm();
  elements.workspace.value = saved.workspace || defaults.workspace || "";
  elements.subjectId.value = saved.subjectId || defaults.subjectId || "";
  elements.subjectTitle.value = saved.subjectTitle || defaults.subjectTitle || "";
  elements.providerSelect.value = saved.provider || defaults.provider || "gemini";
  updateModelOptions(saved.model || defaults.model || "");
  if (elements.chatgptThinking) {
    updateChatGptModeOptions(saved.chatgptThinkingPreset
      || normalizeChatGptPreset(
        saved.chatgptThinking || defaults.chatgptThinking || "thinking",
        saved.chatgptThinkingEffort || defaults.chatgptThinkingEffort || "advanced",
      ));
  }
  elements.proFallback.value = saved.proFallback || defaults.proFallback || "flash";
  if (elements.pagesPerPrompt) {
    elements.pagesPerPrompt.value = String(normalizePagesPerPrompt(saved.pagesPerPrompt || defaults.pagesPerPrompt || 1));
  }
  if (elements.autoCacheDecks) elements.autoCacheDecks.checked = !!saved.autoCacheDecks;
  elements.promptText.value = saved.prompt || defaults.prompt || "\u8bf7\u8be6\u7ec6\u8bb2\u89e3\u8fd9\u4e00\u9762PPT";
  elements.prePromptText.value = saved.prePrompt || defaults.prePrompt || "";
  state.lastAutoSubjectTitle = folderNameFromPath(elements.workspace.value);
  state.lastAutoSubjectId = subjectIdFromTitle(state.lastAutoSubjectTitle);
}

function stableHash(input) {
  let hash = 2166136261;
  for (const char of String(input || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function folderNameFromPath(input) {
  return String(input || "")
    .trim()
    .replace(/[\\/]+$/g, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || "";
}

function comparablePath(input) {
  return String(input || "")
    .trim()
    .replace(/[\\/]+$/g, "")
    .replace(/\//g, "\\")
    .toLowerCase();
}

function sameWorkspace(a, b) {
  const left = comparablePath(a);
  const right = comparablePath(b);
  return !!left && !!right && left === right;
}

function runningWorkspaceProvider() {
  const workspace = elements.workspace?.value || "";
  const job = (state.jobs || []).find((item) => (
    item.status === "running"
    && item.provider
    && sameWorkspace(item.workspace, workspace)
  ));
  return job?.provider || selectedProvider();
}

function subjectIdFromTitle(title) {
  const raw = String(title || "subject").trim();
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii || `course-${stableHash(raw)}`;
}

function autoFillSubjectFromWorkspace(options = {}) {
  const title = folderNameFromPath(elements.workspace.value);
  if (!title) return;
  const id = subjectIdFromTitle(title);
  const force = !!options.force;
  const oldDefaultTitle = elements.subjectTitle.value === "\u7b97\u6cd5\u5bfc\u8bba";
  const oldDefaultId = elements.subjectId.value === "algorithms";
  const titleLooksAuto = !elements.subjectTitle.value.trim()
    || elements.subjectTitle.value === state.lastAutoSubjectTitle
    || oldDefaultTitle;
  const idLooksAuto = !elements.subjectId.value.trim()
    || elements.subjectId.value === state.lastAutoSubjectId
    || oldDefaultId;

  if (force || titleLooksAuto) elements.subjectTitle.value = title;
  if (force || idLooksAuto) elements.subjectId.value = id;

  state.lastAutoSubjectTitle = title;
  state.lastAutoSubjectId = id;
  saveForm();
}

function payload() {
  saveForm();
  const chatgptSettings = chatGptSettingsFromPreset();
  return {
    workspace: elements.workspace.value.trim(),
    subjectId: elements.subjectId.value.trim(),
    title: elements.subjectTitle.value.trim(),
    provider: selectedProvider(),
    model: elements.modelSelect.value,
    chatgptThinking: chatgptSettings.thinking,
    chatgptThinkingEffort: chatgptSettings.effort,
    proFallback: elements.proFallback.value,
    pagesPerPrompt: normalizePagesPerPrompt(elements.pagesPerPrompt?.value),
    autoCacheDecks: !!elements.autoCacheDecks?.checked,
    prompt: elements.promptText.value.trim() || "\u8bf7\u8be6\u7ec6\u8bb2\u89e3\u8fd9\u4e00\u9762PPT",
    prePrompt: elements.prePromptText.value.trim(),
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || `\u8bf7\u6c42\u5931\u8d25\uff1a${response.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function card(label, value, meta = "", tone = "", extraClass = "") {
  const toneClass = tone ? ` ${escapeHtml(tone)}` : "";
  const extra = extraClass ? ` ${escapeHtml(extraClass)}` : "";
  return `<div class="card${toneClass}${extra}">
    <span class="card-label">${escapeHtml(label)}</span>
    <strong>${escapeHtml(value)}</strong>
    ${meta ? `<span class="card-meta">${escapeHtml(meta)}</span>` : ""}
  </div>`;
}

function cacheDeckCandidates(summary = state.summary) {
  const cacheDecks = summary?.cache?.decks || [];
  const cacheByDeck = new Map(cacheDecks.map((deck) => [deck.id, deck]));
  if (summary?.decks?.length) {
    return summary.decks.map((deck, index) => {
      const id = deck.id || (deck.deckNumber ? `deck${String(deck.deckNumber).padStart(2, "0")}` : `deck${String(index + 1).padStart(2, "0")}`);
      const cached = cacheByDeck.get(id) || deck.cache || {};
      return {
        ...cached,
        id,
        provider: cached.provider || deck.provider || selectedProvider(),
        title: cached.title || deck.title || deck.folder || id,
        totalPages: cached.totalPages || deck.slides || 0,
        geminiUrl: cached.geminiUrl || deck.geminiUrl || "",
        chatgptUrl: cached.chatgptUrl || deck.chatgptUrl || "",
        conversationUrl: cached.conversationUrl || cached.geminiUrl || cached.chatgptUrl || deck.conversationUrl || deck.geminiUrl || deck.chatgptUrl || "",
        conversationId: cached.conversationId || deck.conversationId || "",
        transcriptUrl: cached.transcriptUrl || deck.transcriptUrl || "",
        cacheExists: !!cached.cacheExists,
        cacheUrl: cached.cacheUrl || "",
      };
    });
  }
  return cacheDecks;
}

function selectedCacheDecks() {
  return Array.from(elements.cacheDeckList?.querySelectorAll("input[name='cacheDeck']:checked") || [])
    .map((input) => input.value)
    .filter(Boolean);
}


function screenshotFileCandidates(summary = state.summary) {
  const sourcePdfs = summary?.sourcePdfs || summary?.pdfs || [];
  const hasScreenshots = (summary?.decks?.length || 0) > 0;
  const pdfs = sourcePdfs.map((file) => ({
    kind: "pdf",
    path: file.path,
    name: file.name,
    label: "PDF",
    checked: !hasScreenshots,
    muted: hasScreenshots,
    status: hasScreenshots ? "\u53ef\u91cd\u505a" : "\u5f85\u622a\u56fe",
  }));
  const ppts = (summary?.ppts || []).map((file) => ({
    kind: "ppt",
    path: file.path,
    name: file.name,
    label: file.name?.toLowerCase().endsWith(".pptx") ? "PPTX" : "PPT",
    checked: !file.screened,
    muted: !!file.screened,
    status: file.screened ? "\u5df2\u622a\u56fe" : "\u5f85\u622a\u56fe",
  }));
  return [...pdfs, ...ppts].filter((file) => file.path);
}

function selectedScreenshotFiles() {
  const list = ensureScreenshotFileList();
  const checked = Array.from(list?.querySelectorAll("input[name='screenshotFile']:checked") || []);
  return {
    pdfs: checked.filter((input) => input.dataset.kind === "pdf").map((input) => input.value),
    ppts: checked.filter((input) => input.dataset.kind === "ppt").map((input) => input.value),
  };
}

function selectedScreenshotFileCount() {
  const selected = selectedScreenshotFiles();
  return selected.pdfs.length + selected.ppts.length;
}

function renderScreenshotFileOptions(summary) {
  const list = ensureScreenshotFileList();
  if (!list) return;
  const previous = new Set(Array.from(list.querySelectorAll("input[name='screenshotFile']:checked")).map((input) => input.value));
  const candidates = screenshotFileCandidates(summary);
  if (!candidates.length) {
    list.innerHTML = '<p class="screenshot-file-empty">\u626b\u63cf\u540e\u4f1a\u5728\u8fd9\u91cc\u9009\u62e9\u8981\u8f6c\u6362\u6210\u622a\u56fe\u7684 PDF / PPT\u3002</p>';
    return;
  }

  list.innerHTML = `<div class="screenshot-file-head">
      <strong>\u9009\u62e9\u8981\u622a\u56fe\u7684\u6587\u4ef6</strong>
      <span>${candidates.length} \u4e2a\u53ef\u8f6c\u6362\u6587\u4ef6</span>
    </div>
    <div class="screenshot-file-options">
      ${candidates.map((file) => {
        const checked = previous.size ? previous.has(file.path) : file.checked;
        return `<label class="screenshot-file-option${file.muted ? " is-muted" : ""}">
          <input type="checkbox" name="screenshotFile" data-kind="${escapeHtml(file.kind)}" value="${escapeHtml(file.path)}"${checked ? " checked" : ""} />
          <span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(file.path)}</small></span>
          <em>${escapeHtml(file.status)}</em>
        </label>`;
      }).join("")}
    </div>`;
}

function selectedCacheableDecks(summary = state.summary) {
  const byId = new Map(cacheDeckCandidates(summary).map((deck) => [deck.id, deck]));
  return selectedCacheDecks()
    .filter((id) => {
      const deck = byId.get(id);
      return (deck?.conversationUrl || deck?.transcriptUrl) && !deck.cacheExists;
    });
}

function uncachedCacheableDecks(summary = state.summary) {
  return cacheDeckCandidates(summary).filter((deck) => deck.id && (deck.conversationUrl || deck.transcriptUrl) && !deck.cacheExists);
}

function cachedDecks(summary = state.summary) {
  return cacheDeckCandidates(summary).filter((deck) => deck.cacheExists && deck.cacheUrl);
}


function renderCacheDeckOptions(summary) {
  if (!elements.cacheDeckList) return;
  const previous = new Set(selectedCacheDecks());
  const candidates = cacheDeckCandidates(summary).filter((deck) => deck.id);
  if (!candidates.length) {
    elements.cacheDeckList.innerHTML = '<p class="cache-deck-empty">\u626b\u63cf\u540e\u4f1a\u5728\u8fd9\u91cc\u9009\u62e9\u8981\u7f13\u5b58\u7684\u5bf9\u8bdd\u3002</p>';
    return;
  }

  elements.cacheDeckList.innerHTML = candidates.map((deck) => {
    const canCache = !!(deck.conversationUrl || deck.transcriptUrl) && !deck.cacheExists;
    const checked = canCache && (previous.size ? previous.has(deck.id) : true);
    const status = deck.cacheExists ? "\u5df2\u7f13\u5b58" : (canCache ? "\u5f85\u7f13\u5b58" : "\u65e0\u5bf9\u8bdd");
    const meta = [
      deck.totalPages ? String(deck.totalPages) + " \u9875" : "",
      deck.conversationId ? "\u5bf9\u8bdd " + deck.conversationId : "",
      deck.provider ? providerLabel(deck.provider) : "",
    ].filter(Boolean).join(" / ") || "\u8fd8\u6ca1\u6709\u6a21\u578b\u5bf9\u8bdd";
    return '<label class="cache-deck-option' + (deck.cacheExists ? ' is-cached' : '') + (canCache ? '' : ' is-disabled') + '">' +
      '<input type="checkbox" name="cacheDeck" value="' + escapeHtml(deck.id) + '"' + (checked ? ' checked' : '') + (canCache ? '' : ' disabled') + ' />' +
      '<span><strong>' + escapeHtml(deck.title || deck.id) + '</strong><small>' + escapeHtml(meta) + '</small></span>' +
      '<em>' + escapeHtml(status) + '</em>' +
    '</label>';
  }).join("");
}

function renderSummary(summary) {
  state.summary = summary;
  const label = providerLabel(summary.provider || selectedProvider());
  const conversationCount = summary.progress.conversationCount || summary.conversationFoldersCount;
  const totalSlides = summary.progress.totalSlides || 0;
  const sentSlides = summary.progress.sentSlides || 0;
  const cacheDecks = summary.cache?.transcriptDeckCount || 0;
  const cacheTotal = Math.max(summary.cache?.totalDecks || 0, summary.decks.length || 0);
  const cacheMeta = cacheDecks
    ? String(summary.cache?.recordCount || 0) + " \u6761\u8bb0\u5f55 / " + String(summary.cache?.interactiveViewCount || 0) + " \u4e2a\u52a8\u6001\u7ec4\u4ef6"
    : "\u8fd8\u6ca1\u751f\u6210\u7f13\u5b58";
  const progressChanged = state.lastSentSlides !== null && sentSlides !== state.lastSentSlides;
  const unscreenedPpts = summary.unscreenedPpts || [];
  const pptMeta = unscreenedPpts.length
    ? String(unscreenedPpts.length) + " \u4e2a\u5f85\u622a\u56fe"
    : (summary.ppts.length ? "\u53ef\u751f\u6210\u622a\u56fe" : "\u53ef\u53ea\u7528 PDF");
  elements.summaryCards.innerHTML = [
    card("PDF", summary.pdfs.length, summary.pdfs.length ? "\u53ef\u4ee5\u5199\u5165\u63d2\u4ef6" : "\u8fd8\u6ca1\u626b\u5230 PDF", summary.pdfs.length ? "tone-sky" : "tone-muted"),
    card("PPT", summary.ppts.length, pptMeta, unscreenedPpts.length ? "tone-warn" : (summary.ppts.length ? "tone-amber" : "tone-muted")),
    card("\u622a\u56fe", summary.decks.length, summary.decks.length ? String(totalSlides) + " \u9875\u622a\u56fe" : "\u9700\u8981\u51c6\u5907\u622a\u56fe", summary.decks.length ? "tone-mint" : "tone-warn"),
    card(label + " \u5bf9\u8bdd", conversationCount, conversationCount ? "\u5df2\u8bb0\u5f55\u5bf9\u8bdd" : "\u8fd8\u6ca1\u8bb0\u5f55\u5bf9\u8bdd", conversationCount ? "tone-sky" : "tone-muted"),
    card("\u5df2\u95ee\u9875\u6570", totalSlides ? String(sentSlides) + "/" + String(totalSlides) : "0", totalSlides ? "\u6309\u8fdb\u5ea6\u6587\u4ef6\u7edf\u8ba1" : "\u6682\u65e0\u8fdb\u5ea6", totalSlides && sentSlides >= totalSlides ? "tone-mint" : "tone-muted", progressChanged ? "progress-bump" : ""),
    card("\u79bb\u7ebf\u7f13\u5b58", cacheTotal ? String(cacheDecks) + "/" + String(cacheTotal) : "0", cacheMeta, cacheDecks && cacheDecks >= cacheTotal ? "tone-mint" : "tone-muted"),
  ].join("");
  state.lastSentSlides = sentSlides;

  const deckRows = summary.decks.slice(0, 12).map((deck) => {
    return '<div class="detail-row"><div><strong>' + escapeHtml(deck.title || deck.folder) + '</strong><br><small>' + escapeHtml(deck.folder) + ' / ' + escapeHtml(deck.slides) + ' \u9875\u622a\u56fe</small></div><span class="badge deck-badge">' + escapeHtml(deck.deckNumber ? 'Deck ' + deck.deckNumber : 'Deck') + '</span></div>';
  }).join("");

  const unscreenedRows = unscreenedPpts.slice(0, 8).map((file) => {
    return '<div class="detail-row pending-row"><div><strong>' + escapeHtml(file.name) + '</strong><br><small>' + escapeHtml(file.path) + '</small></div><span class="badge pending-badge">\u5f85\u622a\u56fe</span></div>';
  }).join("");

  const fileRows = summary.pdfs.slice(0, 8).map((file) => {
    return '<div class="detail-row"><div><strong>' + escapeHtml(file.name) + '</strong><br><small>' + escapeHtml(file.path) + '</small></div><span class="badge">PDF</span></div>';
  }).join("");

  elements.details.innerHTML = deckRows || unscreenedRows
    ? deckRows + unscreenedRows
    : (fileRows || "<p>\u8fd8\u6ca1\u626b\u63cf\u5230 PDF\u3001PPT \u6216\u622a\u56fe\u3002</p>");
  renderScreenshotFileOptions(summary);
  renderCacheDeckOptions(summary);
  updateWorkflowState();
}


function formatJobTitle(job) {
  const title = String(job?.title || "");
  const type = String(job?.type || "");
  if (type === "organize" || title.includes("\u6574\u7406\u8bfe\u7a0b\u76ee\u5f55")) return "\u6574\u7406\u6587\u4ef6\u5939";
  if (type === "prepare" || title.includes("\u622a\u56fe")) return "\u751f\u6210\u8bfe\u4ef6\u622a\u56fe";
  if (type === "plugin" || title.includes("\u63d2\u4ef6")) return "\u5199\u5165\u63d2\u4ef6";
  if (type === "cache" || title.includes("\u7f13\u5b58")) return "\u751f\u6210\u79bb\u7ebf\u7f13\u5b58";
  if (type === "chatgpt") return "ChatGPT \u81ea\u52a8\u95ee\u8bfe\u4ef6";
  if (type === "gemini") return "Gemini \u81ea\u52a8\u95ee\u8bfe\u4ef6";
  return title || "\u540e\u53f0\u4efb\u52a1";
}

function formatJobStatus(status) {
  if (status === "running") return "\u8fd0\u884c\u4e2d";
  if (status === "complete") return "\u5b8c\u6210";
  if (status === "failed") return "\u5931\u8d25";
  return status || "\u7b49\u5f85";
}

function formatJobTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderJobs(jobs) {
  state.jobs = jobs;
  const visible = visibleJobs(jobs);
  document.body.classList.toggle("has-running-job", jobs.some((job) => job.status === "running"));
  if (!visible.length) {
    elements.jobs.innerHTML = "<p>\u8fd8\u6ca1\u6709\u540e\u53f0\u4efb\u52a1\u3002</p>";
    updateWorkflowState();
    return;
  }
  elements.jobs.innerHTML = visible.map((job) => {
    const active = job.id === state.selectedJobId ? " is-selected" : "";
    const meta = [formatJobTime(job.startedAt), job.provider ? providerLabel(job.provider) : "", job.workspace ? folderNameFromPath(job.workspace) : ""].filter(Boolean);
    const finished = job.finishedAt ? " / \u7ed3\u675f " + formatJobTime(job.finishedAt) : "";
    return '<button class="job' + active + '" data-job="' + escapeHtml(job.id) + '" type="button"><div><strong>' + escapeHtml(formatJobTitle(job)) + '</strong><br><small>' + escapeHtml(meta.join(" / ") + finished) + '</small></div><span class="badge ' + escapeHtml(job.status) + '">' + escapeHtml(formatJobStatus(job.status)) + '</span></button>';
  }).join("");
  for (const button of elements.jobs.querySelectorAll("[data-job]")) button.addEventListener("click", () => selectJob(button.dataset.job));
  updateWorkflowState();
}

function clearSummary() {
  state.summary = null;
  state.lastSentSlides = null;
  elements.summaryCards.innerHTML = "";
  elements.details.innerHTML = "<p>\u8bf7\u5148\u626b\u63cf\u5f53\u524d\u5b66\u79d1\u6587\u4ef6\u5939\u3002</p>";
  renderScreenshotFileOptions(null);
  renderCacheDeckOptions(null);
  updateWorkflowState();
}

function setStep(button, options = {}) {
  const enabled = !!options.enabled;
  const primary = !!options.primary;
  const complete = !!options.complete;
  const reason = options.reason || "";
  const step = button.closest(".step-item");
  let statePill = step?.querySelector(".step-state");
  if (step && !statePill) {
    statePill = document.createElement("span");
    statePill.className = "step-state";
    step.querySelector(".step-title")?.append(statePill);
  }
  button.disabled = !enabled;
  button.title = enabled ? "" : reason;
  button.classList.toggle("primary", primary && enabled);
  step?.classList.toggle("is-disabled", !enabled);
  step?.classList.toggle("is-next", primary && enabled);
  step?.classList.toggle("is-complete", complete);
  step?.classList.toggle("is-ready", enabled && !primary && !complete);
  step?.setAttribute("title", enabled ? "" : reason);
  if (statePill) statePill.textContent = complete && enabled ? "\u53ef\u518d\u6253\u5f00" : complete ? "\u5df2\u5b8c\u6210" : primary && enabled ? "\u4e0b\u4e00\u6b65" : enabled ? "\u53ef\u70b9\u51fb" : "\u672a\u5c31\u7eea";
}

function updateWorkflowState() {
  const workspace = elements.workspace.value.trim();
  const summary = state.summary;
  const jobs = state.jobs || [];
  const running = jobs.some((job) => job.status === "running" && sameWorkspace(job.workspace, workspace));
  const scanned = !!summary;
  const pdfCount = summary?.pdfs?.length || 0;
  const pptCount = summary?.ppts?.length || 0;
  const deckCount = summary?.decks?.length || 0;
  const pendingPptCount = summary?.unscreenedPpts?.length || 0;
  const conversationCount = summary?.progress?.conversationCount || summary?.conversationFoldersCount || 0;
  const quotaWaiting = !!summary?.progress?.quotaWaiting;
  const completedDeckCount = summary?.progress?.completedDeckCount || 0;
  const allDecksComplete = deckCount > 0 && pendingPptCount === 0 && completedDeckCount >= deckCount;
  const hasAllConversations = deckCount > 0 && pendingPptCount === 0 && conversationCount >= deckCount;
  const configuredDeckCount = summary?.cache?.totalDecks || 0;
  const pluginWritten = !!summary?.cache?.configExists && configuredDeckCount >= deckCount;
  const cacheDecks = summary?.cache?.transcriptDeckCount || 0;
  const cacheTotal = Math.max(configuredDeckCount, deckCount);
  const cacheComplete = pluginWritten && cacheTotal > 0 && cacheDecks >= cacheTotal && (allDecksComplete || hasAllConversations);
  const uncachedDecks = uncachedCacheableDecks(summary);
  const selectedUncachedDecks = selectedCacheableDecks(summary);
  const screenshotSelectionCount = selectedScreenshotFileCount();
  const usableConversationDeckCount = cacheDeckCandidates(summary).filter((deck) => deck.conversationUrl || deck.transcriptUrl).length;
  const hasFiles = pdfCount > 0 || pptCount > 0 || deckCount > 0;
  const hasScreenshots = deckCount > 0;
  const hasPpts = pptCount > 0;
  const provider = selectedProvider();
  const label = providerLabel(provider);
  const chromeOk = providerChromeOk(provider);
  const askFinished = allDecksComplete || hasAllConversations;
  const hasUsableAskOutput = askFinished || usableConversationDeckCount > 0;
  const canGenerateCache = provider === "chatgpt" ? scanned && pendingPptCount === 0 && hasScreenshots && hasUsableAskOutput && !cacheComplete && !running : scanned && pendingPptCount === 0 && hasScreenshots && hasUsableAskOutput && !running && selectedUncachedDecks.length > 0;
  const canPrepareScreenshots = scanned && !running && screenshotSelectionCount > 0 && (pendingPptCount > 0 || (!hasScreenshots && (hasPpts || pdfCount > 0)) || screenshotSelectionCount > 0);
  let next = "scan";
  let hint = "\u5148\u9009\u62e9\u8bfe\u7a0b\u6587\u4ef6\u5939\uff0c\u7136\u540e\u626b\u63cf\u3002";
  if (!workspace) hint = "\u5148\u9009\u62e9\u8bfe\u7a0b\u6587\u4ef6\u5939\u3002";
  else if (!scanned) { next = "scan"; hint = "\u5f53\u524d\u9700\u8981\u5148\u626b\u63cf\u6587\u4ef6\u5939\u3002"; }
  else if (running) { next = ""; hint = "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c\uff0c\u70b9\u4efb\u52a1\u53ef\u4ee5\u67e5\u770b\u65e5\u5fd7\u3002"; }
  else if (!hasFiles) { next = "scan"; hint = "\u8fd9\u4e2a\u6587\u4ef6\u5939\u91cc\u6ca1\u6709\u626b\u5230 PDF\u3001PPT \u6216\u622a\u56fe\u3002"; }
  else if (pendingPptCount > 0) { next = "prepare"; hint = "\u53d1\u73b0 " + pendingPptCount + " \u4e2a PPT \u8fd8\u6ca1\u6709\u622a\u56fe\u3002"; }
  else if (!hasScreenshots && (hasPpts || pdfCount > 0)) { next = "prepare"; hint = "\u8fd8\u6ca1\u6709\u622a\u56fe\uff0c\u4e0b\u4e00\u6b65\u5148\u51c6\u5907\u622a\u56fe\u3002"; }
  else if (quotaWaiting) { next = "gemini"; const resetHint = summary?.progress?.quotaResumeAfter || summary?.progress?.quotaResetHint || ""; hint = label + " \u989d\u5ea6\u6216\u9650\u6d41\u6682\u505c\u3002" + (resetHint ? " \u5efa\u8bae\u7b49\u5230 " + resetHint + " \u540e\u7ee7\u7eed\u3002" : "") + "\u8fdb\u5ea6\u5df2\u4fdd\u5b58\u3002"; }
  else if (hasScreenshots && !askFinished && !chromeOk) { next = "chrome"; hint = "\u5df2\u6709\u622a\u56fe\u3002\u4e0b\u4e00\u6b65\u6253\u5f00 " + label + " \u6807\u7b7e\u9875\u5e76\u786e\u8ba4\u5df2\u767b\u5f55\u3002"; }
  else if (hasScreenshots && hasUsableAskOutput && !pluginWritten) { next = "plugin"; hint = "\u5bf9\u8bdd\u5df2\u7ecf\u6709\u4e86\u3002\u4e0b\u4e00\u6b65\u5199\u5165\u63d2\u4ef6\u3002"; }
  else if (hasScreenshots && hasUsableAskOutput && !cacheComplete) { next = "cache"; hint = provider === "chatgpt" ? "ChatGPT \u8bb0\u5f55\u5df2\u751f\u6210\u3002\u4e0b\u4e00\u6b65\u540c\u6b65\u7f13\u5b58\u3002" : "\u4e0b\u4e00\u6b65\u751f\u6210 Gemini \u79bb\u7ebf\u7f13\u5b58\u3002"; }
  else if (hasScreenshots && cacheComplete) { next = ""; hint = "\u63d2\u4ef6\u914d\u7f6e\u548c\u79bb\u7ebf\u7f13\u5b58\u90fd\u51c6\u5907\u597d\u4e86\u3002"; }
  else if (hasScreenshots && chromeOk && conversationCount < deckCount) { next = "gemini"; hint = "\u622a\u56fe\u548c Chrome \u90fd\u51c6\u5907\u597d\u4e86\uff0c\u53ef\u4ee5\u542f\u52a8 " + label + " \u81ea\u52a8\u95ee\u3002"; }
  else { next = "chrome"; hint = "\u622a\u56fe\u51c6\u5907\u597d\u4e86\u3002\u4e0b\u4e00\u6b65\u6253\u5f00 " + label + " \u6807\u7b7e\u9875\u3002"; }
  elements.chrome.textContent = "\u6253\u5f00 " + label + " \u6807\u7b7e\u9875";
  elements.runGemini.textContent = "\u542f\u52a8 " + label + " \u81ea\u52a8\u95ee";
  elements.cacheGemini.textContent = provider === "chatgpt" ? "\u540c\u6b65\u7f13\u5b58" : "\u751f\u6210\u7f13\u5b58";
  setStep(elements.scan, { enabled: !!workspace && !running, primary: next === "scan", complete: scanned, reason: workspace ? "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" : "\u8bf7\u5148\u9009\u62e9\u8bfe\u7a0b\u6587\u4ef6\u5939" });
  setStep(elements.prepare, { enabled: canPrepareScreenshots, primary: next === "prepare", complete: hasScreenshots && pendingPptCount === 0, reason: !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : running ? "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" : hasScreenshots ? "\u5df2\u7ecf\u6709\u622a\u56fe" : "\u53ef\u4ee5\u751f\u6210\u622a\u56fe" });
  setStep(elements.chrome, { enabled: scanned && hasScreenshots && pendingPptCount === 0 && !askFinished && !running, primary: next === "chrome", complete: askFinished || chromeOk, reason: !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : pendingPptCount > 0 ? "\u8bf7\u5148\u51c6\u5907\u65b0\u589e PPT \u622a\u56fe" : !hasScreenshots ? "\u6ca1\u6709\u622a\u56fe" : askFinished ? label + " \u5df2\u7ecf\u95ee\u5b8c" : "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" });
  setStep(elements.runGemini, { enabled: scanned && hasScreenshots && pendingPptCount === 0 && chromeOk && !allDecksComplete && !running, primary: next === "gemini", complete: allDecksComplete || hasAllConversations, reason: !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : pendingPptCount > 0 ? "\u8bf7\u5148\u51c6\u5907\u65b0\u589e PPT \u622a\u56fe" : !hasScreenshots ? "\u6ca1\u6709\u622a\u56fe" : !chromeOk ? "\u8bf7\u5148\u6253\u5f00 " + label + " \u6807\u7b7e\u9875\u5e76\u767b\u5f55" : allDecksComplete ? "\u5df2\u7ecf\u95ee\u5b8c" : "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" });
  elements.resetProgress.disabled = !(scanned && hasScreenshots && !running);
  elements.resetProgress.title = !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : !hasScreenshots ? "\u6ca1\u6709\u622a\u56fe\u8fdb\u5ea6\u53ef\u4ee5\u91cd\u7f6e" : running ? "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" : "\u4ece\u7b2c 1 \u9875\u91cd\u65b0\u5f00\u59cb\u63d0\u95ee";
  setStep(elements.updatePlugin, { enabled: scanned && pendingPptCount === 0 && pdfCount > 0 && hasScreenshots && hasUsableAskOutput && !running, primary: next === "plugin", complete: pluginWritten, reason: !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : pendingPptCount > 0 ? "\u8bf7\u5148\u51c6\u5907\u65b0\u589e PPT \u622a\u56fe" : !hasScreenshots ? "\u8bf7\u5148\u51c6\u5907\u622a\u56fe" : !askFinished ? "\u8bf7\u5148\u5b8c\u6210\u81ea\u52a8\u95ee" : pdfCount > 0 ? "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" : "\u6ca1\u6709 PDF" });
  setStep(elements.cacheGemini, { enabled: canGenerateCache, primary: next === "cache", complete: cacheComplete, reason: !scanned ? "\u8bf7\u5148\u626b\u63cf\u6587\u4ef6\u5939" : pendingPptCount > 0 ? "\u8bf7\u5148\u51c6\u5907\u65b0\u589e PPT \u622a\u56fe" : !hasScreenshots ? "\u8bf7\u5148\u51c6\u5907\u622a\u56fe" : !hasUsableAskOutput ? "\u8bf7\u5148\u5b8c\u6210\u81ea\u52a8\u95ee" : running ? "\u5f53\u524d\u6709\u4efb\u52a1\u6b63\u5728\u8fd0\u884c" : !uncachedDecks.length ? "\u5df2\u7ecf\u5168\u90e8\u7f13\u5b58" : "\u8bf7\u52fe\u9009\u81f3\u5c11\u4e00\u4e2a\u672a\u7f13\u5b58\u5bf9\u8bdd" });
  if (elements.openCache) {
    const hasCache = cachedDecks(summary).length > 0;
    elements.openCache.disabled = !hasCache;
    elements.openCache.title = hasCache ? "" : "\u8fd8\u6ca1\u6709\u53ef\u6253\u5f00\u7684\u79bb\u7ebf\u7f13\u5b58";
  }
  setWorkflowHint(hint);
}

async function refreshState() {
  const data = await api("/api/state");
  state.chromeByProvider = data.chromeByProvider || { gemini: data.chrome || { ok: false }, chatgpt: data.chrome || { ok: false } };
  state.chromeOk = providerChromeOk();
  if (!state.formLoaded) { loadForm(data.defaults); state.formLoaded = true; }
  pruneHiddenJobs(data.jobs);
  renderJobs(data.jobs);
  if (state.summary && elements.workspace.value.trim()) { await scan(); return; }
  const currentChrome = providerChromeStatus();
  const chrome = currentChrome.ok ? providerLabel() + " \u81ea\u52a8\u5316\u7aef\u53e3\u5df2\u6253\u5f00\uff1a" + (currentChrome.browser || currentChrome.debugUrl || "") : providerLabel() + " \u81ea\u52a8\u5316\u7aef\u53e3\u672a\u6253\u5f00";
  setStatus(selectedProvider() === "chatgpt" ? (currentChrome.ok ? "ChatGPT \u81ea\u52a8\u5316\u7aef\u53e3\u5df2\u6253\u5f00" : "ChatGPT \u9700\u8981\u5148\u6253\u5f00\u81ea\u52a8\u5316 Chrome \u5e76\u767b\u5f55") : chrome);
  updateWorkflowState();
}

async function scan() {
  const data = await api("/api/scan", { method: "POST", body: JSON.stringify(payload()) });
  renderSummary(data.summary);
  setStatus("\u626b\u63cf\u5b8c\u6210");
  updateWorkflowState();
}


async function refreshSummaryProgress() {
  if (!state.summary || state.summaryRefreshInFlight || !elements.workspace.value.trim()) return;
  state.summaryRefreshInFlight = true;
  try {
    const requestPayload = {
      ...payload(),
      provider: runningWorkspaceProvider(),
    };
    let data;
    try {
      data = await api("/api/progress/current", {
        method: "POST",
        body: JSON.stringify(requestPayload),
      });
    } catch (error) {
      if (!String(error.message || "").includes("Not found")) throw error;
      const scanData = await api("/api/scan", {
        method: "POST",
        body: JSON.stringify(requestPayload),
      });
      renderSummary(scanData.summary);
      return;
    }
    renderSummary({
      ...state.summary,
      decks: data.result.decks || state.summary.decks,
      progress: data.result.progress || state.summary.progress,
      conversationFoldersCount: data.result.conversationFoldersCount ?? state.summary.conversationFoldersCount,
    });
  } finally {
    state.summaryRefreshInFlight = false;
  }
}

async function startJob(path, body = payload()) {
  const data = await api(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  state.selectedJobId = data.job.id;
  const existing = (state.jobs || []).filter((job) => job.id !== data.job.id);
  renderJobs([data.job, ...existing]);
  await refreshJobsAndLog();
  updateWorkflowState();
  return data.job;
}

async function prepareSelectedScreenshots() {
  const selected = selectedScreenshotFiles();
  const count = selected.pdfs.length + selected.ppts.length;
  if (!count) {
    setStatus("\u8bf7\u5148\u9009\u62e9\u8981\u8f6c\u6362\u6210\u622a\u56fe\u7684 PDF \u6216 PPT\u3002");
    updateWorkflowState();
    return null;
  }
  return startJob("/api/jobs/prepare", { ...payload(), ...selected });
}

async function selectJob(id) {
  state.selectedJobId = id;
  await refreshJobsAndLog();
}

async function refreshJobsAndLog() {
  const data = await api("/api/jobs");
  pruneHiddenJobs(data.jobs);
  renderJobs(data.jobs);
  const hasRunningContentJob = data.jobs.some((job) => (
    (job.type === "prepare" || job.type === "gemini" || job.type === "chatgpt" || job.type === "plugin" || job.type === "cache")
    && job.status === "running"
  ));
  const justCompletedContentJob = data.jobs.find((job) => (
    (job.type === "prepare" || job.type === "gemini" || job.type === "chatgpt" || job.type === "plugin" || job.type === "cache")
    && job.status === "complete"
    && !state.refreshedJobIds.has(job.id)
  ));
  if (justCompletedContentJob && state.summary) {
    state.refreshedJobIds.add(justCompletedContentJob.id);
    await scan();
  } else if (hasRunningContentJob) {
    await refreshSummaryProgress();
  }
  const selectableJobs = visibleJobs(data.jobs);
  if (state.selectedJobId && !selectableJobs.some((job) => job.id === state.selectedJobId)) {
    state.selectedJobId = null;
  }
  if (!state.selectedJobId && selectableJobs.length) state.selectedJobId = selectableJobs[0].id;
  if (state.selectedJobId) {
    const logData = await api("/api/jobs/" + encodeURIComponent(state.selectedJobId) + "/log");
    elements.log.textContent = logData.log || "\u6682\u65e0\u65e5\u5fd7\u3002";
    elements.stopJob.disabled = logData.job.status !== "running";
    elements.log.scrollTop = elements.log.scrollHeight;
  } else {
    elements.stopJob.disabled = true;
    elements.log.textContent = "\u8fd8\u6ca1\u6709\u4efb\u52a1\u65e5\u5fd7\u3002";
  }
}

async function startChrome() {
  const provider = selectedProvider();
  const data = await api("/api/chrome/start", {
    method: "POST",
    body: JSON.stringify(payload()),
  });
  const label = providerLabel(provider);
  state.chromeByProvider[provider] = {
    ok: !!data.result.ok,
    browser: data.result.browser || "",
    debugUrl: data.result.debugUrl || "",
  };
  if (data.result.openedTab) {
    setStatus("\u5df2\u5728\u81ea\u52a8\u5316 Chrome \u4e2d\u6253\u5f00 " + label + " \u6807\u7b7e\u9875");
  } else if (data.result.launched && data.result.ok) {
    setStatus("\u5df2\u542f\u52a8\u81ea\u52a8\u5316 Chrome\uff0c\u5e76\u786e\u8ba4 " + label + " \u7aef\u53e3\u53ef\u7528\u3002");
  } else if (data.result.launched) {
    setStatus("\u5df2\u542f\u52a8\u81ea\u52a8\u5316 Chrome\uff0c\u8bf7\u7b49\u5f85\u51e0\u79d2\u540e\u5237\u65b0\u72b6\u6001\u3002" + (data.result.message ? " " + data.result.message : ""));
  } else {
    setStatus(data.result.alreadyRunning ? "\u81ea\u52a8\u5316 Chrome \u5df2\u7ecf\u6253\u5f00" : "\u5df2\u6253\u5f00\u81ea\u52a8\u5316 Chrome\uff0c\u8bf7\u786e\u8ba4\u5df2\u767b\u5f55 " + label);
  }
  state.chromeOk = providerChromeOk();
  updateWorkflowState();
}

async function resetProgress() {
  const data = await api("/api/progress/reset", {
    method: "POST",
    body: JSON.stringify(payload()),
  });
  renderSummary(data.result.summary);
  setStatus("\u5df2\u91cd\u7f6e\u63d0\u95ee\u8fdb\u5ea6\uff1a" + data.result.decks + " \u4e2a Deck \u4f1a\u4ece\u7b2c 1 \u9875\u91cd\u65b0\u5f00\u59cb " + providerLabel(data.result.provider || selectedProvider()) + " \u63d0\u95ee");
  await refreshJobsAndLog();
}

async function chooseFolder(input, title, options = {}) {
  setStatus("\u6b63\u5728\u9009\u62e9\u6587\u4ef6\u5939...");
  let data = null;
  try {
    data = await api("/api/pick-folder", {
      method: "POST",
      body: JSON.stringify({
        title,
        initialPath: input.value.trim(),
      }),
    });
  } catch (error) {
    const manualPath = window.prompt(title + "\n\n如果系统选择器没有打开，请把课程文件夹路径粘贴到这里：", input.value.trim());
    if (!manualPath) {
      setStatus("\u5df2\u53d6\u6d88\u9009\u62e9\u6587\u4ef6\u5939");
      return;
    }
    data = { path: manualPath.trim() };
  }

  if (data.canceled || !data.path) {
    const manualPath = window.prompt(title + "\n\n请选择失败时，可以直接粘贴课程文件夹路径：", input.value.trim());
    if (!manualPath) {
      setStatus("\u5df2\u53d6\u6d88\u9009\u62e9\u6587\u4ef6\u5939");
      return;
    }
    data = { path: manualPath.trim() };
  }

  input.value = data.path;
  if (input === elements.workspace) {
    autoFillSubjectFromWorkspace({ force: true });
    clearSummary();
  }
  saveForm();
  setStatus("\u5df2\u9009\u62e9\u6587\u4ef6\u5939");
  if (options.scanAfterPick) await scan();
}

async function stopSelectedJob() {
  if (!state.selectedJobId) return;
  await api("/api/jobs/" + encodeURIComponent(state.selectedJobId) + "/stop", { method: "POST" });
  await refreshJobsAndLog();
}

async function clearSelectedLog() {
  if (!state.selectedJobId) {
    elements.log.textContent = "\u6682\u65e0\u65e5\u5fd7\u3002";
    setStatus("\u8fd8\u6ca1\u6709\u9009\u4e2d\u4efb\u52a1");
    return;
  }
  await api("/api/jobs/" + encodeURIComponent(state.selectedJobId) + "/log/clear", { method: "POST" });
  elements.log.textContent = "\u6682\u65e0\u65e5\u5fd7\u3002";
  setStatus("\u5f53\u524d\u4efb\u52a1\u65e5\u5fd7\u5df2\u6e05\u7a7a");
}

async function clearFinishedJobs() {
  let data;
  try {
    data = await api("/api/jobs/clear-finished", { method: "POST" });
  } catch (error) {
    if (!String(error.message || "").includes("404") && !String(error.message || "").includes("Not found")) throw error;
    const expiredJobs = (state.jobs || []).filter((job) => job.status !== "running");
    for (const job of expiredJobs) state.hiddenJobIds.add(job.id);
    saveHiddenJobs();
    renderJobs(state.jobs);
    const selectable = visibleJobs(state.jobs);
    if (!selectable.some((job) => job.id === state.selectedJobId)) {
      state.selectedJobId = selectable[0]?.id || null;
      if (state.selectedJobId) await refreshJobsAndLog();
      else {
        elements.stopJob.disabled = true;
        elements.log.textContent = "\u8fd8\u6ca1\u6709\u4efb\u52a1\u65e5\u5fd7\u3002";
      }
    }
    setStatus(expiredJobs.length ? "\u5df2\u6e05\u7a7a " + expiredJobs.length + " \u4e2a\u8fc7\u671f\u4efb\u52a1" : "\u6ca1\u6709\u8fc7\u671f\u4efb\u52a1\u9700\u8981\u6e05\u7a7a");
    return;
  }

  const nextJobs = data.jobs || [];
  pruneHiddenJobs(nextJobs);
  renderJobs(nextJobs);
  if (state.selectedJobId && !nextJobs.some((job) => job.id === state.selectedJobId)) state.selectedJobId = null;
  if (!state.selectedJobId && nextJobs.length) state.selectedJobId = nextJobs[0].id;
  if (state.selectedJobId) await refreshJobsAndLog();
  else {
    elements.stopJob.disabled = true;
    elements.log.textContent = "\u8fd8\u6ca1\u6709\u4efb\u52a1\u65e5\u5fd7\u3002";
  }
  setStatus(data.removed ? "\u5df2\u6e05\u7a7a " + data.removed + " \u4e2a\u8fc7\u671f\u4efb\u52a1" : "\u6ca1\u6709\u8fc7\u671f\u4efb\u52a1\u9700\u8981\u6e05\u7a7a");
}
async function writePluginConfig() {
  const job = await startJob("/api/jobs/plugin");
  const result = job.result || {};
  if (result.alreadyImported) {
    setStatus("\u5df2\u7ecf\u5199\u5165\u8fc7\u63d2\u4ef6\uff1a" + (result.title || "\u5f53\u524d\u8bfe\u7a0b"));
  } else if (result.reusedExistingSubject) {
    setStatus("\u5df2\u66f4\u65b0\u5df2\u6709\u8bfe\u7a0b\uff1a" + (result.title || "\u5f53\u524d\u8bfe\u7a0b"));
  } else {
    setStatus("\u5df2\u5199\u5165\u63d2\u4ef6\uff1a" + (result.title || "\u5f53\u524d\u8bfe\u7a0b"));
  }
}

async function cacheGeminiTranscript() {
  const cacheDecks = selectedCacheableDecks();
  if (!cacheDecks.length && selectedProvider() !== "chatgpt") {
    setStatus("\u6ca1\u6709\u9009\u4e2d\u7684\u672a\u7f13\u5b58\u5bf9\u8bdd\u3002");
    return;
  }
  const job = await startJob("/api/jobs/cache", { ...payload(), cacheDecks });
  const result = job.result || {};
  const countText = cacheDecks.length ? " / " + cacheDecks.length + " \u4e2a\u5bf9\u8bdd" : "";
  setStatus("\u5df2\u5f00\u59cb\u751f\u6210\u79bb\u7ebf\u7f13\u5b58\uff1a" + (result.title || "\u5f53\u524d\u8bfe\u7a0b") + countText);
}

function openCachedContent() {
  const selected = new Set(selectedCacheDecks());
  const decks = cachedDecks();
  const deck = decks.find((item) => selected.has(item.id)) || decks[0];
  if (!deck?.cacheUrl) {
    setStatus("\u8fd8\u6ca1\u6709\u53ef\u6253\u5f00\u7684\u79bb\u7ebf\u7f13\u5b58");
    return;
  }
  window.open(deck.cacheUrl, "_blank", "noopener");
  setStatus("\u5df2\u6253\u5f00\u79bb\u7ebf\u7f13\u5b58\uff1a" + (deck.title || deck.id));
}

function openManagerWindow() {
  const url = window.location.origin + window.location.pathname;
  const opened = window.open(url, "_blank");
  setStatus(opened ? "\u5df2\u65b0\u5f00\u4e00\u4e2a DeckSync \u7ba1\u7406\u5668\u9875\u9762" : "\u6d4f\u89c8\u5668\u62e6\u622a\u4e86\u65b0\u9875\u9762\uff0c\u8bf7\u5141\u8bb8\u5f39\u7a97\u540e\u518d\u70b9\u4e00\u6b21");
}
elements.workspace.addEventListener("change", () => {
  const saved = readSavedForm();
  if (saved.provider) {
    elements.providerSelect.value = saved.provider;
    updateModelOptions(saved.model || "");
    if (elements.chatgptThinking) {
      updateChatGptModeOptions(saved.chatgptThinkingPreset
        || normalizeChatGptPreset(saved.chatgptThinking || "thinking", saved.chatgptThinkingEffort || "advanced"));
    }
    elements.proFallback.value = saved.proFallback || elements.proFallback.value;
    elements.promptText.value = saved.prompt || "\u8bf7\u8be6\u7ec6\u8bb2\u89e3\u8fd9\u4e00\u9762PPT";
    if (Object.prototype.hasOwnProperty.call(saved, "prePrompt")) elements.prePromptText.value = saved.prePrompt || "";
    if (elements.pagesPerPrompt && saved.pagesPerPrompt) elements.pagesPerPrompt.value = String(normalizePagesPerPrompt(saved.pagesPerPrompt));
    if (elements.autoCacheDecks) elements.autoCacheDecks.checked = !!saved.autoCacheDecks;
  }
  autoFillSubjectFromWorkspace();
  clearSummary();
});

for (const input of [
  elements.workspace,
  elements.subjectId,
  elements.subjectTitle,
  elements.providerSelect,
  elements.modelSelect,
  elements.chatgptThinking,
  elements.proFallback,
  elements.pagesPerPrompt,
  elements.autoCacheDecks,
  elements.promptText,
  elements.prePromptText,
]) {
  input?.addEventListener("change", saveForm);
}
elements.providerSelect?.addEventListener("change", () => {
  updateModelOptions();
  saveForm();
  state.chromeOk = providerChromeOk();
  setStatus(selectedProvider() === "chatgpt"
    ? (providerChromeOk("chatgpt") ? "ChatGPT \u7f51\u9875\u81ea\u52a8\u5316\u7aef\u53e3\u5df2\u6253\u5f00" : "ChatGPT \u9700\u8981\u5148\u6253\u5f00\u6807\u7b7e\u9875\u5e76\u767b\u5f55")
    : (providerChromeOk("gemini") ? "Gemini \u81ea\u52a8\u5316\u7aef\u53e3\u5df2\u6253\u5f00" : "Gemini \u81ea\u52a8\u5316\u7aef\u53e3\u672a\u6253\u5f00"));
  if (elements.workspace.value.trim()) {
    scan().catch((error) => setStatus(error.message));
  } else {
    updateWorkflowState();
  }
});
elements.modelSelect?.addEventListener("change", () => {
  updateChatGptModeOptions();
  saveForm();
});
elements.promptText.addEventListener("input", saveForm);
elements.prePromptText.addEventListener("input", saveForm);
elements.cacheDeckList?.addEventListener("change", updateWorkflowState);

elements.refreshState.addEventListener("click", () => refreshState().catch((error) => setStatus(error.message)));
elements.pickWorkspace.addEventListener("click", () => chooseFolder(elements.workspace, "\u9009\u62e9\u8bfe\u7a0b\u6587\u4ef6\u5939", { scanAfterPick: true }).catch((error) => setStatus(error.message)));
elements.organizeWorkspace?.addEventListener("click", () => startJob("/api/jobs/organize").catch((error) => setStatus(error.message)));
elements.openManagerWindow?.addEventListener("click", openManagerWindow);
elements.scan.addEventListener("click", () => scan().catch((error) => setStatus(error.message)));
elements.prepare.addEventListener("click", () => prepareSelectedScreenshots().catch((error) => setStatus(error.message)));
elements.chrome.addEventListener("click", () => startChrome().catch((error) => setStatus(error.message)));
elements.runGemini.addEventListener("click", () => startJob("/api/jobs/ask").catch((error) => setStatus(error.message)));
elements.resetProgress.addEventListener("click", () => resetProgress().catch((error) => setStatus(error.message)));
elements.updatePlugin.addEventListener("click", () => writePluginConfig().catch((error) => setStatus(error.message)));
elements.cacheGemini.addEventListener("click", () => cacheGeminiTranscript().catch((error) => setStatus(error.message)));
elements.openCache.addEventListener("click", () => openCachedContent());
elements.stopJob.addEventListener("click", () => stopSelectedJob().catch((error) => setStatus(error.message)));
elements.clearLog.addEventListener("click", () => clearSelectedLog().catch((error) => setStatus(error.message)));
elements.clearFinishedJobs.addEventListener("click", () => clearFinishedJobs().catch((error) => setStatus(error.message)));

state.pollTimer = setInterval(() => {
  refreshJobsAndLog().catch(() => {});
}, 1800);

refreshState().catch((error) => setStatus(error.message));
renderScreenshotFileOptions(null);
renderCacheDeckOptions(null);
updateWorkflowState();
