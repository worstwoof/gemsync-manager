import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);

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

function required(args, key) {
  const value = args.get(key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function optional(args, key, fallback) {
  return args.get(key) || fallback;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findPythonWithPillow() {
  const candidates = [
    process.env.GEMSYNC_PYTHON,
    "F:\\Environment\\file_reader_env\\python.exe",
    "python",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(":") && !(await pathExists(candidate))) continue;
    try {
      await execFileAsync(candidate, ["-c", "from PIL import Image; print('ok')"], { timeout: 8000 });
      return candidate;
    } catch {
      // Try the next Python candidate.
    }
  }
  return "";
}

function slideFileName(deckId, page) {
  return `${deckId}_slide${String(page).padStart(3, "0")}.png`;
}

function padNumber(value, size) {
  return String(Math.max(0, Number(value) || 0)).padStart(size, "0");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hostFromBlobUrl(value) {
  const match = String(value || "").match(/^blob:https:\/\/([^/]+)/i);
  return match?.[1] || "";
}

function guessAssetExtension(url, contentType = "") {
  let ext = "";
  try {
    ext = path.extname(new URL(url).pathname).toLowerCase();
  } catch {
    ext = "";
  }
  if (/^\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|json|wasm)$/i.test(ext)) {
    return ext;
  }
  const type = String(contentType || "").toLowerCase();
  if (type.includes("css")) return ".css";
  if (type.includes("javascript") || type.includes("ecmascript")) return ".js";
  if (type.includes("svg")) return ".svg";
  if (type.includes("png")) return ".png";
  if (type.includes("jpeg") || type.includes("jpg")) return ".jpg";
  if (type.includes("webp")) return ".webp";
  if (type.includes("woff2")) return ".woff2";
  if (type.includes("woff")) return ".woff";
  if (/fonts\.googleapis\.com\/css/i.test(url)) return ".css";
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/i.test(url)) return ".js";
  return ".bin";
}

function collectRemoteAssetUrls(html) {
  const urls = new Set();
  const pattern = /\b(?:src|href)=["'](https?:\/\/[^"']+)["']/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    urls.add(match[1].replace(/&amp;/g, "&"));
  }
  return [...urls];
}

function collectCssAssetUrls(css, baseUrl) {
  const refs = [];
  const pattern = /url\(\s*(['"]?)([^"')]+)\1\s*\)/gi;
  let match;
  while ((match = pattern.exec(String(css || "")))) {
    const raw = match[2].trim();
    if (!raw || /^(data:|blob:|#)/i.test(raw)) continue;
    try {
      refs.push({ raw, url: new URL(raw, baseUrl).href });
    } catch {}
  }
  return refs;
}

async function cacheRemoteAsset(url, vendorDir, assetCache) {
  if (assetCache.has(url)) return assetCache.get(url);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 GemSyncManager/1.0",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const filename = `${hash}${guessAssetExtension(url, contentType)}`;
    const filePath = path.join(vendorDir, filename);

    await fs.mkdir(vendorDir, { recursive: true });
    assetCache.set(url, filePath);

    if (filename.endsWith(".css")) {
      let css = buffer.toString("utf8");
      for (const ref of collectCssAssetUrls(css, url)) {
        const nestedPath = await cacheRemoteAsset(ref.url, vendorDir, assetCache);
        if (!nestedPath) continue;
        const relative = path.relative(path.dirname(filePath), nestedPath).replace(/\\/g, "/");
        css = css.replace(new RegExp(escapeRegExp(ref.raw), "g"), relative);
      }
      await fs.writeFile(filePath, css, "utf8");
    } else {
      await fs.writeFile(filePath, buffer);
    }
    return filePath;
  } catch (error) {
    console.warn(`WARN interactive asset cache failed ${url}: ${error.message}`);
    assetCache.set(url, "");
    return "";
  }
}

async function localizeInteractiveHtml(html, htmlDir, vendorDir, assetCache) {
  let output = String(html || "").replace(
    /<meta\b[^>]*http-equiv=["']content-security-policy["'][^>]*>/gi,
    "",
  );

  for (const url of collectRemoteAssetUrls(output)) {
    const localPath = await cacheRemoteAsset(url, vendorDir, assetCache);
    if (!localPath) continue;
    const relative = path.relative(htmlDir, localPath).replace(/\\/g, "/");
    output = output.replace(new RegExp(escapeRegExp(url), "g"), relative);
    output = output.replace(new RegExp(escapeRegExp(url.replace(/&/g, "&amp;")), "g"), relative);
  }

  return output;
}

async function ensureGeminiLoaded(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  let lastState = null;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const hasContent = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const containers = document.querySelectorAll(
        ".conversation-container, user-query-content, message-content, .model-response, model-response",
      ).length;
      return {
        ready: containers > 0 || body.includes("Gemini 说") || (body.includes("你说") && body.length > 1200),
        bodyLength: body.length,
        containers,
        isLoginPage: body.includes("登录") && body.includes("Gemini") && !body.includes("Gemini 说"),
        url: location.href,
      };
    });
    lastState = hasContent;
    if (hasContent.ready && hasContent.bodyLength > 500) return;
    if (hasContent.isLoginPage) {
      throw new Error("Gemini is not logged in in the automation Chrome profile. Open Gemini in that Chrome window and sign in first.");
    }
    if (attempt === 3 || attempt === 7) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
    await page.waitForTimeout(8000);
  }

  throw new Error(
    `Gemini conversation did not render chat content after reloads. ` +
      `Current URL: ${lastState?.url || page.url()}; body length: ${lastState?.bodyLength || 0}.`,
  );
}

async function getChatState(page) {
  return page.evaluate(() => {
    const scroller =
      document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
      document.querySelector("#chat-history infinite-scroller") ||
      document.querySelector("infinite-scroller.chat-history");
    const containers = Array.from(
      document.querySelectorAll(".conversation-container.message-actions-hover-boundary, .conversation-container"),
    );
    return {
      hasScroller: Boolean(scroller),
      scrollTop: scroller?.scrollTop ?? 0,
      scrollHeight: scroller?.scrollHeight ?? 0,
      clientHeight: scroller?.clientHeight ?? 0,
      count: containers.length,
      firstId: containers[0]?.id || "",
      lastId: containers.at(-1)?.id || "",
      firstText: (containers[0]?.innerText || containers[0]?.textContent || "").slice(0, 120),
      lastText: (containers.at(-1)?.innerText || containers.at(-1)?.textContent || "").slice(0, 120),
    };
  });
}

async function loadFullConversation(page, minimumTurns) {
  let stableTopSamples = 0;
  let previous = await getChatState(page);
  if (!previous.hasScroller) throw new Error("Gemini chat scroller was not found.");

  for (let step = 1; step <= 90; step += 1) {
    await page.evaluate(() => {
      const scroller =
        document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
        document.querySelector("#chat-history infinite-scroller") ||
        document.querySelector("infinite-scroller.chat-history");
      if (scroller) {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
    });
    await page.waitForTimeout(3500);
    const current = await getChatState(page);
    console.log(
      `LOAD step=${step} turns=${current.count} scrollTop=${Math.round(current.scrollTop)} ` +
        `height=${current.scrollHeight} first=${JSON.stringify(current.firstText.slice(0, 36))}`,
    );

    const isSameTop =
      current.count === previous.count &&
      current.firstId === previous.firstId &&
      Math.round(current.scrollTop) === 0;
    stableTopSamples = isSameTop ? stableTopSamples + 1 : 0;
    previous = current;

    if (current.count >= minimumTurns && Math.round(current.scrollTop) === 0 && stableTopSamples >= 2) {
      return current;
    }
  }

  return previous;
}

function buildExtractionFunction() {
  return ({ totalPages, deckId, prompt, pagesPerPrompt }) => {
    const promptPageCount = Math.max(1, Math.min(3, Math.floor(Number(pagesPerPrompt) || 1)));
    function normalizeText(value) {
      return String(value || "")
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function queryOutsideThoughts(root, selector) {
      const candidates = Array.from(root.querySelectorAll(selector));
      return (
        candidates.find((el) => !el.closest("model-thoughts, .thoughts-container, .thoughts-content")) ||
        null
      );
    }

    function cloneWithoutNoise(element) {
      const clone = element.cloneNode(true);
      clone
        .querySelectorAll(
          [
            "button",
            "mat-icon",
            "model-thoughts",
            ".thoughts-container",
            ".thoughts-content",
            "sources-carousel-inline",
            "source-inline-chips",
            "source-inline-chip",
            ".source-inline-chip-container",
            ".copy-button",
            ".action-button",
            ".table-footer",
            ".export-sheets-button",
            ".generated-image-controls",
            ".hide-from-message-actions",
          ].join(","),
        )
        .forEach((node) => node.remove());
      return clone;
    }

    function replaceMath(root) {
      const nodes = Array.from(root.querySelectorAll("[data-math]")).filter((node) => {
        const parentMath = node.parentElement?.closest("[data-math]");
        return !parentMath;
      });
      for (const node of nodes) {
        const tex = node.getAttribute("data-math") || "";
        if (!tex.trim()) continue;
        const isInline = node.classList.contains("math-inline");
        const replacement = document.createElement(isInline ? "span" : "div");
        replacement.textContent = isInline ? `$${tex}$` : `\n\n$$\n${tex}\n$$\n\n`;
        node.replaceWith(replacement);
      }
    }

    function replaceCode(root) {
      const blocks = Array.from(root.querySelectorAll("code-block, .code-block, pre"));
      for (const block of blocks) {
        const codeNode =
          block.querySelector?.('code[role="text"], [data-test-id="code-content"], code') ||
          (block.tagName?.toLowerCase() === "pre" ? block.querySelector("code") : null);
        const code = codeNode?.textContent || "";
        if (!code.trim()) continue;
        const languageLabel =
          block.querySelector?.(".code-block-decoration")?.textContent ||
          codeNode?.className?.match?.(/language-([a-z0-9_-]+)/i)?.[1] ||
          "";
        const language = normalizeText(languageLabel).toLowerCase();
        const replacement = document.createElement("pre");
        replacement.textContent = `\n\`\`\`${language}\n${code.replace(/\n+$/g, "")}\n\`\`\`\n`;
        block.replaceWith(replacement);
      }
    }

    function tableToMarkdown(table) {
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((row) =>
          Array.from(row.querySelectorAll("th,td")).map((cell) =>
            normalizeText(cell.textContent).replaceAll("|", "\\|"),
          ),
        )
        .filter((row) => row.length);
      if (!rows.length) return "";
      const width = Math.max(...rows.map((row) => row.length));
      const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
      const header = normalized[0];
      const body = normalized.slice(1);
      return [
        `| ${header.join(" | ")} |`,
        `| ${header.map(() => "---").join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
      ].join("\n");
    }

    function replaceTables(root) {
      for (const table of Array.from(root.querySelectorAll("table"))) {
        const md = tableToMarkdown(table);
        if (!md) continue;
        const replacement = document.createElement("pre");
        replacement.textContent = `\n${md}\n`;
        table.replaceWith(replacement);
      }
    }

    function escapeHtml(value) {
      return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function escapeHtmlAttribute(value) {
      return escapeHtml(value).replaceAll("\n", "&#10;");
    }

    function extractCodeHtml(element) {
      const codeNode = element.querySelector?.('code[role="text"], [data-test-id="code-content"], code');
      const code = codeNode?.textContent || "";
      if (!code.trim()) return "";
      const languageLabel =
        element.querySelector?.(".code-block-decoration")?.textContent ||
        codeNode?.className?.match?.(/language-([a-z0-9_-]+)/i)?.[1] ||
        "";
      const language = normalizeText(languageLabel).toLowerCase();
      return `<pre><code class="language-${escapeHtmlAttribute(language)}">${escapeHtml(code)}</code></pre>`;
    }

    function cleanTableHtml(table) {
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("th,td"))
            .map((cell) => `<${cell.tagName.toLowerCase()}>${serializeChildren(cell)}</${cell.tagName.toLowerCase()}>`)
            .join("");
          return cells ? `<tr>${cells}</tr>` : "";
        })
        .filter(Boolean);
      return rows.length ? `<table><tbody>${rows.join("")}</tbody></table>` : "";
    }

    function shouldSkipHtmlElement(element) {
      const tag = element.tagName.toLowerCase();
      return (
        tag === "button" ||
        tag === "mat-icon" ||
        tag === "model-thoughts" ||
        tag === "sources-carousel-inline" ||
        tag === "source-inline-chips" ||
        tag === "source-inline-chip" ||
        tag === "share-button" ||
        tag === "copy-button" ||
        tag === "download-generated-image-button" ||
        element.classList.contains("thoughts-container") ||
        element.classList.contains("thoughts-content") ||
        element.classList.contains("source-inline-chip-container") ||
        element.classList.contains("copy-button") ||
        element.classList.contains("action-button") ||
        element.classList.contains("table-footer") ||
        element.classList.contains("export-sheets-button") ||
        element.classList.contains("generated-image-controls") ||
        element.classList.contains("hide-from-message-actions")
      );
    }

    function serializeChildren(element) {
      return Array.from(element.childNodes).map(serializeNode).join("");
    }

    function serializeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return escapeHtml(node.textContent || "").replace(/\n/g, "<br>");
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";

      const element = node;
      if (shouldSkipHtmlElement(element)) return "";

      const math = element.getAttribute("data-math");
      if (math) {
        const tag = element.classList.contains("math-block") ? "div" : "span";
        const cls = tag === "div" ? "math-display" : "math-inline";
        return `<${tag} class="${cls}" data-math="${escapeHtmlAttribute(math)}"></${tag}>`;
      }

      const tag = element.tagName.toLowerCase();
      if (tag === "code-block" || element.classList.contains("code-block")) {
        return extractCodeHtml(element);
      }
      if (tag === "table") return cleanTableHtml(element);
      if (tag === "br" || tag === "hr") return `<${tag}>`;
      if (tag === "img") return "";

      const children = serializeChildren(element);
      const allowedBlockTags = new Set([
        "p",
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
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
      ]);

      if (!allowedBlockTags.has(tag)) return children;

      if (tag === "code") {
        const className = String(element.getAttribute("class") || "")
          .split(/\s+/)
          .filter((name) => /^language-[a-z0-9_-]+$/i.test(name))
          .join(" ");
        return `<code${className ? ` class="${escapeHtmlAttribute(className)}"` : ""}>${children}</code>`;
      }

      return `<${tag}>${children}</${tag}>`;
    }

    function extractAssistantHtml(element) {
      const source =
        queryOutsideThoughts(element, ".markdown-main-panel, .markdown") ||
        queryOutsideThoughts(element, "message-content") ||
        element;
      return serializeChildren(source);
    }

    function extractAssistant(container) {
      const source =
        queryOutsideThoughts(container, "message-content") ||
        queryOutsideThoughts(container, ".markdown-main-panel, .markdown, .model-response-text") ||
        queryOutsideThoughts(container, ".model-response, model-response, .response-container");
      if (!source) return { text: "", html: "" };
      const clone = cloneWithoutNoise(source);
      replaceMath(clone);
      replaceCode(clone);
      replaceTables(clone);
      return {
        text: normalizeText(clone.innerText || clone.textContent || ""),
        html: extractAssistantHtml(source),
      };
    }

    function extractUser(container) {
      const user =
        container.querySelector("user-query-content") ||
        container.querySelector(".user-query-bubble-with-background") ||
        container.querySelector(".user-query-bubble-container") ||
        container.querySelector(".user-query-container");
      if (!user) return { text: "", hasImage: false };
      const imageNodes = Array.from(user.querySelectorAll("user-query-file-preview img, .preview-image, img")).filter(
        (img) => (img.getAttribute("src") || img.src || "").trim(),
      );
      const textLines = Array.from(user.querySelectorAll(".query-text-line"))
        .map((line) => line.getAttribute("data-user-latex-original") || line.textContent || "")
        .map(normalizeText)
        .filter(Boolean);
      let text = textLines.join("\n");
      if (!text) {
        text = normalizeText(user.innerText || user.textContent || "");
        text = text.replace(/^你说\s*/u, "").replace(/^User\s*/iu, "").trim();
      }
      return {
        text: text || prompt,
        hasImage: imageNodes.length > 0,
        remoteImageCount: imageNodes.length,
        remoteImageUrls: imageNodes.map((image) => image.src || image.getAttribute("src") || "").filter(Boolean),
        remoteImageUrl: imageNodes[0]?.src || imageNodes[0]?.getAttribute("src") || "",
      };
    }

    const containers = Array.from(
      document.querySelectorAll(".conversation-container.message-actions-hover-boundary, .conversation-container"),
    );

    let imagePage = 0;
    return containers
      .map((container, index) => {
        const user = extractUser(container);
        const assistant = extractAssistant(container);
        const assistantText = assistant.text;
        if (!user.text && !assistantText) return null;

        let page = null;
        let pageStart = null;
        let pageEnd = null;
        let pageCount = 0;
        let expectedPage = null;
        if (user.hasImage) {
          pageCount = Math.max(1, Math.min(promptPageCount, Number(user.remoteImageCount || 1), totalPages - imagePage));
          pageStart = Math.min(totalPages, imagePage + 1);
          imagePage = Math.min(totalPages, imagePage + pageCount);
          pageEnd = imagePage;
          page = pageStart;
        } else {
          expectedPage = Math.min(totalPages, Math.max(1, imagePage + 1));
        }

        const record = {
          turn: index + 1,
          containerIndex: index,
          conversationTurnId: container.id || "",
          userText: user.text || prompt,
          assistantText,
          assistantHtml: assistant.html,
          hasUserImage: Boolean(user.hasImage),
          missingImage: !user.hasImage,
          consumesSlide: Boolean(user.hasImage),
          consumesSlides: user.hasImage ? pageCount : 0,
          remoteImageUrl: user.remoteImageUrl || "",
          remoteImageCount: user.remoteImageCount || 0,
          remoteImageUrls: user.remoteImageUrls || [],
        };

        if (page) {
          record.page = page;
          record.pageStart = pageStart;
          record.pageEnd = pageEnd;
          record.pages = Array.from({ length: Math.max(0, pageEnd - pageStart + 1) }, (_value, offset) => pageStart + offset);
        } else if (expectedPage) {
          record.expectedPage = expectedPage;
        }

        if (user.hasImage && page <= totalPages) {
          const imageName = `${deckId}_slide${String(page).padStart(3, "0")}.png`;
          record.imageName = imageName;
          record.slideImageUrl = `../screenshots/${deckId}/${imageName}`;
          record.slideImageUrls = record.pages.map((item) => `../screenshots/${deckId}/${deckId}_slide${String(item).padStart(3, "0")}.png`);
        }

        return record;
      })
      .filter(Boolean);
  };
}

async function copyScreenshots({ sourceDir, destDir, deckId, totalPages }) {
  await fs.mkdir(destDir, { recursive: true });
  for (let page = 1; page <= totalPages; page += 1) {
    const name = slideFileName(deckId, page);
    const source = path.join(sourceDir, name);
    const dest = path.join(destDir, name);
    await fs.copyFile(source, dest);
  }
}

async function updateConfig(configPath, deckId, transcriptUrl) {
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const deck = config.decks?.find((item) => item.id === deckId);
  if (!deck) throw new Error(`Deck ${deckId} not found in ${configPath}`);
  deck.transcriptUrl = transcriptUrl;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function getInteractiveFrameInfos(page) {
  return page.evaluate(() => {
    const scroller =
      document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
      document.querySelector("#chat-history infinite-scroller") ||
      document.querySelector("infinite-scroller.chat-history");
    const containers = Array.from(
      document.querySelectorAll(".conversation-container.message-actions-hover-boundary, .conversation-container"),
    );
    return Array.from(document.querySelectorAll('iframe[src*="usercontent.goog"][src*="/gemini-code-immersive/shim.html"]'))
      .map((iframe, index) => {
        const container = iframe.closest(
          ".conversation-container.message-actions-hover-boundary, .conversation-container",
        );
        const rect = iframe.getBoundingClientRect();
        let host = "";
        try {
          host = new URL(iframe.src).host;
        } catch {}
        return {
          index,
          src: iframe.src || "",
          host,
          containerId: container?.id || "",
          containerIndex: containers.indexOf(container),
          width: Math.round(rect.width || iframe.clientWidth || 0),
          height: Math.round(rect.height || iframe.clientHeight || 0),
          top: Math.round(rect.top || 0),
          scrollTop: Math.round(scroller?.scrollTop || 0),
        };
      })
      .filter((item) => item.host && item.containerIndex >= 0);
  });
}

async function collectInteractiveFrameInfos(page) {
  const seen = new Map();
  const addInfos = (infos) => {
    for (const info of infos) {
      if (!info?.host) continue;
      const prior = seen.get(info.host);
      if (!prior || info.containerIndex < prior.containerIndex || (info.height && !prior.height)) {
        seen.set(info.host, info);
      }
    }
  };

  addInfos(await getInteractiveFrameInfos(page));

  const state = await page.evaluate(() => {
    const scroller =
      document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
      document.querySelector("#chat-history infinite-scroller") ||
      document.querySelector("infinite-scroller.chat-history");
    return {
      hasScroller: Boolean(scroller),
      scrollTop: Math.round(scroller?.scrollTop || 0),
      scrollHeight: Math.round(scroller?.scrollHeight || 0),
      clientHeight: Math.round(scroller?.clientHeight || 0),
    };
  });

  if (!state.hasScroller || state.scrollHeight <= state.clientHeight) {
    return [...seen.values()].sort((a, b) => a.containerIndex - b.containerIndex);
  }

  const step = Math.max(1600, Math.round((state.clientHeight || 900) * 2.1));
  const positions = [];
  for (let top = 0; top <= state.scrollHeight; top += step) positions.push(top);
  positions.push(Math.max(0, state.scrollHeight - state.clientHeight));

  for (const top of [...new Set(positions)]) {
    await page.evaluate((nextTop) => {
      const scroller =
        document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
        document.querySelector("#chat-history infinite-scroller") ||
        document.querySelector("infinite-scroller.chat-history");
      if (!scroller) return;
      scroller.scrollTop = nextTop;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, top);
    await page.waitForTimeout(900);
    addInfos(await getInteractiveFrameInfos(page));
  }

  await page.evaluate(() => {
    const scroller =
      document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
      document.querySelector("#chat-history infinite-scroller") ||
      document.querySelector("infinite-scroller.chat-history");
    if (!scroller) return;
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.waitForTimeout(1000);

  const result = [...seen.values()].sort((a, b) => a.containerIndex - b.containerIndex);
  console.log(`INTERACTIVE_SCAN frames=${result.length}`);
  return result;
}

async function scrollInteractiveFrameIntoView(page, frameInfoOrHost) {
  const frameInfo = typeof frameInfoOrHost === "string" ? { host: frameInfoOrHost } : frameInfoOrHost || {};
  const host = frameInfo.host || "";
  const fallbackScrollTop = Number(frameInfo.scrollTop || 0);
  await page
    .evaluate(({ targetHost, scrollTop }) => {
      const iframe = Array.from(
        document.querySelectorAll('iframe[src*="usercontent.goog"][src*="/gemini-code-immersive/shim.html"]'),
      ).find((item) => {
        try {
          return new URL(item.src).host === targetHost;
        } catch {
          return false;
        }
      });
      if (iframe) {
        iframe.scrollIntoView({ block: "center", inline: "nearest" });
        return true;
      }
      const scroller =
        document.querySelector("infinite-scroller.chat-history.enable-lr26-markdown-styling.lm") ||
        document.querySelector("#chat-history infinite-scroller") ||
        document.querySelector("infinite-scroller.chat-history");
      if (scroller && scrollTop) {
        scroller.scrollTop = scrollTop;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      return false;
    }, { targetHost: host, scrollTop: fallbackScrollTop })
    .catch(() => false);
  await page.waitForTimeout(2500);
}

function createTargetTransport(browserSession, targetId) {
  let sessionId = "";
  let nextId = 1;
  const pending = new Map();

  const handler = (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(`${message.error.message || "CDP error"} (${message.error.code || "unknown"})`));
    } else {
      waiter.resolve(message);
    }
  };

  return {
    async attach() {
      const attached = await browserSession.send("Target.attachToTarget", { targetId, flatten: false });
      sessionId = attached.sessionId;
      browserSession.on("Target.receivedMessageFromTarget", handler);
    },
    send(method, params = {}, timeoutMs = 15000) {
      if (!sessionId) throw new Error("Target transport is not attached.");
      const id = nextId;
      nextId += 1;
      const message = JSON.stringify({ id, method, params });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        browserSession
          .send("Target.sendMessageToTarget", { sessionId, message })
          .catch((error) => {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          });
      });
    },
    async detach() {
      browserSession.off?.("Target.receivedMessageFromTarget", handler);
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Detached from target."));
      }
      pending.clear();
      if (sessionId) {
        await browserSession.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    },
  };
}

async function readInteractiveTarget(browserSession, targetInfo) {
  const transport = createTargetTransport(browserSession, targetInfo.targetId);
  await transport.attach();
  try {
    await transport.send("Runtime.enable");
    const response = await transport.send(
      "Runtime.evaluate",
      {
        expression: `(() => {
          const body = document.body;
          const root = document.documentElement;
          const width = Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0, root?.clientWidth || 0, body?.clientWidth || 0);
          const height = Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, root?.clientHeight || 0, body?.clientHeight || 0);
          return {
            title: document.title || body?.querySelector("h1,h2,h3")?.textContent?.trim() || "",
            url: location.href,
            html: root?.outerHTML || "",
            bodyText: (body?.innerText || body?.textContent || "").trim(),
            width,
            height,
            counts: {
              canvas: document.querySelectorAll("canvas").length,
              svg: document.querySelectorAll("svg").length,
              script: document.querySelectorAll("script").length,
              style: document.querySelectorAll("style,link[rel='stylesheet']").length,
              button: document.querySelectorAll("button").length,
            },
          };
        })()`,
        returnByValue: true,
        awaitPromise: true,
        timeout: 10000,
      },
      20000,
    );
    const result = response.result?.result;
    if (result?.subtype === "error" || response.result?.exceptionDetails) {
      throw new Error(response.result?.exceptionDetails?.text || result?.description || "Runtime evaluation failed.");
    }
    return result?.value || null;
  } finally {
    await transport.detach();
  }
}

async function exportInteractiveViews({ browser, page, records, deckId, subjectDir }) {
  let frameInfos = await collectInteractiveFrameInfos(page);

  if (!frameInfos.length) {
    console.log("INTERACTIVE none");
    return [];
  }

  const browserSession = await browser.newBrowserCDPSession();
  const interactiveRoot = path.join(subjectDir, "interactives");
  const deckInteractiveDir = path.join(interactiveRoot, deckId);
  const vendorDir = path.join(interactiveRoot, "vendor");
  const assetCache = new Map();
  const exported = [];
  const usedTargetIds = new Set();

  await fs.mkdir(deckInteractiveDir, { recursive: true });

  async function findBlobTargetForHost(host) {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const targetInfos = (await browserSession.send("Target.getTargets")).targetInfos || [];
      const targetInfo = targetInfos.find((item) => {
        return (
          item.type === "iframe" &&
          String(item.url || "").startsWith("blob:") &&
          hostFromBlobUrl(item.url) === host &&
          !usedTargetIds.has(item.targetId)
        );
      });
      if (targetInfo) return targetInfo;
      await scrollInteractiveFrameIntoView(page, { host });
    }
    return null;
  }

  for (const frameInfo of frameInfos) {
    await scrollInteractiveFrameIntoView(page, frameInfo);
    const targetInfo = await findBlobTargetForHost(frameInfo.host);
    if (!targetInfo) {
      console.warn(`WARN interactive blob target missing for host ${frameInfo.host}`);
      continue;
    }
    usedTargetIds.add(targetInfo.targetId);

    let widget;
    try {
      widget = await readInteractiveTarget(browserSession, targetInfo);
    } catch (error) {
      console.warn(`WARN interactive read failed for ${frameInfo.host}: ${error.message}`);
      continue;
    }
    if (!widget?.html) continue;

    const record =
      records.find((item) => item.conversationTurnId && item.conversationTurnId === frameInfo.containerId) ||
      records.find((item) => Number(item.containerIndex) === frameInfo.containerIndex) ||
      records[frameInfo.containerIndex];
    if (!record) {
      console.warn(`WARN interactive record missing for container ${frameInfo.containerIndex}`);
      continue;
    }

    const widgetIndex = (record.interactiveViews?.length || 0) + 1;
    const turnNumber = record.turn || frameInfo.containerIndex + 1;
    const fileName = `turn${padNumber(turnNumber, 3)}-widget${padNumber(widgetIndex, 2)}.html`;
    const htmlPath = path.join(deckInteractiveDir, fileName);
    const localizedHtml = await localizeInteractiveHtml(widget.html, deckInteractiveDir, vendorDir, assetCache);
    await fs.writeFile(htmlPath, localizedHtml, "utf8");

    const height = Math.max(420, Math.min(960, Math.round(frameInfo.height || widget.height || 640)));
    const width = Math.max(560, Math.min(1200, Math.round(frameInfo.width || widget.width || 760)));
    const view = {
      title: widget.title || "Interactive view",
      kind: "sandbox-html",
      htmlUrl: `../interactives/${deckId}/${fileName}`,
      width,
      height,
      sourceHost: frameInfo.host,
      bodyPreview: String(widget.bodyText || "").slice(0, 240),
      counts: widget.counts || {},
    };

    if (!record.interactiveViews) record.interactiveViews = [];
    record.interactiveViews.push(view);
    exported.push({ turn: turnNumber, title: view.title, path: htmlPath });
    console.log(`INTERACTIVE turn=${turnNumber} title=${JSON.stringify(view.title)} file=${fileName}`);
  }

  console.log(`INTERACTIVE exported=${exported.length}`);
  return exported;
}

async function writeImageMatchHelper(dir) {
  const helperPath = path.join(dir, "match_images.py");
  const source = String.raw`
import json
import re
import sys
from pathlib import Path
from PIL import Image, ImageOps

manifest_path = Path(sys.argv[1])
slides_dir = Path(sys.argv[2])
deck_id = sys.argv[3]

manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

def slide_number(path):
    match = re.search(r"_slide(\d+)", path.name)
    return int(match.group(1)) if match else 0

def vector(path, size=(160, 120)):
    image = ImageOps.exif_transpose(Image.open(path)).convert("L")
    image = image.resize(size, Image.Resampling.LANCZOS)
    return list(image.getdata())

def mse(a, b):
    return sum((x - y) * (x - y) for x, y in zip(a, b)) / len(a) / (255 * 255)

slides = []
for slide_path in sorted(slides_dir.glob(f"{deck_id}_slide*.png"), key=slide_number):
    try:
        slides.append({
            "page": slide_number(slide_path),
            "name": slide_path.name,
            "vector": vector(slide_path),
        })
    except Exception:
        pass

results = []
for item in manifest:
    try:
        remote_vector = vector(Path(item["path"]))
        ranked = sorted(
            (
                {
                    "page": slide["page"],
                    "imageName": slide["name"],
                    "score": mse(remote_vector, slide["vector"]),
                }
                for slide in slides
            ),
            key=lambda row: row["score"],
        )
        if ranked:
            best = ranked[0]
            second = ranked[1]["score"] if len(ranked) > 1 else 1
            best["turn"] = item["turn"]
            best["secondScore"] = second
            best["margin"] = second - best["score"]
            results.append(best)
    except Exception as error:
        results.append({"turn": item.get("turn"), "error": str(error)})

print(json.dumps(results, ensure_ascii=False))
`;
  await fs.writeFile(helperPath, source.trimStart(), "utf8");
  return helperPath;
}

function applyExpectedPages(records, totalPages) {
  const pageLimit = Math.max(1, Number(totalPages) || 1);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const hasImage = record.hasUserImage === true && record.missingImage !== true;
    record.consumesSlide = hasImage;
    if (hasImage) {
      const start = Number(record.pageStart || record.page || 0);
      const end = Number(record.pageEnd || start || 0);
      if (start > 0 && end >= start) {
        record.page = start;
        record.pageStart = start;
        record.pageEnd = Math.min(pageLimit, end);
        record.pages = Array.from({ length: record.pageEnd - record.pageStart + 1 }, (_value, offset) => record.pageStart + offset);
        record.consumesSlides = record.pages.length;
      }
      delete record.expectedPage;
      continue;
    }

    const previousPage = records
      .slice(0, index)
      .reverse()
      .find((item) => item.hasUserImage === true && item.missingImage !== true && Number(item.page))?.page;
    const nextPage = records
      .slice(index + 1)
      .find((item) => item.hasUserImage === true && item.missingImage !== true && Number(item.page))?.page;
    record.hasUserImage = false;
    record.missingImage = true;
    record.consumesSlide = false;
    record.expectedPage = Math.min(pageLimit, Math.max(1, Number(nextPage || previousPage + 1 || 1)));
    delete record.page;
    delete record.pageStart;
    delete record.pageEnd;
    delete record.pages;
    delete record.imageName;
    delete record.slideImageUrl;
    delete record.slideImageUrls;
    delete record.imageUrl;
    delete record.thumbnailUrl;
  }
}

function inferPageFromText(record, deckId, totalPages) {
  const pageLimit = Math.max(1, Number(totalPages) || 1);
  const escapedDeckId = String(deckId || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = `${record.assistantText || ""}\n${record.assistantHtml || ""}\n${record.imageName || ""}`;
  const patterns = [
    new RegExp(`${escapedDeckId}_slide0*(\\d{1,4})\\.png`, "i"),
    /deck\d+_slide0*(\d{1,4})\.png/i,
    /slide0*(\d{1,4})\.png/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const page = Number(match?.[1] || 0);
    if (page >= 1 && page <= pageLimit) return page;
  }
  return 0;
}

function setRecordPage(record, deckId, page, source) {
  record.page = page;
  record.pageStart = page;
  record.pageEnd = Math.max(page, Number(record.pageEnd || page));
  record.pages = Array.from(
    { length: Math.max(1, record.pageEnd - record.pageStart + 1) },
    (_value, offset) => record.pageStart + offset,
  );
  record.imageName = slideFileName(deckId, page);
  record.slideImageUrl = `../screenshots/${deckId}/${record.imageName}`;
  record.slideImageUrls = record.pages.map((item) => `../screenshots/${deckId}/${slideFileName(deckId, item)}`);
  record.consumesSlide = true;
  record.consumesSlides = record.pages.length;
  record.pageSource = source;
  delete record.expectedPage;
}

function applyTextPageHints(records, deckId, totalPages) {
  let applied = 0;
  for (const record of records) {
    if (record.hasUserImage !== true || record.missingImage === true) continue;
    const page = inferPageFromText(record, deckId, totalPages);
    if (!page) continue;
    setRecordPage(record, deckId, page, "assistant_filename");
    applied += 1;
  }
  return applied;
}

function slideRecordScore(record) {
  const interactive = Array.isArray(record.interactiveViews) ? record.interactiveViews.length : 0;
  return (record.pageSource === "assistant_filename" ? 100000 : 0)
    + (interactive ? 5000 + interactive * 100 : 0)
    + Math.min(4000, String(record.assistantText || "").length)
    + Number(record.turn || 0) / 1000;
}

function dedupeSlideRecords(records, totalPages) {
  const pageLimit = Math.max(1, Number(totalPages) || 1);
  const bestByPage = new Map();
  const duplicateRecords = new Set();

  for (const record of records) {
    const pages = Array.isArray(record.pages) && record.pages.length
      ? record.pages.map((item) => Number(item)).filter((item) => item >= 1 && item <= pageLimit)
      : [Number(record.page || 0)].filter((item) => item >= 1 && item <= pageLimit);
    const consumesPage = record.hasUserImage === true
      && record.missingImage !== true
      && pages.length > 0;
    if (!consumesPage) continue;

    for (const page of pages) {
      const current = bestByPage.get(page);
      if (!current || slideRecordScore(record) >= slideRecordScore(current)) {
        if (current && current !== record) duplicateRecords.add(current);
        bestByPage.set(page, record);
      } else {
        duplicateRecords.add(record);
      }
    }
  }

  let removed = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (!duplicateRecords.has(records[index])) continue;
    records.splice(index, 1);
    removed += 1;
  }

  return {
    removed,
    mappedPages: bestByPage.size,
    missingPages: Array.from({ length: pageLimit }, (_value, index) => index + 1)
      .filter((page) => !bestByPage.has(page)),
  };
}

async function matchUploadedImagesToSlides({ context, records, screenshotsDir, deckId, totalPages }) {
  const imageRecords = records.filter((record) => record.hasUserImage && record.remoteImageUrl);
  if (!imageRecords.length) {
    applyExpectedPages(records, totalPages);
    return { matched: 0, attempted: 0, unavailable: true };
  }

  const python = await findPythonWithPillow();
  if (!python) {
    console.warn("WARN image matching skipped: Python with Pillow was not found.");
    applyExpectedPages(records, totalPages);
    return { matched: 0, attempted: imageRecords.length, unavailable: true };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gemsync-match-"));
  try {
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(remoteDir, { recursive: true });
    const manifest = [];

    let cursor = 0;
    async function fetchWorker() {
      while (cursor < imageRecords.length) {
        const record = imageRecords[cursor];
        cursor += 1;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const response = await context.request.get(record.remoteImageUrl, {
              headers: { referer: "https://gemini.google.com/" },
              timeout: 45000,
            });
            if (!response.ok()) {
              console.warn(`WARN image fetch failed turn=${record.turn} status=${response.status()} attempt=${attempt}`);
              continue;
            }
            const contentType = response.headers()["content-type"] || "";
            const ext = guessAssetExtension(record.remoteImageUrl, contentType).replace(".bin", ".png");
            const remotePath = path.join(remoteDir, `turn${padNumber(record.turn, 3)}${ext}`);
            await fs.writeFile(remotePath, await response.body());
            manifest.push({ turn: record.turn, path: remotePath });
            break;
          } catch (error) {
            console.warn(`WARN image fetch failed turn=${record.turn} attempt=${attempt}: ${error.message.split("\n")[0]}`);
            await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
          }
        }
      }
    }

    await Promise.all([fetchWorker(), fetchWorker()]);

    if (!manifest.length) {
      applyExpectedPages(records, totalPages);
      return { matched: 0, attempted: imageRecords.length, unavailable: true };
    }

    const manifestPath = path.join(tmpDir, "manifest.json");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const helperPath = await writeImageMatchHelper(tmpDir);
    const { stdout } = await execFileAsync(
      python,
      [helperPath, manifestPath, screenshotsDir, deckId],
      { maxBuffer: 1024 * 1024 * 16, timeout: 120000 },
    );
    const matches = JSON.parse(stdout || "[]");
    const byTurn = new Map(matches.map((item) => [Number(item.turn), item]));
    let matched = 0;

    for (const record of imageRecords) {
      if (record.pageSource === "assistant_filename") continue;
      const match = byTurn.get(Number(record.turn));
      const confident = match
        && Number(match.page) > 0
        && Number(match.page) <= Number(totalPages)
        && Number(match.score) <= 0.012
        && Number(match.margin) >= 0.008;
      if (!confident) continue;
      record.page = Number(match.page);
      const count = Math.max(1, Number(record.consumesSlides || record.remoteImageCount || 1));
      record.pageStart = record.page;
      record.pageEnd = Math.min(Number(totalPages), record.page + count - 1);
      record.pages = Array.from({ length: record.pageEnd - record.pageStart + 1 }, (_value, offset) => record.pageStart + offset);
      record.imageName = match.imageName || slideFileName(deckId, record.page);
      record.slideImageUrl = `../screenshots/${deckId}/${record.imageName}`;
      record.slideImageUrls = record.pages.map((item) => `../screenshots/${deckId}/${slideFileName(deckId, item)}`);
      record.matchScore = Number(match.score.toFixed(6));
      matched += 1;
    }

    applyExpectedPages(records, totalPages);
    return { matched, attempted: imageRecords.length, unavailable: false };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function hydrateInteractiveViewsFromFiles({ records, deckId, subjectDir }) {
  const deckInteractiveDir = path.join(subjectDir, "interactives", deckId);
  let files = [];
  try {
    files = await fs.readdir(deckInteractiveDir);
  } catch {
    return 0;
  }

  let restored = 0;
  for (const file of files.sort()) {
    const match = /^turn(\d+)-widget(\d+)\.html$/i.exec(file);
    if (!match) continue;
    const turn = Number(match[1]);
    const record = records.find((item) => Number(item.turn) === turn);
    if (!record) continue;

    const htmlUrl = `../interactives/${deckId}/${file}`;
    const existing = Array.isArray(record.interactiveViews) ? record.interactiveViews : [];
    if (existing.some((view) => view.htmlUrl === htmlUrl)) continue;

    let title = "Interactive view";
    try {
      const html = await fs.readFile(path.join(deckInteractiveDir, file), "utf8");
      title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.trim() || title;
    } catch {}

    record.interactiveViews = existing;
    record.interactiveViews.push({
      title,
      kind: "sandbox-html",
      htmlUrl,
      width: 760,
      height: 650,
      restoredFromLocalCache: true,
      counts: {},
    });
    restored += 1;
    console.log(`INTERACTIVE_RESTORED turn=${turn} title=${JSON.stringify(title)} file=${file}`);
  }
  return restored;
}

const args = readArgs();
const chromeUrl = optional(args, "chrome", "http://127.0.0.1:9222");
const url = required(args, "url");
const deckId = required(args, "deck");
const title = required(args, "title");
const totalPages = Number(required(args, "total-pages"));
const subjectDir = path.resolve(optional(args, "subject-dir", path.join(repoRoot, "extension", "pdf-panel", "subjects", "algorithms")));
const screenshotsDir = path.resolve(required(args, "screenshots"));
const prompt = optional(args, "prompt", "请详细讲解这一面PPT");
const prePrompt = optional(args, "pre-prompt", "");
const promptStartIndex = Math.max(1, Number(optional(args, "prompt-start-index", prePrompt ? "2" : "1")) || 1);
const pagesPerPrompt = Math.max(1, Math.min(3, Math.floor(Number(optional(args, "pages-per-prompt", "1")) || 1)));
const transcriptPath = path.resolve(optional(args, "out", path.join(subjectDir, "transcripts", `${deckId}.json`)));
const localScreenshotDir = path.join(subjectDir, "screenshots", deckId);
const configPath = path.join(subjectDir, "config.json");

if (!Number.isInteger(totalPages) || totalPages < 1) {
  throw new Error(`Invalid --total-pages: ${args.get("total-pages")}`);
}

console.log(`CONNECT ${chromeUrl}`);
const browser = await chromium.connectOverCDP(chromeUrl);
const context = browser.contexts()[0] || (await browser.newContext());
const conversationId = url.match(/\/app\/([^/?#]+)/)?.[1] || "";
let page =
  context.pages().find((candidate) => conversationId && candidate.url().includes(conversationId)) ||
  context.pages().find((candidate) => candidate.url().includes("gemini.google.com/app/")) ||
  (await context.newPage());

console.log(`OPEN ${url}`);
await ensureGeminiLoaded(page, url);
const expectedPromptTurns = Math.max(promptStartIndex, (promptStartIndex - 1) + Math.ceil(totalPages / pagesPerPrompt));
const finalState = await loadFullConversation(page, expectedPromptTurns);
console.log(`LOADED turns=${finalState.count} first=${JSON.stringify(finalState.firstText.slice(0, 60))}`);

const records = await page.evaluate(buildExtractionFunction(), {
  totalPages,
  deckId,
  prompt,
  pagesPerPrompt,
});
const textPageHints = applyTextPageHints(records, deckId, totalPages);
if (textPageHints) console.log(`PAGE_HINT assistant_filename=${textPageHints}`);

const imageRecords = records.filter((record) => record.hasUserImage).length;
const imageBackedPages = records.reduce((total, record) => total + (record.hasUserImage ? Math.max(1, Number(record.consumesSlides || 1)) : 0), 0);
console.log(`EXTRACT records=${records.length} imageRecords=${imageRecords} imagePages=${imageBackedPages} missingImage=${records.length - imageRecords}`);
if (imageBackedPages !== totalPages) {
  console.warn(`WARN image-backed pages ${imageBackedPages} != total pages ${totalPages}`);
}

const imageMatchStats = await matchUploadedImagesToSlides({
  context,
  records,
  screenshotsDir,
  deckId,
  totalPages,
});
console.log(
  `IMAGE_MATCH matched=${imageMatchStats.matched}/${imageMatchStats.attempted}` +
  (imageMatchStats.unavailable ? " unavailable=true" : ""),
);

const interactiveViews = await exportInteractiveViews({
  browser,
  page,
  records,
  deckId,
  subjectDir,
});
const restoredInteractiveViews = await hydrateInteractiveViewsFromFiles({
  records,
  deckId,
  subjectDir,
});
const dedupeStats = dedupeSlideRecords(records, totalPages);
applyExpectedPages(records, totalPages);
if (dedupeStats.removed || dedupeStats.missingPages.length) {
  console.log(
    `PAGE_DEDUPE removed=${dedupeStats.removed} mapped=${dedupeStats.mappedPages}/${totalPages}` +
    (dedupeStats.missingPages.length ? ` missing=${dedupeStats.missingPages.join(",")}` : ""),
  );
}
const interactiveViewCount = records.reduce(
  (total, record) => total + (Array.isArray(record.interactiveViews) ? record.interactiveViews.length : 0),
  0,
);

for (const record of records) {
  delete record.remoteImageUrl;
  delete record.remoteImageUrls;
}

await copyScreenshots({
  sourceDir: screenshotsDir,
  destDir: localScreenshotDir,
  deckId,
  totalPages,
});

await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
const transcript = {
  version: 1,
  title: `${title} - Gemini 全记录缓存`,
  deckId,
  totalPages,
  conversationUrl: url.replace(/\?hl=zh$/, ""),
  prompt,
  prePrompt,
  promptStartIndex,
  pagesPerPrompt,
  exportedAt: new Date().toISOString(),
  source: {
    type: "gemini-dom",
    extractor: "gemsync-manager",
    note: "assistantText and assistantHtml are extracted from Gemini DOM without summarizing or rewriting. interactiveViews stores Gemini sandbox widgets as local HTML when present.",
  },
  interactiveViewCount,
  interactiveViewStats: {
    exported: interactiveViews.length,
    restoredFromLocalCache: restoredInteractiveViews,
  },
  pageMapping: {
    pagesPerPrompt,
    imageBackedRecords: records.filter((record) => record.hasUserImage && !record.missingImage).length,
    imageBackedPages: records.reduce((total, record) => total + (record.hasUserImage && !record.missingImage ? Math.max(1, Number(record.consumesSlides || 1)) : 0), 0),
    missingImageRecords: records.filter((record) => record.missingImage).length,
    imageMatch: imageMatchStats,
    rule: "Only Gemini turns with actual uploaded images consume PDF pages. Text-only turns stay as placeholders with expectedPage.",
  },
  records,
};
await fs.writeFile(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
await updateConfig(configPath, deckId, `./transcripts/${deckId}.json`);

console.log(`WRITE ${transcriptPath}`);
console.log(`SCREENSHOTS ${localScreenshotDir}`);
console.log(`CONFIG ${configPath}`);
await browser.close();
