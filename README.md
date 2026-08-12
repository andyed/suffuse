<p align="center">
  <img src="assets/brand/suffuse-mark.svg" width="112" alt="Suffuse: controlled light spreading through space">
</p>

<h1 align="center">Suffuse</h1>

<p align="center"><strong>An MCP server and Agent Skill for safe Govee control.</strong></p>

Suffuse gives AI agents two complementary control surfaces for Govee lights: a
local MCP server with typed tools, and an Agent Skill that supplies the workflow
for using those tools safely. Together they cover inspection, planning, control,
evidence, and restoration.

Both surfaces keep credentials out of tool arguments, begin with read-only
inspection, and require explicit confirmation before an agent can change a
physical device. A deterministic CLI and the portable `LightScore` format are
their shared infrastructure. Perceptual palettes and color-theory helpers are
optional authoring tools, not the core product.

Suffuse uses Govee's documented Developer Platform. It is an unofficial
community project and is not affiliated with or endorsed by Govee.

## MCP + Agent Skill

| Surface | Role |
| --- | --- |
| MCP server | Exposes seven typed tools over local stdio and enforces the runtime write gates |
| Agent Skill | Teaches Codex, Claude Code, and OpenClaw when to inspect, compile, confirm, apply, restore, and report incomplete evidence |

### What the Govee API key unlocks

A Govee Developer API key turns Suffuse from an offline authoring and test
package into a live, account-aware lighting interface. It lets the local MCP
server ask Govee which supported devices belong to the account, what each
installed device can do, its current queryable state, and which scenes it can
run.

| Without a key | With a key |
| --- | --- |
| Validate `LightScore` documents | Discover the account's supported Govee devices |
| List bundled optional palettes | Inspect capabilities reported by the installed unit and firmware |
| Compile and test against fixtures | Read current queryable state and native or DIY scene catalogs |
| Inspect MCP metadata and install the Agent Skill | Compile against live hardware, then apply or restore when separately authorized |

The key authenticates Govee cloud access; it does **not** enable physical writes
by itself. Suffuse still requires its server-level write switch, confirmation on
the individual tool call, and a private restoration receipt.

Apply in Govee Home under **Settings → Apply for API Key**, then submit the
requested information. Generating a replacement key invalidates older active
keys for the same account, so update every service that uses the old key.

### MCP tools

| Tool | What it does | Default |
| --- | --- | --- |
| `govee_inspect_devices` | Reads installed devices and advertised capabilities, with household identifiers redacted | Read-only |
| `govee_list_scenes` | Reads native or DIY scene names for one exact device | Read-only |
| `govee_validate_score` | Validates lighting intent locally | Read-only |
| `govee_compile_score` | Discovers the selected device and returns a redacted execution plan | Read-only |
| `govee_apply_score` | Applies a compiled look and writes a private restore receipt | Write-gated |
| `govee_restore` | Restores the queryable prior state from a receipt | Write-gated |
| `govee_list_palettes` | Lists the optional bundled palettes without contacting Govee | Read-only |

Inspect the MCP metadata without starting a connection:

```bash
node mcp/server.mjs --describe
```

Run the local stdio server:

```bash
GOVEE_API_KEY="your-private-key" node mcp/server.mjs
```

Configure an MCP client to run `node` with the absolute path to
`mcp/server.mjs`, forwarding `GOVEE_API_KEY` from the client process environment.
Do not put the key in checked-in MCP configuration. See
[the MCP reference](references/mcp.md) for connection and deployment boundaries.

### Install the Agent Skill

Preview the managed discovery links:

```bash
node scripts/manage.mjs plan --target all --scope user
```

Install links while keeping this checkout as the single source of truth:

```bash
node scripts/manage.mjs install --target all --scope user
node scripts/manage.mjs doctor
```

See [cross-agent distribution](references/distribution.md) for project-scoped
installation and conservative removal.

## Safety model

The normal MCP connection cannot change a light. Physical writes require both:

- `GOVEE_MCP_ALLOW_WRITES=1` in the server process; and
- `confirmWrite: true` on the individual tool call.

Every write also requires an absolute private receipt path. Experimental segment
operations require a third acknowledgement, `confirmSegments: true`, until that
exact unit and firmware have visibly demonstrated independent segment control.

This separates five facts that device-control tools often blur together:

1. the intent an agent authored;
2. the capabilities an installed device advertised;
3. the operations Suffuse compiled;
4. the requests Govee accepted; and
5. what the hardware visibly rendered.

An accepted API request is not treated as proof of visible output. Restoration
is reported as partial when Govee exposes global state but not the previous
per-segment arrangement.

## Quick start

Suffuse requires Node.js 20 or newer.

```bash
git clone https://github.com/andyed/suffuse.git
cd suffuse
npm install
npm test
node mcp/server.mjs --describe
```

Store the Govee Developer API key outside the repository and expose it only
through the process environment. Never paste it into a score, receipt, command
argument, issue, or chat transcript.

Node 20+ can load a private environment file directly:

```bash
node --env-file=/private/path/govee.env mcp/server.mjs
```

## LightScore and CLI

MCP tools exchange a provider-neutral `LightScore` rather than raw Govee
commands. A score targets a device by SKU or name and describes power, brightness,
color, a named scene, or an ordered gradient plus declared fallbacks.

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
safely express the request. See
[the LightScore reference](references/light-score.md) for the schema.

The CLI is useful for diagnostics, fixtures, and direct inspection of the layer
underneath MCP:

```bash
node scripts/govee.mjs inspect --sku H608B

node scripts/govee.mjs compile \
  --score tests/fixtures/dusk-gradient.score.json \
  --capabilities tests/fixtures/segmented-device.json

node scripts/govee.mjs apply --score /private/path/look.score.json
```

The last command remains a redacted preview because `--confirm-write` is absent.
After a direct request to change the lights:

```bash
node scripts/govee.mjs apply \
  --score /private/path/look.score.json \
  --confirm-write \
  --receipt /private/path/look.receipt.json

node scripts/govee.mjs restore \
  --receipt /private/path/look.receipt.json \
  --confirm-write
```

## Optional palette authoring

Suffuse can resolve named palettes, preserve exact authored 3-5-band colors, or
compile constrained OKLCH recipes with gamut and adjacency diagnostics. These
helpers make an agent's color choices reproducible; they are not required for
device inspection, scene control, solid colors, apply, or restore.

```bash
node scripts/govee.mjs palettes
```

See [palette authoring](references/palettes.md) and
[color theory](references/color-theory.md) when a task actually needs custom
color work.

## Psychodeli+

Suffuse grew out of Room Lights for [Psychodeli+](https://psychodeli.com), a
live music visualizer that lets compatible Govee lights join the screen's
evolving palette.

| Platform | Current availability |
| --- | --- |
| iPhone and iPad | [Available on the App Store](https://apps.apple.com/us/app/psychodeli/id6782244331) |
| Android | Closed test: join the [psychodeli-testers Google Group](https://groups.google.com/g/psychodeli-testers), then [opt in through Google Play](https://play.google.com/apps/testing/com.psychodeli.android) |
| Desktop apps | Closed beta |
| Web | Product information at [psychodeli.com](https://psychodeli.com) |

Suffuse is a separate developer tool, not the real-time Psychodeli+ rendering
engine. High-rate music- or screen-reactive lighting belongs in a dedicated
local runtime, not a cloud API request loop.

## Evidence and boundaries

- Compile against fresh device capabilities; never promise a feature from a SKU
  or marketing page alone.
- The public API can activate advertised DIY scenes but does not document
  creating or uploading arbitrary DIY effects.
- Suffuse does not scrape Govee Home or reproduce private authentication.
- The current provider is Govee. `LightScore` keeps vendor resources out of
  authored intent so another provider can implement the same MCP contract.

One recorded H608B result is negative: the device advertised segmented color
and accepted correctly chunked requests but did not visibly render independent
colors. Its advertised `Sunset Glow` scene did render. See
[device evidence](references/device-evidence.md) for the precise boundary.

## Development

```bash
npm ci
npm test
npm run doctor
npm run mcp:describe
npm pack --dry-run
```

Contributions must preserve typed MCP contracts, capability-driven compilation,
redacted output, explicit write gates, receipts for physical changes, and the
distinction between API acceptance and visible evidence.

Before adding another Govee transport, check
[the ecosystem notes](references/ecosystem.md). Prefer an explicit adapter to
silently forking or reimplementing mature work such as `govee2mqtt`.

The repository identity is documented in [assets/brand](assets/brand/README.md).
For sensitive reports, follow [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
