# Govee control ecosystem

Suffuse is an agent-facing intent compiler and safety layer, not a claim that no lighting-control software already exists. Reuse mature transports and operational patterns where they fit, while keeping the vendor-neutral `LightScore`, perceptual palette compiler, evidence receipt, and explicit write gates as the stable contract presented to agents.

These are implementation references, not runtime dependencies or endorsements.

## Primary references

| Project | Control path | What to learn or reuse | Boundary for this skill |
| --- | --- | --- | --- |
| [wez/govee2mqtt](https://github.com/wez/govee2mqtt) | LAN, Govee Platform API, undocumented AWS IoT, MQTT/Home Assistant | Mature device compatibility; capability-driven control; scene, DIY, music-mode, and segment handling; device-specific segment caveats | Best candidate for a future opt-in execution backend. It is not an MCP server or palette-authoring contract. Do not silently adopt its undocumented-cloud path or require Home Assistant. MIT. |
| [danjam/mcp-govee](https://github.com/danjam/mcp-govee) | MCP over Govee API v1/v2 or direct LAN UDP | A compact real-LAN implementation and correct resolution of v2 scene and DIY-scene catalogs before activation | Useful direct MCP precedent, but it does not provide custom palette compilation, segmented gradients, evidence receipts, restoration, or this skill's write gates. MIT. |
| [evefromwayback/govee-mcp](https://github.com/evefromwayback/govee-mcp) | MCP and CLI over merged Govee cloud plus LAN discovery | Friendly-name groups, one cloud/LAN device registry, explicit cached-versus-live commands, a setup doctor, partial cloud-error reporting, and a fake UDP device integration test | Useful household-ergonomics precedent, not a control authority for Suffuse. Its LAN send path reports `ok` without acknowledgment, automatic identity matching is permissive, runtime LAN failure does not retry through cloud, and its published rate guard no longer matches Govee's endpoint-specific limits. MIT. |
| [joeynyc/Govee-MCP](https://github.com/joeynyc/Govee-MCP) | MCP over Govee OpenAPI v2 | Device allowlists, dry-run configuration, rate limiting, retries, structured logging, and batch operations | Useful operational reference. Its LAN adapter is currently a placeholder, and its surface does not provide segment/palette compilation, receipts, or restoration. MIT. |
| [wez/govee-lan-hass](https://github.com/wez/govee-lan-hass) | Govee LAN API for Home Assistant | Historical LAN discovery/control behavior and fixed-port constraints | The project recommends `govee2mqtt` for new installations. Treat this as LAN precedent, not the preferred integration. MIT. |
| [SaarthurR/govee-lights-app](https://github.com/SaarthurR/govee-lights-app) | Browser app over direct LAN UDP, per-LED `razer` stream; read-only Govee Platform calls for names and scenes | H805D bench notes (132 slots, short-frame stretch, enable re-send blackout, power-cut exit from per-LED mode); a server that rejects every cloud endpoint except three reads; an LLM chat constrained to a checked list of app actions | A render loop with no write gate, receipt, or restoration, and it auto-updates from `main` by default. Its H805D notes are recorded in [lan-razer.md](lan-razer.md) as reported, not reproduced. Run against this project's lamps on 2026-11-11 it drove five more SKUs per-LED once given their counts; a `models.json` of counts drawn from this portfolio, with a switch for owners to try unconfirmed ones, is proposed there in [PR #1](https://github.com/SaarthurR/govee-lights-app/pull/1). MIT. |
| [RishaanJ/govee-mcp](https://github.com/RishaanJ/govee-mcp) | macOS Bluetooth Low Energy daemon plus MCP | A precedent for isolating macOS Bluetooth permission handling from the MCP process | Device-specific rather than a general Govee backend. Use only if a supported device requires local BLE. MIT. |

## Architectural decision

Keep one agent-facing MCP and CLI contract in this repository. The contract owns:

- palette and `LightScore` authoring;
- deterministic capability-gated compilation;
- dry-run and write confirmation policy;
- redacted evidence receipts and best-effort restore;
- truthful reporting of fallback and visible device evidence.

Treat device transports as providers behind that contract. The current provider is the documented Govee Developer Platform. A future Hue provider should compile the same authored intent into Hue-native gradients, grouped lights, or scenes rather than leaking Hue resources into `LightScore`.

### Build on `govee2mqtt` through an adapter; do not fork it

`govee2mqtt` is good enough to build on as an executable backend. Its service already exposes JSON light commands on `gv2mqtt/light/<device>/command` and per-segment commands on `gv2mqtt/light/<device>/command/<segment>`, and it selects LAN, Platform API, or its optional IoT path internally. A provider here can translate compiled operations to those MQTT topics while preserving the existing agent tools and score files.

Consume a released or commit-pinned upstream build. This keeps device compatibility fixes flowing from its active project and avoids making a small agent skill responsible for a substantial Rust/Home Assistant bridge. Pin and contract-test the MQTT messages because those topics are an implementation interface rather than a separately versioned public SDK. If the adapter needs a missing interface, propose that narrow addition upstream and retain the direct Developer Platform provider as the fallback.

Make the provider explicit and opt-in. Document broker authentication, the selected `govee2mqtt` version, availability behavior, transport selection, and restoration semantics before enabling writes. Do not require Home Assistant when a broker and bridge are sufficient, and do not silently enable the undocumented IoT login path.

### Do not rebase this skill on an existing MCP server

The current MCP projects are useful references but do not save enough core work to justify replacing this repository. The strongest operational MCP foundation is cloud-first and has only placeholder LAN support. The strongest LAN-capable MCP implementation is compact and tested, but uses a hand-rolled protocol surface and lacks segmented palettes, evidence receipts, restoration, and double write confirmation. Retain the official MCP SDK surface here and borrow focused ideas or adapters under their licenses.

Adopt small operational improvements independently when they strengthen the current provider: a device allowlist, process-level dry-run mode, bounded retries, structured redacted logs, and per-device rate limiting. Do not import another project's control model wholesale or weaken the existing double confirmation for physical writes.

### Candidate route: HyperHDR's raw UDP input

[HyperHDR](https://github.com/awawa-dev/HyperHDR) (core MIT) is an ambient
lighting server whose output drivers reach hardware Suffuse does not: its
v22.0.0.0 driver registry includes Hue, WLED, Nanoleaf, LIFX, WiZ,
Art-Net/E1.31 and USB/DIY LED controllers. It has no OpenRGB or MSI Mystic
Light output. A driver entry makes a fixture a candidate, not a verified
target. The input contract below is protocol fact from a review of the
released v22.0.0.0 raw UDP receiver (`sources/base/RawUdpServer.cpp`), by
psychodeli-webgl-port, 2026-10:

- One datagram is one complete LED array: packed `R,G,B` bytes, with no
  header and no sequence number.
- A nonempty multiple of three bytes, at most **1500 bytes (500 LEDs)** per
  datagram. **Never split a larger array** across datagrams: each one is taken
  as a new complete frame.
- Default port **5568** and default input priority **109**, both configurable
  per instance. Port 5568 is the usual sACN port, but this input is raw RGB,
  not an E1.31 parser.
- After **3000 ms** without a frame the input goes inactive. That releases its
  priority; it does not restore any lamp's earlier state.
- No acknowledgement. A sent datagram proves neither delivery nor that
  HyperHDR is running, so evidence for it is `sent-unacknowledged`, and output
  health must be checked separately.
- The receiver binds every interface and has no authentication or source
  ownership. Point it only at a configured local or trusted-LAN endpoint.

As a Suffuse provider this would compile bands to one RGB array per frame,
pace and stream it like a held look (a frame at least every 3 s), and treat
"restore" as releasing the input priority, since nothing here can capture or
replay prior state. It is a candidate, not a planned dependency. HyperHDR
also offers a JSON API and a FlatBuffers image input; raw RGB is the smallest
contract that matches a lighting frame.

## Segment evidence

`govee2mqtt` corroborates an important constraint: segment support and behavior vary by installed device, and some devices couple segment brightness or ignore particular values. Continue to gate authored gradients on the live `segmentedColorRgb` capability and explicit segment domain. Treat a successful transport response as request acceptance, not proof that individual bulbs or pucks rendered independently.
