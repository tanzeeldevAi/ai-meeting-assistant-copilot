"""
Meeting Copilot audio sidecar.

Owns the microphone and the speaker loopback, turns both into transcript
events, and streams them to the Electron app over a local WebSocket.

Run:  py -3.11 audio/engine.py --port 8790 [--config data/audio-config.json]

Design notes that matter:

* THEM (loopback) and ME (mic) are separate sources all the way through. That
  separation IS the "answer them, not me" feature -- we never have to guess who
  spoke, because we know which wire it came from.

* One STT worker, not two. On 2 cores, two Whisper calls racing each other are
  slower than the same two calls run back to back, and they make latency
  unpredictable. The queue is priority-ordered and aggressively drops stale
  work so the newest speech always wins.

* On speakers instead of headphones the mic re-hears the other person. Two
  guards drop that duplicate: an envelope correlation BEFORE transcription
  (free), and a time+text overlap check after it (safety net).
"""

import argparse
import json
import os
import queue
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np
if sys.platform == "darwin":
    import mac_pa as pa          # same API, Core Audio + ScreenCaptureKit
else:
    import pyaudiowpatch as pa

import devices
from capture import CaptureSource
from vad import Segmenter
from stt import LocalWhisper, looks_hallucinated, normalise

SR = 16000
ECHO_HISTORY_S = 60.0     # keep loudness history well past any queue delay

DEFAULTS = {
    "backend": "local",
    "partial_model": "tiny.en",
    "final_model": "tiny.en",
    "compute_type": "int8",
    "cpu_threads": 3,
    "language": "en",
    "partials": False,          # see docs/BENCHMARKS.md -- too expensive on a 2-core CPU
    "listen_me": True,
    "echo_guard": True,
    "vad": {},
    # Chosen devices, by NAME. None means "follow whatever Windows is using",
    # which is what most people want; an explicit name pins it like Zoom does.
    "input_device": None,
    "output_device": None,
    "device_poll_s": 2.0,
    "cloud": {"provider": "deepgram", "api_key": "", "model": "nova-2"},
}

PRIORITY = {("them", "final"): 0, ("me", "final"): 1,
            ("them", "partial"): 2, ("me", "partial"): 3}


def log(*a):
    print("[engine]", *a, file=sys.stderr, flush=True)


class Engine:
    def __init__(self, cfg, emit):
        self.cfg = cfg
        self.emit = emit                     # fn(dict) -> queued to websocket
        self.p = pa.PyAudio()

        self.stt = None
        self.stream = None        # Deepgram live stream for THEM, when backend=cloud
        self.mic_only = False     # no system audio: the mic stands in for both sides
        self.paused = False
        self._stop = threading.Event()

        # STT work queue: (priority, monotonic_seq, job)
        self._jobs = queue.PriorityQueue()
        self._jobseq = 0
        self._joblock = threading.Lock()
        self._pending_finals = 0

        self.sources = {}
        self.segs = {}
        self._recent_them = []               # for echo detection
        self._them_level_hist = []

        self._sig = None
        self._tap = None          # temporary audio capture, used by the device tests

        # Sticky state. Whisper loads BEFORE the websocket server binds, so the
        # "devices" and "models_ready" events are emitted while nobody is
        # connected and would otherwise be thrown away -- which is why the UI
        # never showed which microphone it was using. Replayed on connect.
        self.sticky = {}

    # ---------- setup ----------

    def start(self):
        self._load_stt()
        self._build_sources()
        threading.Thread(target=self._stt_worker, name="stt", daemon=True).start()
        threading.Thread(target=self._device_watcher, name="devwatch", daemon=True).start()
        threading.Thread(target=self._level_pump, name="levels", daemon=True).start()

    def _load_stt(self):
        if self.cfg["backend"] == "local":
            t0 = time.time()
            self.emit({"t": "status", "stage": "loading_models",
                       "partial": self.cfg["partial_model"],
                       "final": self.cfg["final_model"]})
            self.stt = LocalWhisper(
                partial_model=self.cfg["partial_model"],
                final_model=self.cfg["final_model"],
                compute_type=self.cfg["compute_type"],
                cpu_threads=int(self.cfg["cpu_threads"]),
                language=self.cfg["language"],
                log=log,
            )
            self.emit({"t": "status", "stage": "models_ready",
                       "took": round(time.time() - t0, 1)})
        else:
            # Cloud mode: THEM streams to Deepgram (the latency-critical path),
            # ME stays on local Whisper. Nothing is waiting on ME -- it only
            # feeds context and notes -- so streaming it too would double the
            # bill for no benefit.
            from stt_stream import DeepgramStream
            self.emit({"t": "status", "stage": "loading_models", "backend": "cloud"})
            self.stream = DeepgramStream(
                self.cfg["cloud"],
                on_final=self._on_stream_final,
                on_partial=self._on_stream_partial,
                on_status=self._on_status,
                log=log,
            )
            try:
                ok = self.stream.start()
            except Exception as e:
                ok = False
                self.emit({"t": "error", "where": "cloud", "msg": str(e)})
            if not ok:
                # Never leave the meeting deaf: fall back to local speech.
                self.emit({"t": "error", "where": "cloud",
                           "msg": "Could not reach the speech service; using local speech instead."})
                self.stream = None
                self.cfg["backend"] = "local"
                self.stt = LocalWhisper(
                    partial_model=self.cfg["partial_model"], final_model=self.cfg["final_model"],
                    compute_type=self.cfg["compute_type"], cpu_threads=int(self.cfg["cpu_threads"]),
                    language=self.cfg["language"], log=log)
            elif self.cfg.get("listen_me", True):
                self.stt = LocalWhisper(
                    partial_model=self.cfg["partial_model"], final_model=self.cfg["final_model"],
                    compute_type=self.cfg["compute_type"], cpu_threads=int(self.cfg["cpu_threads"]),
                    language=self.cfg["language"], log=log)
            self.emit({"t": "status", "stage": "models_ready",
                       "backend": self.cfg["backend"], "streaming": self.stream is not None})

    def _build_sources(self):
        for s in self.sources.values():
            s.close()
        self.sources.clear()
        self.segs.clear()

        want_out = self.cfg.get("output_device")
        want_in = self.cfg.get("input_device")

        out = devices.find_by_name(self.p, want_out, True) if want_out else None
        if out is None:
            if want_out:
                self.emit({"t": "status", "stage": "device_missing", "which": "output", "name": want_out})
            out = devices.default_output(self.p)

        mic = devices.find_by_name(self.p, want_in, False) if want_in else None
        if mic is None:
            if want_in:
                self.emit({"t": "status", "stage": "device_missing", "which": "input", "name": want_in})
            mic = devices.default_input(self.p)

        lb = devices.loopback_for(self.p, out)
        self._sig = devices.signature(self.p)

        vcfg = dict(self.cfg.get("vad", {}))
        self.mic_only = False

        if lb is not None:
            if self.stream is None:
                self.segs["them"] = Segmenter("them", self._on_partial, self._on_final, vcfg)
            src = CaptureSource(self.p, "them", self._on_audio, self._on_status)
            try:
                src.open(lb, keepalive_dev=out)
                self.sources["them"] = src
            except Exception as e:
                self.emit({"t": "error", "where": "loopback", "msg": str(e)})
        elif mic is not None:
            # This computer cannot hand its own sound to apps (a Mac older than
            # macOS 13 without BlackHole). The microphone hears the room, the
            # other person through the speakers included, so it stands in for
            # both sides. Their words and yours arrive as one voice.
            self.mic_only = True
            if self.stream is None:
                self.segs["them"] = Segmenter("them", self._on_partial, self._on_final, vcfg)
            src = CaptureSource(self.p, "them", self._on_audio, self._on_status)
            try:
                src.open(mic)
                self.sources["them"] = src
                self.emit({"t": "status", "stage": "mic_only",
                           "msg": "Listening through the microphone: this Mac cannot share its own sound "
                                  "with apps. Use the speakers, not headphones, so the mic hears the other person."})
            except Exception as e:
                self.emit({"t": "error", "where": "mic", "msg": str(e)})
        else:
            self.emit({"t": "error", "where": "loopback",
                       "msg": "No loopback device for the current output. Meeting audio cannot be heard."})

        if self.cfg.get("listen_me", True) and mic is not None and not self.mic_only:
            self.segs["me"] = Segmenter("me", self._on_partial, self._on_final, vcfg)
            src = CaptureSource(self.p, "me", self._on_audio, self._on_status)
            try:
                src.open(mic)
                self.sources["me"] = src
            except Exception as e:
                self.emit({"t": "error", "where": "mic", "msg": str(e)})

        self.emit({"t": "devices",
                   "out": out["name"] if out else None,
                   "loopback": (lb["name"] if lb else
                                ("%s (hears both sides)" % mic["name"]) if self.mic_only and mic else None),
                   "mic": mic["name"] if mic else None,
                   "pinned_output": bool(want_out),
                   "pinned_input": bool(want_in)})

    # ---------- audio path ----------

    def _on_status(self, ev, **kw):
        self.emit({"t": "status", "stage": ev, **kw})

    def _remember(self, msg):
        """Keep the latest of the events a late-joining client still needs."""
        if msg.get("t") == "devices":
            self.sticky["devices"] = msg
        elif msg.get("t") == "status" and msg.get("stage") in ("models_ready", "loading_models"):
            self.sticky["models"] = msg
        elif msg.get("t") == "error":
            self.sticky["error"] = msg

    def snapshot(self):
        """Everything a client that connected late has already missed."""
        return [self.sticky[k] for k in ("models", "devices", "error") if k in self.sticky]

    def _on_audio(self, role, pcm):
        if self.paused:
            return
        if role == "them":
            now = time.time()
            rms = float(np.sqrt(np.mean(pcm.astype(np.float64) ** 2)))
            self._them_level_hist.append((now, rms))
            # Trim by TIME, not by count. A ME utterance can sit in the queue for
            # seconds behind a THEM transcription, and if the matching window has
            # already rolled off the echo guard silently stops working.
            if len(self._them_level_hist) > 3000:
                cut = now - ECHO_HISTORY_S
                self._them_level_hist = [h for h in self._them_level_hist if h[0] >= cut]
        tap = self._tap
        if tap is not None and tap["role"] == role:
            tap["frames"].append(pcm.copy())

        # In cloud mode THEM bypasses our VAD entirely: the audio goes straight
        # up while they are still speaking, and Deepgram decides where the
        # sentence ends. That is what removes seconds of upload-after-the-fact.
        if role == "them" and self.stream is not None:
            self.stream.feed(pcm)
            return

        seg = self.segs.get(role)
        if seg is not None:
            seg.feed(pcm)

    def _on_partial(self, role, audio, seq, dur):
        if not self.cfg.get("partials", False) or self.paused:
            return
        # Never let partials crowd out finals.
        if self._pending_finals > 0:
            return
        self._submit(role, "partial", audio, seq, dur, False)

    def _on_final(self, role, audio, seq, dur, continued):
        if self.paused:
            return
        with self._joblock:
            self._pending_finals += 1
        self._submit(role, "final", audio, seq, dur, continued)

    def _submit(self, role, kind, audio, seq, dur, continued):
        with self._joblock:
            self._jobseq += 1
            n = self._jobseq
        job = {"role": role, "kind": kind, "audio": audio, "seq": seq,
               "dur": dur, "continued": continued, "at": time.time()}
        self._jobs.put((PRIORITY[(role, kind)], n, job))

    # ---------- STT worker ----------

    def _stt_worker(self):
        while not self._stop.is_set():
            try:
                _, _, job = self._jobs.get(timeout=0.25)
            except queue.Empty:
                continue

            kind, role = job["kind"], job["role"]
            try:
                # Drop stale partials: if newer work is already waiting, this
                # partial is obsolete before we even start it.
                if kind == "partial" and self._jobs.qsize() > 0:
                    continue

                depth = self._jobs.qsize()
                if depth >= 3:
                    self.emit({"t": "lag", "depth": depth})

                # Free gate first: never spend a Whisper pass on our own speakers
                # bleeding into the mic.
                if (role == "me" and kind == "final"
                        and self.cfg.get("echo_guard", True)
                        and self._echo_by_envelope(job["audio"], job["at"], job["dur"])):
                    log("dropped mic echo before STT (envelope match)")
                    continue

                t0 = time.time()
                text = self.stt.transcribe(job["audio"], partial=(kind == "partial"))
                took = time.time() - t0
                text = normalise(text)

                if not text:
                    continue
                if kind == "final" and looks_hallucinated(text, job["audio"], job["dur"]):
                    log("dropped hallucination (%s): %r" % (role, text))
                    continue

                if role == "me" and kind == "final" and self.cfg.get("echo_guard", True):
                    if self._echo_by_text(text, job["at"], job["dur"]):
                        log("dropped mic echo of THEM: %r" % text[:50])
                        continue

                if role == "them" and kind == "final":
                    self._recent_them.append((job["at"] - job["dur"], job["at"], text))
                    self._recent_them = self._recent_them[-8:]

                self.emit({
                    "t": kind, "role": role, "seq": job["seq"], "text": text,
                    "dur": round(job["dur"], 2), "continued": job["continued"],
                    "took": round(took, 2), "at": job["at"],
                    "rtf": round(took / job["dur"], 2) if job["dur"] else None,
                })
            except Exception as e:
                self.emit({"t": "error", "where": "stt", "msg": str(e)})
            finally:
                if kind == "final":
                    with self._joblock:
                        self._pending_finals = max(0, self._pending_finals - 1)

    # ---------- streaming results ----------

    def _on_stream_final(self, text, dur):
        text = normalise(text)
        if not text or self.paused:
            return
        now = time.time()
        # Keep the echo guard fed: it compares ME turns against what THEY said.
        self._recent_them.append((now - dur, now, text))
        self._recent_them = self._recent_them[-8:]
        self.emit({"t": "final", "role": "them", "seq": 0, "text": text,
                   "dur": round(dur, 2), "continued": False, "took": 0.0,
                   "at": now, "rtf": 0.0, "via": "stream"})

    def _on_stream_partial(self, text, dur):
        if self.paused:
            return
        text = normalise(text)
        if text:
            self.emit({"t": "partial", "role": "them", "seq": 0, "text": text,
                       "dur": round(dur, 2), "via": "stream"})

    # ---------- echo guard ----------
    #
    # On speakers (not headphones) the mic re-hears the other person, which
    # would produce a duplicate ME turn and -- worse on a 2-core box -- burn a
    # full Whisper pass on audio we are going to throw away.
    #
    # Two gates. The first runs BEFORE transcription and is nearly free.

    def _echo_by_envelope(self, audio, at, dur):
        """
        Cheap pre-STT gate: does this mic clip have the same loudness shape as
        what the speakers were playing at the same moment?

        Acoustic echo preserves the amplitude envelope even though the waveform
        is filtered and delayed by the room, so correlating 20 ms RMS bins over
        a range of small lags catches it without a Whisper pass.
        """
        if len(audio) < SR // 2:
            return False
        nbin = SR // 50                                   # 20 ms bins
        n = len(audio) // nbin
        if n < 12:
            return False

        me = np.sqrt((audio[:n * nbin].astype(np.float64) ** 2).reshape(n, nbin).mean(axis=1))
        if me.max() <= 0:
            return False

        start = at - dur
        hist = [h for h in self._them_level_hist if start - 0.6 <= h[0] <= at + 0.6]
        if len(hist) < 12:
            return False
        hts = np.array([h[0] for h in hist], dtype=np.float64)
        hrm = np.array([h[1] for h in hist], dtype=np.float64)

        grid = start + (np.arange(n) + 0.5) * (dur / float(n))
        them = np.interp(grid, hts, hrm)
        if them.max() < 0.004:                            # they were not talking
            return False

        me_c = me - me.mean()
        best = 0.0
        max_lag = min(20, n // 4)                         # +/- 400 ms
        for lag in range(-max_lag, max_lag + 1):
            t = np.roll(them, lag)
            t_c = t - t.mean()
            denom = np.sqrt((me_c ** 2).sum() * (t_c ** 2).sum())
            if denom <= 1e-12:
                continue
            best = max(best, float((me_c * t_c).sum() / denom))
        # 0.62 was too strict for bleed through laptop speakers, where the room
        # heavily filters the signal. Loosened, but paired with the level test
        # below so genuine speech over the top of them is still kept.
        if best >= 0.52:
            return True

        # Weaker correlation still counts as bleed if they were talking through
        # essentially the whole clip and the mic only picked up something faint.
        loud_frac = float(np.mean(them > 0.006)) if len(them) else 0.0
        me_peak = float(np.max(np.abs(audio)))
        return best >= 0.35 and loud_frac > 0.7 and me_peak < 0.07

    def _echo_by_text(self, text, at, dur):
        """
        Post-STT safety net. Requires the mic clip to overlap a THEM utterance
        in TIME as well as in words -- so you genuinely paraphrasing them a
        moment later ("so you mean database contention?") is never swallowed.
        """
        mine = set(text.lower().split())
        if len(mine) < 3:
            return False
        me_start, me_end = at - dur, at
        for t_start, t_end, prev in self._recent_them:
            overlap = min(me_end, t_end) - max(me_start, t_start)
            if overlap <= 0 or overlap < 0.4 * min(dur, max(t_end - t_start, 0.1)):
                continue
            theirs = set(prev.lower().split())
            if theirs and len(mine & theirs) / float(len(mine)) >= 0.5:
                return True
        return False

    # ---------- background loops ----------

    def _device_watcher(self):
        """Follow headphone / Bluetooth / USB-headset switches without a restart."""
        poll = float(self.cfg.get("device_poll_s", 2.0))
        while not self._stop.is_set():
            time.sleep(poll)
            try:
                sig = devices.signature(self.p)
                dead = [r for r, s in self.sources.items() if not s.alive]
                pinned = self.cfg.get("output_device") or self.cfg.get("input_device")
                # If the user pinned a device, a change of Windows default is not
                # our business -- only rebuild if a stream actually died.
                changed = (sig != self._sig and not pinned) or bool(dead)
                self._sig = sig
                if changed:
                    log("audio routing changed (%s -> %s) dead=%s; rebuilding"
                        % (self._sig, sig, dead))
                    self.emit({"t": "status", "stage": "rebuilding_audio", "reason": sig})
                    self._build_sources()
            except Exception as e:
                self.emit({"t": "error", "where": "devwatch", "msg": str(e)})

    def _level_pump(self):
        while not self._stop.is_set():
            time.sleep(0.12)
            try:
                self.emit({"t": "level",
                           "them": round(self.sources["them"].level, 5) if "them" in self.sources else 0.0,
                           "me": round(self.sources["me"].level, 5) if "me" in self.sources else 0.0,
                           "paused": self.paused})
            except Exception:
                pass

    # ---------- device tests ----------
    #
    # Same idea as Zoom's "Test Speaker" / "Test Mic", with one addition: the
    # speaker test also reports what the LOOPBACK heard. That is the path the
    # whole app depends on -- if a tone plays but the loopback stays silent, the
    # other person will never be transcribed, and this is where you find out.

    def _play(self, pcm16k, out_dev, gain=1.0):
        """Play 16 kHz mono audio on a specific output device."""
        sr = int(out_dev["defaultSampleRate"])
        ch = max(1, min(2, int(out_dev["maxOutputChannels"])))
        n = int(len(pcm16k) * sr / SR)
        idx = np.clip((np.arange(n) * SR / sr).astype(np.int64), 0, len(pcm16k) - 1)
        sig = (pcm16k[idx] * gain).astype(np.float32)

        st = self.p.open(format=pa.paFloat32, channels=ch, rate=sr, output=True,
                         output_device_index=out_dev["index"], frames_per_buffer=1024)
        try:
            for i in range(0, len(sig), 1024):
                chunk = sig[i:i + 1024]
                st.write(np.repeat(chunk, ch).astype(np.float32).tobytes())
        finally:
            st.stop_stream()
            st.close()

    def _current_output(self):
        want = self.cfg.get("output_device")
        return (devices.find_by_name(self.p, want, True) if want else None) or devices.default_output(self.p)

    def test_speaker(self):
        def run():
            try:
                out = self._current_output()
                if out is None:
                    self.emit({"t": "test_result", "which": "speaker", "ok": False,
                               "detail": "No output device available."})
                    return

                self.emit({"t": "test_started", "which": "speaker", "device": out["name"]})

                # A rising two-tone chime: pleasant, and easy to recognise as ours.
                t = np.arange(int(SR * 1.4)) / SR
                tone = np.zeros_like(t)
                for i, f in enumerate((587.0, 880.0)):
                    seg = (t >= i * 0.7) & (t < (i + 1) * 0.7)
                    tone[seg] = np.sin(2 * np.pi * f * t[seg])
                env = np.minimum(1.0, np.minimum(t * 12, (t[-1] - t) * 12))
                tone = (0.35 * tone * env).astype(np.float32)

                self._tap = {"role": "them", "frames": []}
                self._play(tone, out)
                time.sleep(0.45)                       # let the loopback drain
                tap, self._tap = self._tap, None

                heard = np.concatenate(tap["frames"]) if tap["frames"] else np.zeros(0, dtype=np.float32)
                peak = float(np.max(np.abs(heard))) if len(heard) else 0.0
                rms = float(np.sqrt(np.mean(heard.astype(np.float64) ** 2))) if len(heard) else 0.0
                ok = peak > 0.01

                self.emit({
                    "t": "test_result", "which": "speaker", "ok": ok,
                    "device": out["name"], "peak": round(peak, 4), "rms": round(rms, 5),
                    "detail": ("Tone played and the loopback heard it - the other person will be transcribed."
                               if ok else
                               "Tone played, but the loopback heard nothing. Meeting audio will NOT be picked up. "
                               "Check that this really is the device your meeting plays through, and that it is not muted."),
                })
            except Exception as e:
                self._tap = None
                self.emit({"t": "test_result", "which": "speaker", "ok": False, "detail": str(e)})

        threading.Thread(target=run, name="test-speaker", daemon=True).start()

    def test_mic(self, seconds=4.0, playback=True):
        def run():
            try:
                role = "them" if getattr(self, "mic_only", False) else "me"
                if role not in self.sources:
                    self.emit({"t": "test_result", "which": "mic", "ok": False,
                               "detail": "Microphone is not being captured. Turn on 'Also transcribe my own voice'."})
                    return

                dev = self.sources[role].device_name
                self.emit({"t": "test_started", "which": "mic", "device": dev, "seconds": seconds})

                self._tap = {"role": role, "frames": []}
                time.sleep(float(seconds))
                tap, self._tap = self._tap, None

                rec = np.concatenate(tap["frames"]) if tap["frames"] else np.zeros(0, dtype=np.float32)
                peak = float(np.max(np.abs(rec))) if len(rec) else 0.0
                rms = float(np.sqrt(np.mean(rec.astype(np.float64) ** 2))) if len(rec) else 0.0
                ok = peak > 0.02

                if ok and playback:
                    out = self._current_output()
                    if out is not None:
                        self.emit({"t": "test_playback", "which": "mic"})
                        # Normalise so a quiet mic is still audible on playback.
                        self._play(rec / max(peak, 1e-6) * 0.5, out)

                self.emit({
                    "t": "test_result", "which": "mic", "ok": ok,
                    "device": dev, "peak": round(peak, 4), "rms": round(rms, 5),
                    "seconds": round(len(rec) / SR, 1),
                    "detail": ("Heard you clearly." if peak > 0.08 else
                               "Heard you, but quietly - move closer or raise the mic level." if ok else
                               "Heard nothing. Check the microphone is the right one and not muted."),
                })
            except Exception as e:
                self._tap = None
                self.emit({"t": "test_result", "which": "mic", "ok": False, "detail": str(e)})

        threading.Thread(target=run, name="test-mic", daemon=True).start()

    # ---------- commands ----------

    def command(self, msg):
        c = msg.get("c")
        if c == "pause":
            self.paused = True
            for s in self.segs.values():
                s.reset()
            self.emit({"t": "status", "stage": "paused"})
        elif c == "resume":
            self.paused = False
            for s in self.segs.values():
                s.reset()
            self.emit({"t": "status", "stage": "resumed"})
        elif c == "hotwords":
            terms = msg.get("terms", [])
            if hasattr(self.stt, "set_hotwords"):
                self.stt.set_hotwords(terms)
            if self.stream is not None:
                # Measured: turns "I deputancy" into "Idempotency".
                self.stream.set_hotwords(terms)
            self.emit({"t": "status", "stage": "hotwords_set",
                       "n": len(msg.get("terms", []))})
        elif c == "rebuild":
            self._build_sources()
        elif c == "list_devices":
            try:
                self.emit({"t": "device_list", **devices.list_all(self.p),
                           "selected_input": self.cfg.get("input_device"),
                           "selected_output": self.cfg.get("output_device")})
            except Exception as e:
                self.emit({"t": "error", "where": "list_devices", "msg": str(e)})
        elif c == "select_devices":
            # "" or null means follow the Windows default again.
            self.cfg["input_device"] = msg.get("input") or None
            self.cfg["output_device"] = msg.get("output") or None
            self.emit({"t": "status", "stage": "devices_selected",
                       "input": self.cfg["input_device"], "output": self.cfg["output_device"]})
            self._build_sources()
        elif c == "test_speaker":
            self.test_speaker()
        elif c == "test_mic":
            self.test_mic(seconds=float(msg.get("seconds", 4.0)),
                          playback=bool(msg.get("playback", True)))
        elif c == "ping":
            self.emit({"t": "pong", "at": time.time()})

    def stop(self):
        self._stop.set()
        if self.stream is not None:
            try:
                self.stream.stop()
            except Exception:
                pass
        for s in self.sources.values():
            s.close()
        try:
            self.p.terminate()
        except Exception:
            pass


# ---------- websocket plumbing ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--config", default="")
    args = ap.parse_args()

    # If the app dies without stopping us, we would keep the mic and system
    # audio open forever. POSIX re-parents an orphan, so watch for that.
    if os.name == "posix":
        parent = os.getppid()

        def orphan_guard():
            while True:
                time.sleep(2.0)
                if os.getppid() != parent:
                    log("parent process gone; exiting")
                    os._exit(0)
        threading.Thread(target=orphan_guard, name="orphan-guard", daemon=True).start()

    cfg = dict(DEFAULTS)
    if args.config and os.path.exists(args.config):
        try:
            with open(args.config, "r", encoding="utf-8") as f:
                user = json.load(f)
            for k, v in user.items():
                if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                    cfg[k].update(v)
                else:
                    cfg[k] = v
        except Exception as e:
            log("bad config, using defaults:", e)

    import asyncio
    import websockets

    outbox = queue.SimpleQueue()
    clients = set()

    def emit(msg):
        engine._remember(msg)
        outbox.put(msg)

    engine = Engine(cfg, emit)

    async def pump():
        """Drain the thread-safe outbox onto all websocket clients."""
        while True:
            sent = 0
            while sent < 64:
                try:
                    msg = outbox.get_nowait()
                except queue.Empty:
                    break
                if clients:
                    data = json.dumps(msg)
                    for ws in list(clients):
                        try:
                            await ws.send(data)
                        except Exception:
                            clients.discard(ws)
                sent += 1
            await asyncio.sleep(0.02)

    async def handler(ws):
        clients.add(ws)
        log("client connected")
        try:
            await ws.send(json.dumps({"t": "ready", "cfg": {
                k: cfg[k] for k in ("backend", "partial_model", "final_model",
                                    "partials", "listen_me", "language")}}))
            # Replay what happened before this client existed.
            for m in engine.snapshot():
                await ws.send(json.dumps(m))
            async for raw in ws:
                try:
                    engine.command(json.loads(raw))
                except Exception as e:
                    log("bad command: %s" % e)
        except Exception:
            pass
        finally:
            clients.discard(ws)
            log("client disconnected")

    async def run():
        # Bind the port BEFORE loading models. Loading Whisper takes seconds --
        # much longer when the CPU is busy warming up Claude at the same time --
        # and doing it first made the app give up waiting for a sidecar that was
        # perfectly healthy, just slow to start. The client can now connect
        # immediately and watch the loading status instead.
        #
        # engine.start() stays on the MAIN thread: opening a WASAPI stream from a
        # fresh thread fails with -9999 (PortAudio needs COM on the calling thread).
        async with websockets.serve(handler, "127.0.0.1", args.port, max_queue=64):
            log("listening on ws://127.0.0.1:%d" % args.port)
            print(json.dumps({"t": "listening", "port": args.port}), flush=True)
            engine.start()
            await pump()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    finally:
        engine.stop()


if __name__ == "__main__":
    main()
