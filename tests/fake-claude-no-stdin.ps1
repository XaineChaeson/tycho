# Stands in for a CLI that is running but no longer reads its input. Node cannot play
# this part on Windows: libuv refuses to close fds 0-2, so the pipe stays open for as
# long as a Node process lives.
#
# FAKE_CLAUDE_CLOSED      file created once stdin is closed
# FAKE_CLAUDE_READ_FIRST  take one line before closing, so that a turn is in progress
Add-Type -Namespace Fake -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int which);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr handle);
'@
$STD_INPUT_HANDLE = -10
if ($env:FAKE_CLAUDE_READ_FIRST) { [void][Console]::In.ReadLine() }
[void][Fake.Win32]::CloseHandle([Fake.Win32]::GetStdHandle($STD_INPUT_HANDLE))
Set-Content -Path $env:FAKE_CLAUDE_CLOSED -Value ''
while ($true) { Start-Sleep -Seconds 60 }
