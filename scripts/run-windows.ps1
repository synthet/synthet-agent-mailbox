# Builds the app, replaces any running tray app, and leaves a new one running.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$exe = Join-Path $root "dist\AgentMailTray.exe"

if (-not (Test-Path -LiteralPath "node_modules")) {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}
& npm run build
if ($LASTEXITCODE -ne 0) { throw "The build failed." }

$running = Get-Process -Name AgentMailTray -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Stopping the running tray app."
    & $exe --quit
    if (-not $running.WaitForExit(10000)) { $running | Stop-Process -Force }
}

$csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) "csc.exe"
& $csc /nologo /target:winexe "/out:$exe" "/win32icon:assets\icon.ico" /r:System.Windows.Forms.dll /r:System.Drawing.dll tray\AgentMailTray.cs
if ($LASTEXITCODE -ne 0) { throw "The tray app did not compile." }

Start-Process -FilePath $exe
Write-Host "Agent Mailbox is running in the system tray."
