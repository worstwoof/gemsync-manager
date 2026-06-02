import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scripts = [
  "start.ps1",
  "scripts/setup-env.ps1",
];

function parsePowerShell(file) {
  const absolute = path.join(ROOT, file);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$tokens = $null",
    "$errors = $null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${absolute.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null`,
    "if ($errors -and $errors.Count -gt 0) {",
    "  $errors | ForEach-Object { Write-Error ($_.ToString()) }",
    "  exit 1",
    "}",
  ].join("; ");

  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], {
      cwd: ROOT,
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

for (const script of scripts) {
  const result = await parsePowerShell(script);
  if (result.code !== 0) {
    console.error(`PowerShell syntax check failed: ${script}`);
    if (result.stdout.trim()) console.error(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
    process.exitCode = 1;
    break;
  }
  console.log(`PowerShell syntax OK: ${script}`);
}
