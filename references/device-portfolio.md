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
hardware-verified 15 discrete pixels at 40 Hz. A source that disagreed with a
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
