#!/usr/bin/env python3
"""
selftest.py — validate analyze.py's scoring on SYNTHETIC frames, no camera required.

WHY: the analyzer's whole job is to replace a human eye on a channel with no readback. If it
is itself wrong, it launders a bad result into a confident PASS — worse than having no tool.
So before trusting it on real footage, feed it frames we constructed and know the answer to.

Covers everything except decode: clapper sync, ROI discovery, axis fitting, and the spatial
and chase scorers — including the NEGATIVE cases, which matter more than the positives here.
A scorer that always says PASS would sail through positive-only tests.

Usage:  python3 verify/selftest.py
"""

import sys, os, numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze as A

FPS = 15
H, W = 120, 320
PASSED, FAILED = [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print(f"  [{'ok  ' if cond else 'FAIL'}] {name}{'  ' + detail if detail else ''}")


def blank():
    return np.zeros((H, W, 3), dtype=np.float32)


def with_strip(frame, x0, x1, y, colors, thickness=6):
    """Paint a horizontal strip of `colors` between x0..x1 — a fixture seen edge-on."""
    f = frame.copy()
    n = len(colors)
    for i, c in enumerate(colors):
        xa = int(x0 + (x1 - x0) * i / n)
        xb = int(x0 + (x1 - x0) * (i + 1) / n)
        f[y:y + thickness, xa:xb] = c
    return f


def build_clip():
    """
    Frames laid out exactly as drive.mjs sequences them, at known indices:
      0.0-3.0s  clapper: 3 white pulses, 1s apart
      3.0-6.0s  calibrate fixture A alone
      6.0-9.0s  spatial: A shows red half / blue half
    """
    frames = []
    white = [255, 255, 255]
    x0, x1, y = 40, 280, 50

    def push(f, seconds):
        frames.extend([f] * int(seconds * FPS))

    push(blank(), 0.4)
    for _ in range(3):                                     # clapper
        push(with_strip(blank(), x0, x1, y, [white] * 8), 0.25)
        push(blank(), 0.75)
    push(blank(), 0.5)
    push(with_strip(blank(), x0, x1, y, [white] * 8), 2.3)  # calibrate solo
    push(blank(), 0.6)
    half = [[255, 0, 0]] * 4 + [[0, 0, 255]] * 4           # spatial
    push(with_strip(blank(), x0, x1, y, half), 3.0)
    return frames, (x0, x1, y)


def main():
    print("suffuse verify analyzer selftest\n")
    frames, (x0, x1, y) = build_clip()

    # ---- sync
    sync, _ = A.find_clapper(frames, FPS, 3, 1000)
    check("finds the clapper", sync is not None)
    if sync is None:
        return finish()
    # Third pulse starts at 0.4 + 2*1.0 = 2.4s -> frame 36.
    check("locks onto the LAST pulse", abs(sync - 36) <= 3, f"got frame {sync}, expected ~36")

    # A clip with no clapper must return None rather than guessing — a false sync would
    # silently shift every downstream measurement.
    none_sync, _ = A.find_clapper([blank() for _ in range(60)], FPS, 3, 1000)
    check("rejects a clip with no clapper", none_sync is None)

    # ---- ROI
    baseline = A.luma(frames[0])
    lo = int(4.0 * FPS)        # inside the calibrate hold
    hi = int(5.5 * FPS)
    roi = A.roi_from_window(frames, lo, hi, baseline)
    check("finds the fixture ROI", roi is not None)
    if roi is None:
        return finish()
    check("ROI lands on the painted strip",
          abs(roi["xs"].mean() - (x0 + x1) / 2) < 20 and abs(roi["ys"].mean() - y) < 12,
          f"centroid=({roi['xs'].mean():.0f},{roi['ys'].mean():.0f})")

    dark = A.roi_from_window(frames, 0, 5, baseline)
    check("returns no ROI for a dark window", dark is None)

    roi["project"], roi["span_px"] = A.principal_axis(roi["xs"], roi["ys"])
    check("axis spans the strip length", roi["span_px"] > (x1 - x0) * 0.8,
          f"span={roi['span_px']:.0f}px")

    # ---- spatial: positive
    # ORIGIN_MS is the clapper's last pulse in SCRIPT time (0.4s + 2*1.0s), which is what
    # frame_for() subtracts. Event times below are script-relative, like drive.mjs writes.
    ORIGIN_MS = 2400
    results = []
    A.score_spatial(frames, FPS, sync, ORIGIN_MS, {"t": 6000, "fixture": "A"}, {"A": roi}, results)
    spatial = results[-1]
    check("scores a red/blue split as PASS", spatial["verdict"] == "PASS",
          f"gap={spatial.get('hue_gap')}")

    # ---- spatial: negative. A solid fixture MUST fail, or the test proves nothing.
    solid = [f for f in frames[:int(9.0 * FPS)]]
    solid_tail = [with_strip(blank(), x0, x1, y, [[255, 0, 0]] * 8)] * int(3.0 * FPS)
    solid_clip = solid[:int(6.0 * FPS)] + solid_tail
    results2 = []
    A.score_spatial(solid_clip, FPS, sync, ORIGIN_MS, {"t": 6000, "fixture": "A"}, {"A": roi},
                    results2)
    check("scores a SOLID fixture as FAIL", results2[-1]["verdict"] == "FAIL",
          f"gap={results2[-1].get('hue_gap')}")

    # ---- chase: positive. Walk a lit pixel and confirm tracking.
    chase_frames = list(frames[:sync + 1])
    steps = []
    t_ms = ORIGIN_MS + 200
    for idx in range(8):
        colors = [[0, 0, 0]] * 8
        colors[idx] = [255, 255, 255]
        chase_frames.extend([with_strip(blank(), x0, x1, y, colors)] * 6)
        steps.append({"t": t_ms, "index": idx, "fixture": "A"})
        t_ms += int(6 / FPS * 1000)
    results3 = []
    A.score_chase(chase_frames, FPS, sync, ORIGIN_MS, steps, "A", 8, {"A": roi}, results3)
    check("scores a real chase as PASS", results3[-1]["verdict"] == "PASS",
          f"corr={results3[-1].get('correlation')}")

    # ---- chase: negative. Whole fixture flashing uniformly is NOT addressing.
    flat_frames = list(frames[:sync + 1])
    for _ in range(8):
        flat_frames.extend([with_strip(blank(), x0, x1, y, [[255, 255, 255]] * 8)] * 6)
    results4 = []
    A.score_chase(flat_frames, FPS, sync, ORIGIN_MS, steps, "A", 8, {"A": roi}, results4)
    check("does NOT call a uniform flash a chase", results4[-1]["verdict"] != "PASS",
          f"verdict={results4[-1]['verdict']}")

    finish()


def finish():
    print(f"\n{len(PASSED)} ok, {len(FAILED)} failed")
    if FAILED:
        print("failed: " + ", ".join(FAILED))
        sys.exit(1)


if __name__ == "__main__":
    main()
