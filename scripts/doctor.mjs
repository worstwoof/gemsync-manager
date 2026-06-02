import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENV_ROOT = process.platform === "win32" ? "F:\\Environment" : "";
const FILE_READER_BIN = ENV_ROOT ? path.join(ENV_ROOT, "file_reader_env", "Library", "bin") : "";

const checks = [];

function addCheck(name, ok, detail = "", required = true) {
  checks.push({ name, ok: !!ok, detail, required });
}

function normalizePort(value, fallback = 5188) {
  const port = Math.floor(Number(value));
  if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  return fallback;
}

function commandCandidates(name, commonPaths = []) {
  const names = process.platform === "win32" && !/\.(exe|cmd|bat)$/i.test(name)
    ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name]
    : [name];
  const paths = [
    ...(process.env.PATH || "").split(path.delimiter),
    FILE_READER_BIN,
    ENV_ROOT ? path.join(ENV_ROOT, "nodejs") : "",
    ENV_ROOT ? path.join(ENV_ROOT, "bin") : "",
  ].filter(Boolean);
  const found = [];
  for (const candidate of commonPaths) {
    if (candidate && fs.existsSync(candidate)) found.push(candidate);
  }
  for (const dir of paths) {
    for (const item of names) {
      const candidate = path.join(dir, item);
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  return [...new Set(found)];
}

function firstCommand(name, envName = "", commonPaths = []) {
  const envValue = envName ? String(process.env[envName] || "").trim() : "";
  if (envValue) {
    if (fs.existsSync(envValue)) return envValue;
    const fromEnv = commandCandidates(envValue, commonPaths)[0];
    if (fromEnv) return fromEnv;
  }
  return commandCandidates(name, commonPaths)[0] || "";
}

function chromeCommonPaths() {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(process.env.HOME || "", "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
}

function officeCommonPaths() {
  if (process.platform === "darwin") {
    return [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      path.join(process.env.HOME || "", "Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ];
  }
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    ];
  }
  return ["/usr/bin/soffice", "/usr/bin/libreoffice"];
}

function commandVersion(command, args = ["--version"], timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!command) return resolve({ ok: false, text: "" });
    const child = spawn(command, args, { windowsHide: true });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { text += chunk.toString(); });
    child.stderr.on("data", (chunk) => { text += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, text: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 || text.trim().length > 0, text: text.trim() });
    });
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function runningManagerState(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`);
    if (!response.ok) return null;
    const data = await response.json();
    return data?.defaults?.appName === "DeckSync" ? data : null;
  } catch {
    return null;
  }
}

async function readJson(file) {
  return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

function stripAssetRef(value) {
  return String(value || "").split(/[?#]/, 1)[0];
}

async function checkHtmlAssets(htmlFile) {
  let html = "";
  try {
    html = await fsp.readFile(htmlFile, "utf8");
  } catch (error) {
    addCheck(`html ${path.relative(ROOT, htmlFile)}`, false, error.message);
    return;
  }

  const refs = [...html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)]
    .map((match) => stripAssetRef(match[1]))
    .filter((ref) => ref && !/^[a-z]+:\/\//i.test(ref) && !ref.startsWith("#"));

  for (const ref of refs) {
    const target = path.resolve(path.dirname(htmlFile), ref);
    addCheck(`asset ${path.relative(ROOT, target)}`, fs.existsSync(target), path.relative(ROOT, htmlFile));
  }
}

async function checkJsStaticImports(jsFile) {
  let source = "";
  try {
    source = await fsp.readFile(jsFile, "utf8");
  } catch (error) {
    addCheck(`js ${path.relative(ROOT, jsFile)}`, false, error.message);
    return;
  }

  const refs = [...source.matchAll(/\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g)]
    .map((match) => stripAssetRef(match[1]))
    .filter((ref) => ref.startsWith("."));

  for (const ref of refs) {
    const target = path.resolve(path.dirname(jsFile), ref);
    addCheck(`import ${path.relative(ROOT, target)}`, fs.existsSync(target), path.relative(ROOT, jsFile));
  }
}

async function checkExtensionIntegrity(extensionRoot, pdfPanelDir) {
  const manifestPath = path.join(extensionRoot, "manifest.json");
  let manifest;
  try {
    manifest = await readJson(manifestPath);
    addCheck("extension manifest JSON", true, manifestPath);
  } catch (error) {
    addCheck("extension manifest JSON", false, `${manifestPath}: ${error.message}`);
    return;
  }

  const serviceWorker = manifest.background?.service_worker;
  if (serviceWorker) {
    const target = path.join(extensionRoot, serviceWorker);
    addCheck(`extension service worker ${serviceWorker}`, fs.existsSync(target), target);
  }

  for (const script of manifest.content_scripts || []) {
    for (const js of script.js || []) {
      const target = path.join(extensionRoot, js);
      addCheck(`extension content script ${js}`, fs.existsSync(target), target);
    }
  }

  const panelHtmlFiles = [
    path.join(pdfPanelDir, "index.html"),
    path.join(pdfPanelDir, "cached-split.html"),
  ];
  for (const htmlFile of panelHtmlFiles) {
    addCheck(`extension panel ${path.basename(htmlFile)}`, fs.existsSync(htmlFile), htmlFile);
    await checkHtmlAssets(htmlFile);
  }

  await checkJsStaticImports(path.join(pdfPanelDir, "app.js"));
  await checkJsStaticImports(path.join(pdfPanelDir, "cached-split.js"));
}

async function canWriteInDir(dir) {
  const file = path.join(dir, `.decksync-doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(file, "ok", "utf8");
    await fsp.rm(file, { force: true });
    return { ok: true, detail: dir };
  } catch (error) {
    await fsp.rm(file, { force: true }).catch(() => {});
    return { ok: false, detail: `${dir}: ${error.message}` };
  }
}

async function checkDefaultWorkspace() {
  const rawWorkspace = String(process.env.GEMSYNC_DEFAULT_WORKSPACE || "").trim();
  if (!rawWorkspace) {
    addCheck("default workspace", true, "not configured; select a course folder in the manager", false);
    return;
  }

  const workspace = path.resolve(rawWorkspace);
  let workspaceStat;
  try {
    workspaceStat = await fsp.stat(workspace);
  } catch (error) {
    addCheck("default workspace exists", false, `${workspace}: ${error.message}`);
    return;
  }

  if (!workspaceStat.isDirectory()) {
    addCheck("default workspace directory", false, `${workspace} is not a directory`);
    return;
  }

  const workspaceWritable = await canWriteInDir(workspace);
  addCheck("default workspace writable", workspaceWritable.ok, workspaceWritable.detail);

  const deckSyncDir = path.join(workspace, "DeckSync");
  try {
    const deckSyncStat = await fsp.stat(deckSyncDir);
    if (!deckSyncStat.isDirectory()) {
      addCheck("default DeckSync directory", false, `${deckSyncDir} exists but is not a directory`);
      return;
    }
    const deckSyncWritable = await canWriteInDir(deckSyncDir);
    addCheck("default DeckSync writable", deckSyncWritable.ok, deckSyncWritable.detail);
  } catch (error) {
    if (error?.code === "ENOENT") {
      addCheck("default DeckSync directory", true, `${deckSyncDir} will be created when needed`, false);
      return;
    }
    addCheck("default DeckSync directory", false, `${deckSyncDir}: ${error.message}`);
  }
}

async function main() {
  const packageJson = await readJson(path.join(ROOT, "package.json"));
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  addCheck("Node.js 20+", nodeMajor >= 20, process.version);

  for (const file of [
    "server.mjs",
    "app/index.html",
    "app/app.js",
    "extension/manifest.json",
    "extension/pdf-panel/index.html",
    "extension/pdf-panel/cached-split.html",
    "scripts/check_brand_assets.mjs",
    "scripts/check_code_syntax.mjs",
    "scripts/check_powershell_syntax.mjs",
    "scripts/doctor_live_automation.mjs",
    "scripts/setup-env.ps1",
    "scripts/add_new_ppts_to_screenshots.py",
    "scripts/gemini_ppt_one_by_one.mjs",
    "scripts/chatgpt_ppt_one_by_one.mjs",
    "scripts/smoke_decksync.mjs",
    "scripts/smoke_real_start.mjs",
    "scripts/smoke_start_port.mjs",
  ]) {
    addCheck(`file ${file}`, fs.existsSync(path.join(ROOT, file)), file);
  }

  const nodeModules = path.join(ROOT, "node_modules");
  const missingDeps = Object.keys(packageJson.dependencies || {})
    .filter((name) => !fs.existsSync(path.join(nodeModules, name)));
  addCheck("npm dependencies", missingDeps.length === 0, missingDeps.length ? `missing: ${missingDeps.join(", ")}` : "installed");

  const logsWritable = await canWriteInDir(path.join(ROOT, "logs"));
  addCheck("logs writable", logsWritable.ok, logsWritable.detail);
  await checkDefaultWorkspace();

  const extensionRoot = path.resolve(process.env.GEMSYNC_EXTENSION_ROOT || path.join(ROOT, "extension"));
  const pdfPanelDir = path.join(extensionRoot, "pdf-panel");
  addCheck("extension pdf-panel exists", fs.existsSync(pdfPanelDir), pdfPanelDir);
  const extensionWritable = await canWriteInDir(pdfPanelDir);
  addCheck("extension pdf-panel writable", extensionWritable.ok, extensionWritable.detail);
  await checkExtensionIntegrity(extensionRoot, pdfPanelDir);

  const pdfinfo = firstCommand("pdfinfo", "GEMSYNC_PDFINFO");
  const pdftoppm = firstCommand("pdftoppm", "GEMSYNC_PDFTOPPM");
  const python = firstCommand("python", "GEMSYNC_PYTHON");
  const chrome = firstCommand("chrome", "GEMSYNC_CHROME", chromeCommonPaths());
  const soffice = firstCommand("soffice", "GEMSYNC_SOFFICE", officeCommonPaths());
  addCheck("pdfinfo", !!pdfinfo, pdfinfo || "not found");
  addCheck("pdftoppm", !!pdftoppm, pdftoppm || "not found");
  addCheck("Python", !!python, python || "not found");
  addCheck("Chrome", !!chrome, chrome || "not found", false);
  addCheck("LibreOffice", !!soffice, soffice || "optional; PowerPoint can also convert PPT", false);

  const pdfinfoVersion = await commandVersion(pdfinfo, ["-v"]);
  const pdftoppmVersion = await commandVersion(pdftoppm, ["-v"]);
  addCheck("pdfinfo executable", pdfinfoVersion.ok, pdfinfoVersion.text || "not runnable");
  addCheck("pdftoppm executable", pdftoppmVersion.ok, pdftoppmVersion.text || "not runnable");

  const fallbackPort = normalizePort(process.env.GEMSYNC_MANAGER_PORT_FALLBACK);
  const port = normalizePort(process.env.GEMSYNC_MANAGER_PORT, fallbackPort);
  if (process.env.GEMSYNC_MANAGER_PORT && port === fallbackPort && String(process.env.GEMSYNC_MANAGER_PORT).trim() !== String(fallbackPort)) {
    addCheck("manager port config", true, `invalid GEMSYNC_MANAGER_PORT '${process.env.GEMSYNC_MANAGER_PORT}', using ${fallbackPort}`, false);
  }
  const free = await portIsFree(port);
  const runningManager = free ? null : await runningManagerState(port);
  addCheck(
    "manager port",
    free || !!runningManager,
    free ? `127.0.0.1:${port} available` : runningManager ? `DeckSync already running on 127.0.0.1:${port}` : `127.0.0.1:${port} already in use`,
    false,
  );

  const requiredFailures = checks.filter((item) => item.required && !item.ok);
  for (const item of checks) {
    const mark = item.ok ? "OK" : item.required ? "FAIL" : "WARN";
    console.log(`[${mark}] ${item.name}${item.detail ? ` - ${item.detail}` : ""}`);
  }

  if (requiredFailures.length) {
    console.error(`DeckSync doctor failed: ${requiredFailures.length} required check(s) failed.`);
    process.exitCode = 1;
    return;
  }
  console.log("DeckSync doctor passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
