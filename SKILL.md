---
name: ai-govee-lights
description: Author, inspect, compile, dry-run, apply, and restore capability-aware Govee lighting through the official Developer Platform API. Use when Codex needs to discover Govee lights and their advertised capabilities; create text-, image-, room-, or music-informed LightScores; build capability-gated 3-5-band gradients with segmentedColorRgb; select scenes, DIY scenes, snapshots, solid colors, or brightness; diagnose why an effect is unavailable; or safely control and restore Govee devices without relying on undocumented private APIs.
---

# AI Govee Lights

Treat the installed device's advertised capabilities as truth. Translate creative intent into a small `LightScore`, compile it deterministically, preview the resulting operations, and perform writes only when the user explicitly requested a device change.

This is an unofficial community skill and is not affiliated with or endorsed by Govee.

## Follow the control workflow

1. Establish whether the request is read-only, an authored preview, or a device write.
2. Inspect the exact installed device before promising segments, scenes, or restoration.
3. Read [references/light-score.md](references/light-score.md) when authoring or revising a score.
4. Compile the score against the returned capability document. Never infer capability support from a SKU or product page.
5. Show a redacted dry run unless the user already gave a direct imperative to change the lights.
6. For a write, use `--confirm-write` and save the receipt to a private path. Report fallback use and restoration coverage.
7. Restore from the receipt when requested. Explain when the API could not capture the prior segmented state exactly.

Read [references/govee-platform.md](references/govee-platform.md) for endpoints, capability forms, rate limits, and the public/private API boundary. Read [references/safety.md](references/safety.md) before changing devices, handling identifiers, or claiming restoration.

## Use the deterministic CLI

Requires Node.js 18 or newer. The CLI reads `GOVEE_API_KEY` only from the process environment and never accepts a key as a command-line argument.

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

Restore the queryable prior state:

```bash
node scripts/govee.mjs restore \
  --receipt /private/path/look.receipt.json \
  --confirm-write
```

## Author gradients honestly

For the preferred spatial result, author 3-5 ordered bands. Compile them only when the selected device advertises `devices.capabilities.segment_color_setting` / `segmentedColorRgb` and supplies an explicit segment domain. If the device also advertises `devices.capabilities.toggle` / `gradientToggle`, enable it before sending segment colors. If the capability or domain is absent, use only fallbacks declared by the score.

Do not describe a solid-color fallback as a gradient. Do not describe scene replay as arbitrary per-light control. Record the selected execution mode in the result.

## Separate authoring from real-time rendering

Use the agent to interpret text or images and author a `LightScore`. Use a dedicated local runtime for high-rate audio-reactive or screen-reactive control. The official cloud device limit is unsuitable for frame-rate streaming; this skill may configure, start, stop, or diagnose such a runtime, but must not turn cloud requests into a pseudo-render loop.

Do not scrape the Govee Home app, reproduce private authentication, or claim access to CogniGlow or AI Lighting Bot generation. Use those products only as interaction precedents unless Govee publishes a supported endpoint.

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
