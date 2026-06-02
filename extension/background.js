const GEMSYNC_TYPES = new Set([
  "gemsync:sync-page",
  "gemsync:bind-page",
  "gemsync:open-gemini",
]);

const conversationIdFromUrl = (value) => {
  try {
    const url = new URL(value);
    if (/(^|\.)gemini\.google\.com$/i.test(url.hostname)) {
      return url.pathname.match(/^\/app\/([^/?#]+)/)?.[1] || "";
    }
    if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(url.hostname)) {
      return url.pathname.match(/^\/c\/([^/?#]+)/)?.[1] || "";
    }
    return "";
  } catch {
    return "";
  }
};

const providerHomeUrl = (provider) => provider === "chatgpt" ? "https://chatgpt.com/" : "https://gemini.google.com/app";

const providerTabPatterns = (provider) => provider === "chatgpt"
  ? ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  : ["https://gemini.google.com/*"];

const findModelTab = async ({ conversationId, geminiUrl, chatgptUrl, provider }) => {
  const targetUrl = chatgptUrl || geminiUrl || "";
  const targetProvider = provider === "chatgpt" || chatgptUrl ? "chatgpt" : "gemini";
  const tabs = (await Promise.all(providerTabPatterns(targetProvider).map((url) => chrome.tabs.query({ url })))).flat();
  const targetConversationId = conversationId || conversationIdFromUrl(targetUrl);
  if (conversationId) {
    const exact = tabs.find((tab) => tab.url && conversationIdFromUrl(tab.url) === targetConversationId);
    if (exact) return exact;
  }

  if (targetUrl) {
    const target = new URL(targetUrl);
    const exact = tabs.find((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return url.origin === target.origin && url.pathname === target.pathname;
      } catch {
        return false;
      }
    });
    if (exact) return exact;
  }

  return tabs.find((tab) => tab.active) || tabs[0] || null;
};

const sendToTab = (tabId, payload) => {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        resolve({ ok: false, error: error.message });
        return;
      }
      resolve(response || { ok: false, error: "Gemini 页面没有回应。" });
    });
  });
};

const activateTab = async (tab) => {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
};

const handleGemSync = async (message) => {
  const payload = message.payload || {};
  const provider = payload.provider === "chatgpt" || payload.chatgptUrl ? "chatgpt" : "gemini";
  const targetUrl = payload.chatgptUrl || payload.geminiUrl || providerHomeUrl(provider);
  const targetConversationId = payload.conversationId || conversationIdFromUrl(targetUrl);
  const tab = await findModelTab({ ...payload, provider, conversationId: targetConversationId });

  if (message.type === "gemsync:open-gemini") {
    if (tab?.id) {
      await activateTab(tab);
      if (targetUrl && tab.url && conversationIdFromUrl(tab.url) !== targetConversationId) {
        await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
        return { ok: true, needLoad: true };
      }
      return { ok: true };
    }
    await chrome.tabs.create({ url: targetUrl });
    return { ok: true, needLoad: true };
  }

  if (!tab?.id) {
    await chrome.tabs.create({ url: targetUrl });
    return { ok: true, needLoad: true };
  }

  if (targetUrl && targetConversationId && tab.url && conversationIdFromUrl(tab.url) !== targetConversationId) {
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    return { ok: true, needLoad: true };
  }

  const response = await sendToTab(tab.id, {
    type: message.type,
    payload,
  });

  if (!response.ok && /receiving end|Could not establish/i.test(response.error || "")) {
    return { ok: true, needLoad: true };
  }

  return response;
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (GEMSYNC_TYPES.has(message?.type)) {
    handleGemSync(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});
