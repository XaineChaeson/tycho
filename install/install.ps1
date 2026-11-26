# tycho installer for Windows.
#
#   irm <url>/install.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install.ps1 -From <release file or unpacked directory>
#
# Needs no administrator rights, asks nothing, and is safe to run again. Whoever runs it
# is who tycho is installed for, with that account's logins and keys. It does two things
# only: unpacks the release under <prefix>\versions, and finds (or downloads) a Node the
# release accepts. Everything after that (version directory, launcher, PATH) is done by
# the release itself through "install-self", the same code an upgrade runs. The oldest
# Node that will do is not written here: the release's package.json declares it
# (engines.node), which is why the release is unpacked before a Node is looked for.
#
# Environment variables:
#   TYCHO_PREFIX          where the program goes; default %USERPROFILE%\.tycho\app
#   TYCHO_RELEASE_URL     where the release is downloaded from
#   TYCHO_NODE_DIST_URL   where the Node package is downloaded from (a mirror will do).
#                         A mirror supplies the package only: its checksum always comes
#                         from nodejs.org, so a package the mirror altered is refused
#   TYCHO_NO_MODIFY_PATH  when set, the user's PATH is left alone
#
# For tests; leave it unset otherwise:
#   TYCHO_NODE_SUMS_URL   where Node's SHASUMS256.txt is read from. Setting it replaces
#                         the root of trust: whatever that address calls the right
#                         package is the package that gets installed
#
# This file is plain ASCII on purpose, and so its own messages are in English: Windows
# PowerShell reads a script without a byte order mark in the system code page, and
# "irm | iex" may decode it as Latin-1. tycho's own messages, once it is unpacked, are
# in Chinese.
param([string]$From = '')

function Install-Tycho {
  param([string]$From)

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  # Bootstrap runs before Node exists, so it must reject test defaults itself.
  if (($env:NODE_TEST_CONTEXT -or $env:TYCHO_TEST_GUARD) -and -not $env:TYCHO_PREFIX) {
    throw 'Tests must set TYCHO_PREFIX before running the installer.'
  }
  $ReleaseUrl = if ($env:TYCHO_RELEASE_URL) { $env:TYCHO_RELEASE_URL } else { 'https://github.com/XaineChaeson/tycho/releases/latest/download/tycho.tar.gz' }
  $NodeDistUrl = if ($env:TYCHO_NODE_DIST_URL) { $env:TYCHO_NODE_DIST_URL } else { 'https://nodejs.org/dist/latest-v24.x' }
  $NodeSumsUrl = if ($env:TYCHO_NODE_SUMS_URL) { $env:TYCHO_NODE_SUMS_URL } else { 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' }
  $Prefix = if ($env:TYCHO_PREFIX) { $env:TYCHO_PREFIX } else { Join-Path $env:USERPROFILE '.tycho\app' }

  # The tar that ships with Windows 10 and later, by its full path: a Git Bash earlier
  # in PATH has its own, which reads "C:\..." as a remote host.
  $Tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $Tar)) {
    throw "tycho install: $Tar is missing. Windows 10 (version 1803) or later is required."
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'versions') | Out-Null
  $Prefix = (Resolve-Path -LiteralPath $Prefix).ProviderPath

  # Looked at before anything is unpacked: every member has to be a plain file or a
  # directory, and to land inside the directory it is unpacked into. Not left to tar:
  # what it refuses differs from one tar and one version to the next. Called from the
  # directory holding the archive, with the archive's name there.
  function Assert-Archive([string]$Name, [string]$Shown) {
    $Names = @(& $Tar -tzf $Name)
    if ($LASTEXITCODE -ne 0) { throw "tycho install: cannot read what is in $Shown. It is not a .tar.gz, or it is damaged." }
    $Bad = $Names | Where-Object { $_ -match '^/|^[A-Za-z]:|\\|(^|/)\.\.(/|$)' } | Select-Object -First 1
    if ($Bad) {
      throw "tycho install: $Shown has a member that would land outside the directory it is unpacked into ($Bad). It was not unpacked and nothing was installed."
    }
    # The first character of each line is the member's type: - a plain file, d a
    # directory, l a symbolic link, h a hard link.
    $Kinds = @(& $Tar -tzvf $Name)
    if ($LASTEXITCODE -ne 0) { throw "tycho install: cannot read what is in $Shown. It is not a .tar.gz, or it is damaged." }
    $Bad = $Kinds | Where-Object { $_ -notmatch '^[-d]' } | Select-Object -First 1
    if ($Bad) {
      throw "tycho install: $Shown has a member that is not a plain file or a directory (a link or a special file: $Bad). It was not unpacked and nothing was installed."
    }
  }

  # The oldest Node the release accepts, from engines.node in its package.json: ">=24.3.0",
  # where a part left out counts as 0.
  function Get-RequiredNode([string]$Release) {
    try {
      $Package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Release 'package.json') | ConvertFrom-Json
      if ("$($Package.engines.node)" -match '^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$') {
        return [version]("{0}.{1}.{2}" -f [int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
      }
    } catch {
    }
    return $null
  }

  # This process's id is in the name: another install cleaning up can tell that the
  # owner of this staging directory is still alive.
  $Stage = Join-Path $Prefix "versions\.staging-$PID-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $Download = "$Stage.tar.gz"
  New-Item -ItemType Directory -Path $Stage | Out-Null
  try {
    if ($From -and (Test-Path -LiteralPath $From -PathType Container)) {
      Get-ChildItem -LiteralPath $From -Force | Copy-Item -Destination $Stage -Recurse -Force
    } else {
      if (-not $From) {
        Write-Host "tycho install: downloading $ReleaseUrl"
        Invoke-WebRequest -UseBasicParsing -Uri $ReleaseUrl -OutFile $Download
        $From = $ReleaseUrl
      } elseif (Test-Path -LiteralPath $From -PathType Leaf) {
        Copy-Item -LiteralPath $From -Destination $Download
      } else {
        throw "tycho install: cannot find $From."
      }
      # By names relative to the versions directory: tar takes its arguments in the
      # system code page, which not every path survives.
      Push-Location -LiteralPath (Join-Path $Prefix 'versions')
      try {
        Assert-Archive (Split-Path -Leaf $Download) $From
        & $Tar -xzf (Split-Path -Leaf $Download) -C (Split-Path -Leaf $Stage)
      } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { throw "tycho install: could not unpack $From." }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Stage 'cli\main.ts')) -or -not (Test-Path -LiteralPath (Join-Path $Stage 'package.json'))) {
      throw "tycho install: $From is not a tycho release."
    }
    $MinNode = Get-RequiredNode $Stage
    if (-not $MinNode) {
      throw "tycho install: the package.json of $From does not say which Node it needs (engines.node should read like "">=24.3.0"")."
    }

    # Whether this node is new enough.
    function Test-Node([string]$Candidate) {
      try {
        $Have = & $Candidate -p "process.versions.node"
        if ($LASTEXITCODE -ne 0 -or "$Have" -notmatch '^(\d+)\.(\d+)\.(\d+)') { return $false }
        return ([version]("{0}.{1}.{2}" -f $Matches[1], $Matches[2], $Matches[3])) -ge $MinNode
      } catch {
        return $false
      }
    }

    # The one on PATH first, then the one an earlier run downloaded; a download only when
    # neither will do.
    $Node = $null
    $Private = Join-Path $Prefix 'node\node.exe'
    $OnPath = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($OnPath -and (Test-Node $OnPath.Path)) { $Node = $OnPath.Path }
    if (-not $Node -and (Test-Path -LiteralPath $Private) -and (Test-Node $Private)) { $Node = $Private }
    if (-not $Node) {
      $Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw "tycho install: there is no official Node build for $env:PROCESSOR_ARCHITECTURE. Install Node $MinNode or later yourself, then run this again." }
      }
      Write-Host "tycho install: no Node $MinNode or later on PATH; downloading one into $Prefix\node (used by tycho only)."
      # Which package is the right one is nodejs.org's to say; a mirror only delivers it.
      $Sums = (Invoke-WebRequest -UseBasicParsing -Uri $NodeSumsUrl).Content
      if ($Sums -is [byte[]]) { $Sums = [Text.Encoding]::ASCII.GetString($Sums) }
      $Pattern = "^([0-9a-f]{64})\s+(node-v[0-9.]+-win-$Arch\.zip)\s*$"
      $Line = $Sums -split "`n" | Where-Object { $_ -match $Pattern } | Select-Object -First 1
      if (-not $Line) { throw "tycho install: $NodeSumsUrl lists no build for win-$Arch." }
      $null = $Line -match $Pattern
      $Sha = $Matches[1]
      $Name = $Matches[2]
      $Scratch = Join-Path $Prefix ".node-download-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
      New-Item -ItemType Directory -Path $Scratch | Out-Null
      try {
        $Zip = Join-Path $Scratch $Name
        Invoke-WebRequest -UseBasicParsing -Uri "$NodeDistUrl/$Name" -OutFile $Zip
        # The official checksum decides whether the download is kept.
        $Stream = [IO.File]::OpenRead($Zip)
        $Hash = [Security.Cryptography.SHA256]::Create()
        try {
          $Actual = [BitConverter]::ToString($Hash.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
        } finally {
          $Hash.Dispose()
          $Stream.Dispose()
        }
        if ($Actual -ne $Sha) {
          throw "tycho install: $Name failed its checksum (nodejs.org says $Sha, got $Actual). Nothing was installed."
        }
        $Folder = $Name -replace '\.zip$', ''
        Push-Location -LiteralPath $Scratch
        try { & $Tar -xf $Name "$Folder/node.exe" } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "tycho install: could not unpack $Name." }
        $Fresh = Join-Path $Scratch "$Folder\node.exe"
        if (-not (Test-Node $Fresh)) {
          throw "tycho install: the downloaded $Name is older than the Node $MinNode tycho needs, or does not run on this machine. Nothing was installed."
        }
        New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'node') | Out-Null
        Move-Item -Force -LiteralPath $Fresh -Destination $Private
      } finally {
        Remove-Item -Recurse -Force -LiteralPath $Scratch -ErrorAction SilentlyContinue
      }
      $Node = $Private
    }

    & $Node (Join-Path $Stage 'cli\main.ts') install-self --prefix $Prefix --node $Node
    if ($LASTEXITCODE -ne 0) { throw 'tycho install did not finish; see the messages above.' }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $Stage -ErrorAction SilentlyContinue
    Remove-Item -Force -LiteralPath $Download -ErrorAction SilentlyContinue
  }
}

Install-Tycho -From $From
