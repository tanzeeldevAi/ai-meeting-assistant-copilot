"""Offline tests for the audio side. No devices, no model download.

    python -m unittest discover -s test -p "test_*.py"
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "audio"))

from resampler import StreamResampler, to_mono  # noqa: E402
from stt import _is_degenerate, looks_hallucinated  # noqa: E402


class Resampler(unittest.TestCase):
    RATES = (8000, 16000, 22050, 32000, 44100, 48000, 96000)
    BLOCKS = (128, 441, 480, 1024, 4096)

    def test_every_common_rate_and_block_size(self):
        # 48000 -> 16000 is an exact ratio (step 3.0). An off-by-one there read
        # past the buffer and killed capture on the most common device rate.
        for sr in self.RATES:
            for block in self.BLOCKS:
                with self.subTest(rate=sr, block=block):
                    r = StreamResampler(sr)
                    total_in, total_out = 0, 0
                    x = np.sin(np.arange(sr * 2) * 2 * np.pi * 440 / sr).astype(np.float32)
                    for i in range(0, len(x), block):
                        out = r.process(x[i:i + block])
                        total_out += len(out)
                        total_in += len(x[i:i + block])
                    expected = total_in * 16000 / sr
                    self.assertLess(abs(total_out - expected), 3,
                                    f"{sr} Hz: {total_out} samples out, expected {expected:.0f}")

    def test_output_is_continuous_across_blocks(self):
        sr = 48000
        x = np.sin(np.arange(sr) * 2 * np.pi * 300 / sr).astype(np.float32)
        whole = StreamResampler(sr).process(x)
        r = StreamResampler(sr)
        parts = np.concatenate([r.process(x[i:i + 480]) for i in range(0, len(x), 480)])
        n = min(len(whole), len(parts))
        self.assertLess(float(np.max(np.abs(whole[:n] - parts[:n]))), 1e-3)

    def test_stereo_becomes_mono(self):
        inter = np.array([0.5, -0.5, 0.2, 0.2], dtype=np.float32).tobytes()
        self.assertEqual(to_mono(inter, 2).tolist(), [0.0, np.float32(0.2)])


class HallucinationFilter(unittest.TestCase):
    def test_runaway_outputs_are_caught(self):
        for bad in ["1,000,000,000,000,000,000,000,000",
                    "hahahahahahahahahahaha",
                    " ".join(["I'm going to go to the next video"] * 14),
                    "thank you thank you thank you thank you thank you thank you"]:
            with self.subTest(text=bad[:30]):
                self.assertTrue(_is_degenerate(bad))

    def test_real_speech_passes(self):
        for good in ["How long would a project like this take you?",
                     "We have three stores and the stock never matches at month end.",
                     "Can you send me the proposal by Friday, and include the timeline?"]:
            with self.subTest(text=good[:30]):
                self.assertFalse(_is_degenerate(good))

    def test_silence_with_stock_words_is_dropped(self):
        quiet = np.zeros(16000, dtype=np.float32) + 1e-4
        self.assertTrue(looks_hallucinated("Thank you.", quiet, 1.0))

    def test_clear_speech_is_kept(self):
        t = np.arange(16000 * 2) / 16000
        voice = (0.2 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)
        self.assertFalse(looks_hallucinated("Can you walk me through the price?", voice, 2.0))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(sys.platform == "darwin", "the macOS audio shim")
class OldMac(unittest.TestCase):
    """Before macOS 13 there is no system-audio capture: what the shim offers."""

    def shim(self, names):
        import importlib
        os.environ["MC_OLD_MAC"] = "1"
        import mac_pa
        importlib.reload(mac_pa)
        devs = []
        for i, (n, ins, outs) in enumerate(names):
            devs.append({"index": i, "name": n, "hostApi": 0, "maxInputChannels": ins,
                         "maxOutputChannels": outs, "defaultSampleRate": 48000.0})
        p = mac_pa.PyAudio.__new__(mac_pa.PyAudio)
        p._devs, p._streams, p._ca, p._ca_at = devs, set(), None, 0.0
        import threading
        p._lock = threading.RLock()
        return p

    def tearDown(self):
        os.environ.pop("MC_OLD_MAC", None)
        import importlib
        import mac_pa
        importlib.reload(mac_pa)

    def test_no_loopback_driver_offers_no_loopback(self):
        p = self.shim([("MacBook Pro Speakers", 0, 2), ("MacBook Pro Microphone", 1, 0)])
        self.assertEqual(list(p.get_loopback_device_info_generator()), [])

    def test_plain_speakers_with_blackhole_still_offer_none(self):
        # BlackHole hears only what is sent to it; plain speakers send it nothing.
        p = self.shim([("MacBook Pro Speakers", 0, 2), ("BlackHole 2ch", 2, 2)])
        names = [d["name"] for d in p.get_loopback_device_info_generator()]
        self.assertEqual(names, ["BlackHole 2ch [Loopback]"])
        self.assertNotIn("MacBook Pro Speakers [Loopback]", names)

    def test_multi_output_with_blackhole_is_heard(self):
        p = self.shim([("MacBook Pro Speakers", 0, 2), ("BlackHole 2ch", 2, 2),
                       ("Multi-Output Device", 0, 2)])
        names = [d["name"] for d in p.get_loopback_device_info_generator()]
        self.assertIn("Multi-Output Device [Loopback]", names)
        info = p.get_device_info_by_index(10000 + 2)
        self.assertEqual(info["maxInputChannels"], 2)
        self.assertEqual(info["defaultSampleRate"], 48000.0)
