# Govee over Bluetooth LE — protocol knowledge

Suffuse does not ship a BLE transport today. This page exists because the
protocol knowledge was expensive to acquire — measured against physical
hardware in the Psychodeli reference room (2026-08-08 → 2026-08-09) — and any
future BLE adapter must honor it. Facts are tagged like
[lan-razer.md](lan-razer.md): hardware-verified unless stated otherwise.

Why BLE matters at all: **the LAN API cannot reach half the installed
hardware.** The H6009 bulb appears in Govee's cloud supported-model list but
has no LAN Control setting in Govee's own app, and a Govee-OUI device on the
LAN stayed silent on ports 4001/4003 under a full unicast sweep. BLE also
needs no Wi-Fi, no multicast entitlement (iOS), and no /24 sweep.

## GATT

| | |
|---|---|
| Service | `00010203-0405-0607-0809-0a0b0c0d1910` |
| Write characteristic | `00010203-0405-0607-0809-0a0b0c0d2b11` (write **without** response) |
| Notify characteristic | `00010203-0405-0607-0809-0a0b0c0d2b10` — advertised on some models, but the H6009 **rejects both read and notify in practice** |

## Frame format

20 bytes; `byte[19]` = XOR of bytes 0..18.

| Opcode | Meaning | Status |
|---|---|---|
| `0x33 0x01 <0\|1>` | power | Verified |
| `0x33 0x04 <0-100>` | brightness | Verified on physical BLE lamps |
| `0x33 0x05 0x0D <R> <G> <B>` | RGBWW colour | **Verified on H6009. The widely documented RGB-only `0x02` variant is accepted by the characteristic and visibly inert** |
| `0xAA 0x01` | keep-alive / status | Required — see below |

**The colour-opcode lesson generalizes:** on the H608B, fifteen `0x33 0x05`
sub-opcodes were swept over `ptReal` (BLE-over-LAN, below) and every one was
inert, while brightness worked first try on the same tunnel. That was a real
per-SKU rejection, not a framing error — and it was *not* evidence that Govee
rejects colour-over-BLE generally, which real BLE against the H6009 later
proved. A write channel with no error surface makes "accepted" and "worked"
different claims; sweep conclusions on one SKU do not transfer.

## The link contract — all three required, or it silently fails

1. **Keep-alive:** the link drops after **~14 s idle** (measured, H6009). Send
   `0xAA 0x01` every **5 s** after real-command quiet.
2. **Serialize writes per peripheral:** overlapping characteristic writes can
   deadlock — including a keep-alive racing a colour command.
3. **Settle delays:** connect settle **350 ms** after full service discovery;
   **1000 ms after power-on** (the controller boots and ignores traffic);
   750 ms on resume from app suspension.

## Measured operating contract

- **Throughput:** cap ~8–10 Hz per peripheral, hold only the newest desired
  frame, deadband small changes, alternate colour/brightness when both moved.
  Write-without-response has no useful flow control — do not infer a higher
  safe rate from nominal BLE connection intervals.
- **No state readback.** `devStatus` is a LAN command; the H6009's notify
  characteristic rejects reads. True capture-and-restore is unavailable over
  BLE — declare an explicit restore point *before* activation (the reference
  implementation uses warm white, `rgb(255,180,110)` at full brightness) and
  say so in the receipt rather than overclaim.
- **Connection contention:** a peripheral accepts one central at a time. A
  connected controller can lock the user out of the Govee Home app, and vice
  versa. Hold connections (setup costs seconds) but release gracefully.
- **Connection count:** macOS/iOS handle ~8–10 concurrent GATT connections,
  Android often ~7; the reference implementation caps at 6.
- **Range:** BLE does not cross the house the way Wi-Fi does. BLE is an
  *additional* transport, not a replacement.

## `ptReal` — BLE-over-LAN (UDP 4003)

The LAN API tunnels BLE frames via the `ptReal` command (the mechanism
govee2mqtt uses for scene codes). Hardware result: brightness `0x33 0x04`
worked on the H608B through the tunnel — proving frame layout and checksum —
while every colour sub-opcode was inert on that SKU, including the three
encodings documented for segmented devices (`0x0b` + masks, `0x15` + mode,
`0x0a`) against the genuinely segmented H6047. Held ~6 s each, checked by eye.
Useful as a keyless brightness path and a frame-validation oracle; not a
colour path on the tested SKUs.

## Host platform traps

- **macOS TCC SIGABRTs adhoc-signed processes.** An unsigned/adhoc-signed
  process touching CoreBluetooth is **killed, not prompted**
  (`TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION`, exit 134) — observed twice, via
  Python `bleak` and via Electron's `navigator.bluetooth.requestDevice()`. A
  `NSBluetoothAlwaysUsageDescription` string is necessary but not sufficient;
  without a real code signature there is no prompt to approve, and System
  Settings ▸ Privacy ▸ Bluetooth will never list the app. Sign the binary or
  don't touch CoreBluetooth.
- **Web Bluetooth in Electron is a dead end** on current macOS: returns no
  devices while Chrome on the same machine works
  ([electron/electron#47046](https://github.com/electron/electron/issues/47046)).
  Use a native BLE library in the main process.

## Prior art

| Project | Relevance |
|---|---|
| [`egold555/Govee-Reverse-Engineering`](https://github.com/egold555/Govee-Reverse-Engineering) | Per-model BLE opcodes, scene codes |
| [`chvolkmann/govee_btled`](https://github.com/chvolkmann/govee_btled) | Working BLE bulb control (H6001), Python |
| [`wez/govee2mqtt`](https://github.com/wez/govee2mqtt) | `ptReal` and the scene-code pipeline |

Take the protocol research, keep your own implementation — the pacing,
recovery, and release semantics above are what the generic clients do not
provide.
