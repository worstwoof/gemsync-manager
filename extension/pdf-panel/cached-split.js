const params = new URLSearchParams(location.hash.replace(/^#/, ""));

const state = {
  subjectId: params.get("subject") || "c",
  deckId: params.get("deck") || "deck01",
  page: Math.max(1, Number(params.get("page") || 1)),
  config: null,
  transcript: null,
  deck: null,
  turn: 0,
  observer: null,
  pdfAutoSyncEnabled: false,
  suppressPdfEventUntil: 0,
  suppressGeminiAutoUntil: 0,
  interactiveResizeTimer: 0,
};

const elements = {
  chatTitle: document.getElementById("chatTitle"),
  chatScroll: document.getElementById("chatScroll"),
  pdfFrame: document.getElementById("pdfFrame"),
  openLiveGemini: document.getElementById("openLiveGemini"),
  recentList: document.getElementById("recentList"),
  recordCount: document.getElementById("recordCount"),
  themeToggle: document.getElementById("themeToggle"),
  themeIcon: document.getElementById("themeIcon"),
  themeText: document.getElementById("themeText"),
};

const INTERACTIVE_MIN_HEIGHT = 420;
const INTERACTIVE_MAX_HEIGHT = 1800;
const INTERACTIVE_HEIGHT_PADDING = 10;

function preferredTheme() {
  const saved = localStorage.getItem("gemsync:cached-split:theme");
  if (saved === "dark" || saved === "light") return saved;
  return "dark";
}

function applyTheme(theme) {
  const nextTheme = theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = nextTheme;
  localStorage.setItem("gemsync:cached-split:theme", nextTheme);
  if (elements.themeToggle) elements.themeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
  if (elements.themeIcon) elements.themeIcon.textContent = nextTheme === "dark" ? "☀" : "◐";
  if (elements.themeText) elements.themeText.textContent = nextTheme === "dark" ? "亮色模式" : "暗色模式";
}

function initTheme() {
  applyTheme(preferredTheme());
  elements.themeToggle?.addEventListener("click", () => {
    applyTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
  });
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

async function loadConfig() {
  const subjectsConfig = await readJson("./subjects.json");
  const subject = (subjectsConfig.subjects || []).find((item) => item.id === state.subjectId)
    || subjectsConfig.subjects?.[0];
  if (!subject) throw new Error("没有可用学科");

  const configUrl = new URL(subject.configUrl, location.href).toString();
  const config = await readJson(configUrl);
  const cachedDecks = (config.decks || []).filter((item) => item.transcriptUrl);
  const deck = cachedDecks.find((item) => item.id === state.deckId) || cachedDecks[0];
  if (!deck) throw new Error("没有可用章节");

  state.subjectId = subject.id;
  state.deckId = deck.id;
  state.config = { ...config, decks: cachedDecks };
  state.deck = {
    ...deck,
    transcriptUrl: deck.transcriptUrl ? new URL(deck.transcriptUrl, configUrl).toString() : "",
  };
  state.transcript = await readJson(state.deck.transcriptUrl);
  history.replaceState(null, "", cachedUrlForState(state.page));
}

function cachedUrlForState(page = state.page) {
  return `#subject=${encodeURIComponent(state.subjectId)}&deck=${encodeURIComponent(state.deckId)}&page=${Math.max(1, Number(page) || 1)}`;
}

async function loadCachedDeckFromPayload(payload = {}) {
  const nextSubjectId = payload.subjectId || state.subjectId;
  const nextDeckId = payload.deckId || state.deckId;
  if (!nextDeckId) return { ok: false, error: "No cached deck was provided." };

  state.subjectId = nextSubjectId;
  state.deckId = nextDeckId;
  state.page = Math.max(1, Number(payload.pageNumber) || 1);
  state.turn = 0;
  state.observer?.disconnect();
  elements.chatScroll.replaceChildren();
  await loadConfig();
  renderTranscript();
  history.replaceState(null, "", cachedUrlForState(state.page));
  setPdfPage(state.page, { forceManual: true, reason: "cached-deck-change" });
  return { ok: true, cachedTranscript: true, deckId: state.deckId, pageNumber: state.page };
}

function resolveTranscriptUrl(value) {
  if (!value) return "";
  return new URL(value, state.deck.transcriptUrl).toString();
}

function cleanUserText(value) {
  return String(value || "请详细讲解这一面PPT").replace(/^你说\s*/u, "").trim();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shouldPromotePlainHeading(line, previousLine, nextLine) {
  const value = line.trim();
  if (!value || value.length > 30) return false;
  if (isMarkdownTableLine(value) || hasMathSyntax(value)) return false;
  if (/^(根据|以下|幻灯片|这张|该|它|在|由于|但|因此)/u.test(value)) return false;
  if (/[。！？；，,.]$/u.test(value)) return false;
  return !previousLine.trim() || !nextLine.trim();
}

function isMarkdownTableLine(value) {
  return /^\|.+\|$/.test(value) || /^:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?$/.test(value);
}

function hasMathSyntax(value) {
  return /\$\$|\\\[|\\\(|(^|[^\w\\$])\$([^\s$][^$\n]*?[^\s$])\$(?![\w$])/.test(value);
}

function makeFormatStore() {
  const bold = [];

  return {
    bold,
    boldToken(text) {
      const token = `GEMSYNBOLD${bold.length}TOKEN`;
      bold.push(String(text || ""));
      return token;
    },
  };
}

function replaceFormatTokens(html, format) {
  return format.bold.reduce((result, text, index) => {
    return result.replaceAll(`GEMSYNBOLD${index}TOKEN`, `<strong>${escapeHtml(text)}</strong>`);
  }, html);
}

function boldColonPrefix(line, format) {
  if (/^\s*(#{1,6}|>|```)/.test(line)) return line;
  const match = line.match(/^(\s*)([^:：\n]{2,42}[:：])(\s*)(.+)$/u);
  if (!match) return line;
  const [, indent, label, space, rest] = match;
  if (/^\*\*.*\*\*$/.test(label) || /^https?:\/\//i.test(label)) return line;
  return `${indent}${format.boldToken(label)}${space}${rest}`;
}

function shouldBoldWholeLine(line, previousLine, nextLine) {
  const value = line.trim();
  if (!value || value.length > 38) return false;
  if (isMarkdownTableLine(value) || hasMathSyntax(value)) return false;
  if (/^(GEMSYNBOLD|\*\*|__|#{1,6}\s|[-*+]\s|\d+\.\s|```|>)/.test(value)) return false;
  if (/[。！？.!?；;，,]$/u.test(value)) return false;
  if (/[:：]/u.test(value)) return true;
  return shouldPromotePlainHeading(line, previousLine, nextLine);
}

function isStandaloneCodeLine(value) {
  if (!value || value.length > 140) return false;
  if (/[\u4e00-\u9fa5]/u.test(value)) return false;
  if (/^\/\*[\s\S]*\*\/$/.test(value)) return true;
  if (/^(#include|#define|#ifdef|#ifndef|#endif)\b/.test(value)) return true;
  if (/^(return|break|continue)\b/.test(value) && /[;{}]/.test(value)) return true;
  if (/^(if|else if|for|while|switch)\s*\(.+\)/.test(value)) return true;
  if (/^(printf|scanf|puts|gets|fopen|fread|fwrite|malloc|free)\s*\(/.test(value)) return true;
  if (/^[A-Za-z_][\w\s*]*\s+[A-Za-z_]\w*(\s*\([^)]*\))?\s*(=|,|;|\{)?/.test(value) && /[;(){}=*]/.test(value)) return true;
  return false;
}

function inlineCodeLine(line) {
  const indentLength = line.search(/\S|$/);
  const indent = line.slice(0, indentLength);
  const value = line.slice(indentLength).trimEnd();
  const fence = value.includes("`") ? "``" : "`";
  return `${indent}${fence}${value}${fence}`;
}

function replaceStrongSyntax(line, format) {
  return line.replace(/\*\*([^*\n]+?)\*\*/g, (_, text) => format.boldToken(text));
}

function boldListLead(line, format) {
  return line.replace(/^(\s*(?:[-*+]|\d+\.)\s+)(.+)$/u, (whole, marker, content) => {
    const value = content.trim();
    if (!value || /^(GEMSYNBOLD|__|`|\[|!\[)/.test(value)) return whole;

    const colonMatch = value.match(/^([^:：\n]{2,42}[:：])(\s*)(.+)$/u);
    if (colonMatch) {
      const [, label, space, rest] = colonMatch;
      return `${marker}${format.boldToken(label)}${space}${rest}`;
    }

    if (value.length <= 36 && !/[。！？.!?；;，,]$/u.test(value)) {
      return `${marker}${format.boldToken(value)}`;
    }

    return whole;
  });
}

function parseColonPrefix(value) {
  const match = value.match(/^([^:：\n]{2,42}[:：])(\s*)(.*)$/u);
  if (!match) return null;
  const [, label, space, rest] = match;
  return { label, space, rest };
}

function stripTrailingColon(value) {
  return String(value || "").replace(/[:：]\s*$/u, "");
}

function listIndent(level) {
  return "   ".repeat(Math.max(1, level));
}

function shouldBreakNumberedSection(label) {
  return /^(总结|教学逻辑总结|视觉与排版风格|视觉与排版|总体评价)$/u.test(stripTrailingColon(label));
}

function shouldNestUnderPreviousBullet(label, lastBullet, activeLevelOneLabel = "") {
  const key = stripTrailingColon(label);
  const parent = stripTrailingColon(lastBullet.label);
  const activeParent = stripTrailingColon(activeLevelOneLabel);
  if (!lastBullet.level) return false;
  if (/^(教学重点|解析|教学意义|原因|运作原理|特点|核心逻辑|效果展示|概念呼应|建立成就感|代码印证|应对|动作|产物|直接的做法|使用循环|如何实现阶乘)$/u.test(key)) {
    return true;
  }
  if (/^(实验教师|助教(?:\s*\(TA\))?|TA)$/iu.test(key) && /助教|教师|\+/u.test(parent)) return true;
  if (/^(实验教师|助教(?:\s*\(TA\))?|TA)$/iu.test(key) && /助教|教师|\+/u.test(activeParent)) return true;
  if (/^(破绽一|破绽二|第一步|第二步|第三步|第四步)$/u.test(key)) return true;
  if (/^(第一部分|第二部分|第三部分|第四部分)$/u.test(parent) && key !== parent) return true;
  return false;
}

function shouldKeepColonLineAsParagraph(colon) {
  const key = stripTrailingColon(colon.label);
  return !colon.rest.trim() && key.length > 18 && /[，,、]/u.test(key);
}

function isShortListTopic(value) {
  if (!value || value.length > 38) return false;
  if (/[:：。！？.!?；;，,]$/u.test(value)) return false;
  if (/^(根据|以下|这张|该|它|在|由于|但|因此)/u.test(value)) return false;
  return true;
}

function geminiTextToMarkdown(text, format) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  let inDisplayMath = false;
  let inNumberedSection = false;
  let lastBullet = { level: 0, label: "", hasRest: false };
  let activeLevelOneLabel = "";

  return lines.map((line, index) => {
    let trimmed = line.trim();
    if (/^\s*```/.test(trimmed)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    if (/^\s*(\$\$|\\\[|\\\])\s*$/.test(trimmed)) {
      inDisplayMath = !inDisplayMath;
      return trimmed;
    }
    if (inDisplayMath) return trimmed;
    if (!trimmed) return "";
    if (isMarkdownTableLine(trimmed)) return line;
    line = replaceStrongSyntax(line, format);
    trimmed = line.trim();
    if (isStandaloneCodeLine(trimmed)) return inlineCodeLine(line);

    const numberedHeading = trimmed.match(/^(\d+)\.\s+(.+)$/u);
    if (numberedHeading) {
      inNumberedSection = true;
      lastBullet = { level: 0, label: numberedHeading[2], hasRest: false };
      activeLevelOneLabel = "";
      return `${numberedHeading[1]}. ${format.boldToken(numberedHeading[2])}`;
    }

    if (inNumberedSection) {
      const colon = parseColonPrefix(trimmed);
      if (colon) {
        if (shouldKeepColonLineAsParagraph(colon)) {
          const paragraphLevel = lastBullet.level ? Math.min(lastBullet.level + 1, 3) : 1;
          return `${listIndent(paragraphLevel)}${line}`;
        }

        if (shouldBreakNumberedSection(colon.label)) {
          inNumberedSection = false;
          lastBullet = { level: 0, label: "", hasRest: false };
          activeLevelOneLabel = "";
          return colon.rest
            ? `${format.boldToken(colon.label)} ${colon.rest}`
            : format.boldToken(colon.label);
        }

        const level = shouldNestUnderPreviousBullet(colon.label, lastBullet, activeLevelOneLabel) ? 2 : 1;
        lastBullet = { level, label: colon.label, hasRest: Boolean(colon.rest.trim()) };
        if (level === 1) activeLevelOneLabel = colon.label;
        return `${listIndent(level)}- ${format.boldToken(colon.label)}${colon.rest ? ` ${colon.rest}` : ""}`;
      }

      if (isShortListTopic(trimmed) && !lastBullet.hasRest) {
        lastBullet = { level: 1, label: trimmed, hasRest: false };
        activeLevelOneLabel = trimmed;
        return `${listIndent(1)}- ${format.boldToken(trimmed)}`;
      }

      const paragraphLevel = lastBullet.level ? Math.min(lastBullet.level + 1, 3) : 1;
      return `${listIndent(paragraphLevel)}${line}`;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) return boldListLead(line, format);
    if (shouldBoldWholeLine(line, lines[index - 1] || "", lines[index + 1] || "")) {
      return `${line.slice(0, line.indexOf(trimmed))}${format.boldToken(trimmed)}`;
    }
    return boldColonPrefix(line, format);
  }).join("\n");
}

function stashMath(text) {
  const math = [];
  const codeFencePattern = /(```[\s\S]*?```)/g;
  const parts = String(text || "").split(codeFencePattern);

  function store(tex, displayMode) {
    const token = `GEMSYNCMATH${math.length}TOKEN`;
    math.push({ tex, displayMode });
    return token;
  }

  function replaceMath(chunk) {
    return chunk
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => `\n\n${store(tex, true)}\n\n`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => `\n\n${store(tex, true)}\n\n`)
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => store(tex, false))
      .replace(/(^|[^\w\\$])\$([^\s$][^$\n]*?[^\s$])\$(?![\w$])/g, (_, prefix, tex) => `${prefix}${store(tex, false)}`);
  }

  const source = parts.map((part) => part.startsWith("```") ? part : replaceMath(part)).join("");
  return { source, math };
}

function renderMathToken(item) {
  if (!window.katex) return escapeHtml(item.tex);
  try {
    return window.katex.renderToString(item.tex.trim(), {
      displayMode: item.displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
    });
  } catch {
    return escapeHtml(item.tex);
  }
}

function sanitizeStoredHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = String(html || "");

  const allowedTags = new Set([
    "p",
    "br",
    "hr",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "strong",
    "b",
    "em",
    "i",
    "span",
    "div",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
  ]);

  function cleanNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
    if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();

    const source = node;
    const tag = source.tagName.toLowerCase();
    const childrenOnly = document.createDocumentFragment();
    if (!allowedTags.has(tag)) {
      for (const child of Array.from(source.childNodes)) childrenOnly.append(cleanNode(child));
      return childrenOnly;
    }

    const target = document.createElement(tag);
    if (source.hasAttribute("data-math")) target.setAttribute("data-math", source.getAttribute("data-math") || "");
    if (source.classList.contains("math-inline")) target.className = "math-inline";
    if (source.classList.contains("math-display")) target.className = "math-display";
    if (tag === "code") {
      const languageClass = Array.from(source.classList).find((name) => /^language-[a-z0-9_-]+$/i.test(name));
      if (languageClass) target.className = languageClass;
    }
    for (const child of Array.from(source.childNodes)) target.append(cleanNode(child));
    return target;
  }

  const fragment = document.createDocumentFragment();
  for (const child of Array.from(template.content.childNodes)) fragment.append(cleanNode(child));
  const wrapper = document.createElement("div");
  wrapper.append(fragment);
  return wrapper.innerHTML;
}

function renderEmbeddedMath(root) {
  for (const node of root.querySelectorAll("[data-math]")) {
    const tex = node.getAttribute("data-math") || "";
    const displayMode = node.classList.contains("math-display") || node.tagName.toLowerCase() === "div";
    if (!tex.trim()) continue;
    if (!window.katex) {
      node.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
      continue;
    }
    try {
      node.innerHTML = window.katex.renderToString(tex.trim(), {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
      });
    } catch {
      node.textContent = displayMode ? `$$${tex}$$` : `$${tex}$`;
    }
  }
}

function renderMarkdownHtml(text) {
  const format = makeFormatStore();
  const source = geminiTextToMarkdown(text, format);
  const { source: mathSource, math } = stashMath(source);
  const renderer = window.marked?.Renderer ? new window.marked.Renderer() : null;
  if (renderer) {
    renderer.html = (token) => escapeHtml(typeof token === "string" ? token : token?.text || token?.raw || "");
  }
  const html = window.marked?.parse
    ? window.marked.parse(mathSource, {
      async: false,
      breaks: true,
      gfm: true,
      renderer,
    })
    : `<p>${escapeHtml(mathSource).replace(/\n/g, "<br>")}</p>`;

  const withFormatting = replaceFormatTokens(html, format);

  return math.reduce((result, item, index) => {
    const rendered = renderMathToken(item);
    const token = `GEMSYNCMATH${index}TOKEN`;
    if (item.displayMode) {
      return result
        .replaceAll(`<p>${token}</p>`, `<div class="math-display">${rendered}</div>`)
        .replaceAll(token, `<span class="math-inline">${rendered}</span>`);
    }
    return result.replaceAll(token, `<span class="math-inline">${rendered}</span>`);
  }, withFormatting);
}

function renderAnswer(element, recordOrText) {
  const record = typeof recordOrText === "object" && recordOrText ? recordOrText : null;
  const text = record ? record.assistantText || "" : String(recordOrText || "");
  element.dataset.rawText = String(text || "");
  if (record?.assistantHtml) {
    element.innerHTML = sanitizeStoredHtml(record.assistantHtml);
    renderEmbeddedMath(element);
  } else {
    element.innerHTML = renderMarkdownHtml(text);
  }
  renderInteractiveViews(element, record);
}

function clampInteractiveHeight(value, minHeight = INTERACTIVE_MIN_HEIGHT) {
  const height = Math.ceil(Number(value) || 0);
  if (!height) return 0;
  return Math.max(minHeight, Math.min(INTERACTIVE_MAX_HEIGHT, height + INTERACTIVE_HEIGHT_PADDING));
}

function setInteractiveFrameHeight(frame, height) {
  const shell = frame?.closest?.(".interactive-view");
  if (!shell) return false;

  const minHeight = Number(shell.dataset.minInteractiveHeight) || INTERACTIVE_MIN_HEIGHT;
  const nextHeight = clampInteractiveHeight(height, minHeight);
  if (!nextHeight) return false;

  const currentHeight = Number.parseFloat(shell.style.getPropertyValue("--interactive-height"))
    || frame.clientHeight
    || 0;
  if (Math.abs(nextHeight - currentHeight) < 4) return false;

  shell.style.setProperty("--interactive-height", `${nextHeight}px`);
  shell.dataset.measuredHeight = String(nextHeight);
  return true;
}

function measureInteractiveFrame(frame) {
  try {
    const doc = frame?.contentDocument;
    const widget = doc?.querySelector?.(".widget-container");
    if (widget) {
      const previousStyle = widget.style.cssText;
      widget.style.cssText = `${previousStyle};
        display: block !important;
        height: auto !important;
        max-height: none !important;
        min-height: 0 !important;
        overflow: visible !important;
        position: absolute !important;
        width: 100% !important;
      `;
      const measured = Math.max(
        widget.offsetHeight || 0,
        widget.scrollHeight || 0,
        widget.getBoundingClientRect?.().height || 0,
      );
      widget.style.cssText = previousStyle;
      return measured;
    }

    return Math.max(
      doc?.documentElement?.scrollHeight || 0,
      doc?.body?.scrollHeight || 0,
    );
  } catch {
    return 0;
  }
}

function refreshInteractiveFrameHeight(frame) {
  const measured = measureInteractiveFrame(frame);
  if (measured) setInteractiveFrameHeight(frame, measured);
}

function scheduleInteractiveFrameMeasure(frame) {
  for (const delay of [80, 350, 1000, 2500]) {
    window.setTimeout(() => refreshInteractiveFrameHeight(frame), delay);
  }
}

function findInteractiveFrameByWindow(source) {
  if (!source) return null;
  for (const frame of document.querySelectorAll(".interactive-frame")) {
    if (frame.contentWindow === source) return frame;
  }
  return null;
}

function handleInteractiveResizeMessage(event, data) {
  const isWidgetResize = data?.type === "widget-resize";
  const isManualResize = data?.__sn__ === 1 && data?.method === "manual_resize";
  if (!isWidgetResize && !isManualResize) return false;

  const frame = findInteractiveFrameByWindow(event.source);
  if (!frame) return false;

  const rawHeight = isWidgetResize ? data.height : data.args?.height;
  if (!setInteractiveFrameHeight(frame, rawHeight)) {
    refreshInteractiveFrameHeight(frame);
  }
  return true;
}

function renderInteractiveViews(element, record) {
  const views = Array.isArray(record?.interactiveViews) ? record.interactiveViews : [];
  if (!views.length) return;

  for (const [index, view] of views.entries()) {
    const htmlUrl = resolveTranscriptUrl(view.htmlUrl);
    if (!htmlUrl) continue;

    const initialHeight = clampInteractiveHeight(Number(view.height) || 640);
    const shell = document.createElement("section");
    shell.className = "interactive-view";
    shell.dataset.minInteractiveHeight = String(initialHeight);
    shell.style.setProperty("--interactive-height", `${initialHeight}px`);

    const frame = document.createElement("iframe");
    frame.className = "interactive-frame";
    frame.title = view.title || `Gemini interactive view ${index + 1}`;
    frame.src = htmlUrl;
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-popups allow-downloads",
    );
    frame.addEventListener("load", () => scheduleInteractiveFrameMeasure(frame));

    shell.append(frame);
    element.append(shell);
  }
}

function clampPromptIndex(value) {
  const total = transcriptRecords().length || 1;
  return Math.max(1, Math.min(total, Number(value) || 1));
}

function getPromptIndexFromTurn(turn) {
  return clampPromptIndex(Number(turn?.dataset?.promptIndex) || Number(turn?.dataset?.turn) || 1);
}

function findTurnForPromptIndex(promptIndex) {
  const target = clampPromptIndex(promptIndex);
  return elements.chatScroll.querySelector(`.turn[data-prompt-index="${target}"]`)
    || elements.chatScroll.querySelector(`.turn[data-turn="${target}"]`)
    || null;
}

function recordForPromptIndex(promptIndex) {
  return transcriptRecords()[clampPromptIndex(promptIndex) - 1] || null;
}

function pageStorageKey(pageNumber) {
  return `gemsync:${state.subjectId}:${state.deckId}:page:${pageNumber}`;
}

function promptStorageKey(promptIndex) {
  return `gemsync:${state.subjectId}:${state.deckId}:prompt:${promptIndex}`;
}

function readLocalBinding(key) {
  try {
    const binding = JSON.parse(localStorage.getItem(key) || "null");
    return binding && !binding.autoLearned ? binding : null;
  } catch {
    return null;
  }
}

function bindingEntriesForCurrentDeck() {
  const prefixes = [
    { prefix: `gemsync:${state.subjectId}:${state.deckId}:page:`, type: "page" },
    { prefix: `gemsync:${state.subjectId}:${state.deckId}:prompt:`, type: "prompt" },
  ];
  const entries = [];
  const seen = new Set();
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    const match = prefixes.find((item) => key?.startsWith(item.prefix));
    if (!match) continue;
    const binding = readLocalBinding(key);
    if (!binding) continue;
    const keyNumber = Number(key.slice(match.prefix.length));
    const pageNumber = Number(match.type === "page" ? keyNumber : binding.pageNumber) || 0;
    const promptIndex = Number(binding.promptIndex || binding.targetPromptIndex || (match.type === "prompt" ? keyNumber : 0)) || 0;
    if (!pageNumber || !promptIndex) continue;
    const seenKey = `${pageNumber}:${promptIndex}:${binding.savedAt || ""}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);
    entries.push({ ...binding, pageNumber, promptIndex });
  }
  return entries;
}

function configuredPromptStartIndex() {
  const pageOne = readLocalBinding(pageStorageKey(1));
  const pageOnePrompt = Number(pageOne?.promptIndex || pageOne?.targetPromptIndex || 0);
  if (pageOnePrompt > 1) return Math.floor(pageOnePrompt);

  const configured = Number(state.transcript?.promptStartIndex || state.config?.promptStartIndex || state.deck?.promptStartIndex || 0);
  if (Number.isFinite(configured) && configured > 1) return Math.floor(configured);
  return String(state.transcript?.prePrompt || state.config?.prePrompt || state.deck?.prePrompt || "").trim() ? 2 : 1;
}

function configuredPagesPerPrompt() {
  const configured = Number(state.transcript?.pagesPerPrompt || state.config?.pagesPerPrompt || state.deck?.pagesPerPrompt || 1);
  if (Number.isFinite(configured)) return Math.max(1, Math.min(3, Math.floor(configured)));
  return 1;
}

function pageIfInRange(page) {
  const total = Number(state.transcript?.totalPages) || transcriptRecords().length || 1;
  const value = Number(page) || 0;
  if (value < 1 || value > total) return null;
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

function pageFromPromptIndex(promptIndex) {
  const index = Number(promptIndex) || 0;
  if (!index) return null;

  const exact = readLocalBinding(promptStorageKey(index));
  const exactPage = pageIfInRange(exact?.pageNumber);
  if (exactPage) return exactPage;

  const entries = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry.promptIndex) > 0 && Number(entry.pageNumber) > 0)
    .sort((a, b) => Number(a.promptIndex) - Number(b.promptIndex) || Number(a.pageNumber) - Number(b.pageNumber));
  const previous = [...entries].reverse().find((entry) => Number(entry.promptIndex) < index);
  const next = entries.find((entry) => Number(entry.promptIndex) > index);
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

function promptIndexForPage(page, payload = {}) {
  const binding = payload?.binding && !payload.binding.autoLearned ? payload.binding : null;
  if (binding?.targetPromptIndex || binding?.promptIndex) {
    return clampPromptIndex(binding.targetPromptIndex || binding.promptIndex);
  }
  if (Number(payload?.targetPromptIndex) > 0) {
    return clampPromptIndex(payload.targetPromptIndex);
  }

  const targetPage = Math.max(1, Number(page) || Number(state.page) || 1);
  const exact = readLocalBinding(pageStorageKey(targetPage));
  const exactPrompt = Number(exact?.promptIndex || exact?.targetPromptIndex || 0);
  if (exactPrompt > 0) return clampPromptIndex(exactPrompt);

  const entries = bindingEntriesForCurrentDeck()
    .filter((entry) => Number(entry.pageNumber) > 0 && Number(entry.promptIndex) > 0)
    .sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber) || Number(a.promptIndex) - Number(b.promptIndex));
  const previous = [...entries].reverse().find((entry) => Number(entry.pageNumber) < targetPage);
  const next = entries.find((entry) => Number(entry.pageNumber) > targetPage);
  if (previous && next) {
    const pageDelta = Number(next.pageNumber) - Number(previous.pageNumber);
    const promptDelta = Number(next.promptIndex) - Number(previous.promptIndex);
    const expectedPromptDelta = promptOffsetForPage(next.pageNumber) - promptOffsetForPage(previous.pageNumber);
    if (pageDelta <= 0 || promptDelta !== expectedPromptDelta) return null;
    return clampPromptIndex(Number(previous.promptIndex) + (promptOffsetForPage(targetPage) - promptOffsetForPage(previous.pageNumber)));
  }
  if (previous) {
    return clampPromptIndex(Number(previous.promptIndex) + (promptOffsetForPage(targetPage) - promptOffsetForPage(previous.pageNumber)));
  }

  return clampPromptIndex(configuredPromptStartIndex() + promptOffsetForPage(targetPage));
}

function currentVisibleTurn() {
  const root = elements.chatScroll;
  const rootRect = root.getBoundingClientRect();
  const anchorY = rootRect.top + Math.min(180, Math.max(80, rootRect.height * 0.2));
  let best = null;

  for (const turn of root.querySelectorAll(".turn")) {
    const rect = turn.getBoundingClientRect();
    const visibleHeight = Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top);
    if (visibleHeight <= 0) continue;

    const containsAnchor = rect.top <= anchorY && rect.bottom >= anchorY;
    const score = containsAnchor
      ? 100000 - Math.abs(rect.top - anchorY)
      : visibleHeight - Math.abs(rect.top - anchorY);
    if (!best || score > best.score) best = { turn, score };
  }

  return best?.turn || null;
}

function setPdfPage(page, options = {}) {
  if (!page) return;
  const forceManual = !!options.forceManual;
  const isAuto = options.reason === "auto";
  if (isAuto && !state.pdfAutoSyncEnabled) return;

  const promptIndex = Number(options.promptIndex || promptIndexForPage(page, options)) || 0;
  if (!promptIndex) return;
  state.page = Math.max(1, Number(page) || promptIndex);
  const url = `./index.html#subject=${encodeURIComponent(state.subjectId)}&deck=${encodeURIComponent(state.deckId)}&page=${state.page}&embed=1&cached=1`;
  state.suppressPdfEventUntil = Date.now() + 2500;
  if (!elements.pdfFrame.src || !elements.pdfFrame.src.includes("index.html")) {
    elements.pdfFrame.src = url;
    return;
  }
  if (!forceManual && !state.pdfAutoSyncEnabled) return;

  elements.pdfFrame.contentWindow?.postMessage({
    source: "gemsync-parent",
    type: "gemsync:gemini-visible-page",
    payload: {
      deckId: state.deckId,
      forceManual,
      cachedTranscript: true,
      promptIndex,
      hasUserImage: recordHasImage(recordForPromptIndex(promptIndex)),
      missingImage: recordForPromptIndex(promptIndex)?.missingImage === true,
    },
  }, "*");
}

function markActive(page, activeTurn = 0) {
  for (const turn of elements.chatScroll.querySelectorAll(".turn")) {
    const sameTurn = activeTurn && Number(turn.dataset.turn) === Number(activeTurn);
    const samePage = !activeTurn && (
      Number(turn.dataset.page) === Number(page)
      || Number(turn.dataset.promptIndex) === Number(page)
    );
    turn.classList.toggle("active", Boolean(sameTurn || samePage));
  }
  for (const item of elements.recentList?.querySelectorAll(".recent-item") || []) {
    const sameTurn = activeTurn && Number(item.dataset.turn) === Number(activeTurn);
    const samePage = !activeTurn && (
      Number(item.dataset.page) === Number(page)
      || Number(item.dataset.promptIndex) === Number(page)
    );
    item.classList.toggle("active", Boolean(sameTurn || samePage));
  }
}

function scrollTurnIntoView(turn, behavior = "auto") {
  if (!turn) return;
  elements.chatScroll.scrollTo({
    top: Math.max(0, turn.offsetTop - 28),
    behavior,
  });
}

function suppressGeminiAutoSync(ms = 2200) {
  state.suppressGeminiAutoUntil = Math.max(state.suppressGeminiAutoUntil, Date.now() + ms);
}

function findTurnForPage(page, payload = {}) {
  const promptIndex = promptIndexForPage(page, payload);
  if (!promptIndex) return null;
  return findTurnForPromptIndex(promptIndex);
}

function transcriptRecords() {
  return Array.isArray(state.transcript?.records) ? state.transcript.records : [];
}

function recordHasImage(record) {
  return Boolean(record?.hasUserImage === true && !record?.missingImage);
}

function pageRangeLabel(start, end = start) {
  const first = Number(start) || 0;
  const last = Number(end || first) || first;
  if (!first) return "";
  return last > first ? `第 ${first}-${last} 页` : `第 ${first} 页`;
}

function promptStatsForPromptIndex(promptIndex) {
  const records = transcriptRecords();
  const index = clampPromptIndex(promptIndex) - 1;
  const record = records[index] || null;

  return {
    record,
    promptIndex: index >= 0 ? index + 1 : null,
    imagePromptIndex: null,
    foundPrompts: records.length,
    foundImagePrompts: records.filter(recordHasImage).length,
  };
}

function promptStatsForTurn(turnNumber) {
  const records = transcriptRecords();
  const turn = Number(turnNumber) || 0;
  const index = records.findIndex((record, recordIndex) => {
    return Number(record.turn || recordIndex + 1) === turn;
  });
  const record = index >= 0 ? records[index] : null;
  const imageRecords = records.filter(recordHasImage);

  return {
    record,
    promptIndex: index >= 0 ? index + 1 : turn || null,
    imagePromptIndex: recordHasImage(record)
      ? records.slice(0, index + 1).filter(recordHasImage).length
      : null,
    foundPrompts: records.length,
    foundImagePrompts: imageRecords.length,
  };
}

function syncCachedTurnForPage(payload = {}) {
  const page = Math.max(1, Number(payload?.pageNumber) || state.page || 1);
  const promptIndex = promptIndexForPage(page, payload);
  if (!promptIndex) {
    return {
      ok: false,
      error: `No mapped cached Gemini record found for page ${page}.`,
      foundPrompts: transcriptRecords().length,
      foundImagePrompts: transcriptRecords().filter(recordHasImage).length,
    };
  }
  const turn = findTurnForPromptIndex(promptIndex);
  if (!turn) {
    return {
      ok: false,
      error: `No cached Gemini record found for page ${page}.`,
      foundPrompts: transcriptRecords().length,
      foundImagePrompts: transcriptRecords().filter(recordHasImage).length,
    };
  }

  const turnNumber = Number(turn.dataset.turn) || 0;
  const stats = promptStatsForPromptIndex(promptIndex);
  const usedBinding = Boolean(payload?.binding && !payload.binding.autoLearned);
  state.page = page;
  state.turn = turnNumber;
  state.suppressPdfEventUntil = Date.now() + 2500;
  suppressGeminiAutoSync();
  markActive(page, turnNumber);
  scrollTurnIntoView(turn, payload?.deep ? "smooth" : "auto");

  return {
    ok: true,
    usedBinding,
    mode: usedBinding ? "cached-calibrated" : "cached-sequential",
    pageNumber: page,
    promptIndex: stats.promptIndex,
    foundPrompts: stats.foundPrompts,
    foundImagePrompts: stats.foundImagePrompts,
    target: page,
  };
}

function bindCachedPage(payload = {}) {
  const page = Math.max(1, Number(payload?.pageNumber) || state.page || 1);
  const turn = currentVisibleTurn() || findTurnForPage(page, payload);
  if (!turn) {
    return {
      ok: false,
      error: `No visible cached Gemini record found for page ${page}.`,
      foundPrompts: transcriptRecords().length,
      foundImagePrompts: transcriptRecords().filter(recordHasImage).length,
    };
  }

  const promptIndex = getPromptIndexFromTurn(turn);
  const turnNumber = Number(turn.dataset.turn) || promptIndex;
  const stats = promptStatsForPromptIndex(promptIndex);
  state.page = page;
  state.turn = turnNumber;
  markActive(page, turnNumber);

  return {
    ok: true,
    binding: {
      href: location.href,
      title: state.transcript?.title || state.deck?.title || document.title,
      promptIndex: stats.promptIndex,
      promptCount: stats.foundPrompts,
      imagePromptCount: stats.foundImagePrompts,
      promptSnippet: String(stats.record?.userText || stats.record?.assistantText || "").slice(0, 220),
      cachedTranscript: true,
      sequentialMapping: true,
      fixedPageMapping: true,
      savedAt: new Date().toISOString(),
    },
  };
}

async function openCachedLiveGemini(payload = {}) {
  if (payload.reason === "deck-change" || payload.reason === "subject-change") {
    return loadCachedDeckFromPayload(payload);
  }
  const url = payload.geminiUrl || state.transcript?.conversationUrl || state.deck?.geminiUrl;
  if (url) window.open(url, "_blank", "noopener");
  return { ok: true };
}

function respondToPdfFrame(event, id, result) {
  try {
    event.source?.postMessage({
      source: "gemsync-parent",
      id,
      ...result,
    }, event.origin || "*");
  } catch {
    // The iframe may have navigated away; there is no useful recovery here.
  }
}

async function handlePdfFrameCommand(data) {
  if (data.type === "gemsync:sync-page") {
    return syncCachedTurnForPage(data.payload);
  }
  if (data.type === "gemsync:bind-page") {
    return bindCachedPage(data.payload);
  }
  if (data.type === "gemsync:open-gemini") {
    return openCachedLiveGemini(data.payload);
  }
  return { ok: false, error: `Unknown cached command: ${data.type}` };
}

function createSlidePreview(record) {
  const preview = document.createElement("div");
  preview.className = "slide-preview";
  const imageUrl = resolveTranscriptUrl(record.slideImageUrl || record.imageUrl || record.thumbnailUrl);
  const label = pageRangeLabel(record.pageStart || record.page, record.pageEnd || record.page);

  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = record.imageName || `${label || `第 ${record.page || record.turn} 页`}截图`;
    preview.append(image);
    return preview;
  }

  preview.classList.add("empty");
  preview.textContent = record.missingImage ? "未上传图片" : (label || `第 ${record.page || record.turn} 页`);
  return preview;
}

function legacyCreateTurn(record, index) {
  const turn = document.createElement("article");
  turn.className = "turn";
  turn.dataset.turn = String(record.turn || index + 1);
  if (record.page && recordHasImage(record)) {
    turn.dataset.page = String(record.page);
  } else if (record.expectedPage || record.page) {
    turn.dataset.expectedPage = String(record.expectedPage || record.page);
  }

  const userRow = document.createElement("div");
  userRow.className = "user-row";
  userRow.append(createSlidePreview(record));

  const userBubble = document.createElement("div");
  userBubble.className = "user-bubble";
  userBubble.textContent = cleanUserText(record.userText);
  userRow.append(userBubble);

  const meta = document.createElement("div");
  meta.className = "turn-meta";
  let pageLabel = "未匹配页码";
  if (recordHasImage(record) && record.page) {
    pageLabel = `第 ${record.page} 页`;
  } else if (record.missingImage) {
    pageLabel = record.expectedPage || record.page
      ? `未上传图片 · 预计第 ${record.expectedPage || record.page} 页`
      : "未上传图片";
  }
  meta.textContent = `${pageLabel} · Gemini 原始记录 ${record.turn || index + 1}`;

  const answer = document.createElement("div");
  answer.className = "answer";
  renderAnswer(answer, record);

  const assistantRow = document.createElement("div");
  assistantRow.className = "assistant-row";
  assistantRow.append(answer);
  turn.append(userRow, meta, assistantRow);
  return turn;
}

function legacyRenderRecent(records) {
  if (!elements.recentList) return;
  const buttons = records.map((record, index) => {
    const turnNumber = Number(record.turn || index + 1);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-item";
    item.dataset.turn = String(turnNumber);
    if (record.page && recordHasImage(record)) item.dataset.page = String(record.page);
    if (record.missingImage && (record.expectedPage || record.page)) {
      item.dataset.expectedPage = String(record.expectedPage || record.page);
    }
    item.textContent = String(turnNumber);
    item.setAttribute("aria-label", record.page && recordHasImage(record)
      ? `第 ${turnNumber} 条记录，第 ${record.page} 页`
      : record.missingImage && (record.expectedPage || record.page)
        ? `第 ${turnNumber} 条记录，未上传图片，预计第 ${record.expectedPage || record.page} 页`
      : `第 ${turnNumber} 条记录`);
    item.addEventListener("click", () => {
      const selector = record.page && recordHasImage(record)
        ? `.turn[data-page="${record.page}"][data-turn="${turnNumber}"], .turn[data-page="${record.page}"]`
        : `.turn[data-turn="${turnNumber}"]`;
      const turn = elements.chatScroll.querySelector(selector);
      scrollTurnIntoView(turn, "smooth");
      state.turn = turnNumber;
      if (record.page && recordHasImage(record)) {
        state.page = Number(record.page);
        markActive(state.page, state.turn);
        setPdfPage(state.page, { forceManual: true, reason: "recent-click" });
      } else if (record.missingImage && (record.expectedPage || record.page)) {
        state.page = Number(record.expectedPage || record.page);
        markActive(state.page, state.turn);
      }
    });
    return item;
  });
  elements.recentList.replaceChildren(...buttons);
}

function createTurn(record, index) {
  const promptIndex = index + 1;
  const mappedPage = pageFromPromptIndex(promptIndex);
  const turnNumber = Number(record.turn || promptIndex);
  const turn = document.createElement("article");
  turn.className = "turn";
  turn.dataset.turn = String(turnNumber);
  turn.dataset.promptIndex = String(promptIndex);
  if (mappedPage) turn.dataset.page = String(mappedPage);

  const userRow = document.createElement("div");
  userRow.className = "user-row";
  userRow.append(createSlidePreview(record));

  const userBubble = document.createElement("div");
  userBubble.className = "user-bubble";
  userBubble.textContent = cleanUserText(record.userText);
  userRow.append(userBubble);

  const meta = document.createElement("div");
  meta.className = "turn-meta";
  const mappedEnd = mappedPage ? Math.min(Number(state.transcript?.totalPages || mappedPage), mappedPage + configuredPagesPerPrompt() - 1) : 0;
  const storedLabel = pageRangeLabel(record.pageStart || mappedPage, record.pageEnd || mappedEnd);
  const pageLabel = mappedPage
    ? `默认${storedLabel || pageRangeLabel(mappedPage, mappedEnd)}`
    : "多出来的 Gemini 记录";
  meta.textContent = `${pageLabel} · Gemini 原始记录 ${turnNumber}`;

  const answer = document.createElement("div");
  answer.className = "answer";
  renderAnswer(answer, record);

  const assistantRow = document.createElement("div");
  assistantRow.className = "assistant-row";
  assistantRow.append(answer);
  turn.append(userRow, meta, assistantRow);
  return turn;
}

function renderRecent(records) {
  if (!elements.recentList) return;
  const buttons = records.map((record, index) => {
    const promptIndex = index + 1;
    const mappedPage = pageFromPromptIndex(promptIndex);
    const turnNumber = Number(record.turn || promptIndex);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "recent-item";
    item.dataset.turn = String(turnNumber);
    item.dataset.promptIndex = String(promptIndex);
    if (mappedPage) item.dataset.page = String(mappedPage);
    item.textContent = String(turnNumber);
    const mappedEnd = mappedPage ? Math.min(Number(state.transcript?.totalPages || mappedPage), mappedPage + configuredPagesPerPrompt() - 1) : 0;
    const storedLabel = pageRangeLabel(record.pageStart || mappedPage, record.pageEnd || mappedEnd);
    item.setAttribute("aria-label", mappedPage
      ? `第 ${turnNumber} 条记录，默认对应${storedLabel || pageRangeLabel(mappedPage, mappedEnd)}`
      : `第 ${turnNumber} 条记录，没有默认对应页`);
    item.addEventListener("click", () => {
      const selector = `.turn[data-prompt-index="${promptIndex}"], .turn[data-turn="${turnNumber}"]`;
      const turn = elements.chatScroll.querySelector(selector);
      scrollTurnIntoView(turn, "smooth");
      state.turn = turnNumber;
      if (mappedPage) {
        state.page = mappedPage;
        markActive(state.page, state.turn);
        setPdfPage(state.page, { forceManual: true, reason: "recent-click", promptIndex });
      }
    });
    return item;
  });
  elements.recentList.replaceChildren(...buttons);
}

function renderTranscript() {
  elements.chatTitle.textContent = state.transcript.title || state.deck.title || "Gemini 全记录";
  elements.openLiveGemini.onclick = () => {
    const url = state.transcript.conversationUrl || state.deck?.geminiUrl;
    if (url) window.open(url, "_blank", "noopener");
  };

  const records = state.transcript.records || [];
  if (elements.recordCount) elements.recordCount.textContent = `${records.length} 条记录`;
  renderRecent(records);
  elements.chatScroll.replaceChildren(...records.map(createTurn));

  for (const turn of elements.chatScroll.querySelectorAll(".turn")) {
    turn.addEventListener("click", () => {
      const promptIndex = getPromptIndexFromTurn(turn);
      const page = pageFromPromptIndex(promptIndex);
      if (!page) return;
      state.page = page;
      state.turn = Number(turn.dataset.turn) || 0;
      markActive(page, state.turn);
      setPdfPage(page, { forceManual: true, reason: "turn-click", promptIndex });
    });
  }

  state.observer?.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    if (Date.now() < state.suppressGeminiAutoUntil) return;
    const visibleTurn = currentVisibleTurn();
    if (!visibleTurn) return;
    const promptIndex = getPromptIndexFromTurn(visibleTurn);
    const page = pageFromPromptIndex(promptIndex);
    if (!page) return;
    const turn = Number(visibleTurn.dataset.turn) || 0;
    if (page === state.page && turn === state.turn) return;
    state.page = page;
    state.turn = turn;
    markActive(page, turn);
    setPdfPage(page, { reason: "auto", promptIndex });
  }, {
    root: elements.chatScroll,
    threshold: [0.18, 0.32, 0.48, 0.62],
  });

  for (const turn of elements.chatScroll.querySelectorAll(".turn")) state.observer.observe(turn);

  const current = findTurnForPage(state.page) || elements.chatScroll.querySelector(".turn");
  state.turn = Number(current?.dataset.turn) || 0;
  scrollTurnIntoView(current);
  markActive(pageFromPromptIndex(getPromptIndexFromTurn(current)) || state.page, state.turn);
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (handleInteractiveResizeMessage(event, data)) return;
  if (data?.source !== "gemsync-app-iframe") return;

  if (data.type === "gemsync:pdf-state") {
    state.pdfAutoSyncEnabled = !!data.payload?.autoSyncEnabled;
    if (!state.pdfAutoSyncEnabled) return;
    if (Date.now() < state.suppressPdfEventUntil) return;
    const page = Number(data.payload?.pageNumber) || 1;
    const turn = findTurnForPage(page, data.payload);
    if (!turn) return;
    const nextTurn = Number(turn?.dataset.turn) || 0;
    if (page === state.page && nextTurn === state.turn) return;
    state.page = page;
    state.turn = nextTurn;
    suppressGeminiAutoSync();
    markActive(page, state.turn);
    scrollTurnIntoView(turn, "auto");
    return;
  }

  if (!data.id) return;
  try {
    Promise.resolve(handlePdfFrameCommand(data))
      .then((result) => respondToPdfFrame(event, data.id, result))
      .catch((error) => respondToPdfFrame(event, data.id, { ok: false, error: error.message }));
  } catch (error) {
    respondToPdfFrame(event, data.id, { ok: false, error: error.message });
  }
});

window.addEventListener("resize", () => {
  window.clearTimeout(state.interactiveResizeTimer);
  state.interactiveResizeTimer = window.setTimeout(() => {
    for (const frame of document.querySelectorAll(".interactive-frame")) {
      refreshInteractiveFrameHeight(frame);
    }
  }, 180);
});

loadConfig()
  .then(() => {
    initTheme();
    renderTranscript();
    setPdfPage(state.page, { forceManual: true, reason: "init" });
  })
  .catch((error) => {
    elements.chatTitle.textContent = error.message;
  });
