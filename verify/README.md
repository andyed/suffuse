# verify/ — camera-in-the-loop verification for per-LED claims

The Govee `razer` channel has **no readback**. The device never replies,
`devStatus` does not reflect segment state, and a malformed frame is
indistinguishable from a perfect one at the socket. That is why every per-LED
result Suffuse reports carries `verified: false` — and why
[references/lan-razer.md](../references/lan-razer.md) admits new SKU profiles
only through a discrete-chase test performed by eye.

This harness is that eye, made repeatable. `drive.mjs` plays known patterns
and records exactly what was sent when; `analyze.py` scores a phone or webcam
recording against that and prints PASS/FAIL. It exists so a contributor can
verify a fixture Suffuse's authors have never seen — and so a "my device
doesn't work" report can become a measurement instead of an argument.

## Run it

```bash
node verify/drive.mjs --fixtures 192.168.1.34:15,192.168.1.84:20 --out verify/runs/today
```

Quit any other light controller first — the script refuses to start if UDP
`:4002` is taken, and refuses fixtures with an active Suffuse hold, because
two writers on the same lamps invalidate every measurement.

It prints `START RECORDING NOW` and waits 5 seconds. Start the camera, let it
run (~2 min), stop when told. Then:

```bash
uv run --with numpy --with pillow python verify/analyze.py capture.mov verify/runs/today/timeline.json
```

## Shooting it

The analysis is only as good as the framing, and a bad take fails for reasons
that have nothing to do with the protocol.

- **Every fixture under test must be in frame for the whole clip.** A fixture
  that drifts out during calibration has no ROI and every later test on it
  reports SKIP.
- **Start recording before the three white flashes.** They are the sync
  signal; without them the analyzer refuses to guess and exits.
- **Lock exposure if the camera allows it.** Auto-exposure hunting during the
  dark phases makes the lights look dimmer than they are. Every test is
  deliberately relative and within-frame to survive this, but locking it is
  still better.
- **Do not overexpose.** A blown-out fixture reads as white everywhere and
  fails the spatial test no matter what it is actually showing.
- **Dim the room.** The baseline is the darkest frame; the more the fixtures
  dominate, the cleaner the ROI.
- Fixtures in the same shot is fine and preferred — calibration lights each
  one alone, so they are separated by time rather than by framing.

## What it measures

| test | question | how |
|---|---|---|
| `calibrate` | is the fixture in frame and responding? | pixels that brighten while it alone is lit |
| `spatial` | does it show two colours at once? | hue gap between the two ends of the fitted axis |
| `chase` | true per-LED, or endpoint blending? | correlation between commanded index and brightest bin |
| `latency` | how late does the room change? | frames from send to brightness rise |

`chase` is the [RAZER_PROFILES](../scripts/lan.mjs) admission test. It reports
**WEAK** rather than PASS/FAIL in the middle band — the interpolating case,
which tracks loosely but cannot resolve a single pixel. A `chase` PASS at the
profile's pixel count, seen on camera, is what promotes `verified: false` to
`verified: true`.

`chase` also writes a **zone map**: for each step, the centroid of the brightest
change against the dark baseline, inside the fixture's ROI, as index → (x, y) in
frame pixels (`zonemap` in `--json`). It is a layout record, not a verdict.
Correlation says the lit pixel tracks the commanded index; the map says where
each index sits, so it learns LED order on layouts one axis cannot describe,
such as indices running up one bar and then up a second (the H6047). Same
method as psychodeli-webgl-port's camera zone map (2026-10): light one index at
a time, subtract a dark baseline, take the centroid of the brightest change.
The chase lights full white, so the centroid uses only pixels at or above half
the peak change: glow around a lit LED pulls the point less than the LED does.

`latency` is an **upper bound**: it includes camera pipeline delay and 1/fps
quantisation. Do not quote it as wire latency.

## Trusting the analyzer

```bash
uv run --with numpy --with pillow python verify/selftest.py
```

Builds synthetic frames with known answers and runs them through the real
scoring path — sync, ROI discovery, axis fitting, and both scorers. It
includes the **negative** cases (a solid fixture must FAIL the spatial test; a
uniform flash must not pass as a chase), because a scorer that always says
PASS would sail through positive-only tests. CI runs it on every push.

## Contributing a result

Attach to a [device compatibility report](https://github.com/andyed/suffuse/issues/new?template=compatibility-report.yml):
the analyzer's `--json` output, the SKU and firmware, and — if you can — the
unedited clip. Redact anything that identifies your household; the timeline
contains fixture IPs, so scrub or renumber them before posting.

## Licensing

`ffmpeg` is invoked as a **binary subprocess**, never linked; numpy and Pillow
are BSD/MIT-class. The razer encoder this exercises was derived from the byte
layout as protocol fact, not copied from OpenRGB (GPL-2.0-or-later). Keep it
that way — this repository is MIT and is distributed.
