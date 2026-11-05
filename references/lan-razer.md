# The LAN `razer` channel — provenance and evidence

Read this before making any claim about the per-LED LAN path. It exists because the
channel is easy to describe confidently and hard to describe *accurately*: it has no
official documentation, no name beyond its JSON command string, and no error surface —
so every claim below is tagged with where it comes from.

## Is it documented?

**No.** Govee has never published this protocol. Razer has never published it. It is a
reverse-engineered channel that Govee firmware implements for Razer Synapse's Chroma
integration and Govee's own Desktop app, and that SignalRGB and LedFx adopted. LedFx's
implementation opens with: *"no current known documentation on the protocol, use with
caution."* That is the honest ceiling on certainty for everything that follows.

Consequences to state plainly when relevant:

- **Stability is not promised.** A firmware update could change or remove the channel;
  Govee has no compatibility obligation to a protocol it never documented.
- **Per-SKU behavior varies** and is only knowable empirically (see the evidence table).
- Suffuse's `verified: false` on every per-LED result is a direct expression of this
  page: the channel never acknowledges, so no write can be claimed as rendered.

## Why the usual canonical repo does not cover this

[`wez/govee2mqtt`](https://github.com/wez/govee2mqtt) (MIT) is the most complete public
reference for Govee's *other* surfaces — documented LAN API, BLE-over-LAN `ptReal`,
cloud platform including its undocumented one-click/DreamView **cloud** endpoints, and
per-SKU capability notes. **It does not implement or document the LAN `razer` channel**
(searched 2026-08-15: no razer / 0xBB / Synapse hits; its "dreamview" references are
cloud endpoints, a different mechanism). Do not cite it for this channel, and do not
read its silence as evidence the channel is unreal.

## Reference chain, strongest first

1. **Hardware verification (this project, H608B, 2026-08-15).** Primary evidence for
   everything Suffuse's implementation depends on — see the table below. Several
   findings appear in no public source at all.
2. **OpenRGB** — `Controllers/GoveeController/GoveeController.cpp` (GPL-2.0-or-later),
   canonical at [GitLab MR !2172](https://gitlab.com/CalcProgrammer1/OpenRGB/-/merge_requests/2172),
   where the reverse-engineering write-up lives. The cleanest public implementation and
   the source of the two constants our encoder self-checks against. **Read, never copy:
   GPL boundary.**
3. **LedFx** — `ledfx/devices/govee.py` + `docs/devices/govee.md` (GPL-3.0). An
   independent implementation that agrees with OpenRGB, plus practical per-model
   behavior notes (matrix-device limits, default 40 fps). Same read-don't-copy rule.
4. **LumiSync** — [`Minlor/LumiSync`](https://github.com/Minlor/LumiSync) (MIT), an
   independent implementation with its own research writeup
   (`docs/govee-lan-research-and-implementation.md`). Notable as a permissively
   licensed peer: unlike the GPL sources above it could legally be copied — Suffuse's
   implementation predates our awareness of it and was derived independently, but it is
   a legitimate cross-check with no licence friction.
5. **SignalRGB's Govee Direct** and the community `Govee.js` addon family — working
   protocol source (the enable constant appears verbatim in a dozen small repos, most
   unlicensed) and behavioral corroboration for device coverage and LED counts.

A survey by the enable-packet fingerprint (base64 `uwABsQEK`, 2026-08-15) found ~36
public files implementing this channel. None pair it with typed tools, write gates,
receipts, or bounded holds — they are render loops. Suffuse's claim is not priority on
the protocol; it is the safety contract around it.

Suffuse's `scripts/lan.mjs` was written from the byte layout as protocol fact and
verified against the published constants and against hardware. No GPL code was copied,
and none may be: this repository is MIT and is distributed.

## The one encoding trap

Every known prose description of this protocol states the frame's length field as a
single byte. **It is 16-bit big-endian**, counting bytes after the `0xB0` subcommand.
An implementation built from a blog post works up to 84 LEDs and then silently
corrupts — on a channel that cannot report the corruption. `assertRazerEncoderSane()`
probes exactly this with an 86-LED frame at every load.

## Evidence table

| Claim | Source | Status |
| --- | --- | --- |
| Frame layout, XOR checksum, enable/disable constants | OpenRGB source; our encoder reproduces both constants | Verified |
| Length field is 16-bit BE | OpenRGB source; 86-LED probe | Verified |
| H608B renders 15 independent pixels | Hardware: discrete chase, every pixel counted (2026-08-15) | Verified |
| 40 Hz sustained, no device-side queue | Hardware: 400 frames / 10.00 s, motion froze at stop (H608B) | Verified, this SKU |
| 60 Hz sustained on the H608B and H61D3, no device-side queue | Hardware stop-test: 480 frames at 60 Hz, motion froze at a dead stop (H608B 2026-08-23, H61D3 2026-09-05; psychodeli-webgl-port). Above 60 unmeasured | Verified, these SKUs. `RAZER_MAX_HZ` |
| H612B and H16C0 run clean at 40 Hz | Hardware stop-test: 320 frames at 40 Hz, instant freeze (2026-08-23). Not yet probed at 60 | Verified at 40 only. `RAZER_PROFILES.maxHz` holds them there |
| Sustained rate and ceiling are separate claims | `frameHz` records a measured sustained rate, `maxHz` the highest rate whose stop froze instantly; neither inherits the other's number without its own probe. The H6047's `maxHz` 30 is the rate it shipped at, never probed, so its `frameHz` stays null | Rule |
| Pixel count must match or the frame is silently ignored | Hardware: 2/10/30-pixel frames showed nothing on a 15-LED string; 15 split immediately | Verified, this SKU |
| Mode byte: `0x01` spatial array, `0x00` first-triple solid | Hardware sweep of both values on H608B + H6047 | Verified; OpenRGB names it `gradient_off`, which is misleading |
| Whole-device `colorwc` flattens a live per-LED look (last writer wins) | Hardware, both orderings | Verified — basis of the hold contention lock |
| ~60 s dead-man without LED data, device reverts to own effects | OpenRGB write-up; consistent with our observations | Corroborated |
| H6047 has 20 slots — 0-9 up the left bar, 10-19 up the right; firmware remaps shorter packets unpredictably, so always stream all 20 | SignalRGB community zone-probe, mined 2026-08-16. Explains the earlier "8 interpolating zones" reading: short packets get remapped, which renders as interpolation | Corroborated; **unverified** by discrete chase |
| H612B renders 10 discrete pixels despite Govee's own product DB saying `supportRazer: 0` | Hardware: field-verified 2026-08-16 — a wrong count renders nothing, so a rendering 10 IS the count | Verified |
| H16C0 Floor Lamp 3 Lite renders 7 discrete vertical regions, index 0 bottom through index 6 top | Hardware: one-hot red segment walked all seven positions with the other six dark; then a smooth 20 s Electron run at 30 Hz stopped immediately with no visible backlog and restored cleanly (2026-08-18) | Verified; native iOS/Android transport performance remains unmeasured |
| H61D3 Neon Rope Light 2 renders 7 discrete pixels; the mined `lanApi.segments` prior of 15 renders ONE collapsed colour that still tracks the palette | Hardware: discrete chase at 7, 60 Hz stop-test clean (psychodeli-webgl-port, 2026-09-05). At 15 the rope looked exactly like a working whole-device lamp — the same shape as the H6047 solid result | Verified; treat `lanApi.segments` as suspect for the H61D2–D6 range |
| The H61D3 and H612B map bytes to LED duty roughly linearly, so minor-channel leakage in an sRGB-shaped pixel ([82,0,10]) lights PINK; the H16C0 (LuminBlend+, gamma-calibrated) shows the same bytes red | Photo + eye, 2026-09-07 (Red Moon): identical frames red on the H16C0, pink end to end on the H61D3/H612B, constant across brightness; raw probe [255,0,25] read pink on both, pure [255,0,0] read best; chroma gamma 2.2 helped, 3 read redder | Verified by eye; the gamma value is an eye measurement, not a photometric one. `RAZER_PROFILES.chromaGamma` |
| Matrix devices (curtains, nets) have partial/first-N-pixel coverage | LedFx docs (H6811: first 224 pixels) | Reported, not reproduced here |

## Chroma gamma — when a fixture drives its LEDs linearly

Every pixel Suffuse compiles is sRGB-shaped: a byte of 10 means ~0.3% of full light.
A fixture whose PWM duty follows the byte linearly emits 4% for it — thirteen times
the intended blue — so a red pixel carrying a little blue lights pink, at every
brightness, because the error is a ratio. Govee's LuminBlend+ lamps carry a gamma
calibration and show the same bytes correctly; the older RGBIC strips and ropes do not.

`chromaGamma(colors, gamma)` re-encodes each pixel's minor channels against its
dominant one, `c' = max · (c/max)^γ`, and zeroes any minor channel that lands below one
LSB. The exponent is weighted by the pixel's saturation (identity at or below 0.05, full
from 0.35 up): the leakage lives on chromatic pixels, and an unweighted gamma turns a
near-white's faint tint into a visible one (a screen ivory read lavender on a neon rope). The dominant channel is untouched, so brightness is preserved. The value is per SKU
in `RAZER_PROFILES.chromaGamma`, applied in the per-LED compile, and reported in the
plan. **null means unmeasured and applies no correction** — never inherit a neighbour's
number, because a guessed γ on a calibrated fixture thins every mixed colour it shows.

To measure a SKU: paint every pixel `[255,0,25]` (10% blue). Pink means linear drive;
red means calibrated, keep null. Then raise γ on a red look until the pink is gone
without oranges and teals going thin. The value may be one exponent or `[gr, gg, gb]`: an exponent tuned on saturated red, where only blue leaks, crushes green as hard as blue, and Golden Hour's golds read pinkish under a scalar 3. The H61D3 and H612B landed at `[2.2, 2.2, 3]` by this method, the H608B downlights at 2.

## What updating this page requires

New SKU claims enter `RAZER_PROFILES` only through the discrete-chase test: one lit
pixel walked across the fixture, every position visually counted. A rendered gradient
is **not** verification — interpolating hardware renders a plausible gradient at any
pixel count, which is precisely how wrong counts hide. Community-sourced counts may
enter as `verified: false` with their provenance named.

The chase test is runnable: `verify/drive.mjs` plays it (with a camera-sync clapper
and per-fixture calibration) and `verify/analyze.py` scores a phone recording of it
into PASS / WEAK / FAIL — see [verify/README.md](../verify/README.md). A camera-scored
chase PASS at the profile's pixel count is the promotion criterion.

**Rule for mined vendor capability flags:** a mined *positive* is trustworthy; a mined
*negative* is only "unknown," never "absent." The H612B taught this — Govee's own
product database says `supportRazer: 0` for it, yet the LAN firmware renders 10
discrete pixels; the flag describes what the Desktop/Chroma app offers, not what the
firmware accepts. The same family disagrees in the other direction too: the H608B
advertises cloud `segmentedColorRgb` that never visibly renders while razer works.
Capability surfaces are claims about *an app's* support, and only hardware settles them.
