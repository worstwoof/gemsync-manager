import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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

function canListen(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function getAdjacentFreePorts(count = 2) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const base = await getFreePort();
    if (base + count >= 65535) continue;
    let ok = true;
    for (let offset = 1; offset < count; offset += 1) {
      if (!await canListen(base + offset)) {
        ok = false;
        break;
      }
    }
    if (ok) return Array.from({ length: count }, (_, index) => base + index);
  }
  throw new Error(`Could not find ${count} adjacent free ports`);
}

function listenBlocker(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(404, { "content-type": "text/plain", connection: "close" });
      res.end("busy");
    });
    const sockets = new Set();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.forceClose = () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections?.();
    };
    server.on("error", reject);
    server.listen(port, HOST, () => resolve(server));
  });
}

async function listenBlockers(ports) {
  const blockers = [];
  try {
    for (const port of ports) blockers.push(await listenBlocker(port));
    return blockers;
  } catch (error) {
    for (const blocker of blockers) blocker.forceClose?.();
    for (const blocker of blockers) blocker.close(() => {});
    throw error;
  }
}

function closeBlockers(blockers) {
  for (const blocker of blockers) blocker.forceClose?.();
  for (const blocker of blockers) blocker.close(() => {});
}

function runPowerShell(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, {
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

async function withRootFile(fileName, content, callback) {
  const file = path.join(process.cwd(), fileName);
  const backup = path.join(os.tmpdir(), `decksync-${path.basename(fileName)}-${process.pid}-${Date.now()}.bak`);
  const existed = fs.existsSync(file);
  if (existed) await fsp.rename(file, backup);
  try {
    if (content === null) {
      await fsp.rm(file, { force: true });
    } else {
      await fsp.writeFile(file, content, "utf8");
    }
    return await callback(file);
  } finally {
    await fsp.rm(file, { force: true }).catch(() => {});
    if (existed) await fsp.rename(backup, file);
  }
}

function launchPowerShell(args, env) {
  const child = spawn("powershell.exe", args, {
    env: { ...process.env, ...env },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

function launchNodeServer(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function waitForFile(file, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

async function readState(port) {
  const response = await fetch(`http://${HOST}:${port}/api/state`);
  if (!response.ok) throw new Error(`state HTTP ${response.status}`);
  return response.json();
}

async function postJson(port, pathname, body) {
  const response = await fetch(`http://${HOST}:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data, text };
}

async function findDeckSyncPort(startPort, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (let port = startPort; port < startPort + 100; port += 1) {
      try {
        const state = await readState(port);
        if (state?.defaults?.appName === "DeckSync") return port;
      } catch {
        // Keep scanning while the manager starts.
      }
    }
    await sleep(350);
  }
  throw new Error(`DeckSync did not start on fallback ports after ${startPort}`);
}

async function findDeckSyncPortRange(startPort, count = 100, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (let port = startPort; port < startPort + count; port += 1) {
      try {
        const state = await readState(port);
        if (state?.defaults?.appName === "DeckSync") return port;
      } catch {
        // Keep scanning while the manager starts.
      }
    }
    await sleep(350);
  }
  throw new Error(`DeckSync did not start from ${startPort} to ${startPort + count - 1}`);
}

async function stopProcess(pid) {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    // Fall through to PowerShell, which is more reliable for detached Windows processes.
  }
  await runPowerShell([
    "-NoProfile",
    "-Command",
    [
      `$pidToStop = ${Number(pid) || 0}`,
      "Stop-Process -Id $pidToStop -Force -ErrorAction SilentlyContinue",
      "for ($i = 0; $i -lt 20; $i++) {",
      "  if (-not (Get-Process -Id $pidToStop -ErrorAction SilentlyContinue)) { exit 0 }",
      "  Start-Sleep -Milliseconds 150",
      "}",
    ].join("; "),
  ], {});
}

async function testInvalidServerPortFallback() {
  const fallbackPorts = await getAdjacentFreePorts(3);
  const blockedPorts = await listenBlockers(fallbackPorts.slice(0, 2));
  let launchedPid = 0;
  try {
    launchedPid = launchNodeServer({
      GEMSYNC_MANAGER_PORT: "not-a-port",
      GEMSYNC_MANAGER_PORT_FALLBACK: String(fallbackPorts[0]),
    });
    const launchedPort = await findDeckSyncPortRange(fallbackPorts[0]);
    assert(launchedPort === fallbackPorts[2], `server.mjs invalid port fallback chose ${launchedPort}, expected ${fallbackPorts[2]}`);
    const state = await readState(launchedPort);
    assert(state?.defaults?.requestedManagerPort === fallbackPorts[0], "server did not normalize invalid requested port to fallback");
    console.log(`DeckSync server invalid-port fallback passed: not-a-port -> ${launchedPort}`);
  } finally {
    closeBlockers(blockedPorts);
    await stopProcess(launchedPid);
  }
}

async function testDirectServerFallback() {
  const blockedPorts = await getAdjacentFreePorts(2);
  const requestedPort = blockedPorts[0];
  const blockers = await listenBlockers(blockedPorts);
  let launchedPid = 0;
  try {
    launchedPid = launchNodeServer({ GEMSYNC_MANAGER_PORT: String(requestedPort) });
    const launchedPort = await findDeckSyncPort(requestedPort + 1);
    assert(!blockedPorts.includes(launchedPort), "server.mjs did not move away from all busy ports");
    const state = await readState(launchedPort);
    assert(state?.defaults?.appName === "DeckSync", "fallback port did not serve DeckSync");
    assert(state?.defaults?.managerPort === launchedPort, "server state did not report the active fallback port");
    console.log(`DeckSync server fallback passed: ${blockedPorts.join(",")} -> ${launchedPort}`);
  } finally {
    closeBlockers(blockers);
    await stopProcess(launchedPid);
  }
}

async function testInvalidStartPortFallback() {
  const fallbackPorts = await getAdjacentFreePorts(3);
  const blockers = await listenBlockers(fallbackPorts.slice(0, 2));
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "decksync-start-"));
  const pidFile = path.join(tmpRoot, "manager.pid");
  let launchedPid = 0;
  try {
    launchPowerShell([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ".\\start.ps1",
      "-NoOpen",
    ], {
      GEMSYNC_MANAGER_PORT: "bad-port",
      GEMSYNC_MANAGER_PORT_FALLBACK: String(fallbackPorts[0]),
      GEMSYNC_PID_FILE: pidFile,
    });

    await waitForFile(pidFile);
    launchedPid = Number((await fsp.readFile(pidFile, "utf8")).trim() || 0);
    assert(Number.isInteger(launchedPid) && launchedPid > 0, "start.ps1 wrote an invalid PID file for invalid port");
    const launchedPort = await findDeckSyncPortRange(fallbackPorts[0]);
    assert(!fallbackPorts.slice(0, 2).includes(launchedPort), "start.ps1 invalid port fallback used a busy port");
    assert(launchedPort >= fallbackPorts[0] && launchedPort < fallbackPorts[0] + 100, "start.ps1 invalid port fallback left the expected scan range");
    console.log(`DeckSync start invalid-port fallback passed: bad-port -> ${launchedPort}`);
  } finally {
    closeBlockers(blockers);
    await stopProcess(launchedPid);
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testStartScriptFallback() {
  const blockedPorts = await getAdjacentFreePorts(2);
  const requestedPort = blockedPorts[0];
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "decksync-start-"));
  const pidFile = path.join(tmpRoot, "manager.pid");
  const blockers = await listenBlockers(blockedPorts);
  let launchedPort = 0;
  let launchedPid = 0;
  try {
    launchPowerShell([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      ".\\start.ps1",
      "-NoOpen",
    ], {
      GEMSYNC_MANAGER_PORT: String(requestedPort),
      GEMSYNC_PID_FILE: pidFile,
    });

    await waitForFile(pidFile);
    launchedPid = Number((await fsp.readFile(pidFile, "utf8")).trim() || 0);
    assert(Number.isInteger(launchedPid) && launchedPid > 0, "start.ps1 wrote an invalid PID file");
    launchedPort = await findDeckSyncPort(requestedPort + 1);
    assert(!blockedPorts.includes(launchedPort), "start.ps1 did not move away from all busy ports");

    const state = await readState(launchedPort);
    assert(state?.defaults?.appName === "DeckSync", "fallback port did not serve DeckSync");
    console.log(`DeckSync start fallback passed: ${blockedPorts.join(",")} -> ${launchedPort}`);
  } finally {
    closeBlockers(blockers);
    await stopProcess(launchedPid);
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testStartScriptLocalEnv(fileName, expectedLabel) {
  const [port] = await getAdjacentFreePorts(1);
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "decksync-start-env-"));
  const pidFile = path.join(tmpRoot, "manager.pid");
  let launchedPid = 0;
  const localEnvContent = [
    `$env:GEMSYNC_MANAGER_PORT = '${port}'`,
    `$env:GEMSYNC_PID_FILE = '${pidFile.replaceAll("'", "''")}'`,
  ].join("\n");
  try {
    await withRootFile(fileName, localEnvContent, async () => {
      launchPowerShell([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        ".\\start.ps1",
        "-NoOpen",
      ], {
        GEMSYNC_MANAGER_PORT: "",
        GEMSYNC_MANAGER_PORT_FALLBACK: "",
        GEMSYNC_PID_FILE: "",
      });

      await waitForFile(pidFile);
      launchedPid = Number((await fsp.readFile(pidFile, "utf8")).trim() || 0);
      assert(Number.isInteger(launchedPid) && launchedPid > 0, `start.ps1 wrote an invalid PID file from ${fileName}`);
      const launchedPort = await findDeckSyncPortRange(port);
      const state = await readState(launchedPort);
      assert(
        state?.defaults?.requestedManagerPort === port,
        `start.ps1 ignored ${fileName}: requested ${state?.defaults?.requestedManagerPort}, expected ${port}`,
      );
      console.log(`DeckSync start ${expectedLabel} local env passed: ${fileName} -> ${launchedPort}`);
    });
  } finally {
    await stopProcess(launchedPid);
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  }
}

async function testStartScriptLocalEnvCompatibility() {
  await withRootFile(".gemsync.local.ps1", null, async () => {
    await testStartScriptLocalEnv(".decksync.local.ps1", "current");
  });
  await withRootFile(".decksync.local.ps1", null, async () => {
    await testStartScriptLocalEnv(".gemsync.local.ps1", "legacy");
  });
}

async function testBadChromePathReportsCleanError() {
  const port = await getFreePort();
  const chromePort = await getFreePort();
  const missingChrome = path.join(os.tmpdir(), `decksync-missing-chrome-${process.pid}.exe`);
  let launchedPid = 0;
  try {
    launchedPid = launchNodeServer({
      GEMSYNC_MANAGER_PORT: String(port),
      GEMSYNC_CHROME: missingChrome,
      GEMINI_CHROME_DEBUG_URL: `http://${HOST}:${chromePort}`,
    });
    await findDeckSyncPortRange(port, 1);
    const { response, data, text } = await postJson(port, "/api/chrome/start", {
      workspace: os.tmpdir(),
      provider: "gemini",
    });
    assert(!response.ok && data?.ok === false, `bad Chrome path should fail cleanly: ${text}`);
    assert(String(data.error || "").includes("Chrome not found"), `bad Chrome error was not clear: ${text}`);
    console.log("DeckSync bad Chrome path check passed");
  } finally {
    await stopProcess(launchedPid);
  }
}

async function main() {
  await testInvalidServerPortFallback();
  await testDirectServerFallback();
  await testInvalidStartPortFallback();
  await testStartScriptFallback();
  await testStartScriptLocalEnvCompatibility();
  await testBadChromePathReportsCleanError();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
