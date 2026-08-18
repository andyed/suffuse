#!/usr/bin/env python3
"""
analyze.py — score a camera recording of the room against what drive.mjs actually sent.

WHY THIS EXISTS
  The Govee `razer` channel is mute: no replies, no readback, `devStatus` blind to segment
  state. A malformed frame looks exactly like a perfect one from the socket, so the only
  instrument has been a person watching the room. This turns a phone/webcam clip into
  PASS/FAIL numbers, so segmentation can be regression-tested instead of re-eyeballed.

WHAT IT ANSWERS
  spatial  — does the fixture show two colours at once, in the order we sent them?
  chase    — does a single lit pixel resolve and ADVANCE (true per-LED addressing), or
             smear (endpoint blending only)?
  latency  — how long after we send does the room change?

HOW IT SYNCS
  Recording starts by hand, so video t=0 is unknown. drive.mjs opens with three full-white
  pulses at a fixed 1s cadence; we find evenly-spaced global brightness peaks and measure
  everything from the last one.

HOW IT FINDS THE FIXTURES
  drive.mjs lights each fixture alone during CALIBRATE. Whatever brightens in that window is
  that fixture's ROI. No hand-drawn boxes, and it survives the camera being moved.

⚠️ CAMERA CAVEATS — these bound what can be claimed:
  - Auto-exposure and auto-white-balance fight absolute measurements. Every test here is
    therefore RELATIVE and WITHIN A SINGLE FRAME (this half vs that half; this pixel vs its
    neighbours), which auto-anything affects equally.
  - Latency includes camera pipeline delay, so read it as an UPPER BOUND, not the wire time.
  - A fixture that is out of frame, reflected, or blown out will fail for reasons that have
    nothing to do with the protocol. Check the calibration overlay before believing a FAIL.

Requires: ffmpeg on PATH, plus numpy + pillow. ffmpeg is invoked as a BINARY,
never linked, so no licence entanglement.

Usage:
  python3 verify/analyze.py <capture.mp4> <timeline.json> [--fps 15] [--json]
"""

import sys, os, json, shutil, subprocess, tempfile, argparse, colorsys

try:
    import numpy as np
    from PIL import Image
except ImportError:
    sys.exit("needs: pip install pillow numpy  (or: uv run --with pillow --with numpy)")


# ---------------------------------------------------------------- decode

def extract_frames(path, fps, workdir):
    """Normalize to constant fps — phone/webcam clips are VFR and index math needs a grid."""
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found on PATH")
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", path, "-vf", f"fps={fps},scale=640:-1",
         os.path.join(workdir, "f%05d.png")],
        check=True)
    files = sorted(f for f in os.listdir(workdir) if f.endswith(".png"))
    if not files:
        sys.exit("ffmpeg produced no frames — is the file a video?")
    return [np.asarray(Image.open(os.path.join(workdir, f)).convert("RGB"), dtype=np.float32)
            for f in files]


def luma(frame):
    return 0.2126 * frame[..., 0] + 0.7152 * frame[..., 1] + 0.0722 * frame[..., 2]


# ---------------------------------------------------------------- sync

def find_clapper(frames, fps, pulses, period_ms):
    """
    Locate the opening clapper and return the frame index of its LAST pulse.

    Matched by CADENCE, not by absolute brightness: we score every candidate start against
    the known pulse spacing, so a bright lamp elsewhere in the room cannot masquerade as sync.
    """
    signal = np.array([luma(f).mean() for f in frames])
    if signal.size < 3:
        return None, signal
    # np.ptp(), not signal.ptp() — the ndarray method was removed in numpy 2.
    norm = (signal - signal.min()) / max(float(np.ptp(signal)), 1e-6)
    spacing = period_ms / 1000.0 * fps

    best, best_score = None, -1.0
    # Only the first third of the clip: the opening clapper is what we align to, and the
    # closing one must not win.
    for start in range(0, max(1, len(frames) // 3)):
        idx = [int(round(start + k * spacing)) for k in range(pulses)]
        if idx[-1] >= len(norm):
            break
        score = float(np.mean([norm[i] for i in idx]))
        if score > best_score:
            best_score, best = score, idx

    # A real clapper is near-full-white; anything dim means we locked onto noise.
    if best is None or best_score < 0.35:
        return None, signal
    return best[-1], signal


# ---------------------------------------------------------------- ROI

def roi_from_window(frames, lo, hi, baseline):
    """
    Pixels that brighten during a solo window = that fixture.

    Differenced against a dark baseline so room lighting, monitors and reflections that are
    on the whole time drop out.
    """
    lo, hi = max(0, lo), min(len(frames), hi)
    if hi - lo < 2:
        return None
    lit = np.max(np.stack([luma(f) for f in frames[lo:hi]]), axis=0)
    delta = lit - baseline
    thresh = max(delta.max() * 0.45, 12.0)      # relative, so exposure drift can't zero it
    mask = delta > thresh
    if mask.sum() < 12:
        return None
    ys, xs = np.nonzero(mask)
    # A fixture running off the edge of frame is only PARTLY measured, and that produces
    # false negatives rather than obvious errors: if only the red half of a red/blue string
    # is in shot, both ends of the visible span are red and `spatial` reports FAIL for a
    # fixture that is working perfectly. Detect it so the verdict can be qualified.
    h, w = mask.shape
    margin = 2
    clipped = bool((xs <= margin).any() or (xs >= w - 1 - margin).any()
                   or (ys <= margin).any() or (ys >= h - 1 - margin).any())
    return {"mask": mask, "xs": xs, "ys": ys, "pixels": int(mask.sum()), "clipped": clipped}


def principal_axis(xs, ys):
    """
    Fit the fixture's long axis so 'position along the strip' is well defined regardless of
    how the fixture is oriented in frame. PCA on the lit pixels; returns a projection fn
    normalized to 0..1 from one end to the other.
    """
    pts = np.stack([xs.astype(np.float64), ys.astype(np.float64)], axis=1)
    centered = pts - pts.mean(axis=0)
    _, _, vt = np.linalg.svd(centered, full_matrices=False)
    axis = vt[0]
    t = centered @ axis
    lo, hi = t.min(), t.max()
    span = max(hi - lo, 1e-6)

    def project(px, py):
        v = np.stack([px.astype(np.float64), py.astype(np.float64)], axis=1) - pts.mean(axis=0)
        return ((v @ axis) - lo) / span

    return project, float(span)


def bin_along_axis(frame, roi, project, nbins):
    """Mean RGB per bin along the fixture axis. Empty bins come back as NaN, not zero —
    zero would read as 'black pixel' and silently pass a brightness test."""
    xs, ys = roi["xs"], roi["ys"]
    t = project(xs, ys)
    vals = frame[ys, xs, :]
    out = np.full((nbins, 3), np.nan)
    edges = np.linspace(0, 1, nbins + 1)
    for i in range(nbins):
        sel = (t >= edges[i]) & (t < edges[i + 1] if i < nbins - 1 else t <= 1.0)
        if sel.sum() >= 2:
            out[i] = vals[sel].mean(axis=0)
    return out


def hue_of(rgb):
    r, g, b = [float(c) / 255.0 for c in rgb]
    h, _, s = colorsys.rgb_to_hls(r, g, b)
    return h, s


def hue_gap(a, b):
    d = abs(a - b) % 1.0
    return min(d, 1.0 - d)


def frame_for(sync, origin_ms, t_ms, fps, offset_ms=0):
    """
    Map a timeline timestamp to a video frame index.

    ⚠️ Event times are measured from SCRIPT start; `sync` is the frame of the clapper's LAST
    pulse, which happens ~2s into the script. Adding one to the other directly looks every
    phase up seconds too late — off the end of a short clip, or into the wrong phase on a long
    one. `origin_ms` is that last pulse's own timestamp, and the difference is what counts.
    """
    return sync + int((t_ms - origin_ms + offset_ms) / 1000.0 * fps)


# ---------------------------------------------------------------- tests

def score_spatial(frames, fps, sync, origin_ms, ev, rois, results):
    fixture = ev["fixture"]
    roi = rois.get(fixture)
    if roi is None:
        results.append({"test": "spatial", "fixture": fixture, "verdict": "SKIP",
                        "why": "no ROI — fixture not found during calibration"})
        return
    # Sample mid-hold: after the device's own crossfade has settled.
    fi = frame_for(sync, origin_ms, ev["t"], fps, offset_ms=2000)
    if fi >= len(frames):
        results.append({"test": "spatial", "fixture": fixture, "verdict": "SKIP",
                        "why": "recording ended before this phase"})
        return

    bins = bin_along_axis(frames[fi], roi, roi["project"], 6)
    ok = ~np.isnan(bins[:, 0])
    if ok.sum() < 4:
        results.append({"test": "spatial", "fixture": fixture, "verdict": "SKIP",
                        "why": "too few lit bins to judge"})
        return

    first, last = bins[ok][0], bins[ok][-1]
    h1, s1 = hue_of(first)
    h2, s2 = hue_of(last)
    gap = hue_gap(h1, h2)

    # Sent red at one end and blue at the other: 1/3 of the wheel apart. Require a clear
    # majority of that, and enough saturation for hue to mean anything at all.
    saturated = s1 > 0.15 and s2 > 0.15
    verdict = "PASS" if (gap > 0.12 and saturated) else "FAIL"
    # Never report a bare FAIL for a fixture we could only see part of — that is a framing
    # result, not a hardware one, and this project has already lost months to a negative
    # that was really a measurement artifact.
    if verdict == "FAIL" and roi.get("clipped"):
        verdict = "SUSPECT"
    results.append({
        "test": "spatial", "fixture": fixture, "verdict": verdict,
        "hue_gap": round(gap, 3), "end_hues": [round(h1, 3), round(h2, 3)],
        "saturation": [round(s1, 2), round(s2, 2)], "clipped": bool(roi.get("clipped")),
        "why": {
            "PASS": "two distinct hues across the fixture",
            "FAIL": "ends share a hue — rendering one colour, or washed out in camera",
            "SUSPECT": "ends share a hue BUT the fixture runs off frame — likely only one "
                       "half was visible. Reframe before believing this.",
        }[verdict],
    })


def score_chase(frames, fps, sync, origin_ms, steps, fixture, leds, rois, results):
    roi = rois.get(fixture)
    if roi is None:
        results.append({"test": "chase", "fixture": fixture, "verdict": "SKIP",
                        "why": "no ROI"})
        return

    positions = []
    for ev in steps:
        fi = frame_for(sync, origin_ms, ev["t"], fps, offset_ms=200)   # settle inside the step
        if fi >= len(frames):
            break
        bins = bin_along_axis(frames[fi], roi, roi["project"], min(leds, 12))
        lum = np.nanmean(bins, axis=1)
        if np.all(np.isnan(lum)):
            continue
        positions.append((ev["index"], int(np.nanargmax(lum))))

    if len(positions) < 6:
        results.append({"test": "chase", "fixture": fixture, "verdict": "SKIP",
                        "why": f"only {len(positions)} usable steps"})
        return

    sent = np.array([p[0] for p in positions], dtype=float)
    seen = np.array([p[1] for p in positions], dtype=float)
    # Correlation, not exact position: camera angle, lens distortion and bin quantisation all
    # shift absolute index. What matters is that the bright spot TRACKS the commanded one.
    if seen.std() < 1e-6:
        corr = 0.0
    else:
        corr = float(np.corrcoef(sent, seen)[0, 1])

    verdict = "PASS" if corr > 0.6 else ("WEAK" if corr > 0.3 else "FAIL")
    results.append({
        "test": "chase", "fixture": fixture, "verdict": verdict,
        "correlation": round(corr, 3), "steps": len(positions),
        "why": {"PASS": "lit pixel tracks the commanded index — discrete addressing",
                "WEAK": "partial tracking — likely interpolating, not discrete",
                "FAIL": "no relationship — fixture is not resolving single pixels"}[verdict],
    })


def score_latency(frames, fps, sync, origin_ms, events, results):
    lat = []
    signal = np.array([luma(f).mean() for f in frames])
    for ev in events:
        fi = frame_for(sync, origin_ms, ev["t"], fps)
        if fi < 1 or fi + int(fps) >= len(frames):
            continue
        window = signal[fi:fi + int(fps)]
        base = signal[max(0, fi - 3):fi].mean() if fi >= 3 else window[0]
        rise = np.nonzero(window > base + max(base * 0.35, 6))[0]
        if rise.size:
            lat.append(rise[0] / fps * 1000.0)

    if not lat:
        results.append({"test": "latency", "verdict": "SKIP", "why": "no detectable steps"})
        return
    results.append({
        "test": "latency", "verdict": "INFO",
        "median_ms": round(float(np.median(lat)), 1), "samples": len(lat),
        "why": "UPPER BOUND — includes camera pipeline delay and 1/fps quantisation",
    })


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("timeline")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    with open(args.timeline) as fh:
        tl = json.load(fh)
    events = tl["events"]

    workdir = tempfile.mkdtemp(prefix="suffuse-verify-")
    try:
        frames = extract_frames(args.video, args.fps, workdir)
    finally:
        pass  # frames are in memory; workdir cleaned below

    try:
        sync, _ = find_clapper(frames, args.fps, tl["clapper"]["pulses"],
                               tl["clapper"]["periodMs"])
        if sync is None:
            sys.exit("could not find the sync clapper — was recording running before the "
                     "3 white pulses? Re-shoot with the fixtures clearly in frame.")

        # The clapper's LAST pulse is the time origin every phase is measured from. Take it
        # from the FIRST clapper only — drive.mjs also plays a closing one.
        pulses = [e for e in events if e["phase"] == "clapper_pulse"]
        first_clapper = pulses[:tl["clapper"]["pulses"]]
        if not first_clapper:
            sys.exit("timeline has no clapper_pulse events — was it written by an old drive.mjs?")
        origin_ms = first_clapper[-1]["t"]

        # Darkest frame as baseline: the room minus our lights.
        baseline = luma(frames[int(np.argmin([luma(f).mean() for f in frames]))])

        rois = {}
        for ev in [e for e in events if e["phase"] == "calibrate"]:
            lo = frame_for(sync, origin_ms, ev["t"], args.fps, offset_ms=500)
            hi = frame_for(sync, origin_ms, ev["t"], args.fps, offset_ms=2800)
            roi = roi_from_window(frames, lo, hi, baseline)
            if roi:
                roi["project"], roi["span_px"] = principal_axis(roi["xs"], roi["ys"])
                rois[ev["fixture"]] = roi

        results = []
        for f in tl["fixtures"]:
            r = rois.get(f["ip"])
            results.append({
                "test": "calibrate", "fixture": f["ip"],
                "verdict": "PASS" if r else "FAIL",
                "pixels": r["pixels"] if r else 0,
                "span_px": round(r["span_px"], 1) if r else 0,
                "clipped": bool(r.get("clipped")) if r else False,
                "why": ("fixture located, but touches the frame edge — only partly measured"
                        if (r and r.get("clipped")) else
                        "fixture located in frame" if r else
                        "never found — out of frame, too dim, or not responding"),
            })

        for ev in [e for e in events if e["phase"] == "spatial"]:
            score_spatial(frames, args.fps, sync, origin_ms, ev, rois, results)

        chase_steps = [e for e in events if e["phase"] == "chase_step"]
        for f in tl["fixtures"]:
            steps = [e for e in chase_steps if e["fixture"] == f["ip"]]
            if steps:
                score_chase(frames, args.fps, sync, origin_ms, steps, f["ip"], f["leds"],
                            rois, results)

        score_latency(frames, args.fps, sync, origin_ms,
                      [e for e in events if e["phase"] == "latency_step"], results)

        if args.json:
            print(json.dumps({"sync_frame": sync, "frames": len(frames),
                              "results": results}, indent=2))
        else:
            print(f"\n{len(frames)} frames @ {args.fps}fps, sync at frame {sync}\n")
            for r in results:
                extra = " ".join(f"{k}={v}" for k, v in r.items()
                                 if k not in ("test", "fixture", "verdict", "why"))
                who = f" {r['fixture']}" if "fixture" in r else ""
                print(f"  [{r['verdict']:5}] {r['test']}{who}  {extra}")
                print(f"          {r['why']}")
            suspect = [r for r in results if r["verdict"] == "SUSPECT"]
            if suspect:
                print("\n⚠️  SUSPECT = the fixture ran off frame, so a negative here is more "
                      "likely framing than hardware. Reshoot with it fully in shot.")
            fails = [r for r in results if r["verdict"] == "FAIL"]
            print(f"\n{len(fails)} FAIL, {sum(1 for r in results if r['verdict'] == 'PASS')} PASS")
            if fails:
                print("⚠️  Check the fixture was in frame and not blown out before blaming the protocol.")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
