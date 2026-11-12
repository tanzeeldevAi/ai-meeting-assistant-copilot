# Meeting Copilot: one-command install for Windows 10 and 11.
#
#   irm https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.ps1 | iex
#
# Paste that into PowerShell (Start menu > type "PowerShell" > Enter).
# Installs into %LOCALAPPDATA%\MeetingCopilot without administrator rights:
# Node and Python are fetched into the app's own folder if this PC does not
# already have suitable versions. Running it again updates the app and keeps
# your meetings and settings.
#
# Options, as environment variables:
#   MC_DIR             install somewhere else
#   MC_NO_LAUNCH=1     do not open the app at the end
#   MC_SKIP_AI=1       do not install the Claude CLI when no AI is found
#   MC_FORCE_PORTABLE=1  ignore this PC's own Node and Python (used by the tests)
#   MC_SOURCE          install from a local copy instead of GitHub (used by the tests)
#   MC_NO_SHORTCUTS=1  do not create the desktop and Start menu shortcuts

# Everything runs inside this block, so the settings below do not stay behind
# in the PowerShell window it was pasted into.
& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'tanzeeldevAi/ai-meeting-assistant-copilot'
$Dir = if ($env:MC_DIR) { $env:MC_DIR } else { Join-Path $env:LOCALAPPDATA 'MeetingCopilot' }
$Rt = Join-Path $Dir '.runtime'
$NodeLine = 'v22.x'

function Step($t) { Write-Host ''; Write-Host $t -ForegroundColor White }
function Info($t) { Write-Host "    $t" }
function Fail($t) { Write-Host ''; Write-Host "  $t" -ForegroundColor Red; Write-Host ''; throw $t }

# Run a native program and stop if it fails. PowerShell 5 does not do this by
# itself for exit codes.
#
# Judged by the exit code alone. With ErrorActionPreference at Stop, Windows
# PowerShell 5 turns any line a program writes to stderr into a terminating
# error, so a harmless warning (Hugging Face prints one on every download)
# killed the whole install.
function Run {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Host } finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { Fail "$Exe failed (exit $LASTEXITCODE)." }
}

# Same, for a step that is allowed to fail. Returns whether it worked.
function Try-Run {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Exe @Arguments *> $null } finally { $ErrorActionPreference = $prev }
  return ($LASTEXITCODE -eq 0)
}

Write-Host ''
Write-Host "Meeting Copilot - installing into $Dir" -ForegroundColor White
New-Item -ItemType Directory -Force -Path $Dir, $Rt | Out-Null
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("mc-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null

try {
  # ------------------------------------------------------------- the app
  Step '[1/6] Getting the app'
  if ($env:MC_SOURCE) {
    $Src = $env:MC_SOURCE
  } else {
    $zip = Join-Path $Tmp 'app.zip'
    Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $Tmp -Force
    $Src = (Get-ChildItem $Tmp -Directory | Select-Object -First 1).FullName
  }
  # Your meetings, settings and installed packages are left where they are.
  $null = robocopy $Src $Dir /MIR /NFL /NDL /NJH /NJS /NP `
    /XD (Join-Path $Src 'data') (Join-Path $Src '.venv') (Join-Path $Src 'node_modules') (Join-Path $Src '.runtime') (Join-Path $Src '.git') `
        (Join-Path $Dir 'data') (Join-Path $Dir '.venv') (Join-Path $Dir 'node_modules') (Join-Path $Dir '.runtime')
  if ($LASTEXITCODE -ge 8) { Fail "Copying the app failed (robocopy $LASTEXITCODE)." }
  Info 'done'

  # ------------------------------------------------------------- Node
  Step '[2/6] Node.js'
  $nodeOk = $false
  if (-not $env:MC_FORCE_PORTABLE -and (Get-Command node -ErrorAction SilentlyContinue)) {
    try {
      $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
      $major = [int]((& node -p "process.versions.node.split('.')[0]" 2>$null) | Select-Object -First 1)
      $nodeOk = $major -ge 18
    } catch { $nodeOk = $false } finally { $ErrorActionPreference = $prev }
  }
  if (-not $nodeOk) {
    $nodeDir = Join-Path $Rt 'node'
    if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) {
      $sums = (Invoke-WebRequest "https://nodejs.org/dist/latest-$NodeLine/SHASUMS256.txt" -UseBasicParsing).Content
      $file = ($sums -split "`n" | ForEach-Object { ($_ -split '\s+')[1] } |
               Where-Object { $_ -match '^node-v[\d.]+-win-x64\.zip$' } | Select-Object -First 1)
      if (-not $file) { Fail 'Could not find a Node.js download for this PC.' }
      Info "downloading $($file -replace '\.zip$','')"
      $nz = Join-Path $Tmp $file
      Invoke-WebRequest "https://nodejs.org/dist/latest-$NodeLine/$file" -OutFile $nz -UseBasicParsing
      Expand-Archive $nz -DestinationPath $Tmp -Force
      if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
      Move-Item (Join-Path $Tmp ($file -replace '\.zip$','')) $nodeDir
    }
    $env:PATH = "$nodeDir;$env:PATH"
  }
  Info "node $(& node -v)"

  # ------------------------------------------------------------- Python
  Step '[3/6] Python and the speech packages'
  # uv fetches a known-good Python 3.12 by itself, without touching this PC's own.
  $uv = $null
  if (-not $env:MC_FORCE_PORTABLE) { $c = Get-Command uv -ErrorAction SilentlyContinue; if ($c) { $uv = $c.Source } }
  if (-not $uv) {
    $uvDir = Join-Path $Rt 'uv'
    $uv = Join-Path $uvDir 'uv.exe'
    if (-not (Test-Path $uv)) {
      # The release archive itself, rather than uv's own installer script: that
      # script may call `exit`, which would end this installer with it.
      $uz = Join-Path $Tmp 'uv.zip'
      Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $uz -UseBasicParsing
      Expand-Archive $uz -DestinationPath $uvDir -Force
      if (-not (Test-Path $uv)) { Fail 'Could not set up uv.' }
    }
  }
  $py = Join-Path $Dir '.venv\Scripts\python.exe'
  if (-not (Test-Path $py)) { Run $uv @('venv', '--quiet', '--seed', '--python', '3.12', (Join-Path $Dir '.venv')) }
  Run $uv @('pip', 'install', '--quiet', '--python', $py, '-r', (Join-Path $Dir 'audio\requirements.txt'))
  Info "$(& $py -V)"

  # ------------------------------------------------------------- app packages
  Step '[4/6] App packages'
  Push-Location $Dir
  try { Run 'npm.cmd' @('install', '--no-fund', '--no-audit', '--loglevel=error') } finally { Pop-Location }
  Info 'done'

  # ------------------------------------------------------------- speech model
  Step '[5/6] Speech model'
  $model = "from faster_whisper import WhisperModel; WhisperModel('tiny.en', compute_type='int8')"
  if (Try-Run $py @('-c', $model)) { Info 'done' } else { Info 'it will download the first time you listen' }
  Run $py @('-c', 'import pyaudiowpatch, scipy, faster_whisper, webrtcvad, websockets')

  # ------------------------------------------------------------- the AI
  Step '[6/6] The AI that writes your answers'
  $claudeExe = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  $haveClaude = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path $claudeExe)
  $haveCodex = [bool](Get-Command codex -ErrorAction SilentlyContinue)
  if ($haveClaude -or $haveCodex) {
    if ($haveClaude) { Info 'found Claude' }
    if ($haveCodex) { Info 'found ChatGPT (Codex CLI)' }
  } elseif ($env:MC_SKIP_AI) {
    Info 'skipped'
  } else {
    Info 'installing the Claude CLI (you can switch to ChatGPT in the app)'
    # In its own PowerShell, so nothing it does can end this installer.
    if (-not (Try-Run 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'))) {
      Info 'could not install it now; the app will tell you how'
    }
  }

  # ------------------------------------------------------------- shortcuts
  $electron = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path $electron)) { Fail 'The app did not install completely (electron.exe is missing).' }
  if (-not $env:MC_NO_SHORTCUTS) {
    $shell = New-Object -ComObject WScript.Shell
    $places = @([Environment]::GetFolderPath('Desktop'),
                (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))
    foreach ($place in $places) {
      $lnk = $shell.CreateShortcut((Join-Path $place 'Meeting Copilot.lnk'))
      $lnk.TargetPath = $electron
      $lnk.Arguments = "`"$Dir`""
      $lnk.WorkingDirectory = $Dir
      $lnk.IconLocation = "$electron,0"
      $lnk.Description = 'Meeting Copilot'
      $lnk.Save()
    }
  }

  Write-Host ''
  Write-Host 'Meeting Copilot is installed.' -ForegroundColor Green
  Info 'Open it any time from the desktop or the Start menu: Meeting Copilot'
  Info 'If no AI is signed in yet, the app shows a Sign in button.'
  Write-Host ''

  if (-not $env:MC_NO_LAUNCH) { Start-Process $electron -ArgumentList "`"$Dir`"" -WorkingDirectory $Dir }
}
finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
}
