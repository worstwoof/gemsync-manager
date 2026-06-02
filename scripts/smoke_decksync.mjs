import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST = "127.0.0.1";
const POPPLER_BIN = "F:\\Environment\\file_reader_env\\Library\\bin";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  assert(response.ok && data?.ok !== false, `${pathname} failed: ${text}`);
  return data;
}

async function requestRaw(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Keep data null so callers can assert non-JSON responses.
  }
  return { response, text, data };
}

async function waitForServer(baseUrl, child) {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    assert(child.exitCode === null, "server exited before it became ready");
    try {
      return await requestJson(baseUrl, "/api/state");
    } catch {
      await sleep(250);
    }
  }
  throw new Error("server did not become ready in time");
}

async function waitForJob(baseUrl, jobId) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const data = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/log`);
    if (data.job.status !== "running") {
      assert(data.job.status === "complete", `job ${jobId} failed:\n${data.log}`);
      return data;
    }
    await sleep(300);
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

async function waitForFailedJob(baseUrl, jobId, expectedText) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const data = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(jobId)}/log`);
    if (data.job.status !== "running") {
      assert(data.job.status === "failed", `job ${jobId} should have failed:\n${data.log}`);
      assert(data.log.includes(expectedText), `failed job log did not include "${expectedText}":\n${data.log}`);
      return data;
    }
    await sleep(300);
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

async function runApiErrorSmoke(baseUrl) {
  const malformed = await requestRaw(baseUrl, "/api/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ broken",
  });
  assert(malformed.response.status === 400, `malformed JSON should return HTTP 400, got ${malformed.response.status}: ${malformed.text}`);
  assert(malformed.data?.ok === false && malformed.data?.error, `malformed JSON did not return a JSON error: ${malformed.text}`);

  const missingWorkspace = await requestRaw(baseUrl, "/api/jobs/organize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace: path.join(os.tmpdir(), "decksync-missing-workspace-for-error-smoke") }),
  });
  assert(missingWorkspace.response.status === 500, `missing workspace should return HTTP 500, got ${missingWorkspace.response.status}: ${missingWorkspace.text}`);
  assert(missingWorkspace.data?.ok === false && String(missingWorkspace.data.error || "").includes("不存在"), `missing workspace error was not clear: ${missingWorkspace.text}`);
}

function runNodeScript(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runPowerShellScript(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function createPptxWithPowerPoint(file) {
  const escaped = file.replaceAll("'", "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$app = New-Object -ComObject PowerPoint.Application",
    "$presentation = $app.Presentations.Add($true)",
    "$slide = $presentation.Slides.Add(1, 12)",
    "$shape = $slide.Shapes.AddTextbox(1, 64, 96, 560, 120)",
    "$shape.TextFrame.TextRange.Text = 'DeckSync smoke PPTX'",
    `$presentation.SaveAs('${escaped}', 24)`,
    "$presentation.Close()",
    "$app.Quit()",
  ].join("; ");
  const result = await runPowerShellScript(script);
  assert(result.code === 0, `PowerPoint smoke PPTX creation failed:\n${result.stdout}\n${result.stderr}`);
  assert(fs.existsSync(file), `PowerPoint did not create ${file}`);
}

function createPdf(pageText) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${pageText.length + 41} >>\nstream\nBT /F1 24 Tf 72 720 Td (${pageText}) Tj ET\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

async function runAutomationDryRunSmoke(tmpRoot) {
  const automationRoot = path.join(tmpRoot, "automation-shots");
  const deckDir = path.join(automationRoot, "deck01_intro");
  await fsp.mkdir(deckDir, { recursive: true });
  await fsp.writeFile(path.join(deckDir, "deck01_slide001.png"), "fake image", "utf8");

  await fsp.writeFile(path.join(automationRoot, "gemini_progress.json"), "{ broken", "utf8");
  await fsp.writeFile(path.join(automationRoot, "conversation_folders.json"), "{ broken", "utf8");
  const gemini = await runNodeScript("scripts/gemini_ppt_one_by_one.mjs", {
    DECKSYNC_AUTOMATION_DRY_RUN: "1",
    GEMINI_PPT_ROOT: automationRoot,
  });
  assert(gemini.code === 0, `Gemini dry-run failed:\n${gemini.stdout}\n${gemini.stderr}`);
  assert(gemini.stdout.includes("DRY_RUN complete provider=gemini"), `Gemini dry-run did not complete:\n${gemini.stdout}`);
  assert(JSON.parse(await fsp.readFile(path.join(automationRoot, "conversation_folders.json"), "utf8")).folders.length === 1, "Gemini dry-run did not write conversation_folders.json");
  let backups = await fsp.readdir(path.join(automationRoot, "archives", "invalid-json"));
  assert(backups.some((name) => name.startsWith("gemini_progress.invalid-")), "Gemini dry-run did not backup invalid progress JSON");
  assert(backups.some((name) => name.startsWith("conversation_folders.invalid-")), "Gemini dry-run did not backup invalid conversation folders JSON");

  await fsp.writeFile(path.join(automationRoot, "chatgpt_progress.json"), "{ broken", "utf8");
  await fsp.writeFile(path.join(automationRoot, "chatgpt_conversation_folders.json"), "{ broken", "utf8");
  const chatgpt = await runNodeScript("scripts/chatgpt_ppt_one_by_one.mjs", {
    DECKSYNC_AUTOMATION_DRY_RUN: "1",
    CHATGPT_PPT_ROOT: automationRoot,
  });
  assert(chatgpt.code === 0, `ChatGPT dry-run failed:\n${chatgpt.stdout}\n${chatgpt.stderr}`);
  assert(chatgpt.stdout.includes("DRY_RUN complete provider=chatgpt"), `ChatGPT dry-run did not complete:\n${chatgpt.stdout}`);
  assert(JSON.parse(await fsp.readFile(path.join(automationRoot, "chatgpt_conversation_folders.json"), "utf8")).folders.length === 1, "ChatGPT dry-run did not write chatgpt_conversation_folders.json");
  backups = await fsp.readdir(path.join(automationRoot, "archives", "invalid-json"));
  assert(backups.some((name) => name.startsWith("chatgpt_progress.invalid-")), "ChatGPT dry-run did not backup invalid progress JSON");
  assert(backups.some((name) => name.startsWith("chatgpt_conversation_folders.invalid-")), "ChatGPT dry-run did not backup invalid conversation folders JSON");
}

async function runBrowserSmoke(baseUrl) {
  let browser = null;
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ headless: true });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  assert(await page.locator("text=DeckSync").first().isVisible(), "DeckSync title is not visible");
  assert(await page.locator("#workspace").count() === 1, "workspace input is missing");
  assert(await page.locator("#scan").count() === 1, "scan button is missing");
  assert(await page.locator("#providerSelect").count() === 1, "provider selector is missing");
  assert(await page.locator("#organizeWorkspace").count() === 1, "organize button is missing");
  await browser.close();
  assert(errors.length === 0, `browser console errors:\n${errors.join("\n")}`);
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "decksync-smoke-"));
  const workspace = path.join(tmpRoot, "course");
  const badWorkspace = path.join(tmpRoot, "bad-course");
  const legacyWorkspace = path.join(tmpRoot, "legacy-course");
  const extensionRoot = path.join(tmpRoot, "extension");
  let child = null;

  try {
    await fsp.mkdir(path.join(extensionRoot, "pdf-panel"), { recursive: true });
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.mkdir(badWorkspace, { recursive: true });
    await fsp.writeFile(path.join(workspace, "01-intro.pdf"), createPdf("DeckSync smoke"), "ascii");
    await createPptxWithPowerPoint(path.join(workspace, "02-slides.pptx"));
    await fsp.writeFile(path.join(badWorkspace, "broken.pdf"), "not a real pdf\n", "utf8");
    await runAutomationDryRunSmoke(tmpRoot);

    const env = {
      ...process.env,
      GEMSYNC_MANAGER_PORT: String(port),
      GEMSYNC_EXTENSION_ROOT: extensionRoot,
      GEMINI_CHROME_DEBUG_URL: `http://${HOST}:${await getFreePort()}`,
      CHATGPT_CHROME_DEBUG_URL: `http://${HOST}:${await getFreePort()}`,
      PATH: fs.existsSync(POPPLER_BIN) ? `${POPPLER_BIN}${path.delimiter}${process.env.PATH || ""}` : process.env.PATH,
    };
    delete env.GEMSYNC_PDFINFO;
    delete env.GEMSYNC_PDFTOPPM;

    child = spawn(process.execPath, ["server.mjs"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let serverOutput = "";
    child.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
    child.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

    const state = await waitForServer(baseUrl, child);
    assert(state.defaults.appName === "DeckSync", "app name default mismatch");
    assert(state.defaults.dataDirName === "DeckSync", "data dir default mismatch");
    assert(state.defaults.shotsDirName === "shots", "shots dir default mismatch");
    await runApiErrorSmoke(baseUrl);

    const before = await requestJson(baseUrl, "/api/scan", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    assert(before.summary.pdfs.length === 1, "scan did not find the test PDF");
    assert(before.summary.ppts.length === 1, "scan did not find the test PPTX");
    assert(before.summary.screenshotRoot.endsWith(`${path.sep}DeckSync${path.sep}shots`), "new screenshot root was not selected");
    const noScreenshotsAsk = await requestRaw(baseUrl, "/api/jobs/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    assert(noScreenshotsAsk.response.status === 500, `ask without screenshots should fail before starting a job: ${noScreenshotsAsk.text}`);
    assert(String(noScreenshotsAsk.data?.error || "").includes("还没有截图 Deck"), `ask without screenshots error was not clear: ${noScreenshotsAsk.text}`);

    const prepare = await requestJson(baseUrl, "/api/jobs/prepare", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    await waitForJob(baseUrl, prepare.job.id);

    const after = await requestJson(baseUrl, "/api/scan", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    assert(after.summary.decks.length === 2, "prepare did not create decks for both PDF and PPTX");
    assert(after.summary.decks.every((deck) => deck.slides >= 1), "PDF/PPTX conversion did not create slide screenshots");
    assert(fs.existsSync(path.join(workspace, "DeckSync", "shots")), "new shots folder is missing");

    const repeatPrepare = await requestJson(baseUrl, "/api/jobs/prepare", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    await waitForJob(baseUrl, repeatPrepare.job.id);
    const afterRepeat = await requestJson(baseUrl, "/api/scan", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    assert(afterRepeat.summary.decks.length === 2, "repeat prepare duplicated mixed PDF/PPTX decks");

    const noChromeAsk = await requestRaw(baseUrl, "/api/jobs/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace, provider: "gemini" }),
    });
    assert(noChromeAsk.response.status === 500, `ask without Chrome should fail before starting a job: ${noChromeAsk.text}`);
    assert(String(noChromeAsk.data?.error || "").includes("自动化 Chrome 端口未打开"), `ask without Chrome error was not clear: ${noChromeAsk.text}`);

    const badPrepare = await requestJson(baseUrl, "/api/jobs/prepare", {
      method: "POST",
      body: JSON.stringify({ workspace: badWorkspace, provider: "gemini" }),
    });
    const failedPrepare = await waitForFailedJob(baseUrl, badPrepare.job.id, "pdftoppm");
    const clearedLog = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(badPrepare.job.id)}/log/clear`, {
      method: "POST",
    });
    assert(clearedLog.log === "", "job log clear did not clear the selected job log");
    const stoppedFinishedJob = await requestJson(baseUrl, `/api/jobs/${encodeURIComponent(badPrepare.job.id)}/stop`, {
      method: "POST",
    });
    assert(stoppedFinishedJob.job.status === failedPrepare.job.status, "stopping a finished job should be a no-op");

    const plugin = await requestJson(baseUrl, "/api/jobs/plugin", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini", title: "Smoke Course", subjectId: "smoke-course" }),
    });
    await waitForJob(baseUrl, plugin.job.id);
    assert(fs.existsSync(path.join(extensionRoot, "pdf-panel", "subjects.json")), "subjects.json was not written");
    const staleSubjectsTmp = path.join(extensionRoot, "pdf-panel", ".subjects.json.1.1.tmp");
    await fsp.writeFile(staleSubjectsTmp, "stale tmp", "utf8");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fsp.utimes(staleSubjectsTmp, oldTime, oldTime);
    const cleanupPlugin = await requestJson(baseUrl, "/api/jobs/plugin", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini", title: "Smoke Course", subjectId: "smoke-course" }),
    });
    await waitForJob(baseUrl, cleanupPlugin.job.id);
    assert(!fs.existsSync(staleSubjectsTmp), "stale subjects.json tmp file was not cleaned up");
    const smokeConfigPath = path.join(extensionRoot, "pdf-panel", "subjects", "smoke-course", "config.json");
    assert(fs.existsSync(smokeConfigPath), "subject config was not written");

    await fsp.writeFile(smokeConfigPath, "{ broken config", "utf8");
    const recoveredConfigPlugin = await requestJson(baseUrl, "/api/jobs/plugin", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini", title: "Smoke Course", subjectId: "smoke-course" }),
    });
    const recoveredConfigJob = await waitForJob(baseUrl, recoveredConfigPlugin.job.id);
    assert(recoveredConfigJob.log.includes("RECOVERED invalid config backup"), "plugin job did not report recovered invalid subject config");
    assert(JSON.parse(await fsp.readFile(smokeConfigPath, "utf8")).course === "Smoke Course", "recovered subject config was not rewritten");

    await fsp.writeFile(path.join(extensionRoot, "pdf-panel", "subjects.json"), "{ broken json", "utf8");
    const recoveredPlugin = await requestJson(baseUrl, "/api/jobs/plugin", {
      method: "POST",
      body: JSON.stringify({ workspace, provider: "gemini", title: "Recovered Course", subjectId: "recovered-course" }),
    });
    const recoveredJob = await waitForJob(baseUrl, recoveredPlugin.job.id);
    assert(recoveredJob.log.includes("RECOVERED invalid config backup"), "plugin job did not report recovered invalid config");
    assert(fs.existsSync(path.join(extensionRoot, "pdf-panel", "subjects", "recovered-course", "config.json")), "recovered subject config was not written");
    const invalidBackups = await fsp.readdir(path.join(extensionRoot, "pdf-panel", "archives", "invalid-configs"));
    assert(invalidBackups.some((name) => name.startsWith("subjects.invalid-")), "invalid subjects.json backup was not created");

    const command = await requestJson(baseUrl, "/api/command", {
      method: "POST",
      body: JSON.stringify({
        type: "gemsync:sync-page",
        payload: { conversationId: "conv-smoke", deckId: "deck01", page: 1 },
      }),
    });
    const queued = await requestJson(baseUrl, "/api/command?conversationId=conv-smoke");
    assert(queued.command?.id === command.id, "command bridge did not return the queued command");
    await requestJson(baseUrl, "/api/result", {
      method: "POST",
      body: JSON.stringify({ id: command.id, ok: true, page: 1 }),
    });
    const result = await requestJson(baseUrl, `/api/result/${encodeURIComponent(command.id)}`);
    assert(result.pending === false && result.result?.ok === true, "command result bridge did not persist the result");

    await fsp.mkdir(path.join(legacyWorkspace, "gemini_ppt_screenshots_full", "deck01_old"), { recursive: true });
    await fsp.mkdir(path.join(legacyWorkspace, "chrome-gemini-automation-profile"), { recursive: true });
    await fsp.writeFile(path.join(legacyWorkspace, "gemini_ppt_one_by_one.mjs"), "// old runner\n", "utf8");
    const organize = await requestJson(baseUrl, "/api/jobs/organize", {
      method: "POST",
      body: JSON.stringify({ workspace: legacyWorkspace, provider: "gemini" }),
    });
    await waitForJob(baseUrl, organize.job.id);
    assert(fs.existsSync(path.join(legacyWorkspace, "DeckSync", "shots")), "legacy screenshots were not moved into DeckSync/shots");
    assert(fs.existsSync(path.join(legacyWorkspace, "DeckSync", "profiles", "gemini")), "legacy profile was not moved into DeckSync/profiles/gemini");
    assert(fs.existsSync(path.join(legacyWorkspace, "DeckSync", "old", "gemini_ppt_one_by_one.mjs")), "legacy runner was not moved into DeckSync/old");

    const beforeClearFinished = await requestJson(baseUrl, "/api/jobs");
    assert(beforeClearFinished.jobs.some((job) => job.status !== "running"), "smoke did not create any finished jobs to clear");
    const clearedFinished = await requestJson(baseUrl, "/api/jobs/clear-finished", { method: "POST" });
    assert(clearedFinished.removed > 0, "clear-finished did not remove finished jobs");
    assert(clearedFinished.jobs.every((job) => job.status === "running"), "clear-finished left non-running jobs in the active list");

    await runBrowserSmoke(baseUrl);
    console.log("DeckSync smoke passed");
    if (serverOutput.includes("Error:")) {
      console.warn(serverOutput);
    }
  } finally {
    if (child && child.exitCode === null) child.kill();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
