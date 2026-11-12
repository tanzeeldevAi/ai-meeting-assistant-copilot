<div align="center">

# AI Meeting Assistant Copilot

**An open-source AI meeting assistant for Zoom, Google Meet and Teams. It listens to the call and writes what to say back on a private overlay that screen sharing does not show. Runs on the Claude or ChatGPT subscription you already have.**

[![Tests](https://github.com/tanzeeldevAi/ai-meeting-assistant-copilot/actions/workflows/tests.yml/badge.svg)](https://github.com/tanzeeldevAi/ai-meeting-assistant-copilot/actions/workflows/tests.yml)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)](#install-in-one-command)
[![macOS](https://img.shields.io/badge/macOS-13%2B-000000?logo=apple&logoColor=white)](#install-in-one-command)
[![Claude](https://img.shields.io/badge/Claude-subscription-D97757)](#which-ai-writes-the-answers)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-subscription-10A37F?logo=openai&logoColor=white)](#which-ai-writes-the-answers)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Developed by Tanzeel](https://img.shields.io/badge/Developed%20by-Tanzeel-6C3EF5)](https://github.com/tanzeeldevAi)

<img src="docs/images/hero.png" alt="Meeting Copilot's overlay beside a video call, showing what the client said and the suggested answer" width="100%">

</div>

---

## What is this?

A client asks you something on a call. You know the answer, but turning it into clear
words while they wait is the hard part, especially in a second language.

**Meeting Copilot listens to the call and shows you what to say back**, a few seconds
after they finish speaking. You read it, say it in your own voice, and keep the
conversation moving. It is a free, open-source alternative to paid AI meeting copilots
such as Cluely, built for client calls, sales calls and consultations.

<table>
  <tr>
    <td align="center" width="33%"><b>1. Prepare</b></td>
    <td align="center" width="33%"><b>2. Listen</b></td>
    <td align="center" width="33%"><b>3. Answer</b></td>
  </tr>
  <tr>
    <td>Write a short brief: who you are meeting, your goal, your prices and the lines you want to use.</td>
    <td>Press <b>Start listening</b>. It hears the other person through your computer's sound.</td>
    <td>When they ask something, the words to say back appear on your private overlay.</td>
  </tr>
</table>

### At a glance

<table>
  <tr><td><b>Cost</b></td><td>Free and open source (MIT)</td></tr>
  <tr><td><b>AI</b></td><td>Your Claude or ChatGPT subscription. No API key needed</td></tr>
  <tr><td><b>Call apps</b></td><td>Zoom, Google Meet, Microsoft Teams, Webex, any app that plays sound</td></tr>
  <tr><td><b>Computers</b></td><td>Windows 10 and 11, macOS 13 or newer</td></tr>
  <tr><td><b>Speed</b></td><td>About 2 to 5 seconds from their last word to the answer on screen, with Claude</td></tr>
  <tr><td><b>Your data</b></td><td>Briefs, transcripts and notes stay on your computer</td></tr>
</table>

---

## Features

<table>
  <tr>
    <td valign="top" width="50%">

### 📝 Before the call

- **Meeting brief.** Who you are meeting, your role, your goal, and any material the
  answers can use: pitch, prices, past results, your CV.
- **Your own script.** Write the exact lines you want to say. When a question is
  covered, you get your line back, almost word for word.
- **"Ask the AI what else it needs."** It asks the 4 to 6 questions whose answers
  improve the live answers most.
- **Better spelling of your words.** Names and jargon from the brief are taught to the
  speech recogniser, so "idempotency" does not come out as "eye-dampitancy".

</td>
    <td valign="top" width="50%">

### 🎧 During the call

- **Live answers.** Written in the first person, ready to say. With Claude the words
  appear as they are written.
- **Answers them, never you.** Their voice comes from your speakers and yours from your
  microphone, so the two are never mixed up.
- **No invented facts.** If the brief does not cover a question, it answers only from
  your facts and will not make up experience, results or prices.
- **Questions to ask next.** Three short suggestions that move the meeting toward your
  goal.
- **Ask box.** Type anything mid-call: "how do I say no politely?"

</td>
  </tr>
  <tr>
    <td valign="top" width="50%">

### 🔒 Private by design

- **Hidden from screen sharing.** Share a window or a tab and the overlay is not in
  what the other side sees.
- **Private notes.** Lines marked `NOTE - DON'T SAY`, like your lowest price, guide the
  answers but are never shown as words to say.
- **Phone view.** The same answers on your phone over your own Wi-Fi, so nothing is on
  screen at all.
- **Local speech to text.** Runs on your computer by default. A faster cloud option is
  there if you want it.

</td>
    <td valign="top" width="50%">

### 📄 After the call

- **Summary.** What was discussed, in a few plain sentences.
- **Decisions and action items.** Who does what, and by when.
- **Follow-up message.** A short, friendly message ready to send.
- **Word export.** Everything above, plus the transcript and your notes, as a `.docx`
  file.

</td>
  </tr>
</table>

<table>
  <tr>
    <td width="73%"><img src="docs/images/dashboard-brief.png" alt="Dashboard: writing the brief before a meeting"></td>
    <td width="27%"><img src="docs/images/phone.png" alt="The phone view showing the transcript and the answer"></td>
  </tr>
  <tr>
    <td align="center"><sub>Prepare the meeting: who you are meeting, your goal, your script and prices.</sub></td>
    <td align="center"><sub>The phone view, for full-screen sharing.</sub></td>
  </tr>
</table>

---

## Which AI writes the answers

Pick whichever you already have. You can change it any time under
**Dashboard → Settings → Main brain**.

| | Claude | ChatGPT | OpenAI API |
|---|---|---|---|
| What you need | Claude Pro or Max | ChatGPT Plus, Pro or Business | An API key from platform.openai.com |
| Extra cost | None | None | Pay per use |
| How it connects | The Claude Code CLI, signed in | The Codex CLI, signed in with ChatGPT | The key, pasted into Settings |
| First words on screen | About 1 to 2 s after the question | About 7 to 9 s (the reply arrives whole) | About 1 to 2 s |
| Best for | Live answers | Prep and summaries; works live, but slower | A backup, or if you prefer the API |

Times are measured from the moment the question is sent, on a real account.
Speech to text adds its own time on top, see [Speed](#speed).

If Claude fails in the middle of a meeting (a usage limit, an expired login), the app
switches to a backup on its own and keeps answering: the OpenAI key if you set one,
otherwise ChatGPT if the Codex CLI is signed in.

---

## Install in one command

Copy one line, paste it, press Enter. It installs everything the app needs and
opens it when it is finished. It takes 5 to 10 minutes the first time.

**Windows 10 or 11:** open the Start menu, type **PowerShell**, open it, paste this
line and press Enter:

```powershell
irm https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.ps1 | iex
```

**Mac (macOS 13 or newer):** open **Terminal** (press Cmd + Space and type Terminal),
paste this line and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.sh | bash
```

<details>
<summary><b>Pay for ChatGPT, not Claude? Use these lines instead</b></summary>

They install ChatGPT's command-line tool (Codex) in place of Claude's.

**Windows:**

```powershell
$env:MC_AI='chatgpt'; irm https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.ps1 | iex
```

**Mac:**

```bash
curl -fsSL https://raw.githubusercontent.com/tanzeeldevAi/ai-meeting-assistant-copilot/main/install.sh | MC_AI=chatgpt bash
```

Already installed with the first line? Run one of these and it adds ChatGPT; your
meetings and settings stay.
</details>

### What the command does

1. Downloads the app.
2. Installs Node.js and Python inside the app's own folder if your computer does not
   have them. It does not ask for an administrator password and does not touch the
   programs already on your computer.
3. Installs the speech packages and the speech model.
4. Looks for Claude or ChatGPT. If it finds neither, it installs Claude's
   command-line tool (or ChatGPT's, with the lines above).
5. Adds a shortcut: on Windows to the desktop and the Start menu, on a Mac to
   Launchpad and Spotlight.
6. Opens the app.

| | Windows | Mac |
|---|---|---|
| Installed in | `%LOCALAPPDATA%\MeetingCopilot` | `~/MeetingCopilot` |
| Open it from | Desktop or Start menu: **Meeting Copilot** | Launchpad or Spotlight: **Meeting Copilot** |
| Update it | Run the same line again | Run the same line again |

Updating keeps your saved meetings and settings.

### Connect your AI

When the app opens it looks for Claude and ChatGPT on your computer by itself:

| Situation | What happens |
|---|---|
| Already signed in to Claude or ChatGPT | It connects straight away. Nothing to do. |
| Signed in only to the one you did not pick | It switches to that one by itself. |
| Signed in to neither | Press **Sign in with Claude** or **Sign in with ChatGPT**, log in in the browser window that opens, and it connects as soon as you are done. |

### The first time on a Mac

macOS asks for two permissions. Allow both for **Electron**:

- **Microphone**, to hear you
- **Screen & System Audio Recording**, to hear the other person (no video is recorded)

If macOS offers **Quit & Reopen** after you allow it, quit, then open Meeting Copilot
again.

<details>
<summary><b>Prefer to install by hand?</b></summary>

You need [Node.js](https://nodejs.org) 18 or newer and [Python 3.12](https://www.python.org/downloads/)
(on Windows, tick **"Add python.exe to PATH"**). Download this project with the green
**Code** button, unzip it, then double-click **`SETUP.bat`** (Windows) or
**`SETUP-MAC.command`** (Mac). Start it with **`START.bat`** or **`START.command`**.

To sign in by hand: `claude auth login` for Claude, or `codex login` for ChatGPT.
**`CHECK.bat`** or **`CHECK.command`** tells you which AI is signed in and how fast it
answers.
</details>

---

## Your first meeting

**1. Before the call: write the brief.** In the dashboard, open **Brief** and fill in
who you are meeting, your role and what a good outcome looks like. Paste anything
the answers may draw on: your pitch, your prices, past results, your CV.

Use this format for a script, and the app follows it closely:

```text
1. PRICING
▶ SAY
"The rebuild is 1,200, and SEO after that is 300 a month, no lock-in."
NOTE - DON'T SAY
My floor is 1,000. Only offer it if they push twice.
```

Then press **Ask the AI what else it needs** and answer its questions. That minute
improves the live answers more than anything else.

Everything you type also helps the speech recognition: words from your brief, like
product names and jargon, come out spelled correctly.

**2. During the call: press Start listening.** The overlay shows:

- what they are saying, as it is transcribed
- **SAY THIS**, the suggested answer, appearing as it is written
- three questions you could ask next
- a box to ask the AI anything directly

**3. After the call: open Notes & summary.** Press **Generate summary** for a summary,
decisions, action items and a follow-up message, then **Download Word (.docx)**.

<img src="docs/images/dashboard-settings.png" alt="Dashboard settings: choosing the AI, the speech engine and the audio devices" width="100%">

### Hotkeys

| Keys | What it does |
|---|---|
| `Ctrl` `Shift` `Space` | Show or hide the overlay |
| `Ctrl` `Shift` `H` | Hide it instantly |
| `Ctrl` `Shift` `X` | Click-through: the mouse passes through the overlay |
| `Ctrl` `Shift` `A` | Jump to the ask box |
| `Ctrl` `Shift` `R` | Write that answer again |

On a Mac these use the **Control** key. Drag the overlay from anywhere on it. **S / M
/ L** resize it and the slider sets how see-through it is.

### Choosing your speaker and microphone

**Dashboard → Settings → Audio devices**, the same idea as in Zoom. Both start on
**Same as system**, which follows your computer when you plug in headphones.

- **Test speaker** plays a short chime and reports whether the app could actually
  hear it. If the chime plays but the app hears nothing, the other person will not
  be transcribed, so this is the test that matters.
- **Test mic** records you for 4 seconds and tells you if you came through clearly.

---

## Screen sharing

**Share a window or a tab, not your entire screen.** Then the overlay is not part of
what the other side sees, on Windows and on Mac.

| What you share | Mac | Windows |
|---|---|---|
| A window or a browser tab | Hidden | Hidden |
| Your entire screen | Hidden on recent macOS | Hidden on most PCs; on some older graphics chips it shows as a dark box, never as readable text |

When you share your entire screen from Chrome on Windows (Google Meet, or Zoom and
Teams in the browser), the app notices and hides the overlay by itself. The desktop
Zoom and Teams apps do not announce a share the same way, so there, share a window. For complete peace of mind in any share mode, use the **phone view**:
Dashboard → Settings → Read answers on your phone, then scan the QR code with a phone
on the same Wi-Fi.

The measurements behind this are in [docs/SCREEN-SHARE.md](docs/SCREEN-SHARE.md).

---

## Speed

Two things take time after the other person stops talking: turning their speech into
text, and writing the answer.

| Speech to text | Words on screen, with Claude |
|---|---|
| Cloud (Deepgram, free tier available) | About 2 s |
| On your computer, modern laptop | About 3 to 4 s |
| On your computer, 2012 laptop | About 5 s |

Speech to text runs on your computer by default, with no account and no cost. For the
fastest answers, get a free key from [deepgram.com](https://deepgram.com) and set
**Settings → Speech backend → cloud**. If the connection drops mid-call it falls back
to your computer by itself.

On a newer machine, **Settings → Local model → base.en** is more accurate. Every
measurement is in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

---

## Privacy

- Your briefs, transcripts and settings are saved only on your computer, in the
  `data/` folder, which is never uploaded.
- Speech to text runs on your computer unless you choose the cloud option.
- The only thing that leaves your computer is what the AI needs to write an answer:
  the brief and the recent conversation, sent to Claude or ChatGPT under your own
  account.
- The phone view is a private link with a secret code in it, and only works on your own Wi-Fi.

**Use it responsibly.** In many places you must tell people before you transcribe a
call, and some workplaces, schools and exams do not allow assistants like this. Check
the rules that apply to you.

---

## Troubleshooting

<details>
<summary><b>Answers never appear</b></summary>

Most often the AI is not signed in. Open the dashboard and press **Sign in with
Claude** or **Sign in with ChatGPT**, then finish in the browser.

Still nothing? Run `CHECK.bat` (Windows) or `CHECK.command` (Mac) in the app's folder.
It says whether the AI is signed in and prints the exact fix.
</details>

<details>
<summary><b>"Python packages are missing" or the setup stops</b></summary>

Run the setup again, it picks up where it stopped. On Windows, make sure Python was
installed with **"Add python.exe to PATH"** ticked.

If the error says **conflicting dependencies**, your Python is newer than the speech
packages support yet (Python 3.14 on an Intel Mac, for example). Install **Python 3.12**,
delete the `.venv` folder in the project, and run the setup again. The setup picks
3.12 by itself when it is installed.
</details>

<details>
<summary><b>It hears me but not the other person</b></summary>

Use **Settings → Test speaker**. If it hears nothing, pick the device your call
actually plays through under **Speaker**. On a Mac, check that **Screen & System Audio
Recording** is allowed for Electron in System Settings → Privacy & Security.
</details>

<details>
<summary><b>"No speaker loopback found" (Windows)</b></summary>

Windows has no active output device. Plug in headphones or choose a speaker, then
press Stop and Start listening again.
</details>

<details>
<summary><b>It falls behind ("catching up")</b></summary>

Use the `tiny.en` local model, turn off **Show live partial text**, or switch the
speech backend to cloud.
</details>

<details>
<summary><b>The overlay is in the way</b></summary>

`Ctrl` `Shift` `X` lets the mouse pass through it. `Ctrl` `Shift` `H` hides it at once.
**Reset overlay** in the dashboard puts it back in the corner.
</details>

<details>
<summary><b>The Mac asks for permissions every time</b></summary>

Always start it with `START.command`, not from Terminal. Started from Terminal, macOS
gives the permissions to Terminal instead of to the app.
</details>

---

## How it works

```text
the other person ─► your speakers ─► system audio capture ─┐
                                                            ├─► voice detection ─► speech to text ─► AI ─► overlay
you ─────────────► your microphone ─────────────────────────┘                                          └─► phone
```

A small Python program captures the two sound sources separately, finds where
speech starts and stops, and turns it into text. The desktop app (Electron) decides
when the other person has finished a thought, sends the question to the AI with your
brief, and streams the answer to the overlay.

| Folder | What is in it |
|---|---|
| `audio/` | Capture, voice detection and speech to text (Python) |
| `audio/mac/` | The macOS system-audio helper (Swift, ScreenCaptureKit) |
| `src/main/` | The app: AI connections, meeting storage, Word export |
| `src/overlay/`, `src/dashboard/`, `src/companion/` | The overlay, the dashboard and the phone view |
| `test/` | Offline tests, run on every change on Windows and macOS |
| `tools/` | Live checks and measurements (see below) |
| `docs/` | Measurements: speed, screen sharing |

### Tests

```bash
npm test                                                    # app logic
.venv/bin/python3 -m unittest discover -s test -p "test_*.py"   # audio (Mac)
.venv\Scripts\python.exe -m unittest discover -s test -p "test_*.py"   # audio (Windows)
```

These need no microphone and no sign-in. Live checks that use your real AI
sign-in live in `tools/`: `test-script-mode.js` (follows the prepared script),
`test-private-notes.js` (private notes never leak) and `test-no-fabrication.js`
(never claims experience the brief does not mention).

---

## Contributing

Bug reports and pull requests are welcome. Please run the tests above first, and
describe how to reproduce any bug you report.

## License

MIT. See [LICENSE](LICENSE).

---

<div align="center">
<sub>Made by <a href="https://github.com/tanzeeldevAi">Tanzeel</a> · If it helps you on a call, a ⭐ helps others find it.</sub>
<br><br>
<sub>AI meeting assistant · meeting copilot · real-time meeting assistant · AI note taker · Zoom AI assistant · Google Meet AI assistant · Microsoft Teams · live transcription · Whisper speech to text · Claude · ChatGPT · Codex CLI · open-source Cluely alternative · Electron desktop app for Windows and macOS</sub>
</div>
