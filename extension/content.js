(() => {
  const HOST_ID = "codex-gemini-reading-marker";
  const CONTENT_VERSION = "1.7.7";
  const MIN_SCROLL_DELTA = 80;
  const SHOW_TOP_AFTER = 280;
  const STORAGE_PREFIX = "gemini-reading-marker:";
  const DEEP_TOP_TIMEOUT_MS = 300000;
  const MARKER_SCROLL_TIMEOUT_MS = 300000;
  const GEMSYNC_DEFAULT_SERVER = "http://127.0.0.1:5188";
  const GEMSYNC_SERVER_KEY = "gemsync:manager-server";
  const GEMSYNC_SERVER_CANDIDATES = [
    GEMSYNC_DEFAULT_SERVER,
    ...Array.from({ length: 99 }, (_, index) => `http://127.0.0.1:${5189 + index}`),
  ];
  const GEMSYNC_PANEL_PATH = "pdf-panel/index.html";
  const OLDER_LOAD_NUDGE_PX = 180;
  const SYNC_TOP_MARGIN_PX = 18;
  const GEMSYNC_PENDING_DOCK_KEY = "gemsync:pending-pdf-dock";
  const STALE_LOCAL_PANEL_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(5177|5188)(?:\/|$)/i;

  const removeExistingInstance = () => {
    document.getElementById(HOST_ID)?.remove();
    document.getElementById(`${HOST_ID}-pdf-dock`)?.remove();
    document.getElementById(`${HOST_ID}-pdf-style`)?.remove();
    document.documentElement.classList.remove(`${HOST_ID}-pdf-open`);
  };

  const existingHost = document.getElementById(HOST_ID);
  const existingDockFrame = document.querySelector(`#${HOST_ID}-pdf-dock iframe`);
  const existingVersion = existingHost?.dataset?.gemsyncVersion || "";
  const hasStaleLocalPanel = !!existingDockFrame?.src && STALE_LOCAL_PANEL_RE.test(existingDockFrame.src);
  if (existingHost) {
    if (existingVersion !== CONTENT_VERSION || hasStaleLocalPanel) {
      removeExistingInstance();
    } else {
      return;
    }
  }

  let chromeContextInvalidated = false;
  let gemSyncServer = localStorage.getItem(GEMSYNC_SERVER_KEY) || GEMSYNC_DEFAULT_SERVER;

  const isContextInvalidatedError = (error) => {
    return /Extension context invalidated|context invalidated/i.test(String(error?.message || error || ""));
  };

  const getChromeRuntime = () => {
    if (chromeContextInvalidated) return null;
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      return runtime?.id ? runtime : null;
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      return null;
    }
  };

  const getExtensionUrl = (path) => {
    const runtime = getChromeRuntime();
    try {
      return runtime?.getURL ? runtime.getURL(path) : "";
    } catch (error) {
      if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
      return "";
    }
  };

  const getExtensionOrigin = () => {
    const url = getExtensionUrl(GEMSYNC_PANEL_PATH);
    try {
      return url ? new URL(url).origin : "";
    } catch {
      return "";
    }
  };

  const isGemSyncFrameOrigin = (origin) => {
    return !!getExtensionOrigin() && origin === getExtensionOrigin();
  };

  const getGemSyncPanelUrl = ({ subjectId = "", deckId = "deck01", page = 1 } = {}) => {
    const extensionUrl = getExtensionUrl(GEMSYNC_PANEL_PATH);
    const safeSubject = encodeURIComponent(subjectId || "");
    const safeDeck = encodeURIComponent(deckId || "deck01");
    const safePage = Math.max(1, Number(page) || 1);
    if (extensionUrl) {
      return `${extensionUrl}#subject=${safeSubject}&deck=${safeDeck}&page=${safePage}&embed=1`;
    }
    return "";
  };

  const getGemSyncConfigs = async () => {
    const extensionSubjects = getExtensionUrl("pdf-panel/subjects.json");
    if (extensionSubjects) {
      const subjectsResponse = await fetch(extensionSubjects, { cache: "no-store" });
      if (!subjectsResponse.ok) throw new Error(`HTTP ${subjectsResponse.status}`);
      const subjectsConfig = await subjectsResponse.json();
      const subjects = subjectsConfig.subjects || [];
      const configs = [];
      for (const subject of subjects) {
        const configUrl = new URL(subject.configUrl, extensionSubjects).toString();
        const response = await fetch(configUrl, { cache: "no-store" });
        if (!response.ok) continue;
        const config = await response.json();
        configs.push({
          subject,
          config: {
            ...config,
            decks: (config.decks || []).map((deck) => ({ ...deck, subjectId: subject.id })),
          },
        });
      }
      return configs;
    }

    throw new Error("PDF 面板配置只能从扩展内读取。请刷新页面，或者在 chrome://extensions 里重新加载 DeckSync 插件。");
  };

  const readLocalJson = (key) => {
    try {
      const text = localStorage.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const storage = {
    async get(key) {
      return readLocalJson(key);
    },
    async set(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
    async remove(key) {
      localStorage.removeItem(key);
    },
  };

  const isChatGptPage = () => /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(location.hostname);
  const isGeminiPage = () => /(^|\.)gemini\.google\.com$/i.test(location.hostname);
  const currentProvider = () => isChatGptPage() ? "chatgpt" : "gemini";

  const conversationIdFromUrl = (url) => {
    try {
      const parsed = new URL(url, location.href);
      if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(parsed.hostname)) {
        return parsed.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || "";
      }
      if (/(^|\.)gemini\.google\.com$/i.test(parsed.hostname)) {
        return parsed.pathname.match(/^\/app\/([^/?#]+)/)?.[1] || "";
      }
      return "";
    } catch {
      return "";
    }
  };

  const fetchWithTimeout = async (url, options = {}, timeoutMs = 650) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const checkGemSyncServer = async (server) => {
    try {
      const response = await fetchWithTimeout(`${server}/api/state`, { cache: "no-store" });
      if (!response.ok) return false;
      const data = await response.json();
      return data?.defaults?.appName === "DeckSync";
    } catch {
      return false;
    }
  };

  const resolveGemSyncServer = async () => {
    if (gemSyncServer && await checkGemSyncServer(gemSyncServer)) return gemSyncServer;
    for (const server of GEMSYNC_SERVER_CANDIDATES) {
      if (await checkGemSyncServer(server)) {
        gemSyncServer = server;
        localStorage.setItem(GEMSYNC_SERVER_KEY, server);
        return server;
      }
    }
    return "";
  };

  const getConversationKey = () => {
    const id = getConversationId();
    const match = id ? [null, id] : null;
    return match ? `${STORAGE_PREFIX}${match[1]}` : null;
  };

  const getConversationId = () => {
    return conversationIdFromUrl(location.href);
  };

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.gemsyncVersion = CONTENT_VERSION;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      position: fixed;
      right: 22px;
      bottom: 132px;
      z-index: 2147483647;
      font-family: Google Sans, Roboto, Arial, sans-serif;
    }

    .stack {
      display: grid;
      gap: 14px;
      justify-items: end;
      isolation: isolate;
    }

    button {
      --hot-rgb: 34, 211, 238;
      --warm-rgb: 191, 246, 255;
      --rim-rgb: 103, 232, 249;
      --glass-dark: rgba(4, 10, 38, 0.12);
      --ink: #ffffff;
      position: relative;
      box-sizing: border-box;
      width: 144px;
      height: 48px;
      border: 1px solid rgba(var(--warm-rgb), 0.72);
      border-radius: 999px;
      background:
        radial-gradient(ellipse 82% 98% at 28% 50%, rgba(var(--hot-rgb), 0.86), rgba(var(--rim-rgb), 0.62) 40%, rgba(var(--warm-rgb), 0.34) 61%, rgba(255, 255, 255, 0.12) 100%),
        linear-gradient(90deg, rgba(var(--hot-rgb), 0.5), rgba(var(--warm-rgb), 0.4) 55%, rgba(255, 255, 255, 0.22)),
        rgba(255, 255, 255, 0.16);
      color: var(--ink);
      box-shadow:
        0 14px 30px rgba(2, 6, 23, 0.26),
        0 0 30px rgba(var(--hot-rgb), 0.32),
        0 0 0 1px rgba(var(--warm-rgb), 0.22),
        inset 0 0 22px rgba(var(--warm-rgb), 0.2),
        inset 13px 12px 24px rgba(var(--rim-rgb), 0.24),
        inset -14px -12px 26px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.82),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.28);
      cursor: pointer;
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      align-items: center;
      justify-items: center;
      column-gap: 6px;
      padding: 0 14px 0 0;
      font-size: 16px;
      font-weight: 760;
      line-height: 1;
      letter-spacing: 0;
      opacity: 0.96;
      overflow: visible;
      transform: translateZ(0);
      text-shadow:
        0 1px 8px rgba(2, 6, 23, 0.32),
        0 0 12px rgba(255, 255, 255, 0.28);
      transition:
        opacity 180ms ease,
        transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1),
        background 180ms ease,
        border-color 180ms ease,
        box-shadow 180ms ease;
      user-select: none;
      -webkit-backdrop-filter: blur(24px) saturate(1.58) brightness(1.14);
      backdrop-filter: blur(24px) saturate(1.58) brightness(1.14);
    }

    button::before {
      content: "";
      position: absolute;
      inset: 2px;
      border-radius: inherit;
      background:
        linear-gradient(118deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.22) 26%, transparent 48%),
        radial-gradient(ellipse 48% 76% at 30% 52%, rgba(var(--warm-rgb), 0.28), rgba(var(--hot-rgb), 0.18) 54%, transparent 76%),
        radial-gradient(ellipse 36% 88% at 92% 54%, rgba(2, 6, 23, 0.08), transparent 70%);
      box-shadow:
        inset 0 1px 2px rgba(255, 255, 255, 0.48),
        inset 9px 9px 22px rgba(var(--rim-rgb), 0.18),
        inset -10px -10px 22px rgba(4, 10, 38, 0.12);
      opacity: 0.92;
      pointer-events: none;
    }

    button:not(.busy)::after {
      content: "";
      position: absolute;
      left: 28px;
      top: 50%;
      width: 40px;
      height: 40px;
      border: 1px solid rgba(255, 255, 255, 0.62);
      border-radius: 999px;
      background:
        radial-gradient(circle at 44% 48%, rgba(var(--warm-rgb), 0.28), rgba(var(--hot-rgb), 0.16) 48%, rgba(255, 255, 255, 0.08) 69%, transparent 72%),
        rgba(255, 255, 255, 0.03);
      box-shadow:
        inset 9px 8px 16px rgba(var(--warm-rgb), 0.18),
        inset -8px -8px 18px rgba(4, 10, 38, 0.12),
        0 0 18px rgba(var(--warm-rgb), 0.18);
      transform: translate(-50%, -50%);
      pointer-events: none;
    }

    .button-icon,
    .button-label {
      position: relative;
      z-index: 1;
      pointer-events: none;
    }

    .button-icon {
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
    }

    .button-icon svg {
      width: 24px;
      height: 24px;
      display: block;
      fill: none;
      stroke: currentColor;
      stroke-width: 2.35;
      stroke-linecap: round;
      stroke-linejoin: round;
      filter: drop-shadow(0 1px 6px rgba(2, 6, 23, 0.28));
    }

    button.busy .button-icon {
      opacity: 0;
    }

    .button-label {
      justify-self: start;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    button:hover,
    button:focus-visible {
      opacity: 1;
      transform: translateY(-2px);
      border-color: rgba(var(--warm-rgb), 0.78);
      background:
        radial-gradient(ellipse 82% 98% at 28% 50%, rgba(var(--hot-rgb), 0.94), rgba(var(--rim-rgb), 0.7) 40%, rgba(var(--warm-rgb), 0.42) 61%, rgba(255, 255, 255, 0.16) 100%),
        linear-gradient(90deg, rgba(var(--hot-rgb), 0.58), rgba(var(--warm-rgb), 0.48) 55%, rgba(255, 255, 255, 0.28)),
        rgba(255, 255, 255, 0.18);
      box-shadow:
        0 16px 34px rgba(2, 6, 23, 0.26),
        0 0 36px rgba(var(--hot-rgb), 0.28),
        0 0 0 1px rgba(var(--warm-rgb), 0.2),
        inset 0 0 20px rgba(var(--warm-rgb), 0.26),
        inset 12px 12px 24px rgba(var(--rim-rgb), 0.22),
        inset -14px -14px 30px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.78),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.42);
      outline: none;
    }

    button:active {
      transform: translateY(0) scale(0.97);
      box-shadow:
        0 10px 24px rgba(2, 6, 23, 0.3),
        0 0 18px rgba(var(--hot-rgb), 0.16),
        inset 7px 7px 18px rgba(2, 6, 23, 0.24),
        inset -7px -7px 18px rgba(var(--rim-rgb), 0.18),
        inset 0 -1px 0 rgba(var(--warm-rgb), 0.18);
    }

    button.hidden {
      opacity: 0;
      transform: translateY(10px) scale(0.88);
      pointer-events: none;
    }

    :host(.pdf-open) {
      right: calc(50vw - 1px);
    }

    :host(.pdf-open) .stack {
      gap: 16px;
    }

    :host(.pdf-open) button {
      width: 26px;
      height: 46px;
      grid-template-columns: 1fr;
      column-gap: 0;
      padding: 0;
      border-radius: 999px 0 0 999px;
      border-right: 0;
      overflow: hidden;
      box-shadow:
        -8px 0 24px rgba(var(--hot-rgb), 0.2),
        0 0 18px rgba(var(--hot-rgb), 0.28),
        inset 8px 8px 18px rgba(var(--rim-rgb), 0.3),
        inset -8px -8px 18px var(--glass-dark),
        inset 0 1px 0 rgba(255, 255, 255, 0.62);
    }

    :host(.pdf-open) button::before {
      inset: 2px 0 2px 2px;
      border-radius: inherit;
      background:
        linear-gradient(118deg, rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.12) 36%, transparent 62%),
        radial-gradient(ellipse 72% 88% at 36% 52%, rgba(var(--warm-rgb), 0.22), rgba(var(--hot-rgb), 0.14) 56%, transparent 82%);
    }

    :host(.pdf-open) button::after,
    :host(.pdf-open) .button-icon,
    :host(.pdf-open) .button-label {
      display: none;
    }

    :host(.pdf-open) button:hover,
    :host(.pdf-open) button:focus-visible {
      width: 32px;
      transform: translateX(-4px);
      border-color: rgba(var(--warm-rgb), 0.78);
    }

    :host(.pdf-open) button:active {
      transform: translateX(-2px) scale(0.98);
    }

    :host(.pdf-open) button.hidden {
      opacity: 0;
      transform: translateX(10px) scale(0.86);
      pointer-events: none;
    }

    button.pdfdock {
      --hot-rgb: 255, 161, 46;
      --warm-rgb: 255, 252, 200;
      --rim-rgb: 255, 222, 118;
    }

    button.pdfdock.marked {
      --hot-rgb: 255, 178, 52;
      --warm-rgb: 255, 253, 210;
      --rim-rgb: 255, 230, 130;
    }

    button.restore {
      --hot-rgb: 168, 85, 247;
      --warm-rgb: 245, 220, 255;
      --rim-rgb: 220, 190, 255;
    }

    button.restore.missing {
      --hot-rgb: 145, 108, 232;
      --warm-rgb: 232, 236, 248;
      --rim-rgb: 205, 190, 255;
      opacity: 0.78;
    }

    button.mark {
      --hot-rgb: 24, 205, 145;
      --warm-rgb: 214, 255, 236;
      --rim-rgb: 128, 240, 196;
    }

    button.mark.marked {
      --hot-rgb: 44, 218, 104;
      --warm-rgb: 224, 255, 232;
      --rim-rgb: 144, 244, 176;
    }

    button.stop {
      --hot-rgb: 255, 96, 96;
      --warm-rgb: 255, 216, 222;
      --rim-rgb: 255, 148, 166;
    }

    button.busy {
      --hot-rgb: 59, 130, 246;
      --warm-rgb: 219, 234, 254;
      --rim-rgb: 147, 197, 253;
    }

    button.busy::after {
      content: "";
      position: absolute;
      left: 28px;
      top: 50%;
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 2px solid rgba(var(--warm-rgb), 0.22);
      border-top-color: rgba(var(--warm-rgb), 0.92);
      pointer-events: none;
      transform: translate(-50%, -50%);
      animation: spinRing 900ms linear infinite;
    }

    .toast {
      max-width: 220px;
      padding: 10px 12px;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.78);
      color: #1e293b;
      box-shadow:
        0 14px 32px rgba(15, 23, 42, 0.18),
        inset 0 1px 0 rgba(255, 255, 255, 0.78);
      font-size: 12px;
      line-height: 1.4;
      opacity: 0;
      transform: translateY(6px) scale(0.98);
      transition: opacity 180ms ease, transform 180ms ease;
      pointer-events: none;
      -webkit-backdrop-filter: blur(14px) saturate(1.25);
      backdrop-filter: blur(14px) saturate(1.25);
    }

    .toast.visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }

    @keyframes spinRing {
      to { transform: translate(-50%, -50%) rotate(360deg); }
    }

    @media (prefers-reduced-motion: reduce) {
      button,
      button::before,
      button::after,
      .toast {
        animation: none !important;
        transition: none !important;
      }
    }
  `;

  const stack = document.createElement("div");
  stack.className = "stack";

  const toast = document.createElement("div");
  toast.className = "toast";

  const icons = {
    pdf: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/></svg>`,
    restore: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/><path d="M12 7v5l3 2"/></svg>`,
    mark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
    top: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.8"/></svg>`,
    busy: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>`,
  };

  const setButtonContent = (button, iconName, label) => {
    button.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "button-icon";
    icon.innerHTML = icons[iconName] || icons.mark;
    const text = document.createElement("span");
    text.className = "button-label";
    text.textContent = label;
    button.append(icon, text);
  };

  const markButton = document.createElement("button");
  markButton.type = "button";
  setButtonContent(markButton, "mark", "Mark");
  markButton.title = "Mark current reading position. Right-click clears the mark.";
  markButton.setAttribute("aria-label", "Mark current reading position");
  markButton.className = "mark";

  const pdfDockButton = document.createElement("button");
  pdfDockButton.type = "button";
  setButtonContent(pdfDockButton, "pdf", "PDF");
  pdfDockButton.title = "Open PDF study panel";
  pdfDockButton.setAttribute("aria-label", "Open PDF study panel");
  pdfDockButton.className = "pdfdock";

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  setButtonContent(restoreButton, "restore", "Restore");
  restoreButton.title = "Go to marked reading position";
  restoreButton.setAttribute("aria-label", "Go to marked reading position");
  restoreButton.className = "restore missing";

  const topButton = document.createElement("button");
  topButton.type = "button";
  setButtonContent(topButton, "top", "Top");
  topButton.title = "Manually deep scroll to the first message";
  topButton.setAttribute("aria-label", "Manually deep scroll to the first message");
  topButton.className = "hidden";

  const stopButton = document.createElement("button");
  stopButton.type = "button";
  setButtonContent(stopButton, "stop", "Stop");
  stopButton.title = "Stop loading upward";
  stopButton.setAttribute("aria-label", "Stop loading upward");
  stopButton.className = "stop hidden";

  stack.append(toast, pdfDockButton, restoreButton, markButton, stopButton, topButton);
  shadow.append(style, stack);
  document.documentElement.append(host);

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("visible"), 1800);
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const normalizeText = (text) => {
    return String(text || "").replace(/\s+/g, " ").trim();
  };

  const sendRuntimeMessage = (message) => {
    return new Promise((resolve, reject) => {
      const runtime = getChromeRuntime();
      if (!runtime?.sendMessage) {
        reject(new Error("Chrome runtime messaging is unavailable."));
        return;
      }
      try {
        runtime.sendMessage(message, (response) => {
          try {
            const error = runtime.lastError;
            if (error) {
              reject(new Error(error.message));
              return;
            }
            if (!response?.ok) {
              reject(new Error(response?.error || "Extension request failed."));
              return;
            }
            resolve(response);
          } catch (error) {
            if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
            reject(error);
          }
        });
      } catch (error) {
        if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
        reject(error);
      }
    });
  };

  const isVisible = (element) => {
    if (!element || element === host) return false;
    if (element === document.documentElement || element === document.body || element === document.scrollingElement) return true;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 120
      && style.display !== "none"
      && style.visibility !== "hidden";
  };

  const isScrollable = (element) => {
    if (!element || !isVisible(element)) return false;
    const delta = element.scrollHeight - element.clientHeight;
    if (delta <= MIN_SCROLL_DELTA) return false;
    if (element.scrollTop > 0) return true;
    const overflowY = getComputedStyle(element).overflowY;
    return /auto|scroll|overlay/i.test(overflowY);
  };

  let scrollablesCache = {
    at: 0,
    items: null,
  };

  const getScrollables = (options = {}) => {
    const now = Date.now();
    if (!options.exhaustive && scrollablesCache.items && now - scrollablesCache.at < 1200) {
      return scrollablesCache.items;
    }

    const fastSelector = [
      "main",
      "[role='main']",
      "[class*='scroll']",
      "[class*='conversation']",
      "[class*='chat']",
      "[data-test-id*='conversation']",
      "[data-testid*='conversation']",
    ].join(",");

    const base = [
      document.scrollingElement,
      document.documentElement,
      document.body,
      ...document.querySelectorAll(fastSelector),
    ];
    if (options.exhaustive) {
      base.push(...document.querySelectorAll("*"));
    }

    const items = Array.from(new Set(base)).filter(isScrollable);
    scrollablesCache = { at: now, items };
    return items;
  };

  const getPrimaryScroller = (options = {}) => {
    const scrollables = getScrollables(options);
    return scrollables
      .slice()
      .sort((a, b) => {
        const aScore = (a.scrollTop || 0) + Math.max(0, a.scrollHeight - a.clientHeight);
        const bScore = (b.scrollTop || 0) + Math.max(0, b.scrollHeight - b.clientHeight);
        return bScore - aScore;
      })[0] || document.scrollingElement || document.documentElement;
  };

  const currentScrollTop = () => {
    const scroller = getPrimaryScroller();
    return Math.max(
      0,
      scroller?.scrollTop || 0,
      window.scrollY || 0,
      document.documentElement.scrollTop || 0,
      document.body.scrollTop || 0,
    );
  };

  const scrollEverywhere = (top, behavior = "smooth", options = {}) => {
    const targets = getScrollables(options);
    const list = targets.length ? targets : [document.scrollingElement || document.documentElement];
    for (const element of list) {
      element.scrollTo({ top, behavior });
    }
    window.scrollTo({ top, behavior });
  };

  const scrollToSavedPosition = (saved, behavior = "auto") => {
    const top = Math.max(0, Number(saved?.top) || 0);
    scrollEverywhere(top, behavior);
  };

  let currentKey = getConversationKey();
  let restoreToken = 0;
  let deepTopToken = 0;
  let markerScrollToken = 0;
  let hasMarker = false;
  let gemSyncPdfState = {
    autoSyncEnabled: false,
    deckId: "",
    pagePrompt: "",
  };
  let gemSyncReverseTimer = 0;
  let gemSyncLastReverseSignature = "";

  const getAnchorCandidates = () => {
    const selector = [
      "p",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "pre",
      "code",
      "user-query",
      "model-response",
      "message-content",
      "rich-text",
      "article",
    ].join(",");

    return Array.from(document.querySelectorAll(selector))
      .filter((element) => !host.contains(element))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const text = normalizeText(element.innerText || element.textContent || "");
        return { element, rect, text };
      })
      .filter(({ rect, text }) => {
        return rect.width > 80
          && rect.height > 8
          && rect.bottom > 72
          && rect.top < window.innerHeight - 120
          && text.length >= 40
          && text.length <= 2500
          && !/^问问 Gemini/i.test(text);
      });
  };

  const getVisibleAnchor = () => {
    const targetTop = Math.min(300, Math.max(140, window.innerHeight * 0.28));
    const candidates = getAnchorCandidates();
    const best = candidates
      .sort((a, b) => {
        const aScore = Math.abs(a.rect.top - targetTop) + Math.max(0, a.text.length - 900) / 12;
        const bScore = Math.abs(b.rect.top - targetTop) + Math.max(0, b.text.length - 900) / 12;
        return aScore - bScore;
      })[0];

    if (!best) return null;
    return {
      snippet: best.text.slice(0, 220),
      context: best.text.slice(0, 520),
      topOffset: Math.round(best.rect.top),
      savedAt: new Date().toISOString(),
    };
  };

  const findAnchorElement = (saved) => {
    const snippets = [
      saved?.anchor?.snippet,
      saved?.anchor?.context,
    ]
      .map(normalizeText)
      .filter((text) => text.length >= 40)
      .flatMap((text) => {
        return [
          text,
          text.slice(0, 180),
          text.slice(0, 120),
        ].filter((value) => value.length >= 40);
      });

    if (!snippets.length) return null;

    const selector = [
      "p",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "pre",
      "code",
      "user-query",
      "model-response",
      "message-content",
      "rich-text",
      "article",
    ].join(",");

    const matches = Array.from(document.querySelectorAll(selector))
      .filter((element) => !host.contains(element))
      .map((element) => {
        return {
          element,
          text: normalizeText(element.innerText || element.textContent || ""),
        };
      })
      .filter(({ text }) => snippets.some((snippet) => text.includes(snippet)))
      .sort((a, b) => a.text.length - b.text.length);

    return matches[0]?.element || null;
  };

  const isDocumentScroller = (element) => {
    return !element
      || element === window
      || element === document
      || element === document.scrollingElement
      || element === document.documentElement
      || element === document.body;
  };

  const topOverlayInset = () => {
    const leftPaneWidth = document.documentElement.classList.contains(`${HOST_ID}-pdf-open`)
      ? Math.max(1, window.innerWidth * 0.5)
      : window.innerWidth;
    const sampleXs = [
      Math.max(24, Math.min(360, leftPaneWidth - 24)),
      Math.max(24, Math.min(leftPaneWidth - 24, Math.round(leftPaneWidth * 0.5))),
    ];
    const maxProbeY = Math.min(160, Math.round(window.innerHeight * 0.35));
    let inset = 0;

    for (const x of sampleXs) {
      for (let y = 0; y <= maxProbeY; y += 12) {
        let node = document.elementFromPoint(x, y);
        for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
          if (host.contains(node)) break;
          const rect = node.getBoundingClientRect?.();
          if (!rect || rect.height <= 0 || rect.height > 180 || rect.width < 80) continue;
          if (rect.top > y + 1 || rect.bottom <= y) continue;
          const style = window.getComputedStyle(node);
          if (style.position === "fixed" || style.position === "sticky") {
            inset = Math.max(inset, rect.bottom);
            break;
          }
        }
      }
    }

    return Math.min(140, Math.max(0, Math.round(inset)));
  };

  const scrollElementToTop = (element, behavior = "auto") => {
    if (!element?.getBoundingClientRect) return;
    const scroller = getPrimaryScroller();
    const rect = element.getBoundingClientRect();
    const overlay = topOverlayInset();

    if (!isDocumentScroller(scroller)) {
      const scrollerRect = scroller.getBoundingClientRect();
      const margin = (scrollerRect.top <= 4 ? overlay : 0) + SYNC_TOP_MARGIN_PX;
      const top = Math.max(0, Math.round((scroller.scrollTop || 0) + rect.top - scrollerRect.top - margin));
      scroller.scrollTo({ top, behavior });
      return;
    }

    const top = Math.max(0, Math.round(currentScrollTop() + rect.top - overlay - SYNC_TOP_MARGIN_PX));
    window.scrollTo({ top, behavior });
    document.documentElement.scrollTop = top;
    document.body.scrollTop = top;
  };

  const scrollElementIntoReadingView = (element, behavior = "smooth", options = {}) => {
    const target = options.preferMessageTop ? expandPromptRootForReading(element) : element;
    const firstBehavior = behavior === "smooth" && !options.forceAuto ? "smooth" : "auto";
    const align = (mode = "auto") => scrollElementToTop(target, mode);

    align(firstBehavior);
    requestAnimationFrame(() => align("auto"));
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 260 : 80);
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 620 : 240);
    setTimeout(() => align("auto"), firstBehavior === "smooth" ? 980 : 520);
  };

  const applyStyles = (element, styles) => {
    Object.assign(element.style, styles);
  };

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

  const scrollPrimaryBy = async (delta) => {
    const before = currentScrollTop();
    const scroller = getPrimaryScroller();
    const target = before + delta;
    scroller?.scrollTo({ top: target, behavior: "auto" });
    window.scrollTo({ top: target, behavior: "auto" });
    await sleep(750);
    await nextFrame();
    return Math.max(0, currentScrollTop() - before);
  };

  const dispatchScrollSignals = (target, deltaY) => {
    const eventTarget = target || document.scrollingElement || document.documentElement;
    try {
      eventTarget.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode: 0,
      }));
    } catch {
      // Some pages restrict synthetic WheelEvent construction; scroll calls below still run.
    }

    try {
      eventTarget.dispatchEvent(new Event("scroll", { bubbles: true }));
      window.dispatchEvent(new Event("scroll"));
    } catch {
      // Ignore synthetic event failures.
    }
  };

  const pressOlderLoadKeys = () => {
    for (const key of ["Home", "PageUp"]) {
      try {
        document.dispatchEvent(new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
          code: key,
        }));
      } catch {
        // Ignore synthetic key failures.
      }
    }
  };

  const triggerOlderMessageLoad = async (attempt = 0) => {
    const scroller = getPrimaryScroller({ exhaustive: true });
    const targets = getScrollables({ exhaustive: true });
    const list = targets.length ? targets : [scroller, document.scrollingElement, document.documentElement].filter(Boolean);

    for (const element of list) {
      const top = Math.max(0, Number(element.scrollTop) || 0);
      element.scrollTo({ top: 0, behavior: "auto" });
      dispatchScrollSignals(element, -1800);

      if (top <= 2 && attempt % 4 === 3) {
        element.scrollTo({ top: OLDER_LOAD_NUDGE_PX, behavior: "auto" });
        dispatchScrollSignals(element, 360);
        await sleep(120);
        element.scrollTo({ top: 0, behavior: "auto" });
        dispatchScrollSignals(element, -2200);
      }
    }

    window.scrollTo({ top: 0, behavior: "auto" });
    pressOlderLoadKeys();
    await sleep(attempt < 8 ? 950 : 1450);
  };

  const getDeepTopSignature = () => {
    const scrollables = getScrollables({ exhaustive: true });
    const primary = getPrimaryScroller({ exhaustive: true });
    const maxHeight = Math.max(0, ...scrollables.map((element) => element.scrollHeight || 0));
    const text = (document.body.innerText || "").slice(0, 2200);
    const nodeCount = document.querySelectorAll("article, user-query, model-response, message-content, rich-text, img").length;
    return {
      top: Math.round(primary?.scrollTop || currentScrollTop()),
      maxHeight,
      nodeCount,
      imageCount: document.images.length,
      text,
    };
  };

  const scrollToDeepTop = async ({ behavior = "smooth", silent = false, restoreId = null } = {}) => {
    const runId = ++deepTopToken;
    let stableRounds = 0;
    let previousSignature = "";
    const startedAt = Date.now();

    topButton.classList.add("busy");
    topButton.classList.remove("hidden");
    updateVisibility();
    setButtonContent(topButton, "busy", "Busy");
    if (!silent) showToast("Loading earliest messages...");

    while (
      runId === deepTopToken
      && (restoreId === null || restoreId === restoreToken)
      && Date.now() - startedAt < DEEP_TOP_TIMEOUT_MS
    ) {
      scrollEverywhere(0, behavior);
      await sleep(900);
      scrollEverywhere(0, "auto");
      await sleep(450);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });

      if (signature.top > 4) {
        stableRounds = 0;
        previousSignature = "";
      } else if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 4) break;
      behavior = "auto";
    }

    const stillActive = runId === deepTopToken && (restoreId === null || restoreId === restoreToken);
    if (stillActive) {
      scrollEverywhere(0, "auto");
      topButton.classList.remove("busy");
      setButtonContent(topButton, "top", "Top");
      if (!silent) showToast("Reached earliest message.");
      updateVisibility();
    }
  };

  const updateMarkButton = () => {
    markButton.classList.toggle("marked", hasMarker);
    restoreButton.classList.toggle("missing", !hasMarker);
    markButton.title = hasMarker
      ? "Update current reading position. Right-click clears the mark."
      : "Mark current reading position. Right-click clears the mark.";
    restoreButton.title = hasMarker
      ? "Go to marked reading position"
      : "No marker yet";
  };

  const readMarker = async (key) => {
    return key ? await storage.get(key) : null;
  };

  const scrollToMarker = async ({ silent = false, restoreId = null } = {}) => {
    const key = getConversationKey();
    const saved = await readMarker(key);
    if (!saved) {
      hasMarker = false;
      updateMarkButton();
      if (!silent) showToast("No marker for this conversation.");
      return false;
    }

    hasMarker = true;
    updateMarkButton();

    const alreadyLoaded = findAnchorElement(saved);
    if (alreadyLoaded) {
      scrollElementIntoReadingView(alreadyLoaded, "smooth");
      if (!silent) showToast("Jumped to marker.");
      return true;
    }

    if (!saved.anchor?.snippet) {
      scrollToSavedPosition(saved, "smooth");
      if (!silent) showToast("Jumped to saved scroll position.");
      return true;
    }

    const runId = ++markerScrollToken;
    deepTopToken += 1;
    let stableRounds = 0;
    let previousSignature = "";
    let found = null;
    const startedAt = Date.now();

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();
    if (!silent) showToast("Loading toward marker...");

    while (
      runId === markerScrollToken
      && (restoreId === null || restoreId === restoreToken)
      && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS
    ) {
      found = findAnchorElement(saved);
      if (found) break;

      scrollEverywhere(0, "auto");
      await sleep(900);
      scrollEverywhere(0, "auto");
      await sleep(450);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });

      if (signature.top > 4) {
        stableRounds = 0;
        previousSignature = "";
      } else if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 4) break;
    }

    const stillActive = runId === markerScrollToken && (restoreId === null || restoreId === restoreToken);
    if (!stillActive) {
      return false;
    }

    if (found) {
      scrollElementIntoReadingView(found, "smooth");
      if (!silent) showToast("Jumped to marker.");
    } else {
      scrollToSavedPosition(saved, "smooth");
      if (!silent) showToast("Marker text not loaded; used saved position.");
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();

    return !!found;
  };

  const elementDocumentTop = (element) => {
    return Math.round((element?.getBoundingClientRect?.().top || 0) + currentScrollTop());
  };

  const messageRootFor = (element) => {
    return element.closest?.([
      "user-query",
      "[data-message-author-role='user']",
      "[data-test-id*='user']",
      "[data-testid*='user']",
      "[data-testid^='conversation-turn-']",
      "[class*='user-query']",
      "article",
      "[role='listitem']",
    ].join(",")) || element;
  };

  const hasAttachedImage = (element) => {
    if (!element) return false;
    return !!element.querySelector([
      "img",
      "picture",
      "canvas",
      "[data-test-id*='image']",
      "[data-testid*='image']",
      "[data-test-id*='attachment']",
      "[data-testid*='attachment']",
      "[aria-label*='图片']",
      "[aria-label*='图像']",
      "[aria-label*='image' i]",
      "[aria-label*='attachment' i]",
      "[role='img']",
    ].join(","));
  };

  const expandPromptRootForReading = (root) => {
    if (!root?.parentElement) return root;
    const rootText = normalizeText(root.innerText || root.textContent || "");
    const rootSnippet = rootText.slice(0, Math.min(120, Math.max(40, rootText.length)));
    const rootRect = root.getBoundingClientRect?.();
    let best = root;
    let current = root;

    for (let depth = 0; depth < 5; depth += 1) {
      const parent = current.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement || host.contains(parent)) break;

      const parentRect = parent.getBoundingClientRect?.();
      if (!parentRect || parentRect.height <= 0) break;

      const parentText = normalizeText(parent.innerText || parent.textContent || "");
      if (rootSnippet && !parentText.includes(rootSnippet)) break;

      const currentRect = current.getBoundingClientRect?.();
      const topGap = Math.max(0, (currentRect?.top || rootRect?.top || 0) - parentRect.top);
      const focusedText = !rootText || parentText.length <= Math.max(2800, rootText.length + 1600);
      const focusedHeight = parentRect.height <= Math.max(1400, (rootRect?.height || 0) + 1100);
      const className = String(parent.className || "");
      const usefulContainer = hasAttachedImage(parent)
        || parent.matches?.("article,[role='listitem']")
        || /user|query|message|turn|conversation/i.test(className);

      if (!usefulContainer || !focusedText || !focusedHeight || topGap > 700) break;

      best = parent;
      current = parent;
    }

    return best;
  };

  const pptPromptVariants = (prompt) => {
    const base = normalizeText(prompt || "请详细讲解这一面PPT");
    const variants = new Set([base]);
    for (const text of [...variants]) {
      variants.add(text.replace("这一面PPT", "这一页PPT"));
      variants.add(text.replace("这一页PPT", "这一面PPT"));
      variants.add(text.replace("这一面 PPT", "这一页 PPT"));
      variants.add(text.replace("这一页 PPT", "这一面 PPT"));
    }
    return [...variants].filter(Boolean);
  };

  const includesAnyPptPrompt = (text, promptTexts) => {
    return promptTexts.some((promptText) => promptText && text.includes(promptText));
  };

  const addPptPromptRoot = (roots, seen, element, promptTexts, options = {}) => {
    if (!element || host.contains(element)) return;
    const text = normalizeText(element.textContent || "");
    if (!options.includeAllUserTurns && !includesAnyPptPrompt(text, promptTexts)) return;
    if (text.length > 2600 && element.tagName.toLowerCase() !== "user-query") return;

    const root = expandPromptRootForReading(messageRootFor(element));
    if (!root || host.contains(root) || seen.has(root)) return;
    seen.add(root);
    roots.push(root);
  };

  const collectPromptRootsFromTextNodes = (roots, seen, promptTexts) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || host.contains(parent)) return NodeFilter.FILTER_REJECT;
        return includesAnyPptPrompt(normalizeText(node.nodeValue || ""), promptTexts)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    let count = 0;
    while (count < 80) {
      const node = walker.nextNode();
      if (!node) break;
      addPptPromptRoot(roots, seen, node.parentElement, promptTexts);
      count += 1;
    }
  };

  const collectPptPromptCandidates = (prompt) => {
    const promptTexts = pptPromptVariants(prompt);
    const selector = [
      "user-query",
      "[data-message-author-role='user']",
      "[data-test-id*='user']",
      "[data-testid*='user']",
      "[data-testid^='conversation-turn-'] [data-message-author-role='user']",
      "[class*='user-query']",
      "[class*='query-text']",
      "[class*='query-content']",
      "[aria-label*='用户']",
      "[aria-label*='User' i]",
    ].join(",");

    const roots = [];
    const seen = new Set();
    for (const element of document.querySelectorAll(selector)) {
      addPptPromptRoot(roots, seen, element, promptTexts, { includeAllUserTurns: true });
    }
    if (!roots.length) collectPromptRootsFromTextNodes(roots, seen, promptTexts);

    const scrollTop = currentScrollTop();
    const candidates = roots
      .map((root) => ({
        root,
        top: Math.round((root.getBoundingClientRect?.().top || 0) + scrollTop),
        text: normalizeText(root.innerText || root.textContent || ""),
        hasImage: hasAttachedImage(root),
      }))
      .filter((item) => item.text || item.hasImage)
      .sort((a, b) => a.top - b.top);

    const deduped = [];
    for (const candidate of candidates) {
      const duplicate = deduped.some((existing) => {
        return existing.root === candidate.root
          || existing.root.contains(candidate.root)
          || candidate.root.contains(existing.root)
          || Math.abs(existing.top - candidate.top) < 8;
      });
      if (!duplicate) deduped.push(candidate);
    }

    return deduped;
  };

  const visiblePptPosition = (prompt) => {
    const all = collectPptPromptCandidates(prompt);
    if (!all.length) return null;

    const image = all.filter((candidate) => candidate.hasImage);
    const anchor = currentScrollTop() + topOverlayInset() + Math.min(260, Math.max(120, window.innerHeight * 0.22));
    const prior = all.filter((candidate) => candidate.top <= anchor).pop();
    const candidate = prior || all
      .slice()
      .sort((a, b) => Math.abs(a.top - anchor) - Math.abs(b.top - anchor))[0];
    const promptIndex = all.findIndex((item) => item.root === candidate.root) + 1;
    const imagePromptIndex = image.findIndex((item) => item.root === candidate.root) + 1;

    return {
      candidate,
      promptIndex: promptIndex || null,
      imagePromptIndex: imagePromptIndex || null,
      promptCount: all.length,
      imagePromptCount: image.length,
    };
  };

  const sendGeminiVisiblePageToPdf = (position) => {
    if (!pdfDock || !position || !gemSyncPdfState.autoSyncEnabled) return;
    if (pdfDock.dataset.mode === "inline") {
      const deck = inlineDockDeck || {
        id: gemSyncPdfState.deckId,
        title: gemSyncPdfState.deckTitle,
        totalPages: gemSyncPdfState.totalPages,
        pagePrompt: gemSyncPdfState.pagePrompt,
        promptStartIndex: gemSyncPdfState.promptStartIndex,
        pagesPerPrompt: gemSyncPdfState.pagesPerPrompt,
        subjectId: gemSyncPdfState.subjectId,
        subjectTitle: gemSyncPdfState.subjectTitle,
        provider: gemSyncPdfState.provider,
      };
      const page = inlinePageFromPromptIndex(deck, position.promptIndex || position.imagePromptIndex);
      if (page) updateInlinePdfDock(deck, page, { silent: true });
      return;
    }
    const iframe = pdfDock.querySelector("iframe");
    if (!iframe?.contentWindow) return;

    iframe.contentWindow.postMessage({
      source: "gemsync-parent",
      type: "gemsync:gemini-visible-page",
      payload: {
        deckId: gemSyncPdfState.deckId || "",
        conversationId: getConversationId(),
        promptIndex: position.promptIndex,
        imagePromptIndex: position.imagePromptIndex,
        promptCount: position.promptCount,
        imagePromptCount: position.imagePromptCount,
      },
    }, new URL(iframe.src).origin);
  };

  const scheduleGeminiToPdfSync = () => {
    if (!pdfDock || !gemSyncPdfState.autoSyncEnabled) return;
    clearTimeout(gemSyncReverseTimer);
    gemSyncReverseTimer = setTimeout(() => {
      if (!pdfDock || !gemSyncPdfState.autoSyncEnabled) return;
      const position = visiblePptPosition(gemSyncPdfState.pagePrompt);
      if (!position) return;
      const signature = [
        gemSyncPdfState.deckId || "",
        getConversationId(),
        position.promptIndex || 0,
        position.imagePromptIndex || 0,
      ].join(":");
      if (signature === gemSyncLastReverseSignature) return;
      gemSyncLastReverseSignature = signature;
      sendGeminiVisiblePageToPdf(position);
    }, 420);
  };

  const selectPptCandidate = (payload, options = {}) => {
    const pageNumber = Math.max(1, Number(payload?.pageNumber) || 1);
    const binding = payload?.binding || null;
    const all = collectPptPromptCandidates(payload?.pagePrompt);
    const image = all.filter((candidate) => candidate.hasImage);
    const targetImagePromptIndex = Number(binding?.targetImagePromptIndex) || 0;
    const targetPromptIndex = Number(binding?.targetPromptIndex || binding?.promptIndex || payload?.targetPromptIndex) || 0;
    const allowAbsoluteFallback = options.allowAbsoluteFallback ?? true;

    if (!targetPromptIndex && payload?.hasPromptMapping === false) {
      return {
        candidate: null,
        all,
        image,
        mode: "unmapped",
        target: 0,
      };
    }

    if (targetImagePromptIndex > 0 && image.length >= targetImagePromptIndex) {
      return {
        candidate: image[targetImagePromptIndex - 1],
        all,
        image,
        mode: "calibrated-image",
        target: targetImagePromptIndex,
      };
    }

    if (targetPromptIndex > 0 && all.length >= targetPromptIndex) {
      return {
        candidate: all[targetPromptIndex - 1],
        all,
        image,
        mode: "calibrated",
        target: targetPromptIndex,
      };
    }

    if (allowAbsoluteFallback && targetPromptIndex > 0 && all.length >= targetPromptIndex) {
      return {
        candidate: all[targetPromptIndex - 1],
        all,
        image,
        mode: "all",
        target: targetPromptIndex,
      };
    }

    return {
      candidate: null,
      all,
      image,
      mode: image.length ? "image" : "all",
      target: Math.max(targetImagePromptIndex, targetPromptIndex, pageNumber),
    };
  };

  const findPptCandidateWithLoading = async (payload) => {
    const runId = ++markerScrollToken;
    let previousSignature = "";
    let stableRounds = 0;
    let attempts = 0;
    const startedAt = Date.now();
    const hasCalibratedIndex = !!(
      Number(payload?.binding?.targetImagePromptIndex)
      || Number(payload?.binding?.targetPromptIndex)
    );
    const isManualSync = payload?.reason !== "auto";

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();

    while (runId === markerScrollToken && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS) {
      const trustAbsolutePageNumber = hasCalibratedIndex
        || isManualSync
        || (attempts >= 18 && stableRounds >= 8)
        || Date.now() - startedAt > 55000;
      const result = selectPptCandidate(payload, {
        allowAbsoluteFallback: trustAbsolutePageNumber,
      });
      if (result.candidate) {
        restoreButton.classList.remove("busy");
        setButtonContent(restoreButton, "restore", "Restore");
        updateMarkButton();
        updateVisibility();
        return result;
      }

      if (attempts % 8 === 0) {
        const found = result.image.length || result.all.length;
        const target = result.target || payload?.pageNumber || 1;
        showToast(`Loading older Gemini messages... ${found}/${target}`);
      }

      await triggerOlderMessageLoad(attempts);
      attempts += 1;

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        top: signature.top,
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        allCount: result.all.length,
        imageCount2: result.image.length,
        text: signature.text,
      });

      if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }

      if (stableRounds >= 10) {
        await triggerOlderMessageLoad(attempts);
        stableRounds = 0;
        previousSignature = "";
      }
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();
    return selectPptCandidate(payload);
  };

  const scrollToBindingAnchor = async (binding, options = {}) => {
    if (!binding?.anchor) return false;

    let found = findAnchorElement({ anchor: binding.anchor });
    if (found) {
      scrollElementIntoReadingView(found, options.behavior || "auto", {
        preferMessageTop: !!options.preferMessageTop,
        forceAuto: options.behavior !== "smooth",
      });
      return true;
    }

    const runId = ++markerScrollToken;
    let stableRounds = 0;
    let previousSignature = "";
    const startedAt = Date.now();

    restoreButton.classList.add("busy");
    setButtonContent(restoreButton, "busy", "Busy");
    updateVisibility();

    while (runId === markerScrollToken && Date.now() - startedAt < MARKER_SCROLL_TIMEOUT_MS) {
      found = findAnchorElement({ anchor: binding.anchor });
      if (found) break;

      scrollEverywhere(0, "auto");
      await sleep(850);
      scrollEverywhere(0, "auto");
      await sleep(420);

      const signature = getDeepTopSignature();
      const signatureKey = JSON.stringify({
        top: signature.top,
        maxHeight: signature.maxHeight,
        nodeCount: signature.nodeCount,
        imageCount: signature.imageCount,
        text: signature.text,
      });
      if (signatureKey === previousSignature) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousSignature = signatureKey;
      }
      if (stableRounds >= 3) break;
    }

    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();

    if (found) {
      scrollElementIntoReadingView(found, options.behavior || "auto", {
        preferMessageTop: !!options.preferMessageTop,
        forceAuto: options.behavior !== "smooth",
      });
      return true;
    }

    return false;
  };

  const nearestPromptCandidate = (prompt) => {
    const all = collectPptPromptCandidates(prompt);
    const image = all.filter((candidate) => candidate.hasImage);
    if (!all.length) {
      return { all, image, candidate: null, promptIndex: null, imagePromptIndex: null };
    }

    const center = currentScrollTop() + window.innerHeight * 0.48;
    const prior = all.filter((candidate) => candidate.top <= center + 220).pop();
    const candidate = prior || all
      .slice()
      .sort((a, b) => Math.abs(a.top - center) - Math.abs(b.top - center))[0];

    return {
      all,
      image,
      candidate,
      promptIndex: all.findIndex((item) => item.root === candidate.root) + 1,
      imagePromptIndex: image.findIndex((item) => item.root === candidate.root) + 1 || null,
    };
  };

  const buildGemSyncBinding = (payload) => {
    const scroller = getPrimaryScroller();
    const promptInfo = nearestPromptCandidate(payload?.pagePrompt);
    return {
      top: Math.max(0, scroller.scrollTop || currentScrollTop()),
      anchor: getVisibleAnchor(),
      href: location.href,
      title: document.title,
      promptIndex: promptInfo.promptIndex,
      imagePromptIndex: promptInfo.imagePromptIndex,
      promptCount: promptInfo.all.length,
      imagePromptCount: promptInfo.image.length,
      promptSnippet: promptInfo.candidate?.text?.slice(0, 220) || "",
      savedAt: new Date().toISOString(),
    };
  };

  const handleGemSyncBind = async (payload) => {
    const binding = buildGemSyncBinding(payload);
    showToast(`Page ${payload?.pageNumber || ""} calibrated.`);
    return { ok: true, binding };
  };

  const handleGemSyncPage = async (payload) => {
    const pageNumber = Math.max(1, Number(payload?.pageNumber) || 1);
    const binding = payload?.binding || null;
    const deep = !!payload?.deep;
    showToast(deep ? `Deep syncing PDF page ${pageNumber}...` : `Syncing PDF page ${pageNumber}...`);

    if (binding?.pageOffset === 0 && binding.anchor) {
      const loadedAnchor = findAnchorElement({ anchor: binding.anchor });
      if (loadedAnchor) {
        scrollElementIntoReadingView(loadedAnchor, "auto", { preferMessageTop: true });
        showToast(`Page ${pageNumber}: calibrated position.`);
        return { ok: true, usedBinding: true };
      }

      const anchored = deep
        ? await scrollToBindingAnchor(binding, { behavior: "auto", preferMessageTop: true })
        : false;
      if (anchored) {
        showToast(`Page ${pageNumber}: calibrated position.`);
        return { ok: true, usedBinding: true };
      }
    }

    if (binding?.pageOffset === 0 && binding?.top && !binding?.targetPromptIndex && !binding?.targetImagePromptIndex) {
      scrollToSavedPosition(binding, "auto");
      showToast(`Page ${pageNumber}: saved position.`);
      return { ok: true, usedBinding: true };
    }

    const result = deep
      ? await findPptCandidateWithLoading(payload)
      : selectPptCandidate(payload, { allowAbsoluteFallback: true });
    if (!result.candidate) {
      showToast(`Only found ${result.image.length || result.all.length} PPT prompts. Calibrate this page.`);
      return {
        ok: false,
        error: deep
          ? `Gemini 里只找到 ${result.image.length || result.all.length} 条 PPT 提问。可能有漏发页，请在这一页点“校准本页”。`
          : `当前已加载的 Gemini 聊天里没找到第 ${pageNumber} 页。可以先点“深度同步”，找到后再点“校准本页”。`,
        foundPrompts: result.all.length,
        foundImagePrompts: result.image.length,
      };
    }

    scrollElementIntoReadingView(result.candidate.root, "auto", { preferMessageTop: true });
    const promptIndex = result.all.findIndex((item) => item.root === result.candidate.root) + 1;
    const imagePromptIndex = result.image.findIndex((item) => item.root === result.candidate.root) + 1;
    showToast(`Page ${pageNumber}: Gemini synced.`);
    return {
      ok: true,
      usedBinding: result.mode.startsWith("calibrated"),
      mode: result.mode,
      foundPrompts: result.all.length,
      foundImagePrompts: result.image.length,
      promptIndex: promptIndex || null,
      imagePromptIndex: imagePromptIndex || null,
      target: result.target,
    };
  };

  let pdfDock = null;
  let pdfDockStyle = null;

  const ensurePdfDockStyle = () => {
    if (pdfDockStyle) return;
    pdfDockStyle = document.createElement("style");
    pdfDockStyle.id = `${HOST_ID}-pdf-style`;
    pdfDockStyle.textContent = `
      html.${HOST_ID}-pdf-open {
        --gemsync-pdf-width: 50vw;
        overflow-x: hidden !important;
      }

      html.${HOST_ID}-pdf-open body {
        width: calc(100vw - var(--gemsync-pdf-width)) !important;
        min-width: 0 !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
        margin-right: var(--gemsync-pdf-width) !important;
        overflow-x: hidden !important;
      }

      html.${HOST_ID}-pdf-open body > div,
      html.${HOST_ID}-pdf-open body > div:first-child,
      html.${HOST_ID}-pdf-open #__next,
      html.${HOST_ID}-pdf-open #root,
      html.${HOST_ID}-pdf-open main,
      html.${HOST_ID}-pdf-open [role="main"] {
        width: auto !important;
        right: var(--gemsync-pdf-width) !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
      }

      html.${HOST_ID}-pdf-open body :where(main, [role="main"], #thread, .composer-parent, [data-testid*="conversation"]) {
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
      }

      html.${HOST_ID}-pdf-open body :where([class~="inset-0"], [class~="right-0"]) {
        right: var(--gemsync-pdf-width) !important;
        width: auto !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
      }

      html.${HOST_ID}-pdf-open #thread-bottom-container,
      html.${HOST_ID}-pdf-open [data-testid="composer"],
      html.${HOST_ID}-pdf-open [class~="w-screen"],
      html.${HOST_ID}-pdf-open [class~="min-w-screen"] {
        width: calc(100vw - var(--gemsync-pdf-width)) !important;
        min-width: 0 !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
      }

      html.${HOST_ID}-pdf-open #thread-bottom-container,
      html.${HOST_ID}-pdf-open [class~="bottom-0"][class~="fixed"],
      html.${HOST_ID}-pdf-open [class~="fixed"][class~="bottom-0"] {
        right: var(--gemsync-pdf-width) !important;
        max-width: calc(100vw - var(--gemsync-pdf-width)) !important;
      }

      #${HOST_ID}-pdf-dock {
        position: fixed;
        inset: 0 0 0 auto;
        width: var(--gemsync-pdf-width);
        height: 100vh;
        z-index: 2147483000;
        display: grid;
        grid-template-rows: 42px minmax(0, 1fr);
        border-left: 1px solid rgba(148, 163, 184, 0.32);
        background: rgba(246, 248, 251, 0.82);
        box-shadow: -18px 0 42px rgba(15, 23, 42, 0.2);
        font-family: Google Sans, Roboto, Arial, sans-serif;
        -webkit-backdrop-filter: blur(18px) saturate(1.12);
        backdrop-filter: blur(18px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 6px 8px 6px 12px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.26);
        background: rgba(255, 255, 255, 0.66);
        color: #1e293b;
        -webkit-backdrop-filter: blur(16px) saturate(1.12);
        backdrop-filter: blur(16px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 700;
      }

      #${HOST_ID}-pdf-dock .gemsync-dock-spacer {
        flex: 1;
      }

      #${HOST_ID}-pdf-dock button {
        height: 30px;
        min-width: 42px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.68);
        color: #1e293b;
        cursor: pointer;
        font: 700 13px Google Sans, Roboto, Arial, sans-serif;
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
        transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        -webkit-backdrop-filter: blur(14px) saturate(1.12);
        backdrop-filter: blur(14px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock button:hover,
      #${HOST_ID}-pdf-dock button:focus-visible {
        border-color: rgba(100, 116, 139, 0.36);
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.78);
        transform: translateY(-1px);
        outline: none;
      }

      #${HOST_ID}-pdf-dock button:active {
        transform: translateY(0) scale(0.98);
        box-shadow: 0 2px 7px rgba(15, 23, 42, 0.12), inset 0 1px 3px rgba(15, 23, 42, 0.12);
      }

      #${HOST_ID}-pdf-dock iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: transparent;
      }

      #${HOST_ID}-pdf-dock[data-mode="inline"] {
        grid-template-rows: minmax(0, 1fr);
        background: linear-gradient(180deg, #f8fbff 0%, #eef3f8 100%);
        font: 14px/1.45 "Microsoft YaHei", "Segoe UI", Arial, sans-serif;
      }

      #${HOST_ID}-pdf-dock[data-mode="inline"] .gemsync-dock-bar {
        display: none;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-panel {
        --gemsync-inline-bg: #eef3f8;
        --gemsync-inline-panel: rgba(255, 255, 255, 0.72);
        --gemsync-inline-ink: #172033;
        --gemsync-inline-muted: #66758a;
        --gemsync-inline-line: rgba(148, 163, 184, 0.28);
        --gemsync-inline-line-strong: rgba(100, 116, 139, 0.36);
        --gemsync-inline-blue: #2563eb;
        --gemsync-inline-blue-dark: #1d4ed8;
        --gemsync-inline-green: #16833a;
        --gemsync-inline-shadow: 0 20px 50px rgba(15, 23, 42, 0.13);
        box-sizing: border-box;
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        gap: 10px;
        padding: 10px 12px 0;
        background: linear-gradient(180deg, #f8fbff 0%, var(--gemsync-inline-bg) 100%);
        color: var(--gemsync-inline-ink);
        overflow: hidden;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-panel *,
      #${HOST_ID}-pdf-dock .gemsync-inline-panel *::before,
      #${HOST_ID}-pdf-dock .gemsync-inline-panel *::after {
        box-sizing: border-box;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-top {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-actions {
        display: grid;
        grid-template-columns: minmax(160px, 1fr) auto auto auto auto auto;
        gap: 10px;
        align-items: center;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-select,
      #${HOST_ID}-pdf-dock .gemsync-inline-page-input,
      #${HOST_ID}-pdf-dock .gemsync-inline-panel button {
        height: 36px;
        border: 1px solid var(--gemsync-inline-line);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.68);
        color: var(--gemsync-inline-ink);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
        font: inherit;
        -webkit-backdrop-filter: blur(14px) saturate(1.12);
        backdrop-filter: blur(14px) saturate(1.12);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-select {
        width: 100%;
        min-width: 0;
        padding: 0 12px;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-panel button {
        min-width: 36px;
        padding: 0 12px;
        cursor: pointer;
        font-weight: 650;
        transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease, transform 150ms ease;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-panel button:hover,
      #${HOST_ID}-pdf-dock .gemsync-inline-panel button:focus-visible {
        border-color: var(--gemsync-inline-line-strong);
        background: rgba(255, 255, 255, 0.86);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.78);
        transform: translateY(-1px);
        outline: none;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-panel button:active {
        transform: translateY(0) scale(0.98);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-primary {
        border-color: rgba(37, 99, 235, 0.55) !important;
        background: rgba(37, 99, 235, 0.9) !important;
        color: #fff !important;
        box-shadow: 0 10px 22px rgba(37, 99, 235, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.22) !important;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-pager {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: max-content;
        padding: 3px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 13px;
        background: rgba(255, 255, 255, 0.46);
        -webkit-backdrop-filter: blur(12px) saturate(1.08);
        backdrop-filter: blur(12px) saturate(1.08);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-pager button {
        width: 34px;
        height: 30px;
        padding: 0;
        border-radius: 10px;
        font-size: 23px;
        line-height: 1;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-page-input {
        width: 64px;
        height: 30px;
        padding: 0 8px;
        text-align: center;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-total {
        color: var(--gemsync-inline-muted);
        white-space: nowrap;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-switch {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        height: 36px;
        padding: 0 11px;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.52);
        color: var(--gemsync-inline-ink);
        white-space: nowrap;
        user-select: none;
        -webkit-backdrop-filter: blur(12px) saturate(1.08);
        backdrop-filter: blur(12px) saturate(1.08);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-switch input {
        width: 17px;
        height: 17px;
        accent-color: var(--gemsync-inline-blue);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-status {
        overflow: hidden;
        padding: 8px 11px;
        border: 1px solid rgba(22, 131, 58, 0.35);
        border-radius: 10px;
        background: rgba(236, 253, 245, 0.78);
        color: var(--gemsync-inline-green);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
        font-size: 14px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
        -webkit-backdrop-filter: blur(14px) saturate(1.1);
        backdrop-filter: blur(14px) saturate(1.1);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-layout {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr);
        margin: 0 -12px;
        border-top: 1px solid rgba(148, 163, 184, 0.24);
        overflow: hidden;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-rail {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 7px;
        overflow: auto;
        padding: 10px 8px 18px;
        border-right: 1px solid rgba(148, 163, 184, 0.24);
        background: rgba(241, 245, 249, 0.72);
        -webkit-backdrop-filter: blur(16px) saturate(1.08);
        backdrop-filter: blur(16px) saturate(1.08);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-rail button {
        width: 100%;
        min-width: 0;
        height: 34px;
        margin: 0;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 10px;
        background: transparent;
        color: var(--gemsync-inline-muted);
        box-shadow: none;
        font-size: 13px;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-rail button.active {
        border-color: rgba(37, 99, 235, 0.34);
        background: rgba(219, 234, 254, 0.78);
        color: var(--gemsync-inline-blue-dark);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.68);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-viewer {
        min-width: 0;
        min-height: 0;
        overflow-x: hidden;
        overflow-y: auto;
        padding: 14px 14px 42px;
        background: linear-gradient(180deg, rgba(241, 245, 249, 0.72), rgba(226, 232, 240, 0.78));
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-pages {
        display: grid;
        gap: 18px;
        max-width: 100%;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-page-label {
        margin: 0 0 8px;
        color: var(--gemsync-inline-muted);
        font-size: 13px;
        font-weight: 700;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-page {
        scroll-margin-top: 12px;
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-page.active .gemsync-inline-page-label {
        color: var(--gemsync-inline-blue-dark);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-page img {
        box-sizing: border-box;
        width: 100%;
        max-width: 100%;
        height: auto;
        display: block;
        background: #fff;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 10px;
        box-shadow: var(--gemsync-inline-shadow);
      }

      #${HOST_ID}-pdf-dock .gemsync-inline-empty {
        margin: 20px;
        padding: 12px 14px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.8);
        color: #475569;
        font: 700 13px Google Sans, Roboto, Arial, sans-serif;
      }
    `;
    document.documentElement.append(pdfDockStyle);
  };

  const geminiConversationIdFromUrl = conversationIdFromUrl;

  const getGemSyncDeck = async (preferredDeckId = "", preferredSubjectId = "") => {
    const conversationId = getConversationId();
    const provider = currentProvider();
    try {
      const configs = await getGemSyncConfigs();
      for (const { subject, config } of configs) {
        if (preferredSubjectId && subject.id !== preferredSubjectId) continue;
        const deck = (config.decks || []).find((item) => item.id === preferredDeckId)
          || (config.decks || []).find((item) => item.conversationId === conversationId);
        if (deck) {
          return {
            ...deck,
            provider: deck.provider || config.provider || "gemini",
            pagePrompt: deck.pagePrompt || config.pagePrompt || "",
            prePrompt: deck.prePrompt || config.prePrompt || "",
            promptStartIndex: deck.promptStartIndex || config.promptStartIndex || 0,
            pagesPerPrompt: deck.pagesPerPrompt || config.pagesPerPrompt || 1,
            subjectId: subject.id,
            subjectTitle: subject.title,
          };
        }
      }
      const first = configs.find(({ config }) => (config.provider || "gemini") === provider)
        || configs.find(({ config }) => (config.decks || []).some((deck) => (deck.provider || config.provider || "gemini") === provider))
        || configs[0];
      const deck = first?.config?.decks?.[0];
      return deck
        ? {
            ...deck,
            provider: deck.provider || first.config.provider || "gemini",
            pagePrompt: deck.pagePrompt || first.config.pagePrompt || "",
            prePrompt: deck.prePrompt || first.config.prePrompt || "",
            promptStartIndex: deck.promptStartIndex || first.config.promptStartIndex || 0,
            pagesPerPrompt: deck.pagesPerPrompt || first.config.pagesPerPrompt || 1,
            subjectId: first.subject.id,
            subjectTitle: first.subject.title,
          }
        : { id: "deck01", title: "PDF" };
    } catch (error) {
      showToast("PDF config not available.");
      return { id: "deck01", title: "PDF" };
    }
  };

  const getGemSyncDeckForCurrentChat = async () => getGemSyncDeck("");

  const setPdfDockOpen = (open) => {
    document.documentElement.classList.toggle(`${HOST_ID}-pdf-open`, open);
    host.classList.toggle("pdf-open", open);
    pdfDockButton.classList.toggle("marked", open);
    pdfDockButton.title = open ? "Close PDF study panel" : "Open PDF study panel";
    if (open) {
      host.style.right = "calc(50vw - 1px)";
    } else {
      host.style.right = "";
    }
    window.dispatchEvent(new Event("resize"));
  };

  const closePdfDock = () => {
    pdfDock?.remove();
    pdfDock = null;
    inlineDockDeck = null;
    setPdfDockOpen(false);
  };

  const pdfDockUrlFor = (deck, page = 1) => {
    return getGemSyncPanelUrl({ subjectId: deck?.subjectId || "", deckId: deck?.id || "deck01", page });
  };

  let inlineDockDeck = null;

  const clampInlinePage = (deck, page) => {
    const total = Math.max(1, Number(deck?.totalPages) || 1);
    return Math.max(1, Math.min(total, Math.floor(Number(page) || 1)));
  };

  const inlineScreenshotUrl = (deck, page) => {
    const subjectId = deck?.subjectId || "";
    const deckId = deck?.id || "deck01";
    const pageId = String(clampInlinePage(deck, page)).padStart(3, "0");
    return getExtensionUrl(`pdf-panel/subjects/${subjectId}/screenshots/${deckId}/${deckId}_slide${pageId}.png`);
  };

  const inlinePromptStartIndex = (deck) => {
    const configured = Number(deck?.promptStartIndex || 0);
    if (Number.isFinite(configured) && configured > 1) return Math.floor(configured);
    return String(deck?.prePrompt || "").trim() ? 2 : 1;
  };

  const inlinePagesPerPrompt = (deck) => {
    const configured = Number(deck?.pagesPerPrompt || 1);
    if (!Number.isFinite(configured)) return 1;
    return Math.max(1, Math.min(3, Math.floor(configured)));
  };

  const inlinePromptIndexForPage = (deck, page) => {
    const offset = Math.floor((clampInlinePage(deck, page) - 1) / inlinePagesPerPrompt(deck));
    return inlinePromptStartIndex(deck) + offset;
  };

  const inlinePageFromPromptIndex = (deck, promptIndex) => {
    const index = Number(promptIndex) || 0;
    if (!index) return null;
    const offset = index - inlinePromptStartIndex(deck);
    if (offset < 0) return 1;
    return clampInlinePage(deck, (offset * inlinePagesPerPrompt(deck)) + 1);
  };

  const inlineSyncPayload = (deck, page, reason = "manual") => {
    const pageNumber = clampInlinePage(deck, page);
    return {
      subjectId: deck?.subjectId || "",
      subjectTitle: deck?.subjectTitle || "",
      deckId: deck?.id || "",
      deckTitle: deck?.title || "",
      conversationId: deck?.conversationId || "",
      geminiUrl: deck?.geminiUrl || "",
      chatgptUrl: deck?.chatgptUrl || "",
      provider: deck?.provider || currentProvider(),
      pagePrompt: deck?.pagePrompt || "",
      promptStartIndex: inlinePromptStartIndex(deck),
      pagesPerPrompt: inlinePagesPerPrompt(deck),
      targetPromptIndex: inlinePromptIndexForPage(deck, pageNumber),
      hasPromptMapping: true,
      pageNumber,
      totalPages: Math.max(1, Number(deck?.totalPages) || 1),
      reason,
      deep: false,
      binding: null,
    };
  };

  const configureInlinePdfState = (deck) => {
    const autoSync = pdfDock?.querySelector(".gemsync-inline-auto-sync");
    gemSyncPdfState = {
      ...gemSyncPdfState,
      ...inlineSyncPayload(deck, Number(pdfDock?.dataset.page) || 1, "inline"),
      autoSyncEnabled: autoSync ? autoSync.checked : true,
    };
  };

  const updateInlineRail = (panel, deck, page) => {
    const rail = panel.querySelector(".gemsync-inline-rail");
    if (!rail) return;
    const total = Math.max(1, Number(deck?.totalPages) || 1);
    if (rail.dataset.deckId !== (deck?.id || "") || Number(rail.dataset.total) !== total) {
      rail.replaceChildren();
      rail.dataset.deckId = deck?.id || "";
      rail.dataset.total = String(total);
      for (let itemPage = 1; itemPage <= total; itemPage += 1) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = String(itemPage);
        button.title = `Page ${itemPage}`;
        button.addEventListener("click", () => {
          updateInlinePdfDock(deck, itemPage);
          const shouldSync = panel.querySelector(".gemsync-inline-auto-sync")?.checked ?? true;
          if (shouldSync) {
            syncInlinePageToChat(deck, itemPage, "click").catch((error) => {
              showToast(error.message);
            });
          }
        });
        rail.append(button);
      }
    }
    for (const button of rail.querySelectorAll("button")) {
      const isActive = Number(button.textContent) === page;
      button.classList.toggle("active", isActive);
      if (isActive) {
        button.scrollIntoView({ block: "nearest" });
      }
    }
  };

  const setInlineStatus = (panel, text) => {
    const status = panel.querySelector(".gemsync-inline-status");
    if (status) status.textContent = text;
  };

  const updateInlineControls = (panel, deck, page) => {
    const total = Math.max(1, Number(deck?.totalPages) || 1);
    const subjectSelect = panel.querySelector(".gemsync-inline-subject");
    const deckSelect = panel.querySelector(".gemsync-inline-deck");
    const pageInput = panel.querySelector(".gemsync-inline-page-input");
    const totalText = panel.querySelector(".gemsync-inline-total-count");

    if (subjectSelect && subjectSelect.dataset.value !== (deck?.subjectId || "")) {
      subjectSelect.replaceChildren();
      const option = document.createElement("option");
      option.value = deck?.subjectId || "";
      option.textContent = deck?.subjectTitle || "ChatGPT";
      subjectSelect.append(option);
      subjectSelect.dataset.value = deck?.subjectId || "";
    }
    if (deckSelect && deckSelect.dataset.value !== (deck?.id || "")) {
      deckSelect.replaceChildren();
      const option = document.createElement("option");
      option.value = deck?.id || "";
      option.textContent = deck?.title || "PDF";
      deckSelect.append(option);
      deckSelect.dataset.value = deck?.id || "";
    }
    if (pageInput) {
      pageInput.max = String(total);
      pageInput.value = String(page);
    }
    if (totalText) totalText.textContent = String(total);
    setInlineStatus(panel, `ChatGPT -> PDF 第 ${page} 页`);
  };

  const buildInlinePages = (panel, deck) => {
    const pages = panel.querySelector(".gemsync-inline-pages");
    if (!pages) return;
    const deckId = deck?.id || "";
    const total = Math.max(1, Number(deck?.totalPages) || 1);
    if (pages.dataset.deckId === deckId && Number(pages.dataset.total) === total) return;

    pages.replaceChildren();
    pages.dataset.deckId = deckId;
    pages.dataset.total = String(total);
    for (let itemPage = 1; itemPage <= total; itemPage += 1) {
      const pageShell = document.createElement("article");
      pageShell.className = "gemsync-inline-page";
      pageShell.dataset.page = String(itemPage);

      const label = document.createElement("div");
      label.className = "gemsync-inline-page-label";
      label.textContent = `第 ${itemPage} 页`;

      const image = document.createElement("img");
      image.alt = `${deck?.title || "PDF"} page ${itemPage}`;
      image.decoding = "async";
      image.loading = itemPage <= 3 ? "eager" : "lazy";
      image.src = inlineScreenshotUrl(deck, itemPage);
      image.addEventListener("error", () => {
        image.hidden = true;
        label.textContent = `第 ${itemPage} 页：图片不可用`;
      });

      pageShell.append(label, image);
      pages.append(pageShell);
    }
  };

  const scrollInlineViewerToPage = (panel, page, smooth = false) => {
    const viewer = panel.querySelector(".gemsync-inline-viewer");
    const target = panel.querySelector(`.gemsync-inline-page[data-page="${page}"]`);
    if (!viewer || !target) return;
    requestAnimationFrame(() => {
      viewer.scrollTo({
        top: Math.max(0, target.offsetTop - viewer.offsetTop - 8),
        behavior: smooth ? "smooth" : "auto",
      });
    });
  };

  const syncInlinePageToChat = async (deck, page, action = "sync") => {
    const payload = inlineSyncPayload(deck, page, `inline-${action}`);
    try {
      if (action === "bind") {
        const result = await handleGemSyncBind(payload);
        if (result?.ok) showToast(`Page ${page}: calibrated.`);
        return;
      }
      const result = await handleGemSyncPage({ ...payload, deep: action === "deep" });
      if (result?.ok) showToast(`Page ${page}: synced.`);
    } catch (error) {
      showToast(error.message);
    }
  };

  const updateInlinePdfDock = (deck, page = 1, options = {}) => {
    const panel = pdfDock?.querySelector(".gemsync-inline-panel");
    if (!panel) return;
    inlineDockDeck = deck;
    const pageNumber = clampInlinePage(deck, page);
    pdfDock.dataset.page = String(pageNumber);
    configureInlinePdfState(deck);

    buildInlinePages(panel, deck);
    updateInlineControls(panel, deck, pageNumber);
    updateInlineRail(panel, deck, pageNumber);
    for (const pageShell of panel.querySelectorAll(".gemsync-inline-page")) {
      pageShell.classList.toggle("active", Number(pageShell.dataset.page) === pageNumber);
    }
    scrollInlineViewerToPage(panel, pageNumber, options.smooth);
    if (!options.silent) showToast(`PDF page ${pageNumber}.`);
  };

  const updateInlineCurrentPageOnly = (panel, deck, page) => {
    if (!pdfDock) return;
    inlineDockDeck = deck;
    const pageNumber = clampInlinePage(deck, page);
    if (Number(pdfDock.dataset.page) === pageNumber) return;
    pdfDock.dataset.page = String(pageNumber);
    configureInlinePdfState(deck);
    updateInlineControls(panel, deck, pageNumber);
    updateInlineRail(panel, deck, pageNumber);
    for (const pageShell of panel.querySelectorAll(".gemsync-inline-page")) {
      pageShell.classList.toggle("active", Number(pageShell.dataset.page) === pageNumber);
    }
  };

  const createInlinePdfPanel = (deck, page = 1) => {
    const panel = document.createElement("div");
    panel.className = "gemsync-inline-panel";

    const top = document.createElement("div");
    top.className = "gemsync-inline-top";

    const subjectSelect = document.createElement("select");
    subjectSelect.className = "gemsync-inline-select gemsync-inline-subject";
    subjectSelect.setAttribute("aria-label", "选择学科");

    const deckSelect = document.createElement("select");
    deckSelect.className = "gemsync-inline-select gemsync-inline-deck";
    deckSelect.setAttribute("aria-label", "选择章节");

    top.append(subjectSelect, deckSelect);

    const actions = document.createElement("div");
    actions.className = "gemsync-inline-actions";

    const pager = document.createElement("div");
    pager.className = "gemsync-inline-pager";
    pager.setAttribute("aria-label", "页码控制");

    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "‹";
    prev.title = "上一页";

    const pageInput = document.createElement("input");
    pageInput.className = "gemsync-inline-page-input";
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.value = String(clampInlinePage(deck, page));
    pageInput.setAttribute("aria-label", "当前页");

    const total = document.createElement("span");
    total.className = "gemsync-inline-total";
    total.append(" / ");
    const totalCount = document.createElement("span");
    totalCount.className = "gemsync-inline-total-count";
    total.append(totalCount);

    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "›";
    next.title = "下一页";

    pager.append(prev, pageInput, total, next);

    const autoLabel = document.createElement("label");
    autoLabel.className = "gemsync-inline-switch";
    const autoInput = document.createElement("input");
    autoInput.className = "gemsync-inline-auto-sync";
    autoInput.type = "checkbox";
    autoInput.checked = true;
    const autoText = document.createElement("span");
    autoText.textContent = "自动同步";
    autoLabel.append(autoInput, autoText);

    const sync = document.createElement("button");
    sync.type = "button";
    sync.className = "gemsync-inline-primary";
    sync.textContent = "同步本页";

    const deep = document.createElement("button");
    deep.type = "button";
    deep.textContent = "深度同步";

    const bind = document.createElement("button");
    bind.type = "button";
    bind.textContent = "校准本页";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "关闭面板";

    actions.append(pager, autoLabel, sync, deep, bind, close);

    const status = document.createElement("div");
    status.className = "gemsync-inline-status";

    const layout = document.createElement("div");
    layout.className = "gemsync-inline-layout";

    const rail = document.createElement("nav");
    rail.className = "gemsync-inline-rail";
    rail.setAttribute("aria-label", "PDF pages");

    const viewer = document.createElement("section");
    viewer.className = "gemsync-inline-viewer";
    viewer.setAttribute("aria-label", "PPT page");

    const pages = document.createElement("div");
    pages.className = "gemsync-inline-pages";

    viewer.append(pages);
    layout.append(rail, viewer);
    panel.append(top, actions, status, layout);

    const currentPage = () => clampInlinePage(inlineDockDeck || deck, Number(pdfDock?.dataset.page) || pageInput.value || page);
    const currentPageFromViewer = () => {
      const activeDeck = inlineDockDeck || deck;
      const threshold = viewer.scrollTop + 42;
      let selected = 1;
      for (const pageShell of panel.querySelectorAll(".gemsync-inline-page")) {
        const pageTop = Math.max(0, pageShell.offsetTop - viewer.offsetTop);
        if (pageTop <= threshold) {
          selected = Number(pageShell.dataset.page) || selected;
        } else {
          break;
        }
      }
      return clampInlinePage(activeDeck, selected);
    };
    const go = (nextPage, smooth = true) => {
      const activeDeck = inlineDockDeck || deck;
      updateInlinePdfDock(activeDeck, nextPage, { smooth });
      if (autoInput.checked) {
        syncInlinePageToChat(activeDeck, nextPage).catch((error) => showToast(error.message));
      }
    };

    prev.addEventListener("click", () => go(currentPage() - 1));
    next.addEventListener("click", () => go(currentPage() + 1));
    pageInput.addEventListener("change", () => go(Number(pageInput.value) || 1));
    pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        go(Number(pageInput.value) || 1);
      }
    });
    let viewerRaf = 0;
    let viewerSyncTimer = 0;
    viewer.addEventListener("scroll", () => {
      cancelAnimationFrame(viewerRaf);
      viewerRaf = requestAnimationFrame(() => {
        const activeDeck = inlineDockDeck || deck;
        const nextPage = currentPageFromViewer();
        if (nextPage === currentPage()) return;
        updateInlineCurrentPageOnly(panel, activeDeck, nextPage);
        clearTimeout(viewerSyncTimer);
        if (autoInput.checked) {
          viewerSyncTimer = setTimeout(() => {
            syncInlinePageToChat(activeDeck, nextPage, "auto").catch((error) => showToast(error.message));
          }, 650);
        }
      });
    }, { passive: true });
    autoInput.addEventListener("change", () => {
      configureInlinePdfState(inlineDockDeck || deck);
      setInlineStatus(panel, autoInput.checked
        ? `ChatGPT -> PDF 第 ${currentPage()} 页`
        : `自动同步已关闭，第 ${currentPage()} 页`);
    });
    sync.addEventListener("click", () => {
      const activeDeck = inlineDockDeck || deck;
      syncInlinePageToChat(activeDeck, currentPage()).catch((error) => showToast(error.message));
    });
    deep.addEventListener("click", () => {
      const activeDeck = inlineDockDeck || deck;
      syncInlinePageToChat(activeDeck, currentPage(), "deep").catch((error) => showToast(error.message));
    });
    bind.addEventListener("click", () => {
      const activeDeck = inlineDockDeck || deck;
      syncInlinePageToChat(activeDeck, currentPage(), "bind").catch((error) => showToast(error.message));
    });
    close.addEventListener("click", closePdfDock);

    setTimeout(() => updateInlinePdfDock(deck, page, { silent: true }), 0);
    return panel;
  };

  const updatePdfDockDeck = (deck, page = 1) => {
    if (!pdfDock) return;
    const title = pdfDock.querySelector(".gemsync-dock-title");
    const iframe = pdfDock.querySelector("iframe");
    if (title) {
      title.textContent = deck?.title ? `PDF: ${deck.title}` : "PDF";
    }
    if (pdfDock.dataset.mode === "inline") {
      updateInlinePdfDock(deck, page, { silent: true });
      return;
    }
    if (iframe) {
      const panelUrl = pdfDockUrlFor(deck, page);
      if (!panelUrl) {
        showToast("PDF 面板地址不可用。请刷新页面，或重载 DeckSync 插件。");
        return;
      }
      iframe.src = panelUrl;
    }
  };

  const openPdfDock = async (options = {}) => {
    const deck = await getGemSyncDeck(options.deckId || "", options.subjectId || "");
    const page = Math.max(1, Number(options.page) || 1);
    const useInlinePanel = (deck?.provider || currentProvider()) === "chatgpt";
    const panelUrl = useInlinePanel ? inlineScreenshotUrl(deck, page) : pdfDockUrlFor(deck, page);
    if (!panelUrl) {
      showToast("PDF 面板地址不可用。请刷新页面，或重载 DeckSync 插件。");
      return;
    }

    if (pdfDock) {
      if ((pdfDock.dataset.mode === "inline") === useInlinePanel) {
        updatePdfDockDeck(deck, page);
        setPdfDockOpen(true);
        return;
      }
      closePdfDock();
    }

    ensurePdfDockStyle();
    const dock = document.createElement("section");
    dock.id = `${HOST_ID}-pdf-dock`;
    dock.setAttribute("aria-label", "DeckSync PDF study panel");

    const bar = document.createElement("div");
    bar.className = "gemsync-dock-bar";

    const title = document.createElement("div");
    title.className = "gemsync-dock-title";
    title.textContent = deck.title ? `PDF: ${deck.title}` : "PDF";

    const spacer = document.createElement("div");
    spacer.className = "gemsync-dock-spacer";

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "刷新";
    refresh.title = "Reload PDF panel";

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close PDF panel";

    refresh.addEventListener("click", () => {
      if (pdfDock?.dataset.mode === "inline") {
        updateInlinePdfDock(inlineDockDeck || deck, Number(pdfDock?.dataset.page) || page);
        return;
      }
      const iframe = pdfDock?.querySelector("iframe");
      if (iframe) iframe.src = iframe.src;
    });
    close.addEventListener("click", closePdfDock);

    if (useInlinePanel) {
      dock.dataset.mode = "inline";
      dock.dataset.page = String(clampInlinePage(deck, page));
      dock.append(createInlinePdfPanel(deck, page));
    } else {
      bar.append(title, spacer, refresh, close);
      dock.dataset.mode = "frame";
      const iframe = document.createElement("iframe");
      iframe.src = panelUrl;
      iframe.title = "DeckSync PDF";
      dock.append(bar, iframe);
    }
    document.documentElement.append(dock);
    pdfDock = dock;
    if (useInlinePanel) updateInlinePdfDock(deck, page, { silent: true });
    setPdfDockOpen(true);
    showToast("PDF panel opened.");
  };

  const rememberPendingPdfDock = (payload) => {
    const targetUrl = payload?.geminiUrl || payload?.chatgptUrl || "";
    const conversationId = payload?.conversationId || geminiConversationIdFromUrl(targetUrl);
    try {
      localStorage.setItem(GEMSYNC_PENDING_DOCK_KEY, JSON.stringify({
        subjectId: payload?.subjectId || "",
        deckId: payload?.deckId || "",
        page: Math.max(1, Number(payload?.pageNumber) || 1),
        conversationId,
        savedAt: Date.now(),
        expiresAt: Date.now() + 90000,
      }));
    } catch {
      // The dock can still be opened manually if storage is unavailable.
    }
  };

  const restorePendingPdfDock = async () => {
    const pending = readLocalJson(GEMSYNC_PENDING_DOCK_KEY);
    if (!pending) return false;

    if (Number(pending.expiresAt) && Date.now() > Number(pending.expiresAt)) {
      localStorage.removeItem(GEMSYNC_PENDING_DOCK_KEY);
      return false;
    }

    const targetConversationId = pending.conversationId || "";
    const currentConversationId = getConversationId();
    if (targetConversationId && currentConversationId !== targetConversationId) {
      return false;
    }

    localStorage.removeItem(GEMSYNC_PENDING_DOCK_KEY);
    await openPdfDock({ subjectId: pending.subjectId, deckId: pending.deckId, page: pending.page || 1 });
    return true;
  };

  const handleGemSyncOpenGemini = async (payload) => {
    const targetUrl = payload?.geminiUrl || payload?.chatgptUrl || "";
    const providerName = payload?.provider === "chatgpt" || payload?.chatgptUrl ? "ChatGPT" : "Gemini";
    if (!targetUrl) {
      return { ok: false, error: `This deck has no ${providerName} URL.` };
    }

    rememberPendingPdfDock(payload);
    const targetConversationId = payload.conversationId || geminiConversationIdFromUrl(targetUrl);
    if (targetConversationId && targetConversationId === getConversationId()) {
      await openPdfDock({ subjectId: payload.subjectId, deckId: payload.deckId, page: payload.pageNumber || 1 });
      showToast(`${providerName} chat already open.`);
      return { ok: true, alreadyOpen: true };
    }

    showToast(`Opening ${payload.deckTitle || `${providerName} chat`}...`);
    setTimeout(() => {
      location.assign(targetUrl);
    }, 80);
    return { ok: true, navigating: true };
  };

  const togglePdfDock = () => {
    if (pdfDock) {
      closePdfDock();
    } else {
      openPdfDock();
    }
  };

  const respondToGemSyncFrame = (event, id, result) => {
    try {
      event.source?.postMessage({
        source: "gemsync-parent",
        id,
        ...result,
      }, event.origin || "*");
    } catch {
      // If the iframe disappeared, there is nothing useful to report.
    }
  };

  const handleGemSyncFrameMessage = async (event) => {
    const message = event.data;
    if (message?.source !== "gemsync-app-iframe") return;
    if (!isGemSyncFrameOrigin(event.origin)) return;
    if (message.type === "gemsync:pdf-state") {
      gemSyncPdfState = {
        ...gemSyncPdfState,
        ...(message.payload || {}),
        autoSyncEnabled: !!message.payload?.autoSyncEnabled,
      };
      const title = pdfDock?.querySelector(".gemsync-dock-title");
      if (title && message.payload?.deckTitle) {
        title.textContent = `PDF: ${message.payload.deckTitle}`;
      }
      if (gemSyncPdfState.autoSyncEnabled) {
        scheduleGeminiToPdfSync();
      } else {
        clearTimeout(gemSyncReverseTimer);
        gemSyncLastReverseSignature = "";
      }
      return;
    }
    if (!message.id) return;

    try {
      let result;
      if (message.type === "gemsync:sync-page") {
        result = await handleGemSyncPage(message.payload);
      } else if (message.type === "gemsync:bind-page") {
        result = await handleGemSyncBind(message.payload);
      } else if (message.type === "gemsync:open-gemini") {
        result = await handleGemSyncOpenGemini(message.payload);
      } else {
        result = { ok: false, error: `Unknown message: ${message.type}` };
      }
      respondToGemSyncFrame(event, message.id, result);
    } catch (error) {
      respondToGemSyncFrame(event, message.id, { ok: false, error: error.message });
    }
  };

  const postGemSyncResult = async (id, result, server = gemSyncServer) => {
    try {
      if (!server) return;
      await fetch(`${server}/api/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...result }),
      });
    } catch {
      // Local sync server may be closed; Gemini should keep working normally.
    }
  };

  const executeGemSyncCommand = async (command, server) => {
    if (!command?.id) return;
    try {
      let result;
      if (command.type === "gemsync:sync-page") {
        result = await handleGemSyncPage(command.payload);
      } else if (command.type === "gemsync:bind-page") {
        result = await handleGemSyncBind(command.payload);
      } else {
        result = { ok: false, error: `Unknown command: ${command.type}` };
      }
      await postGemSyncResult(command.id, result, server);
    } catch (error) {
      await postGemSyncResult(command.id, { ok: false, error: error.message }, server);
    }
  };

  let gemSyncPolling = false;
  const pollGemSyncServer = async () => {
    if (gemSyncPolling) return;
    gemSyncPolling = true;
    try {
      const server = await resolveGemSyncServer();
      if (!server) return;
      const conversationId = encodeURIComponent(getConversationId());
      const response = await fetch(`${server}/api/command?conversationId=${conversationId}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.command) {
        await executeGemSyncCommand(data.command, server);
      }
    } catch {
      // The local PDF sync app is optional. Stay quiet when it is closed.
    } finally {
      gemSyncPolling = false;
    }
  };

  const refreshCurrentConversationState = async () => {
    const key = getConversationKey();
    currentKey = key;
    const saved = await readMarker(key);
    hasMarker = !!saved;
    ++restoreToken;
    ++markerScrollToken;
    ++deepTopToken;
    gemSyncLastReverseSignature = "";
    resetScrollingButtons();
    updateMarkButton();
    updateVisibility();
    setTimeout(restorePendingPdfDock, 300);
  };

  const saveMarker = async () => {
    const key = getConversationKey();
    if (!key) {
      showToast("Open a saved Gemini chat first.");
      return;
    }

    const scroller = getPrimaryScroller();
    const top = Math.max(0, scroller.scrollTop || currentScrollTop());
    const anchor = getVisibleAnchor();
    await storage.set(key, {
      top,
      anchor,
      href: location.href,
      title: document.title,
      savedAt: new Date().toISOString(),
    });
    currentKey = key;
    hasMarker = true;
    updateMarkButton();
    showToast("Reading position marked.");
  };

  const clearMarker = async () => {
    const key = getConversationKey();
    if (!key) return;
    await storage.remove(key);
    if (currentKey === key) {
      hasMarker = false;
      updateMarkButton();
    }
    showToast("Marker cleared.");
  };

  const resetScrollingButtons = () => {
    topButton.classList.remove("busy");
    setButtonContent(topButton, "top", "Top");
    restoreButton.classList.remove("busy");
    setButtonContent(restoreButton, "restore", "Restore");
    updateMarkButton();
    updateVisibility();
  };

  const cancelActiveScrolling = () => {
    ++deepTopToken;
    ++markerScrollToken;
    ++restoreToken;
    resetScrollingButtons();
    stopButton.blur();
    showToast("Stopped.");
  };

  let scheduled = false;
  const updateVisibility = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const busy = topButton.classList.contains("busy");
      topButton.classList.toggle("hidden", !busy && currentScrollTop() <= SHOW_TOP_AFTER);
      const scrollBusy = busy
        || restoreButton.classList.contains("busy");
      stopButton.classList.toggle("hidden", !scrollBusy);
    });
  };

  const detectRouteChange = () => {
    const key = getConversationKey();
    if (key !== currentKey) {
      refreshCurrentConversationState();
    }
  };

  const patchHistory = () => {
    for (const name of ["pushState", "replaceState"]) {
      const original = history[name];
      history[name] = function patchedHistoryMethod(...args) {
        const result = original.apply(this, args);
        setTimeout(detectRouteChange, 50);
        return result;
      };
    }
  };

  markButton.addEventListener("click", saveMarker);
  markButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    clearMarker();
  });
  pdfDockButton.addEventListener("click", togglePdfDock);
  restoreButton.addEventListener("click", () => scrollToMarker());
  topButton.addEventListener("click", () => scrollToDeepTop({ behavior: "smooth" }));
  stopButton.addEventListener("click", cancelActiveScrolling);
  const runtime = getChromeRuntime();
  try {
    if (runtime?.onMessage?.addListener) {
      runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type === "gemsync:sync-page") {
          handleGemSyncPage(message.payload)
            .then((response) => sendResponse(response))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }

        if (message?.type === "gemsync:bind-page") {
          handleGemSyncBind(message.payload)
            .then((response) => sendResponse(response))
            .catch((error) => sendResponse({ ok: false, error: error.message }));
          return true;
        }

        return false;
      });
    }
  } catch (error) {
    if (isContextInvalidatedError(error)) chromeContextInvalidated = true;
  }
  window.addEventListener("message", handleGemSyncFrameMessage);
  window.addEventListener("scroll", () => {
    updateVisibility();
    scheduleGeminiToPdfSync();
  }, true);
  window.addEventListener("resize", updateVisibility);
  window.addEventListener("popstate", () => setTimeout(detectRouteChange, 50));
  patchHistory();
  setInterval(() => {
    detectRouteChange();
    updateVisibility();
  }, 1000);
  setInterval(pollGemSyncServer, 650);
  setTimeout(pollGemSyncServer, 1200);
  refreshCurrentConversationState();
  setTimeout(restorePendingPdfDock, 900);
  setTimeout(restorePendingPdfDock, 2400);
})();
