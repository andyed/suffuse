# Govee over Bluetooth LE — protocol knowledge

Suffuse ships a one-shot BLE transport (`scripts/ble.mjs`, `ble scan` /
`ble set`, MCP `govee_ble_scan` / `govee_ble_set`) built on the knowledge
recorded here. The knowledge came first: it was expensive to acquire —
measured against physical hardware in the Psychodeli reference room
(2026-08-08 → 2026-08-09) — and the transport must honor every part of it.
Facts are tagged like [lan-razer.md](lan-razer.md): hardware-verified unless
stated otherwise.

The shipped transport deliberately implements the ONE-SHOT subset only:
scan → connect → write → drain → disconnect. Session semantics (keep-alive
loop, reconnect ladder, sleep/wake recovery) are documented below because a
future session mode needs them, but a process-per-command CLI cannot use them,
and a held connection locks the owner's own app out of the lamp.

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

- **macOS TCC attributes Bluetooth to the RESPONSIBLE PROCESS, and kills
  rather than prompts when that grant is missing** (exit 134, SIGABRT,
  `TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION` in the crash report). Measured
  2026-08-18 with this repo's own `ble scan`, same binary, same machine:
  - launched from **Terminal.app** (Terminal holds the Bluetooth grant):
    **works** — adhoc-signed Homebrew node is fine, because Terminal is the
    responsible process;
  - launched from inside a **Claude Code session**: **SIGABRT** — the crash
    report names `claude` as the responsible process, and it has no Bluetooth
    grant. Sandboxed or not made no difference.
  So the remediation is not "sign node"; it is *run from a host that holds
  (or can prompt for) the Bluetooth permission*. An agent driving this
  transport from an unblessed host must delegate the command to a terminal
  the user has granted (or can grant) Bluetooth. App-bundle hosts (Electron)
  still need a real signature + entitlement — earlier failures via Python
  `bleak` and Electron's `navigator.bluetooth` were this same attribution
  rule seen from hosts that could never be granted. System Settings ▸
  Privacy ▸ Bluetooth only lists apps that have successfully *requested*
  access; a killed process never appears there, so there is nothing to
  toggle.
- **Windows refuses a reconnect to a lamp that has not advertised since its
  last link closed.** Seen in psychodeli-webgl-port (2026-10-17): after a BLE
  bulb was handed straight from a running room to a direct colour, the next
  room start reused the last discovery and Windows refused the connection.
  Rescanning first fixed it. Suffuse's `bleResolve` scans fresh on every call
  and keeps no peripheral between calls; a future session mode must do the
  same after any hand-over or disconnect, rather than reconnecting to a cached
  handle.
- **Web Bluetooth in Electron is a dead end** on current macOS: returns no
  devices while Chrome on the same machine works
  ([electron/electron#47046](https://github.com/electron/electron/issues/47046)).
  Use a native BLE library in the main process.

## Prior art

| Project | Relevance |
|---|---|
| [`egold555/Govee-Reverse-Engineering`](https://github.com/egold555/Govee-Reverse-Engineering) | Per-model BLE opcodes, scene codes |
| [`chvolkmann/govee_btled`](https://github.com/chvolkmann/govee_btled) | Working BLE bulb control (H6001), Python |
| [`homebridge-govee`](https://github.com/homebridge-plugins/homebridge-govee) | Actively maintained; ships BLE control alongside cloud and LAN, inside Homebridge |
| [`wez/govee2mqtt`](https://github.com/wez/govee2mqtt) | `ptReal` and the scene-code pipeline |
| [`SaarthurR/govee-lights-app`](https://github.com/SaarthurR/govee-lights-app) | Reports that BLE on the H805D addresses 33 groups of 4 slots against 132 over LAN `razer`, with an acknowledgement per command. Reported, not reproduced here |

Take the protocol research, keep your own implementation — the pacing,
recovery, and release semantics above are what the generic clients do not
provide.
