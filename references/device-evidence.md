# Device evidence ledger

Capability advertisement is necessary for compilation, but visible output is the acceptance test for spatial claims.

## H608B observation — 2026-08-10

One installed H608B string-downlight fixture advertised:

- `segmentedColorRgb` with 15 segment indices;
- a maximum of 3 segment indices per control request;
- `gradientToggle`;
- native scenes and DIY scenes.

The cloud API returned success for correctly chunked segment requests, both before and after enabling `gradientToggle`, but the fixture did not visibly render independent colors. It remained uniform or unchanged. This is negative evidence for that tested unit and firmware state, not a global SKU blacklist.

The same fixture visibly changed when the advertised native `Sunset Glow` scene was resolved by name and triggered. That is positive evidence for named native-scene replay, not for arbitrary palette upload or per-puck control.

## LAN: all lamps found, none captured

When every LAN lamp answers the discovery scan but none answers `devStatus`,
the evidence points at the host, not the lamps. On Windows the usual cause is
the firewall: a `node` path with no Allow rule gets inbound Block rules, which
pass the multicast scan's replies and drop every `devStatus` reply (measured
6/6 discovered, 0/36 asks answered). Do not record those lamps as offline or
as lacking LAN support. See [lan.md](lan.md) for the event log to check and
the fix. A single lamp that misses capture once is the Wi-Fi case instead;
`lanDevStatusRead` asks three times before calling it silent.

## H6056 observation — 2026-11-11

One pair of Flow Plus Light Bars, Wi-Fi firmware 1.00.16, driven over LAN `razer` and
watched by a webcam (1280×720) with the room's other lamps switched off.

**Count.** For each slot, 12 dim-blue triples were streamed and a baseline frame taken,
then the same frame with that one slot white and a second frame taken. The positive part
of the difference was summed per column inside a box around each bar. The twelve
difference images are in [evidence/h6056-walk-2026-11-11.jpg](evidence/h6056-walk-2026-11-11.jpg)
(left bar on the left, right bar on the right, one row per slot).

| Slot | Bar | Centroid x (px) | Lit span (px) | Energy | Other bar |
| --- | --- | --- | --- | --- | --- |
| 0 | right | 697.1 | 682–711 | 53304 | 0 |
| 1 | right | 691.9 | 673–710 | 61793 | 0 |
| 2 | right | 683.7 | 663–706 | 71992 | 0 |
| 3 | right | 674.5 | 652–696 | 71869 | 0 |
| 4 | right | 666.8 | 647–686 | 64394 | 0 |
| 5 | right | 660.8 | 646–678 | 50750 | 0 |
| 6 | left | 414.6 | 395–436 | 81932 | 0 |
| 7 | left | 422.9 | 398–449 | 99865 | 0 |
| 8 | left | 432.4 | 405–460 | 96694 | 0 |
| 9 | left | 444.6 | 416–474 | 102234 | 0 |
| 10 | left | 455.8 | 431–480 | 83592 | 0 |
| 11 | left | 461.4 | 440–482 | 77434 | 0 |

The right bar's box was 76 px wide and the left bar's 96 px. Every slot lit exactly one
bar. The centroids step monotonically along each bar (right −5.2, −8.2, −9.1, −7.7,
−6.0 px; left +8.3, +9.5, +12.2, +11.3, +5.6 px). Neighbouring lit spans overlap: that is
bloom at this distance, and the end steps are shorter because the bloom is clipped at the
bar ends. Reading: 12 slots, 6 per bar; slots 0–5 run along one bar and 6–11 along the
other, outer end to inner end on both as this pair was mounted.

**Wrong counts.** Sent 6 colours (the mined SignalRGB total), the bars rendered, each
colour stretched over two segments: one lit slot of a 6-slot frame was twice as wide as
one of a 12-slot frame. Sent 24, the bars went dark. A one-colour frame filled both bars.

**Rate.** The stop-test described in [lan.md](lan.md) (a travelling blob, 12 slots, 8 s), webcam frames every
150 ms across the stop, each compared with the run's last frame (mean absolute difference
inside the two bar boxes; still-frame floor 2.1–2.9):

| Rate | Frames sent | Last frame clearly different from the final look |
| --- | --- | --- |
| 30 Hz | 240 | +0.36 s after the last frame was sent |
| 40 Hz | 320 | +0.35 s |
| 60 Hz | 480 | +0.67 s |

30 and 40 Hz settle alike; that ~0.4 s is camera lag plus the bars' own settling. 60 Hz
takes about 0.3 s longer. One run each. A camera cannot see a queue shorter than its own
lag, so this supports `maxHz: 40` and nothing finer; `frameHz` stays null until someone
watches a stop.

Not measured: chroma gamma, a second unit, other firmware.

## Three shapes of a wrong count

A wrong per-LED count does not always look wrong. Seen on this project's hardware:

| What the fixture did | SKU | Wrong count sent | Right count |
| --- | --- | --- | --- |
| Nothing: the frame is ignored | H608B | 2, 10, 30 | 15 |
| One collapsed colour that still tracks the palette | H61D3 | 15 | 7 |
| A working look at lower resolution, each colour stretched | H6056 | 6 | 12 |

The H805D is reported to stretch too (84 colours across 132 slots). Only the first shape
announces itself. The other two pass a glance, so a count is confirmed by a one-lit-slot
walk with every position counted, never by "it lit up".

## Retest rule

After a firmware update or on a different unit:

1. inspect fresh capabilities and segment limits;
2. dry-run a high-contrast 3-band score;
3. explicitly confirm the experimental segment write;
4. visually check whether at least three spatial regions differ;
5. record accepted operations and the visible result separately.

Do not repeatedly write the same failed sequence without a meaningful changed condition such as firmware, capability document, or device.
