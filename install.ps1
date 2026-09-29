<#
  Registers the combined Boost dashboard (dashboard/server.mjs) to start at logon and stay up.

  `boost ui` is started by hand and takes a new port each launch, so this server runs all the
  time, costs nothing while Boost is down, and opens http://127.0.0.1:<Port>/ in the browser each
  time a new `boost ui` appears. A Scheduled Task rather than a service: node is not service-aware, and the data is the user's own under their profile.

  No elevation required.
#>
[CmdletBinding()]
param(
  [int]$Port = 56300,
  [string]$TaskName = 'agent-ops'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dash = Join-Path $here 'dashboard'
$vbs = Join-Path $dash 'run.vbs'

if (-not (Test-Path $vbs)) { throw "run.vbs not found at $vbs" }

$action = New-ScheduledTaskAction `
  -Execute "$env:SystemRoot\System32\wscript.exe" `
  -Argument "`"$vbs`"" `
  -WorkingDirectory $dash

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "Replacing the existing '$TaskName' task."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Serves JFrog Boost's dashboard with the model-routing and skill-router cards on http://127.0.0.1:$Port and opens it when boost ui starts" | Out-Null

if ($Port -eq 56300) {
  [Environment]::SetEnvironmentVariable('ROUTING_PORT', $null, 'User')
} else {
  [Environment]::SetEnvironmentVariable('ROUTING_PORT', "$Port", 'User')
}

# A copy started by hand would hold the port and make the task's copy exit.
$owners = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($id in ($owners | Select-Object -Unique)) {
  Write-Host "Stopping pid $id, which already holds port $Port."
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Registered '$TaskName'."
Write-Host "  runs   : at logon, as $env:USERNAME, no window, restarts up to 3x on failure"
Write-Host "  serves : http://127.0.0.1:$Port"
Write-Host "  opens  : that page whenever a new 'boost ui' starts"
Write-Host ""
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
try {
  Invoke-WebRequest -Uri "http://127.0.0.1:$Port/__routing/period.js" -UseBasicParsing -TimeoutSec 5 | Out-Null
  Write-Host "Up on http://127.0.0.1:$Port"
} catch {
  Write-Warning "Not answering on port $Port yet. Give it a few seconds."
}
