# Spike: find a Claude Code process by a marker in its command line and kill its whole tree.
# The marker is the --session-id UUID, which Claude accepts and keeps in argv.
param(
  [Parameter(Mandatory = $true)][string]$Claude,
  [Parameter(Mandatory = $true)][string]$Mcp
)
$ErrorActionPreference = 'Stop'
$marker = [guid]::NewGuid().ToString()
$cfg = Join-Path $env:TEMP "orch-spike-mcp.json"
@{ mcpServers = @{ ledger = @{ command = 'node'; args = @($Mcp) } } } | ConvertTo-Json -Depth 5 | Set-Content -Encoding ascii $cfg

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Claude
$psi.Arguments = "-p --input-format stream-json --output-format stream-json --verbose --tools `"`" --strict-mcp-config --mcp-config `"$cfg`" --permission-mode bypassPermissions --session-id $marker"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
foreach ($n in @('CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN')) { $psi.Environment.Remove($n) | Out-Null }
$p = [System.Diagnostics.Process]::Start($psi)
# One user message keeps the process alive waiting for more input, and makes it spawn the MCP child.
$p.StandardInput.WriteLine('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Reply with the single word OK."}]},"parent_tool_use_id":null,"session_id":""}')
$p.StandardInput.Flush()
Start-Sleep -Seconds 12

function Tree($rootPid) {
  $all = Get-CimInstance Win32_Process
  $out = @(); $queue = @($rootPid)
  while ($queue.Count) { $cur = $queue[0]; $queue = $queue[1..$queue.Count]; $kids = $all | Where-Object { $_.ParentProcessId -eq $cur }; foreach ($k in $kids) { $out += $k; $queue += $k.ProcessId } }
  return $out
}
$found = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $marker }
"FOUND by marker: " + (($found | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join '; ')
$kids = Tree $p.Id
"CHILDREN before kill: " + (($kids | ForEach-Object { "$($_.ProcessId) $($_.Name)" }) -join '; ')
$root = ($found | Select-Object -First 1).ProcessId
"ROOT pid $root (spawned pid $($p.Id)); exited=$($p.HasExited)"
if ($root) { & taskkill /T /F /PID $root 2>&1 | Out-Null; "TASKKILL exit code: $LASTEXITCODE" }
Start-Sleep -Seconds 3
$left = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -match $marker }
"LEFT by marker after kill: " + @($left).Count
$leftKids = @($kids | ForEach-Object { $id = $_.ProcessId; Get-Process -Id $id -ErrorAction SilentlyContinue } | Where-Object { $_ })
"LEFT children after kill: " + $leftKids.Count
Remove-Item $cfg -ErrorAction SilentlyContinue
