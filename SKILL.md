---
name: suffuse
description: Control Govee lighting through a capability-safe MCP server and Agent Skill. Use when an agent needs to inspect devices, discover scenes, compile a read-only plan, apply or restore a LightScore with explicit write gates, diagnose unavailable effects, author optional perceptual palettes, or install one managed lighting tool for Codex, Claude Code, and OpenClaw.
---

# Suffuse

Use this Skill with the local MCP server as the two agent-facing parts of Govee lighting control. The Skill supplies the workflow and judgment; MCP supplies the typed tools and runtime gates. Inspect the installed device, translate intent into a small `LightScore`, compile it deterministically against advertised capabilities, preview the resulting operations, and perform writes only when the user explicitly requested a device change. The CLI is shared infrastructure beneath both surfaces; perceptual palette authoring is optional.

The current execution provider is Govee's documented Developer Platform. Provider-specific MCP tools retain `govee_` names until another provider is implemented. This is an unofficial community project and is not affiliated with or endorsed by Govee.

## Follow the control workflow

1. Establish whether the request is palette authoring, read-only inspection, a compiled preview, or a device write.
2. Use `govee_inspect_household` when transport inventory or cross-source identity matters, then inspect the exact installed device before promising segments, scenes, or restoration. Household snapshot references are read-only and ephemeral.
3. Read [references/color-theory.md](references/color-theory.md), [references/palettes.md](references/palettes.md), and [references/light-score.md](references/light-score.md) when authoring or revising a palette or score.
4. Compile the score against the returned capability document. Never infer capability support from a SKU or product page.
5. Show a redacted dry run unless the user already gave a direct imperative to change the lights.
6. For a write, use `--confirm-write` and save the receipt to a private path. Segment writes also require `--confirm-segments` until visible independence has been established.
7. Restore from the receipt when requested. Explain when the API could not capture the prior segmented state exactly.

Read [references/govee-platform.md](references/govee-platform.md) for endpoints, capability forms, rate limits, and the public/private API boundary. Read [references/ecosystem.md](references/ecosystem.md) when deciding whether the documented cloud API, LAN, MQTT, BLE, or an existing MCP implementation should own execution. Read [references/device-evidence.md](references/device-evidence.md) before interpreting a successful API response as visual proof. Read [references/safety.md](references/safety.md) before changing devices, handling identifiers, or claiming restoration. Read [references/lan-razer.md](references/lan-razer.md) before making any claim about the per-LED LAN channel — it is undocumented by Govee, and that page is the provenance chain for every claim Suffuse relies on.
Read [references/device-registry.md](references/device-registry.md) before using household observations for transport selection, persistence, or group design.

## Use the deterministic CLI

Requires Node.js 20 or newer. `GOVEE_API_KEY` unlocks discovery of the account's supported devices, their fresh capabilities and queryable state, their native and DIY scenes, and authenticated control requests. The key does not authorize a Suffuse write by itself. The CLI reads it only from the process environment and never accepts it as a command-line argument.

List bundled custom palettes without credentials:

```bash
node scripts/govee.mjs palettes
```

Inspect live capabilities without changing a device:

```bash
node scripts/govee.mjs inspect --sku H608B
```

Inspect a fixture while credentials are unavailable:

```bash
node scripts/govee.mjs inspect \
  --fixture tests/fixtures/segmented-device.json --sku H0001
```

Compile a score against captured or fixture capabilities:

```bash
node scripts/govee.mjs compile \
  --score tests/fixtures/dusk-gradient.score.json \
  --capabilities tests/fixtures/segmented-device.json
```

Preview against live capabilities. This remains read-only because `--confirm-write` is absent:

```bash
node scripts/govee.mjs apply --score /private/path/look.score.json
```

For scene looks, live apply resolves `lightScene` and `diyScene` names through Govee's dedicated scene catalogs before compiling. Do not substitute an invented identifier when a name is absent.

Apply after an explicit user request and retain an evidence/restore receipt:

```bash
node scripts/govee.mjs apply \
  --score /private/path/look.score.json \
  --confirm-write \
  --receipt /private/path/look.receipt.json
```

For an experimental segmented write, add `--confirm-segments` only after explaining that advertised support is not visible proof.

Restore the queryable prior state:

```bash
node scripts/govee.mjs restore \
  --receipt /private/path/look.receipt.json \
  --confirm-write
```

## Author gradients honestly

For the preferred spatial result, author 3-5 ordered bands directly, name a validated palette catalog entry, or compile a constrained OKLCH recipe. Recipes make interpolation, hue travel, and diagnostics reproducible; explicit hex bands remain first-class and are never silently regenerated. Compile either form only when the selected device advertises `devices.capabilities.segment_color_setting` / `segmentedColorRgb` and supplies an explicit segment domain. If the device also advertises `devices.capabilities.toggle` / `gradientToggle`, enable it before sending segment colors. If the capability or domain is absent, use only fallbacks declared by the score.

Treat API acceptance and visible rendering as separate evidence. A `200` response proves only that Govee accepted the request. It does not prove that individual pucks or bulbs rendered distinct colors. Record the firmware context and visible result before calling a device segment-verified.

Do not describe a solid-color fallback as a gradient. Do not describe scene replay as arbitrary per-light control. The public API can trigger advertised DIY scenes but does not document creation or upload of new DIY effects. Record the selected execution mode in the result.

## Use the managed package

The repository root is the single source of truth. `scripts/manage.mjs` previews, installs, audits, and conservatively removes local discovery links for Codex, Claude Code, and OpenClaw. Read [references/distribution.md](references/distribution.md) before installing or packaging it.

Use `mcp/server.mjs` when the agent should call typed tools instead of shell commands. It is read-mostly by default, inherits credentials from the environment, and double-gates physical writes. Read [references/mcp.md](references/mcp.md) before connecting it to an agent.

## Separate authoring from real-time rendering

Use the agent to interpret text or images and author a `LightScore`. Use a dedicated local runtime for high-rate audio-reactive or screen-reactive control. The official cloud device limit is unsuitable for frame-rate streaming; this skill may configure, start, stop, or diagnose such a runtime, but must not turn cloud requests into a pseudo-render loop.

Do not scrape the Govee Home app, reproduce private authentication, or claim access to CogniGlow or AI Lighting Bot generation. Use those products only as interaction precedents unless Govee publishes a supported endpoint.

## Paint per-LED over the LAN

The `lan` commands reach devices on the local network without an API key, including per-LED painting on fixtures with a verified pixel profile. The workflow above still applies; these rules are additional, and each encodes a hardware-measured lesson:

1. Scan first (`lan scan`) — it is read-only and reports which discovered fixtures support per-LED and whether their pixel count is hardware-verified. Multicast discovery is intermittent per device, so never conclude "no LAN support" from a short or partial scan.
2. Author per-LED intent as an ordinary gradient LightScore. Bands compile to pixels in authored order; there is no arbitrary per-pixel array on purpose, because fixtures with fewer zones interpolate between stops the long way round the hue wheel, and band order is what keeps adjacent pixels adjacent in hue.
3. Never claim a per-LED write rendered. The channel is mute — no acknowledgment, no queryable segment state. Results carry `verified: false`; only eyes (or the user) can confirm, and the skill must say so.
4. Make duration explicit. A per-LED look reverts to the device's own effects roughly a minute after data stops. Use `--hold-seconds` for a bounded hold (default 900, max 14400) and tell the user when the look will end; use `lan release` to end it early.
5. Never mix writers. While a hold is active, whole-device color writes to that fixture are refused — a whole-device command repaints every pixel and flattens the per-LED look. Release before switching modes.
6. Restoration is whole-device only. `devStatus` is captured before the write and replayed by `restore`; a prior per-LED look is not queryable on any channel, and the receipt must say that rather than overclaim.
7. If the reply port (UDP 4002) is held by another local controller, scanning and state capture fail loudly. Do not work around it with port sharing — two listeners silently steal each other's replies. Tell the user which process to quit, or pin the device with `--ip`.
8. For an unfamiliar SKU, consult the mined portfolio first (`node scripts/portfolio.mjs <SKU>`) — 371 SKUs of community priors with per-fact provenance. Read it under one rule: a mined positive is trustworthy, a mined negative is only "unknown" — vendor flags describe app support, not what the firmware accepts. Never tell the user their device "doesn't support" per-LED on the strength of a mined flag or absence from the portfolio.

## Reach BLE-only hardware over Bluetooth

The `ble` commands reach lamps the LAN structurally cannot (the H6009 class: cloud-listed, no LAN Control) — keyless and without Wi-Fi. The workflow above still applies; these rules are additional:

1. Scan first (`ble scan`) — read-only. A lamp held by another central (the user's Govee Home app, another controller) stops advertising and will not appear; absence is not absence. Say that instead of concluding the lamp is gone.
2. One-shot only. Connect, write, drain, disconnect — never hold a BLE session open: a connected central locks the user out of their own app. If the user wants a persistent look, BLE is the wrong wire; say so.
3. There is no readback. Prior colour and brightness cannot be captured, so the receipt records a declared warm-white restore point and `restore` returns the lamp there — to a stated neutral, not to its previous look. Tell the user this before writing.
4. Writes are unacknowledged (`verified: false`). Report what was sent; only eyes confirm.
5. The colour opcode is per-device-class (verified on the RGBWW H6009; the widely documented RGB-only encoding is accepted and inert there). A lamp that powers and dims but ignores colour is the signature of a wrong opcode — file a compatibility report rather than retrying harder.
6. The dependency is optional. If `@stoprocent/noble` is missing or the host lacks Bluetooth permission (macOS kills unsigned processes touching CoreBluetooth without a prompt — the responsible process, usually the terminal app, must hold the permission), relay the structured remediation from the error; every other Suffuse surface still works.

## Handle unavailable credentials

If `GOVEE_API_KEY` is absent, continue with score authoring, fixtures, compilation tests, and documentation. State that live device capability verification and writes remain pending. Never ask the user to paste a key into chat.

## Return an evidence receipt

Report:

- selected SKU and redacted device identity;
- advertised capability used;
- requested and executed mode;
- fallbacks and warnings;
- number and outcome of control operations;
- receipt path, when written;
- restoration coverage and any state that could not be captured.
