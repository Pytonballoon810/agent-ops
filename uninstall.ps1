<#
  Stops and removes the agent-routing task and whatever still holds its port. Leaves the code and
  dashboard/routing.db alone.
#>
[CmdletBinding()]
param([string]$TaskName = 'agent-routing')

$ErrorActionPreference = 'Continue'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the '$TaskName' task."
} else {
  Write-Host "No '$TaskName' task registered."
}

# Stopping the task ends wscript, not necessarily node; find the server by its port.
$port = [Environment]::GetEnvironmentVariable('ROUTING_PORT', 'User')
if (-not $port) { $port = '56300' }
$owners = (Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue).OwningProcess
foreach ($id in ($owners | Select-Object -Unique)) {
  Write-Host "Stopping pid $id, which still holds port $port."
  Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}

[Environment]::SetEnvironmentVariable('ROUTING_PORT', $null, 'User')
Write-Host "Done."
