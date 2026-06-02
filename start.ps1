[CmdletBinding()]
param(
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LocalEnv = Join-Path $Root '.decksync.local.ps1'
$LegacyLocalEnv = Join-Path $Root '.gemsync.local.ps1'
if (Test-Path -LiteralPath $LocalEnv) {
  . $LocalEnv
} elseif (Test-Path -LiteralPath $LegacyLocalEnv) {
  . $LegacyLocalEnv
}

$Node = if ($env:GEMSYNC_NODE) { $env:GEMSYNC_NODE } else { 'node' }
$LogDir = Join-Path $Root 'logs'
$OutLog = Join-Path $LogDir 'manager.out.log'
$ErrLog = Join-Path $LogDir 'manager.err.log'

function Resolve-ManagerPort {
  param(
    [string]$Value,
    [int]$Fallback = 5188
  )
  $parsed = 0
  if ([int]::TryParse($Value, [ref]$parsed) -and $parsed -gt 0 -and $parsed -lt 65536) {
    return $parsed
  }
  if ($Value) {
    Write-Warning "Invalid GEMSYNC_MANAGER_PORT '$Value', falling back to $Fallback."
  }
  return $Fallback
}

$FallbackPort = Resolve-ManagerPort $env:GEMSYNC_MANAGER_PORT_FALLBACK 5188
$Port = Resolve-ManagerPort $env:GEMSYNC_MANAGER_PORT $FallbackPort

function Get-DeckSyncState {
  param([int]$CheckPort)
  try {
    $checkUrl = "http://127.0.0.1:$CheckPort/api/state"
    $response = Invoke-WebRequest -UseBasicParsing -Uri $checkUrl -TimeoutSec 2
    if ($response.StatusCode -ne 200) { return $null }
    $data = $response.Content | ConvertFrom-Json
    if ($data.defaults.appName -eq 'DeckSync') { return $data }
  } catch {
    return $null
  }
  return $null
}

function Test-PortFree {
  param([int]$CheckPort)
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $CheckPort)
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    try { $listener.Stop() } catch {}
  }
}

function Find-FreePort {
  param([int]$StartPort)
  for ($candidate = $StartPort; $candidate -lt ($StartPort + 100); $candidate++) {
    if (Test-PortFree $candidate) { return $candidate }
  }
  throw "No free DeckSync port found from $StartPort to $($StartPort + 99)."
}

function Find-DeckSyncPort {
  param([int]$StartPort)
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    for ($candidate = $StartPort; $candidate -lt ($StartPort + 100); $candidate++) {
      $state = Get-DeckSyncState $candidate
      if ($state) { return $candidate }
    }
    Start-Sleep -Milliseconds 300
  }
  return 0
}

if (!(Test-Path -LiteralPath $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir | Out-Null
}

$Running = $null
$Running = Get-DeckSyncState $Port
$ScanStartPort = $Port

if (-not $Running -and -not (Test-PortFree $Port)) {
  $OriginalPort = $Port
  $Port = Find-FreePort ($OriginalPort + 1)
  $env:GEMSYNC_MANAGER_PORT = [string]$Port
  Write-Warning "Port $OriginalPort is busy, starting DeckSync on $Port instead."
}

if (-not $Running) {
  $StartedProcess = Start-Process -FilePath $Node `
    -ArgumentList 'server.mjs' `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $OutLog `
    -RedirectStandardError $ErrLog `
    -WindowStyle Hidden `
    -PassThru
  if ($env:GEMSYNC_PID_FILE) {
    Set-Content -LiteralPath $env:GEMSYNC_PID_FILE -Value $StartedProcess.Id -Encoding ASCII
  }
  $ActualPort = Find-DeckSyncPort $ScanStartPort
  if ($ActualPort -gt 0) {
    $Port = $ActualPort
  } else {
    Start-Sleep -Milliseconds 900
  }
}

$Url = "http://127.0.0.1:$Port"

if (-not $NoOpen) {
  Start-Process $Url
}
Write-Host "DeckSync: $Url"
