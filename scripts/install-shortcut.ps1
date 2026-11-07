# Points the Agent Mailbox desktop and logon shortcuts at the tray app.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "dist\AgentMailTray.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    Write-Host "Run run.bat once first so the tray app is built."
    exit 1
}

foreach ($folder in "Desktop", "Startup") {
    $path = Join-Path ([Environment]::GetFolderPath($folder)) "Agent Mailbox.lnk"
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = (Join-Path $root "assets\icon.ico") + ",0"
    $shortcut.Save()
    Write-Host "Updated $path"
}
