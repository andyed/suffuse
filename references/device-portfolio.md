# The mined device portfolio

`assets/device-portfolio.json` is a per-SKU capability portfolio covering 371
Govee SKUs, harvested from four open-source integrations with per-fact
provenance, and anchored against this project's own hardware measurements. It
exists because every hardware-verified profile row was bought with hours of
probing against mute devices — the open-source ecosystem has already paid that
cost across hundreds of SKUs, and this file harvests it *with the source of
each claim named* so disagreements stay visible.

Query it: `node scripts/portfolio.mjs H612B`. Regenerate it:
`node scripts/mine-portfolio.mjs --sources <dir-with-clones>` (the script
prints the clone list; sources are read locally, never redistributed).

## Sources, and what each is authoritative for

| Key | Repository | Contributes |
| --- | --- | --- |
| `govee` | fu-raz/signalrgb-govee-direct-connect | A dump of **Govee's own product database** (293 SKUs): product names, `supportRazer` / `supportFeast` flags |
| `signalrgb` | RobThePCGuy/SignalRGB-Govee-Network-Plugin | Community-probed razer LED counts, DreamView flags, subdevice layouts — the source of the H6047 "20 slots, 0-9 left bar / 10-19 right" fact |
| `lanApi` | Galorhallen/govee-local-api (Home Assistant's LAN backend) | Which SKUs speak the documented LAN API + BLE-bitmask segment counts |
| `quirks` | wez/govee2mqtt | `lan_api_capable` / `ble_only` / `avoid_platform_api` quirks |
| `ourHardware` | This project | Hardware ground truth. The validation anchor; never overwritten by mining |

Each mined snapshot pins the source commits (`sources` field) and records the
validation check: the H608B's three independent mined claims (signalrgb
ledCount 15, govee supportRazer 1, lanApi segments 15) all match the
hardware-verified 15 discrete pixels (stop-tested at 60 Hz). A source that disagreed with a
hardware-verified fact would be suspect for everything else it claims.

## The rules for reading it

1. **A mined positive is trustworthy; a mined negative is only "unknown."**
   Vendor flags describe what an app offers, not what the firmware accepts.
   The H612B is the proof: Govee's own database says `supportRazer: 0`, and
   the fixture renders 10 discrete pixels over the razer channel
   (field-verified 2026-08-16). `scripts/portfolio.mjs` `priors()` encodes
   this — it never reports "unsupported", only "corroborated" or "unknown".
2. **Absence from the portfolio means unknown, not unsupported.** The mining
   only sees SKUs the four sources happen to cover.
3. **Mined counts enter `RAZER_PROFILES` as `verified: false`.** Promotion to
   `verified: true` happens only through the discrete-chase test defined in
   [lan-razer.md](lan-razer.md). A rendered gradient is not verification.
4. **`ourHardware` outranks every mined claim** for its SKU, and mining never
   overwrites it.

## From a mined count to driving it: the qualification contract

`priors()` can say a count is `corroborated`. That is a candidate, not a
verdict: a wrong count can render nothing, and the per-LED channel has no
readback to tell that from success. Suffuse's own `lan paint` therefore never
drives a mined count; it refuses any SKU without a `RAZER_PROFILES` entry. A
consumer that wants to use a corroborated count anyway (psychodeli-webgl-port
does, `spatial-qualification.js`, 2026-10-13) follows this contract:

1. **Precedence, most trustworthy first:** a `RAZER_PROFILES` entry (measured,
   never re-asked); then a person's stored verdict for this install; then a
   test the person asked for; otherwise a single whole-device colour.
2. **States:** `untried` (a candidate exists; show ordinary colour) →
   `trying` (the person asked for a test and frames are going out) →
   `confirmed` or `rejected` (the person answered). Nothing drives per-LED
   until a person has watched the test and answered.
3. **The test is independent of the look.** Slow, strongly contrasting bands
   (warm red, blue, green) stepped along the fixture every 500 ms, repeated
   until answered. Not the palette, not audio: a test that moves with the
   music cannot tell "the count is right" from "something is changing".
4. **Only the explicit verdict persists.** Requests and attempts are
   session-only; a crash or quit mid-test leaves the lamp `untried`, not
   half-qualified. A `rejected` verdict keeps an explicit retry.
5. **Key verdicts on the device id**, which survives DHCP, and record the SKU so
   a second fixture of the same model can inherit the answer, except for
   variable fixtures (cuttable strips, chainable panels), where the count
   belongs to the install, not the model.
6. **A fixture qualified by eye is not rate-probed.** Stream it at no more
   than 20 Hz, below every rate a Govee fixture has been seen to sustain (see
   `RAZER_PROFILES.maxHz`), and assume `discrete` blend: on an interpolating
   fixture discrete stops still render, smoother than intended, while the
   reverse assumption can render nothing.

A confirmed verdict is still not `verified: true` in `RAZER_PROFILES` (rule 3
above). It says one person saw one install light across the fixture;
promotion still takes the discrete chase.

## Mined counts that hardware corrected

Two of the mined counts checked against a real fixture were wrong, in two different
ways, and neither failure looked like one:

| SKU | Mined | Measured | What the mined count rendered |
| --- | --- | --- | --- |
| H61D3 | 15 (`lanApi.segments`) | 7 | One collapsed colour that still tracked the palette, like a working whole-device lamp |
| H6056 | 6 (`signalrgb` total of two 3-LED subdevices) | 12 | A working per-LED look at half resolution: each colour stretched over two segments |

Both passed a glance. That is the case for rule 3 and for the qualification contract
above, and it is why this table is published as candidates for owners to check rather
than held back until someone has measured all of it. The same counts are offered for
checking in [govee-lights-app](https://github.com/SaarthurR/govee-lights-app/pull/1)
(`models.json`, with a switch to try an untested model and a report form). A count
corrected there belongs here too, as an `ourHardware` entry or a named outside report.

## Known upstream disagreement

`govee-local-api` 3.0.1 states two different segment counts for the **H612D**: its
generated `SUPPORTED_DEVICES.md` says 15, its `light_capabilities.py` says 20. The miner
reads the `.py`, so 20 is what lands here. Neither number is hardware-verified, and rule 3
already holds the count at `verified: false` — treat it as a range until a discrete chase
settles it.

## Licensing

The miner reads the source repositories locally and extracts device facts —
SKU capability data, not copyrightable expression. No code from those
repositories (two of which are GPL) is copied into this one, and the clones
are never redistributed. Same read-never-copy boundary as
[lan-razer.md](lan-razer.md).
