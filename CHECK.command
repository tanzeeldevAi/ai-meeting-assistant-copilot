#!/bin/bash
# Is the AI that writes your answers signed in, and how fast is it? Double-click it.
cd "$(dirname "$0")" || exit 1
node tools/check-claude.js
node tools/check-chatgpt.js
node tools/check-cursor.js
read -n1 -p "Press any key to close." || true
exit 0
