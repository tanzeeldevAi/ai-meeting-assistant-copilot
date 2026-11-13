"""
The slice of the PyAudioWPatch API the engine uses, implemented for macOS.

The engine, capture and device code were written against PyAudioWPatch on
Windows: WASAPI devices plus a "[Loopback]" input that mirrors each speaker.
Rather than fork that code, this module answers the same calls on a Mac:

  mic / speakers -> sounddevice (PortAudio over Core Audio)
  "[Loopback]"   -> audio/mac/syscap, a ScreenCaptureKit helper that streams
                    the whole system mix. One per output device is advertised
                    so devices.loopback_for() keeps working, but they all hear
                    the same thing: whatever the Mac plays, AirPods included.

Before macOS 13 apps cannot capture the system mix, and syscap does not run.
There, a "[Loopback]" is offered only while the Mac plays through a virtual
device that a loopback driver can hear (BlackHole, or a Multi-Output Device
that includes it), and it records that driver's input. Otherwise none is
offered and the engine listens through the microphone instead.

Two Mac facts shape it:

1. PortAudio reads the device list once, at initialise. It can only be
   re-scanned with no stream open, so we re-scan lazily, when every stream is
   closed and Core Audio reports a different set of devices.
2. Core Audio's CURRENT default devices come from `syscap --devices` (~50 ms),
   so following a headphone switch never touches PortAudio under live streams.
"""

import json
import os
import platform
import re
import subprocess
import sys
import threading
import time

import numpy as np
import sounddevice as sd

paFloat32 = 1
paContinue = 0
paWASAPI = 13
NO_KEEPALIVE = True       # ScreenCaptureKit needs no silent stream to stay awake

HERE = os.path.dirname(os.path.abspath(__file__))
SYSCAP = os.path.join(HERE, "mac", "syscap")
LOOPBACK_SUFFIX = " [Loopback]"
LOOPBACK_BASE = 10000      # loopback i mirrors output device i - LOOPBACK_BASE
SYSCAP_SR = 16000



def _mac_major():
    try:
        return int(platform.mac_ver()[0].split(".")[0])
    except Exception:
        return 99


# ScreenCaptureKit audio arrived in macOS 13. MC_OLD_MAC=1 forces the old path (tests).
OLD_MAC = _mac_major() < 13 or os.environ.get("MC_OLD_MAC") == "1"
VIRTUAL_IN = re.compile(r"blackhole|soundflower|loopback audio|vb-cable", re.I)
VIRTUAL_OUT = re.compile(r"blackhole|soundflower|loopback audio|vb-cable|multi-output", re.I)

PERMISSION_HELP = ("macOS blocked system-audio capture. Open System Settings > Privacy & Security > "
                   "Screen & System Audio Recording, turn ON the app that started Meeting Copilot "
                   "(Electron or Terminal), then quit and reopen it.")


def coreaudio_now():
    """Current default device names from Core Audio, or None if the helper fails."""
    if OLD_MAC and not os.environ.get("MC_OLD_MAC"):
        return None          # syscap needs macOS 13; sounddevice's defaults are used
    try:
        r = subprocess.run([SYSCAP, "--devices"], capture_output=True, text=True, timeout=3)
        return json.loads(r.stdout)
    except Exception:
        return None


class PyAudio:
    def __init__(self):
        self._lock = threading.RLock()
        self._streams = set()
        self._ca = None
        self._ca_at = 0.0
        self._scan()

    # ---------- device list ----------

    def _scan(self):
        devs = []
        for i, d in enumerate(sd.query_devices()):
            devs.append({
                "index": i,
                "name": d["name"],
                "hostApi": 0,
                "maxInputChannels": int(d["max_input_channels"]),
                "maxOutputChannels": int(d["max_output_channels"]),
                "defaultSampleRate": float(d["default_samplerate"]),
            })
        self._devs = devs

    def _coreaudio(self):
        if time.time() - self._ca_at > 1.0:
            ca = coreaudio_now()
            if ca is not None:
                self._ca = ca
            self._ca_at = time.time()
        return self._ca

    def _maybe_rescan(self):
        """Re-scan PortAudio if Core Audio's device set changed and nothing is open."""
        ca = self._coreaudio()
        if not ca:
            return
        have = sorted(d["name"] for d in self._devs)
        if have == sorted(ca.get("all") or []):
            return
        with self._lock:
            if self._streams:
                return
            try:
                sd._terminate()
                sd._initialize()
                self._scan()
            except Exception as e:
                print("[mac_pa] rescan failed:", e, file=sys.stderr, flush=True)

    def _by_name(self, name, want_output):
        for d in self._devs:
            if d["name"] == name and (d["maxOutputChannels"] if want_output else d["maxInputChannels"]) > 0:
                return d["index"]
        return -1

    def get_host_api_info_by_type(self, _type):
        self._maybe_rescan()
        ca = self._coreaudio() or {}
        out = self._by_name(ca.get("output"), True) if ca.get("output") else -1
        inp = self._by_name(ca.get("input"), False) if ca.get("input") else -1
        if out < 0 or inp < 0:
            try:
                di, do = sd.default.device
            except Exception:
                di, do = -1, -1
            out = out if out >= 0 else int(do)
            inp = inp if inp >= 0 else int(di)
        return {"index": 0, "defaultOutputDevice": out, "defaultInputDevice": inp}

    def get_device_count(self):
        return len(self._devs)

    def _virtual_input(self):
        """The input side of a loopback driver such as BlackHole, if one is installed."""
        for d in self._devs:
            if d["maxInputChannels"] > 0 and VIRTUAL_IN.search(d["name"]):
                return d
        return None

    def get_device_info_by_index(self, i):
        if i >= LOOPBACK_BASE:
            out = self._devs[i - LOOPBACK_BASE]
            rate, ch = float(SYSCAP_SR), 1
            if OLD_MAC:
                vin = self._virtual_input() or {}
                rate = float(vin.get("defaultSampleRate") or 48000)
                ch = max(1, min(2, int(vin.get("maxInputChannels") or 1)))
            return {"index": i, "name": out["name"] + LOOPBACK_SUFFIX, "hostApi": 0,
                    "maxInputChannels": ch, "maxOutputChannels": 0,
                    "defaultSampleRate": rate, "isLoopbackDevice": True}
        if i < 0 or i >= len(self._devs):
            raise IOError("Invalid device index %r" % i)
        return dict(self._devs[i])

    def get_loopback_device_info_generator(self):
        if OLD_MAC and self._virtual_input() is None:
            return
        for d in self._devs:
            if d["maxOutputChannels"] > 0 and (not OLD_MAC or VIRTUAL_OUT.search(d["name"])):
                yield self.get_device_info_by_index(LOOPBACK_BASE + d["index"])

    # ---------- streams ----------

    def open(self, format=paFloat32, channels=1, rate=16000, input=False, output=False,
             input_device_index=None, output_device_index=None, frames_per_buffer=1024,
             stream_callback=None, **_):
        if input and input_device_index is not None and input_device_index >= LOOPBACK_BASE and OLD_MAC:
            vin = self._virtual_input()
            if vin is None:
                raise RuntimeError("No loopback driver (such as BlackHole) is installed.")
            st = SdStream(self, channels, rate, True, False, vin["index"],
                          frames_per_buffer, stream_callback)
        elif input and input_device_index is not None and input_device_index >= LOOPBACK_BASE:
            st = SysCapStream(self, frames_per_buffer, stream_callback)
        else:
            st = SdStream(self, channels, rate, input, output,
                          input_device_index if input else output_device_index,
                          frames_per_buffer, stream_callback)
        with self._lock:
            self._streams.add(st)
        try:
            st.start_stream()
        except Exception:
            self._closed(st)
            raise
        return st

    def _closed(self, st):
        with self._lock:
            self._streams.discard(st)

    def terminate(self):
        for st in list(self._streams):
            try:
                st.close()
            except Exception:
                pass


class SdStream:
    """A PortAudio stream with PyAudio's method names."""

    def __init__(self, owner, channels, rate, is_input, is_output, device, block, callback):
        self._owner = owner
        self._channels = channels
        kw = dict(samplerate=rate, blocksize=block, device=device, channels=channels, dtype="float32")
        if is_input:
            cb = None
            if callback:
                def cb(indata, frames, t, status):
                    callback(bytes(indata), frames, None, 0)
            self._s = sd.RawInputStream(callback=cb, **kw)
        else:
            cb = None
            if callback:
                def cb(outdata, frames, t, status):
                    data, _flag = callback(None, frames, None, 0)
                    n = min(len(data), len(outdata))
                    outdata[:n] = data[:n]
                    if n < len(outdata):
                        outdata[n:] = b"\x00" * (len(outdata) - n)
            self._s = sd.RawOutputStream(callback=cb, **kw)

    def start_stream(self):
        if not self._s.active:
            self._s.start()

    def write(self, data):
        self._s.write(data)

    def is_active(self):
        return bool(self._s.active)

    def stop_stream(self):
        try:
            self._s.stop()
        except Exception:
            pass

    def close(self):
        try:
            self._s.close()
        finally:
            self._owner._closed(self)


class SysCapStream:
    """
    System audio from the ScreenCaptureKit helper, delivered through the same
    callback shape as a PortAudio input: mono float32 bytes at 16 kHz.
    """

    def __init__(self, owner, block, callback):
        self._owner = owner
        self._block = block
        self._cb = callback
        self._proc = None
        self._thread = None
        self._err = []
        self._resampler = None

    def start_stream(self):
        if self._proc is not None:
            return
        if not os.path.exists(SYSCAP):
            raise RuntimeError("System-audio helper missing: build it with "
                               "`swiftc -O -o audio/mac/syscap audio/mac/syscap.swift`.")
        self._proc = subprocess.Popen([SYSCAP], stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        threading.Thread(target=self._read_err, daemon=True).start()

        # Wait for the stream to come up or fail. Capture starts in well under a
        # second; a permission refusal also comes back that fast.
        deadline = time.time() + 6.0
        while time.time() < deadline:
            if self._proc.poll() is not None:
                break
            if any("started" in e for e in self._err):
                break
            time.sleep(0.05)
        code = self._proc.poll()
        if code is not None:
            msg = " ".join(self._err) or ("exit %d" % code)
            self._proc = None
            if code == 3 or "PERMISSION" in msg:
                raise RuntimeError(PERMISSION_HELP)
            raise RuntimeError("System-audio capture failed: " + msg)

        self._thread = threading.Thread(target=self._read, name="syscap", daemon=True)
        self._thread.start()

    def _read_err(self):
        p = self._proc
        for line in iter(p.stderr.readline, b""):
            s = line.decode("utf-8", "replace").strip()
            if s:
                self._err.append(s)
                del self._err[:-20]
                print("[mac_pa]", s, file=sys.stderr, flush=True)

    def _readn(self, f, n):
        buf = b""
        while len(buf) < n:
            chunk = f.read(n - len(buf))
            if not chunk:
                return None
            buf += chunk
        return buf

    def _read(self):
        p = self._proc
        f = p.stdout
        head = self._readn(f, 8)
        if not head or head[:4] != b"SCAP":
            return
        rate = int.from_bytes(head[4:8], "little")
        if rate != SYSCAP_SR:
            from resampler import StreamResampler
            self._resampler = StreamResampler(rate, SYSCAP_SR)
        nbytes = self._block * 4
        while True:
            raw = self._readn(f, nbytes)
            if raw is None:
                return
            if self._resampler is not None:
                pcm = self._resampler.process(np.frombuffer(raw, dtype=np.float32))
                raw = pcm.astype(np.float32).tobytes()
            if self._cb and raw:
                self._cb(raw, len(raw) // 4, None, 0)

    def is_active(self):
        return self._proc is not None and self._proc.poll() is None

    def stop_stream(self):
        p, self._proc = self._proc, None
        if p is not None and p.poll() is None:
            p.terminate()
            try:
                p.wait(timeout=2)
            except Exception:
                p.kill()

    def close(self):
        self.stop_stream()
        self._owner._closed(self)
