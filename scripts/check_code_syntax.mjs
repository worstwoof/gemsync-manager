import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PYTHON = process.env.GEMSYNC_PYTHON || "python";
const NODE_CHECK = process.env.DECKSYNC_CHECK_NODE || "node";

const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "subjects",
]);

const EXCLUDED_PARTS = [
  path.join("extension", "pdf-panel", "vendor"),
  path.join("extension", "pdf-panel", "pdfjs"),
  path.join("extension", "pdf-panel", "subjects"),
].map((item) => item.toLowerCase());

function isExcluded(fileOrDir) {
  const relative = path.relative(ROOT, fileOrDir);
  if (!relative || relative.startsWith("..")) return false;
  const lower = relative.toLowerCase();
  return EXCLUDED_PARTS.some((part) => lower === part || lower.startsWith(`${part}${path.sep}`));
}

async function collectFiles(dir, files = []) {
  if (isExcluded(dir)) return files;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await collectFiles(fullPath, files);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if ([".js", ".mjs", ".py"].includes(ext) && !isExcluded(fullPath)) files.push(fullPath);
    }
  }
  return files;
}

function run(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed${output ? `\n${output}` : ""}`);
  }
}

function runWithEnv(command, args, label, env) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${label} failed${output ? `\n${output}` : ""}`);
  }
  return result.stdout || "";
}

function checkPromptEncoding() {
  const prompt = "\u8bf7\u53ea\u7528\u4e00\u53e5\u4e2d\u6587\u56de\u590d\uff1aDeckSync \u7f16\u7801\u6d4b\u8bd5\u901a\u8fc7\u3002";
  const encoded = Buffer.from(prompt, "utf8").toString("base64");
  const gemini = runWithEnv(NODE_CHECK, ["scripts/gemini_ppt_one_by_one.mjs"], "Gemini prompt encoding", {
    DECKSYNC_AUTOMATION_DRY_RUN: "1",
    GEMINI_PPT_ROOT: path.join(ROOT, "scripts", "__missing_decksync_encoding_smoke__"),
    GEMINI_PPT_PROMPT: "????????",
    GEMINI_PPT_PROMPT_B64: encoded,
  });
  const chatgpt = runWithEnv(NODE_CHECK, ["scripts/chatgpt_ppt_one_by_one.mjs"], "ChatGPT prompt encoding", {
    DECKSYNC_AUTOMATION_DRY_RUN: "1",
    CHATGPT_PPT_ROOT: path.join(ROOT, "scripts", "__missing_decksync_encoding_smoke__"),
    CHATGPT_PPT_PROMPT: "????????",
    CHATGPT_PPT_PROMPT_B64: encoded,
  });
  if (!gemini.includes(prompt)) throw new Error("Gemini prompt encoding check did not preserve UTF-8 prompt");
  if (!chatgpt.includes(prompt)) throw new Error("ChatGPT prompt encoding check did not preserve UTF-8 prompt");
}

async function main() {
  const files = await collectFiles(ROOT);
  const jsFiles = files.filter((file) => [".js", ".mjs"].includes(path.extname(file).toLowerCase())).sort();
  const pyFiles = files.filter((file) => path.extname(file).toLowerCase() === ".py").sort();

  for (const file of jsFiles) {
    run(NODE_CHECK, ["--check", file], `node --check ${path.relative(ROOT, file)}`);
  }

  if (pyFiles.length) {
    run(PYTHON, ["-m", "py_compile", ...pyFiles], `python py_compile ${pyFiles.length} file(s)`);
  }
  checkPromptEncoding();

  console.log(`Code syntax OK: ${jsFiles.length} JS/MJS, ${pyFiles.length} Python`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
