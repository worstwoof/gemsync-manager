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

async function waitForFile(file, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function waitForState(baseUrl, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) {
        const state = await response.json();
        if (state?.defaults?.appName === "DeckSync") return state;
      }
    } catch {
      // Keep polling while start.ps1 launches the manager.
    }
    await sleep(300);
  }
  throw new Error(`DeckSync did not answer at ${baseUrl}`);
}

async function stopProcess(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    spawn("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ], { windowsHide: true });
  }
  await sleep(500);
}

async function launchBrowser() {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    return await chromium.launch({ headless: true });
  }
}

async function main() {
  const port = await getFreePort();
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "decksync-real-start-"));
  const pidFile = path.join(tmpRoot, "manager.pid");
  const baseUrl = `http://${HOST}:${port}`;
  let managerPid = 0;
  let browser = null;

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    ".\\start.ps1",
    "-NoOpen",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      GEMSYNC_MANAGER_PORT: String(port),
      GEMSYNC_PID_FILE: pidFile,
    },
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForFile(pidFile);
    managerPid = Number((await fsp.readFile(pidFile, "utf8")).trim() || 0);
    assert(Number.isInteger(managerPid) && managerPid > 0, `start.ps1 wrote an invalid PID file: ${managerPid}`);

    const state = await waitForState(baseUrl);
    assert(state.defaults.dataDirName === "DeckSync", "real start state reported the wrong data directory");
    assert(state.defaults.shotsDirName === "shots", "real start state reported the wrong shots directory");

    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert(await page.locator("text=DeckSync").first().isVisible(), "DeckSync title is not visible");
    assert((await page.locator(".brand-mark").first().innerText()).trim() === "DS", "DeckSync brand mark is not DS");
    assert(!(await page.locator("text=GemSync Manager").count()), "legacy GemSync Manager title is still visible");
    assert(await page.locator("#workspace").count() === 1, "workspace input is missing");
    assert(await page.locator("#scan").count() === 1, "scan button is missing");
    assert(await page.locator("#providerSelect").count() === 1, "provider selector is missing");
    assert(await page.locator("#organizeWorkspace").count() === 1, "organize button is missing");
    assert(errors.length === 0, `browser console errors:\n${errors.join("\n")}`);

    console.log(`DeckSync real start passed: ${baseUrl} pid=${managerPid}`);
    if (stdout.trim()) console.log(stdout.trim());
    if (stderr.trim()) console.warn(stderr.trim());
  } finally {
    if (browser) await browser.close();
    await stopProcess(managerPid);
    if (child.exitCode === null) child.kill();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
