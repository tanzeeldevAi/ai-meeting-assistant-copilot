#!/usr/bin/env bash
# Meeting Copilot: one-command install for macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.sh | bash
#
# For ChatGPT instead of Claude, put MC_AI=chatgpt before bash:
#   curl -fsSL .../install.sh | MC_AI=chatgpt bash
#
# Installs into ~/MeetingCopilot without an administrator password: Node and
# Python are fetched into the app's own folder if the Mac does not already
# have suitable versions. Running it again updates the app and keeps your
# meetings and settings.
#
# Options, as environment variables:
#   MC_DIR=...            install somewhere else
#   MC_NO_LAUNCH=1        do not open the app at the end
#   MC_AI=chatgpt         use ChatGPT: installs its Codex CLI (into the app's folder)
#   MC_AI=claude          use Claude: installs the Claude CLI if it is missing
#   MC_SKIP_AI=1          install no AI tool at all
#   MC_FORCE_PORTABLE=1   ignore the Mac's own Node and Python (used by the tests)
#   MC_SOURCE=/path       install from a local copy instead of GitHub (used by the tests)
#   MC_APPS_DIR=...       where the launcher goes (default ~/Applications)
set -euo pipefail

# Everything is inside main(), which is called on the last line. Piped from
# curl, bash runs a script as it arrives; if the download stopped half way, a
# partial script would run. Wrapped like this, nothing runs until all of it is
# here.
main() {

REPO="tanzeeldevAi/ai-meeting-assistant-copilot"
DIR="${MC_DIR:-$HOME/MeetingCopilot}"
RT="$DIR/.runtime"
NODE_LINE="v22.x"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[31m  %s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "This installer is for macOS. On Windows, see the README for the PowerShell command."
MACOS=$(sw_vers -productVersion)
[ "${MACOS%%.*}" -ge 13 ] || die "macOS 13 or newer is needed (this Mac has $MACOS)."
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) die "Unsupported processor: $(uname -m)" ;; esac

bold "Meeting Copilot - installing into $DIR"
mkdir -p "$DIR" "$RT"

# --------------------------------------------------------------- the app
bold "[1/6] Getting the app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ -n "${MC_SOURCE:-}" ]; then
  SRC="$MC_SOURCE"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" | tar -xz -C "$TMP"
  SRC=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)
fi
# Your meetings, settings and installed packages are left where they are.
rsync -a --delete \
  --exclude data/ --exclude .venv/ --exclude node_modules/ --exclude .runtime/ \
  --exclude .git/ --exclude audio/mac/syscap \
  "$SRC/" "$DIR/"
info "done"

# --------------------------------------------------------------- Node
bold "[2/6] Node.js"
NODE_OK=""
if [ -z "${MC_FORCE_PORTABLE:-}" ] && command -v node >/dev/null 2>&1; then
  [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] && NODE_OK=1
fi
if [ -z "$NODE_OK" ]; then
  if [ ! -x "$RT/node/bin/node" ]; then
    FILE=$(curl -fsSL "https://nodejs.org/dist/latest-$NODE_LINE/SHASUMS256.txt" \
      | awk '{print $2}' | grep -E "^node-v[0-9.]+-darwin-$ARCH\.tar\.gz$" | head -1)
    [ -n "$FILE" ] || die "Could not find a Node.js download for this Mac."
    info "downloading ${FILE%.tar.gz}"
    curl -fsSL "https://nodejs.org/dist/latest-$NODE_LINE/$FILE" | tar -xz -C "$TMP"
    rm -rf "$RT/node"; mv "$TMP/${FILE%.tar.gz}" "$RT/node"
  fi
  export PATH="$RT/node/bin:$PATH"
fi
info "node $(node -v)"

# --------------------------------------------------------------- Python
bold "[3/6] Python and the speech packages"
# uv fetches a known-good Python 3.12 by itself, without touching the Mac's own.
UV=""
if [ -z "${MC_FORCE_PORTABLE:-}" ] && command -v uv >/dev/null 2>&1; then UV=$(command -v uv); fi
if [ -z "$UV" ]; then
  if [ ! -x "$RT/uv/uv" ]; then
    case "$ARCH" in arm64) UVT=aarch64-apple-darwin ;; *) UVT=x86_64-apple-darwin ;; esac
    mkdir -p "$RT/uv"
    curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-$UVT.tar.gz" \
      | tar -xz -C "$RT/uv" --strip-components 1
  fi
  UV="$RT/uv/uv"
fi
[ -x "$DIR/.venv/bin/python3" ] || "$UV" venv --quiet --seed --python 3.12 "$DIR/.venv"
"$UV" pip install --quiet --python "$DIR/.venv/bin/python3" -r "$DIR/audio/requirements-mac.txt"
info "$("$DIR/.venv/bin/python3" -V)"

# --------------------------------------------------------------- app packages
bold "[4/6] App packages"
( cd "$DIR" && npm install --no-fund --no-audit --loglevel=error )
# Some npm versions (the one with Node 26, for one) skip install scripts, and
# Electron downloads its app in one. Fetch it directly if it is not there.
if [ ! -x "$DIR/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
  ( cd "$DIR" && node node_modules/electron/install.js ) || die "Could not download Electron."
fi
info "done"

# --------------------------------------------------------------- audio helper + model
bold "[5/6] System audio helper and speech model"
# xcode-select -p, not `command -v swiftc`: on a Mac without the developer
# tools, /usr/bin/swiftc is a stub that pops up an install dialog when run.
if xcode-select -p >/dev/null 2>&1 && xcrun --find swiftc >/dev/null 2>&1; then
  swiftc -O -o "$DIR/audio/mac/syscap" "$DIR/audio/mac/syscap.swift"
  info "built from source"
else
  # No Apple developer tools: use the ready-made build from the release.
  curl -fsSL -o "$DIR/audio/mac/syscap" \
    "https://github.com/$REPO/releases/latest/download/syscap-macos-universal"
  chmod +x "$DIR/audio/mac/syscap"
  info "downloaded ready-made"
fi
"$DIR/audio/mac/syscap" --devices >/dev/null || die "The system audio helper did not run."
"$DIR/.venv/bin/python3" -c "from faster_whisper import WhisperModel; WhisperModel('tiny.en', compute_type='int8')" \
  >/dev/null 2>&1 || info "the speech model will download the first time you listen"
"$DIR/.venv/bin/python3" -c "import sounddevice, scipy, faster_whisper, webrtcvad, websockets" \
  || die "The speech packages did not load."
info "done"

# --------------------------------------------------------------- the AI
bold "[6/6] The AI that writes your answers"
have_claude=""; have_codex=""
{ command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; } && have_claude=1
{ command -v codex >/dev/null 2>&1 || [ -x "$RT/codex/bin/codex" ]; } && have_codex=1
want="$(printf '%s' "${MC_AI:-}" | tr '[:upper:]' '[:lower:]')"
[ -n "$have_claude" ] && info "found Claude"
[ -n "$have_codex" ] && info "found ChatGPT (Codex CLI)"
if [ -n "${MC_SKIP_AI:-}" ]; then
  info "skipped"
elif [ "$want" = "chatgpt" ] || [ "$want" = "codex" ]; then
  if [ -z "$have_codex" ]; then
    # Into the app's own folder: a global npm install would need sudo on many Macs.
    info "installing ChatGPT's Codex CLI"
    npm install -g --prefix "$RT/codex" --no-fund --no-audit --loglevel=error @openai/codex >/dev/null 2>&1 \
      && [ -x "$RT/codex/bin/codex" ] \
      || info "could not install it now; run this line again later"
  fi
elif { [ "$want" = "claude" ] && [ -z "$have_claude" ]; } \
  || { [ -z "$want" ] && [ -z "$have_claude" ] && [ -z "$have_codex" ]; }; then
  info "installing the Claude CLI (for ChatGPT, see the README)"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 \
    || info "could not install it now; the app will tell you how"
fi

# --------------------------------------------------------------- launcher
# A small app in ~/Applications, so it opens from Launchpad and Spotlight. It
# starts Electron through `open`, which is what makes macOS ask for the
# microphone and screen-recording permissions for the app, not for Terminal.
APPDIR="${MC_APPS_DIR:-$HOME/Applications}/Meeting Copilot.app"
mkdir -p "$APPDIR/Contents/MacOS"
cat > "$APPDIR/Contents/MacOS/MeetingCopilot" <<EOF
#!/bin/bash
exec open -n "$DIR/node_modules/electron/dist/Electron.app" --args "$DIR"
EOF
chmod +x "$APPDIR/Contents/MacOS/MeetingCopilot"
cat > "$APPDIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Meeting Copilot</string>
  <key>CFBundleIdentifier</key><string>com.tanzeeldevai.meetingcopilot.launcher</string>
  <key>CFBundleExecutable</key><string>MeetingCopilot</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict></plist>
EOF

bold "Meeting Copilot is installed."
info "Open it any time from Launchpad or Spotlight: Meeting Copilot"
info "The first time, allow Microphone and Screen & System Audio Recording for Electron."
info "If no AI is signed in yet, the app shows a Sign in button."

if [ -z "${MC_NO_LAUNCH:-}" ]; then
  open "$APPDIR"
fi
}

main "$@"
