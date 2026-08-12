<p align="center">
  <img src="assets/brand/suffuse-mark.svg" width="112" alt="Suffuse: controlled light spreading through space">
</p>

<h1 align="center">Suffuse</h1>

<p align="center"><strong>Give AI agents a safe language for spatial lighting.</strong></p>

Suffuse translates atmospheric intent such as “make the room feel like dusk”
into deterministic, capability-safe lighting operations. It provides one
portable `LightScore` format, a CLI, an Agent Skill, and a local MCP server.

The first execution provider uses Govee's documented Developer Platform.
Suffuse is an unofficial community project and is not affiliated with or
endorsed by Govee.

## Why Suffuse exists

Giving an agent direct access to physical lights creates a deceptively hard
control problem. Device capabilities vary by installed unit and firmware, an
accepted API request is not proof of visible output, and a beautiful gradient
prompt is not useful if the selected fixture can only render one solid color.

Suffuse treats lighting as a compilation and evidence problem:

1. author a small, portable lighting score;
2. inspect the exact installed device;
3. compile only against advertised capabilities;
4. preview redacted operations before writing;
5. double-gate physical changes;
6. retain an evidence and restoration receipt.

It does not turn a cloud API into a frame-rate renderer. High-rate music- or
screen-reactive lighting belongs in a dedicated local runtime.

## Psychodeli+

Suffuse grew from the device-control, palette, and restoration lessons learned
while building Room Lights for [Psychodeli+](https://psychodeli.com), a live
music visualizer that lets compatible Govee lights join the same evolving
palette as the screen.

| Platform | Current availability |
| --- | --- |
| iPhone and iPad | [Available on the App Store](https://apps.apple.com/us/app/psychodeli/id6782244331) |
| Android | Closed beta; not yet a public Google Play release |
| Web and desktop | Product information and downloads at [psychodeli.com](https://psychodeli.com) |

Suffuse is a separate developer tool, not the real-time Psychodeli+ rendering
engine. The projects share hard-won principles: capability truth, local control
where practical, bounded command rates, visible hardware evidence, and honest
restoration semantics.

## What it includes

- **LightScore** - a provider-neutral JSON format for solid looks, named scenes,
  and ordered 3-5-band palettes.
- **Perceptual palette compiler** - named palettes, exact authored bands, or
  reproducible OKLCH recipes with diagnostics.
- **Capability-safe planning** - segment domains, per-command limits, scene
  catalogs, and declared fallbacks are resolved before control.
- **Safe CLI** - inspect, compile, preview, apply, and restore.
- **Local MCP server** - typed tools for agents, read-mostly by default.
- **Managed Agent Skill** - one canonical checkout for Codex, Claude Code, and
  OpenClaw.
- **Evidence receipts** - redacted output plus best-effort restoration coverage.

## Quick start

Suffuse requires Node.js 20 or newer.

```bash
git clone https://github.com/andyed/suffuse.git
cd suffuse
npm install
npm test
```

List bundled palettes without credentials:

```bash
node scripts/govee.mjs palettes
```

Inspect and compile entirely against fixtures:

```bash
node scripts/govee.mjs inspect \
  --fixture tests/fixtures/segmented-device.json --sku H0001

node scripts/govee.mjs compile \
  --score tests/fixtures/dusk-gradient.score.json \
  --capabilities tests/fixtures/segmented-device.json
```

## Connect a Govee account

Live reads require a Govee Developer API key. Apply for the key through the
Govee Home app, store it outside the repository, and expose it only through the
process environment. Never paste a key into a score, receipt, command argument,
issue, or chat transcript.

```bash
export GOVEE_API_KEY="your-private-key"
node scripts/govee.mjs inspect --sku H608B
```

If the key lives in a private environment file, Node 20+ can load it directly:

```bash
node --env-file=/private/path/govee.env scripts/govee.mjs inspect --sku H608B
```

## Author a LightScore

```json
{
  "version": 1,
  "name": "Dusk gradient",
  "target": {
    "sku": "H608B",
    "name": "String Downlights"
  },
  "power": "on",
  "look": {
    "kind": "gradient",
    "brightness": 45,
    "palette": "dusk",
    "fallbackScene": "Sunset"
  },
  "fallback": ["scene", "solid"],
  "restore": { "mode": "capture" }
}
```

The score contains no API key or stable device identifier. Compilation fails if
the target is ambiguous or no advertised capability or declared fallback can
safely express the requested look. See
[the LightScore reference](references/light-score.md) for the complete schema.

## Preview, apply, and restore

`apply` is a read-only capability check and redacted preview unless the explicit
write gate is present:

```bash
node scripts/govee.mjs apply --score /private/path/look.score.json
```

After a direct request to change the physical lights, apply with a private
receipt path:

```bash
node scripts/govee.mjs apply \
  --score /private/path/look.score.json \
  --confirm-write \
  --receipt /private/path/look.receipt.json
```

Experimental segment writes require the additional `--confirm-segments` gate
until visible independence has been established for that unit and firmware.

Restore the queryable prior state:

```bash
node scripts/govee.mjs restore \
  --receipt /private/path/look.receipt.json \
  --confirm-write
```

Restoration can be partial: Govee may report global power, brightness, and color
without exposing the previous per-segment arrangement. Suffuse reports that gap
instead of promising bit-for-bit recovery.

## Use it as an Agent Skill

Preview managed discovery links:

```bash
node scripts/manage.mjs plan --target all --scope user
```

Install links for Codex, Claude Code, and OpenClaw:

```bash
node scripts/manage.mjs install --target all --scope user
node scripts/manage.mjs doctor
```

The repository root remains the single source of truth. See
[cross-agent distribution](references/distribution.md) for project-scoped
installation and conservative removal.

## Use the MCP server

Inspect the tool metadata without starting a live connection:

```bash
node mcp/server.mjs --describe
```

The server exposes tools for palette listing, score validation, device and scene
inspection, compilation, apply, and restore. Physical writes require both:

- `GOVEE_MCP_ALLOW_WRITES=1` on the server process; and
- `confirmWrite: true` on the individual tool call.

Segment operations additionally require `confirmSegments: true`. Keep a normal
agent connection read-only and create a separate write-enabled connection only
when physical control is intended. See [the MCP reference](references/mcp.md).

## Evidence, limitations, and non-goals

- Compile against fresh device capabilities; never promise a feature from a SKU
  or marketing page alone.
- A successful API response proves request acceptance, not visible rendering.
- The public API can activate advertised DIY scenes but does not document
  creating or uploading arbitrary DIY effects.
- Suffuse does not scrape Govee Home or reproduce private authentication.
- Suffuse is not a real-time music or screen renderer.
- The current provider is Govee. The `LightScore` contract is designed to allow
  future providers without leaking vendor resources into authored intent.

The evidence ledger currently includes a useful negative result: one H608B
advertised segmented color and accepted correctly chunked requests but did not
visibly render independent colors. Its advertised `Sunset Glow` scene did render.
See [device evidence](references/device-evidence.md) for the precise boundary.

## Development

```bash
npm ci
npm test
npm run doctor
npm run mcp:describe
npm pack --dry-run
```

Contributions should preserve capability-driven compilation, redacted output,
explicit write gates, receipts for physical changes, and the distinction between
API success and visible evidence. New providers should implement the existing
agent-facing contract rather than adding vendor concepts to `LightScore`.

The repository mark and its deliberately small identity system are documented
in [assets/brand](assets/brand/README.md).

Review [the ecosystem notes](references/ecosystem.md) before proposing another
Govee transport. Mature projects such as `govee2mqtt` are better used through an
explicit adapter than silently forked or reimplemented.

For sensitive reports, follow [SECURITY.md](SECURITY.md). Do not open a public
issue containing an API key, household device identifier, private receipt, or
network details.

## License

[MIT](LICENSE)
