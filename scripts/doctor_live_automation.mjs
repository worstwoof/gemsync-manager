import { chromium } from "playwright";

const HOST = "127.0.0.1";
const DEFAULT_MANAGER_PORT = Number(process.env.DECKSYNC_PORT || process.env.PORT || 5188);
const DEFAULT_GEMINI_PORT = Number(process.env.GEMSYNC_GEMINI_CHROME_PORT || process.env.GEMSYNC_CHROME_PORT || 9222);
const DEFAULT_CHATGPT_PORT = Number(process.env.GEMSYNC_CHATGPT_CHROME_PORT || 9223);

const PROVIDERS = {
  gemini: {
    label: "Gemini",
    homeUrl: "https://gemini.google.com/app?hl=zh",
    debugUrl: process.env.GEMINI_CHROME_DEBUG_URL || process.env.GEMSYNC_CHROME_DEBUG_URL || `http://${HOST}:${DEFAULT_GEMINI_PORT}`,
    urlPattern: /gemini\.google\.com/i,
    loginPattern: /sign in|log in|登录|登入/i,
    readySelectors: [
      "rich-textarea",
      "rich-textarea [contenteditable='true']",
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
    ],
    actions: [
      "在 DeckSync 管理器选择 Gemini 后点击“打开模型标签页”。",
      "在自动化 Chrome 里确认 Gemini 已登录，并打开一个可输入的新对话。",
      "如果页面已打开但输入框消失，刷新 Gemini 页面或新建对话后重试。",
    ],
  },
  chatgpt: {
    label: "ChatGPT",
    homeUrl: "https://chatgpt.com/",
    debugUrl: process.env.CHATGPT_CHROME_DEBUG_URL || `http://${HOST}:${DEFAULT_CHATGPT_PORT}`,
    urlPattern: /chatgpt\.com|chat\.openai\.com/i,
    loginPattern: /log in|sign up|sign in|登录|登入/i,
    readySelectors: [
      "#prompt-textarea",
      "div#prompt-textarea.ProseMirror",
      "[data-testid='composer'] [contenteditable='true']",
      "textarea",
      "[contenteditable='true']",
      "[role='textbox']",
    ],
    actions: [
      "在 DeckSync 管理器选择 ChatGPT 后点击“打开模型标签页”。",
      "在自动化 Chrome 里确认 ChatGPT 已登录，并打开一个可输入的新对话。",
      "如果当前历史对话没有输入框，刷新页面或新建对话后重试。",
    ],
  },
};

function parseArgs() {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "1");
    }
  }
  return args;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 3000) {
  const response = await fetchWithTimeout(url, {}, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, body, timeoutMs = 5000) {
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }, timeoutMs);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function timeout(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, timeout(ms, message)]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectOverCdpWithRetry(debugUrl, label) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await withTimeout(
        chromium.connectOverCDP(debugUrl, { timeout: 15000 }),
        17000,
        `${label} DevTools connection timed out`,
      );
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1200);
    }
  }
  throw lastError;
}

async function visibleSelector(page, selectors) {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 }) && await locator.isEnabled({ timeout: 1000 }).catch(() => true)) {
        return selector;
      }
    } catch {
      // Try the next selector.
    }
  }
  return "";
}

function withActions(result, actions = []) {
  result.actions = actions;
  return result;
}

async function findManagerUrl() {
  const explicit = process.env.DECKSYNC_MANAGER_URL || process.env.GEMSYNC_MANAGER_URL;
  const candidates = explicit
    ? [explicit]
    : Array.from({ length: 100 }, (_value, offset) => `http://${HOST}:${DEFAULT_MANAGER_PORT + offset}`);
  for (const baseUrl of candidates) {
    try {
      const state = await getJson(`${baseUrl.replace(/\/+$/g, "")}/api/state`, 1000);
      const extensionRoot = String(state?.defaults?.extensionRoot || state?.extension?.extensionRoot || "");
      if (state?.defaults?.appName === "DeckSync" || /[\\/]extension$/i.test(extensionRoot)) {
        return baseUrl.replace(/\/+$/g, "");
      }
    } catch {
      // Try the next possible manager port.
    }
  }
  return "";
}

async function openProviderViaCdp(config) {
  await getJson(`${config.debugUrl}/json/version`, 1000);
  const url = `${config.debugUrl}/json/new?${encodeURIComponent(config.homeUrl)}`;
  const response = await fetchWithTimeout(url, { method: "PUT" }, 5000)
    .catch(() => fetchWithTimeout(url, {}, 5000));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json().catch(() => ({}));
}

async function repairProvider(provider, config) {
  const managerUrl = await findManagerUrl();
  if (managerUrl) {
    const data = await postJson(`${managerUrl}/api/chrome/start`, { provider }, 10000);
    return {
      ok: true,
      via: "manager",
      detail: data?.result?.tab?.url || data?.result?.debugUrl || managerUrl,
    };
  }

  const tab = await openProviderViaCdp(config);
  return {
    ok: true,
    via: "cdp",
    detail: tab?.url || config.homeUrl,
  };
}

async function textSample(page) {
  try {
    return (await page.locator("body").innerText({ timeout: 3000 })).replace(/\s+/g, " ").trim().slice(0, 500);
  } catch {
    return "";
  }
}

async function inspectProvider(provider, config) {
  const result = {
    provider,
    label: config.label,
    debugUrl: config.debugUrl,
    endpoint: false,
    browser: "",
    pageUrl: "",
    ready: false,
    selector: "",
    actions: [],
    repaired: false,
    repair: null,
    status: "failed",
    message: "",
  };

  try {
    const version = await getJson(`${config.debugUrl}/json/version`);
    result.endpoint = true;
    result.browser = version.Browser || "";
  } catch (error) {
    result.message = `${config.label} DevTools 端口未打开：${config.debugUrl}。请先在管理器点击“打开模型标签页”。`;
    return withActions(result, config.actions);
  }

  let targets = [];
  try {
    targets = await getJson(`${config.debugUrl}/json/list`);
  } catch {
    // The browser endpoint is enough to continue to the Playwright check.
  }
  const matchingTarget = Array.isArray(targets)
    ? targets.find((target) => target.type === "page" && config.urlPattern.test(target.url || ""))
    : null;
  if (matchingTarget?.url) result.pageUrl = matchingTarget.url;

  let browser = null;
  try {
    browser = await connectOverCdpWithRetry(config.debugUrl, config.label);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages.find((candidate) => config.urlPattern.test(candidate.url()))
      || pages.find((candidate) => candidate.url() !== "about:blank")
      || pages[0];

    if (!page) {
      result.status = "warn";
      result.message = `${config.label} DevTools 已打开，但没有可检查的标签页。请在自动化 Chrome 里打开 ${config.label}。`;
      return withActions(result, config.actions);
    }

    await withTimeout(page.bringToFront().catch(() => {}), 3000, `${config.label} 标签页激活超时`).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    result.pageUrl = page.url() || result.pageUrl;
    const body = await withTimeout(textSample(page), 5000, `${config.label} 页面文本读取超时`).catch((error) => {
      result.status = "warn";
      result.message = `${config.label} 页面已找到，但读取页面状态超时：${error.message}`;
      return "";
    });
    result.selector = await withTimeout(
      visibleSelector(page, config.readySelectors),
      5000,
      `${config.label} 输入框检查超时`,
    ).catch((error) => {
      if (!result.message) result.message = `${config.label} 页面已找到，但输入框检查超时：${error.message}`;
      return "";
    });
    result.ready = !!result.selector && config.urlPattern.test(result.pageUrl);

    if (result.ready) {
      result.status = "ok";
      result.message = `${config.label} 自动化页面可用，输入框已找到：${result.selector}`;
      result.actions = [];
    } else if (config.loginPattern.test(body) || /accounts\.google\.com|auth\.openai\.com/i.test(result.pageUrl)) {
      result.status = "warn";
      result.message = `${config.label} 页面像是未登录。请在自动化 Chrome 里完成网页登录后重试。`;
      result.actions = config.actions;
    } else if (!config.urlPattern.test(result.pageUrl)) {
      result.status = "warn";
      result.message = `${config.label} DevTools 已打开，但当前标签页不是 ${config.label}：${result.pageUrl}`;
      result.actions = config.actions;
    } else {
      result.status = "warn";
      result.message = `${config.label} 页面已打开，但没有找到可用输入框。请确认页面加载完成且账号已登录。`;
      result.actions = config.actions;
    }
  } catch (error) {
    if (matchingTarget?.url) {
      result.status = "warn";
      result.message = `${config.label} 标签页已找到，但深度页面检查失败：${error.message}`;
      result.actions = [
        `保留 ${config.label} 自动化 Chrome，刷新当前模型页面后重试。`,
        ...config.actions,
      ];
    } else {
      result.message = `${config.label} 页面检查失败：${error.message}`;
      result.actions = config.actions;
    }
  } finally {
    if (browser) await withTimeout(browser.close(), 3000, `${config.label} browser.close timeout`).catch(() => {});
  }

  return result;
}

async function inspectProviderWithWait(provider, config, waitMs, repair = false) {
  const deadline = Date.now() + Math.max(0, waitMs);
  let last = await inspectProvider(provider, config);
  if (repair && last.status !== "ok") {
    try {
      const repairResult = await repairProvider(provider, config);
      await sleep(1500);
      last = await inspectProvider(provider, config);
      last.repaired = last.status === "ok";
      last.repair = repairResult;
      if (last.status !== "ok") {
        last.actions = [
          `${config.label} 自动修复已尝试（${repairResult.via}），但页面仍未就绪。`,
          ...last.actions,
        ];
      }
    } catch (error) {
      last.repair = { ok: false, error: error.message };
      last.actions = [
        `${config.label} 自动修复失败：${error.message}`,
        ...last.actions,
      ];
    }
  }
  while (last.status !== "ok" && Date.now() < deadline) {
    await sleep(Math.min(2000, Math.max(250, deadline - Date.now())));
    last = await inspectProvider(provider, config);
  }
  return last;
}

async function inspectProviderBounded(provider, config, waitMs, repair = false) {
  try {
    return await withTimeout(
      inspectProviderWithWait(provider, config, waitMs, repair),
      Math.max(30000, waitMs + 45000),
      `${config.label} live check exceeded its safety timeout`,
    );
  } catch (error) {
    return {
      provider,
      label: config.label,
      debugUrl: config.debugUrl,
      endpoint: false,
      browser: "",
      pageUrl: "",
      ready: false,
      selector: "",
      actions: [
        `${config.label} live doctor 超时。请关闭卡住的自动化 Chrome 标签页，或在管理器里重新点击“打开模型标签页”。`,
        ...config.actions,
      ],
      repaired: false,
      repair: null,
      status: "warn",
      message: `${config.label} live doctor 超时：${error.message}`,
    };
  }
}

function printResult(result) {
  const mark = result.status === "ok" ? "OK" : result.status === "warn" ? "WARN" : "FAIL";
  console.log(`[${mark}] ${result.label} - ${result.message}`);
  console.log(`      endpoint: ${result.debugUrl}${result.browser ? ` (${result.browser})` : ""}`);
  if (result.pageUrl) console.log(`      page: ${result.pageUrl}`);
  if (result.repair) {
    const repairStatus = result.repair.ok === false ? "failed" : `via ${result.repair.via}`;
    console.log(`      repair: ${repairStatus}${result.repair.detail ? ` -> ${result.repair.detail}` : ""}${result.repair.error ? ` (${result.repair.error})` : ""}`);
  }
  if (result.actions?.length) {
    for (const action of result.actions) console.log(`      action: ${action}`);
  }
}

async function main() {
  const args = parseArgs();
  const providerArg = String(args.get("provider") || "all").toLowerCase();
  const waitMs = Math.max(0, Number(args.get("wait") ?? 8) || 0) * 1000;
  const soft = args.has("soft");
  const json = args.has("json");
  const repair = args.has("repair");
  const selected = providerArg === "all"
    ? Object.entries(PROVIDERS)
    : Object.entries(PROVIDERS).filter(([provider]) => provider === providerArg);
  if (!selected.length) throw new Error(`Unknown provider: ${providerArg}`);

  const results = [];
  for (const [provider, config] of selected) {
    const result = await inspectProviderBounded(provider, config, waitMs, repair);
    results.push(result);
    if (!json) printResult(result);
  }

  const failures = results.filter((result) => result.status !== "ok");
  if (json) {
    console.log(JSON.stringify({
      ok: failures.length === 0,
      failures: failures.length,
      results,
    }, null, 2));
  }
  if (failures.length) {
    if (!json) console.error(`DeckSync live automation check found ${failures.length} item(s) needing attention.`);
    process.exit(soft ? 0 : 1);
  }
  if (!json) console.log("DeckSync live automation check passed");
  process.exit(0);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
