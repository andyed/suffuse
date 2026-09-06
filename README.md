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
| MCP server | Exposes fourteen typed tools over local stdio and enforces the runtime write gates |
| Agent Skill | Teaches Codex, Claude Code, and Hermes when to inspect, compile, confirm, apply, restore, and report incomplete evidence |

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
| `govee_inspect_household` | Merges current cloud and LAN observations into one provenance-aware inventory, with identifiers redacted | Read-only |
| `govee_list_scenes` | Reads native or DIY scene names for one exact device | Read-only |
| `govee_validate_score` | Validates lighting intent locally | Read-only |
| `govee_compile_score` | Discovers the selected device and returns a redacted execution plan | Read-only |
| `govee_apply_score` | Applies a compiled look and writes a private restore receipt | Write-gated |
| `govee_inspect_receipt` | Classifies protocol, query, visual, restoration, and uncertainty evidence without returning household identifiers | Read-only |
| `govee_restore` | Restores the queryable prior state from a receipt | Write-gated |
| `govee_list_palettes` | Lists the optional bundled palettes without contacting Govee | Read-only |
| `govee_lan_scan` | Discovers Govee devices on the local network, keyless, and reports per-LED support | Read-only |
| `govee_lan_paint` | Paints a gradient or solid LightScore over the LAN, per-LED on verified fixtures | Write-gated |
| `govee_lan_release` | Ends a per-LED hold early, returning the device to its own effects | Write-gated |
| `govee_ble_scan` | Discovers Govee peripherals over Bluetooth LE — keyless and Wi-Fi-free | Read-only |
| `govee_ble_set` | One-shot power/colour/brightness over BLE with a declared restore point | Write-gated |

Inspect the MCP metadata without starting a connection:

```bash
node mcp/server.mjs --describe
```

Diagnose cloud configuration, LAN discovery, and exact device-identity merging
without changing a light:

```bash
node scripts/govee.mjs doctor
node scripts/govee.mjs household
```

`household` is a live read-only snapshot, not a durable routing table. Cloud
account membership does not prove current reachability; a LAN scan response
records only that the device answered at the stated observation time. Automatic
merging requires an exact normalized device id. Command routing remains outside
this first registry slice. See [the household device registry](references/device-registry.md)
for the identity, freshness, privacy, and future routing contract.

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

Each private receipt also carries a transport-neutral evidence transaction. Its
typed events keep requested state, selected transport, pre-write query results,
protocol acceptance or lack of acknowledgment, visual observation, restoration
attempts, and residual uncertainty separate. Inspect that classification without
changing a device:

```bash
node scripts/govee.mjs evidence --receipt /private/path/look.receipt.json
```

The resulting summary deliberately says, for example, “Command accepted but
appearance unverified.” Restoration writes its started/completed/failed attempt
back into the receipt before and after touching the device. Existing v0.6.0
receipts remain restorable and receive an explicitly inferred evidence boundary
when inspected or restored. See [evidence transactions](references/evidence-transactions.md)
for the contract.

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

## LAN control — keyless, per-LED, bounded

Suffuse 0.5 adds a local-network transport beside the cloud path: the documented
LAN API (`scan`, `devStatus`, `colorwc`) plus the undocumented per-LED `razer`
channel that Razer Synapse, Govee Desktop, SignalRGB and LedFx use. The same
contract applies — LightScore in, write gates on, private receipt out — with a
different wire underneath. The LAN API's measured failure modes — `colorwc`
queues unboundedly past ~10 Hz, `devStatus` returns stale replies while
sending, multicast discovery is intermittent *per device* — are documented
with methods in [references/lan.md](references/lan.md).

```bash
node scripts/govee.mjs lan scan
node scripts/govee.mjs lan paint --score dusk.score.json --confirm-write \
  --confirm-segments --receipt /private/receipts/dusk.json --hold-seconds 1800
node scripts/govee.mjs lan release --ip 192.168.1.34 --confirm-write
```

What makes this path different, and how Suffuse holds the line on each:

- **It is keyless.** No API key protects the user's lights on the LAN, so every
  write sits behind the same `--confirm-write` gate as the cloud path, and
  per-LED writes additionally require `--confirm-segments`.
- **The per-LED channel is mute.** No acknowledgment, no queryable segment
  state, no error surface — a malformed frame and a perfect one look identical
  from the socket. Suffuse therefore validates everything before the wire
  (encoder self-checks against independently published constants at every load;
  the length field is 16-bit big-endian, which every prose description of this
  protocol gets wrong), and reports `verified: false` on every per-LED result:
  it claims what was sent, never that the device obeyed.
- **The pixel count must match the fixture exactly.** A wrong count is silently
  ignored and reads as an unsupported device, so only hardware-verified SKU
  profiles compile to per-LED (H608B: 15 pixels, chase-verified). Unknown SKUs
  refuse rather than guess.
- **Gradient bands are the only per-LED authoring surface — deliberately.**
  Bands compile to pixels in authored order, so adjacent pixels stay adjacent
  in hue by construction. Fixtures with fewer zones than pixels interpolate
  between supplied stops the long way round the hue wheel; an arbitrary-array
  API would let an agent trip that without knowing. The schema makes it
  inexpressible.
- **Looks are bounded in time.** The hardware reverts to its own effects ~60s
  after per-LED data stops (a dead-man, not a bug). `--hold-seconds` makes the
  duration explicit: a detached keepalive maintains the look, then the device
  hands itself back — default 15 minutes, hard cap 4 hours. An abandoned agent
  session cannot hold a room indefinitely.
- **Writers contend.** A whole-device color command repaints every pixel and
  flattens a live per-LED look (measured; last writer wins). While a hold is
  active, Suffuse refuses whole-device writes to that device with a structured
  error instead of letting the two silently fight.
- **Restore still works, keyless.** `devStatus` answers over LAN, so pre-write
  whole-device state is captured into the receipt before painting, and
  `restore` replays it. Prior *per-LED* looks are not queryable on any channel;
  the receipt says so rather than overclaiming.

This resolves the negative recorded below for the H608B: the cloud
`segmentedColorRgb` path never rendered on it, but the same fixture paints 15
independent pixels over LAN. The advertised capability and the reachable one
are different surfaces.

The `razer` channel is **not documented by Govee or Razer** — it is a
reverse-engineered protocol with no stability promise, and Suffuse's claims
about it are tagged by evidence class in
[references/lan-razer.md](references/lan-razer.md): what was verified on
hardware, what is corroborated by independent implementations (OpenRGB, LedFx),
and what remains a working guess.

For SKUs Suffuse has never touched, `node scripts/portfolio.mjs <SKU>` queries
a mined portfolio of 371 SKUs — community priors harvested from four
open-source integrations with per-fact provenance, anchored against this
project's hardware measurements. One rule governs it: a mined positive is
trustworthy, a mined negative is only "unknown" (the H612B renders 10 discrete
pixels despite Govee's own database saying `supportRazer: 0`). See
[references/device-portfolio.md](references/device-portfolio.md).

## What Suffuse reaches — and what it does not

| Wire | Status | What it gives you |
| --- | --- | --- |
| Cloud Platform API | Supported, needs a [Govee Developer key](https://developer.govee.com/) | Device/scene inspection, capability-aware compile, apply, restore — one-shot and rate-limited |
| LAN (`colorwc` + `razer`) | Supported, **keyless** | Whole-device color and per-LED painting on profiled fixtures; 260 of the 371 portfolio SKUs advertise LAN support |
| Bluetooth LE | Supported, **keyless**, one-shot | Power, colour, brightness on BLE-reachable lamps — the only local path to the H6009 class; needs the optional `@stoprocent/noble` dependency |

**Where the effort goes.** Suffuse's centre of gravity is the keyless LAN
path — per-LED `razer` painting against hardware-verified profiles — and the
perceptual colour pipeline that decides what those pixels show: OKLCH recipes,
conserved lightness, capability-aware compilation. That combination is what
the authors run daily against a real room, and it is where this project is
genuinely ahead. The cloud path works and is gated identically, but it is the
least-exercised surface here; if something drifts, it will drift there first
([#3](https://github.com/andyed/suffuse/issues/3) tracks verifying it
end-to-end against live devices — reports welcome).

## BLE control — keyless, Wi-Fi-free, one-shot

Some SKUs are BLE-only (six are flagged that way in the mined portfolio), and
a larger class — the H6009 bulb is the reference example — is cloud-listed but
has no LAN Control at all. BLE is the only keyless path to that hardware, and
it needs no Wi-Fi, no multicast, no /24 sweep. The transport implements the
hardware-measured contract in [references/ble.md](references/ble.md): full
service discovery with a connect settle, the RGBWW `0x0D` colour opcode (the
widely documented `0x02` is accepted and visibly inert), a one-second settle
after power-on (the lamp's controller boots and silently drops whatever
arrives meanwhile), and a write drain before disconnect (tearing the link down
immediately destroys the queued packet — measured).

```bash
node scripts/govee.mjs ble scan
node scripts/govee.mjs ble set --name H6009 --color '#ffb46e' --brightness 35 \
  --confirm-write --receipt /private/receipts/lamp.json
```

The boundaries, each a hardware fact rather than a policy choice:

- **One-shot only, on purpose.** A BLE lamp accepts one central at a time; a
  held connection locks the owner's own Govee Home app out, and a connected
  peripheral stops advertising. Suffuse borrows the lamp for the seconds a
  write takes and hands it back. There are no BLE holds.
- **No state readback exists.** The notify characteristic rejects reads on
  real hardware, so prior state cannot be captured. The receipt records a
  *declared* restore point (warm white) and says so honestly; `restore`
  returns the lamp to that declared neutral, not to its previous look.
- **Writes are unacknowledged.** Results report what was sent
  (`verified: false`), never that the lamp obeyed — same honesty rule as the
  per-LED LAN channel.
- **The dependency is optional.** `@stoprocent/noble` is a native module; if
  it is absent or cannot build, every other Suffuse surface keeps working and
  the `ble` commands fail with a structured remediation. On macOS, Bluetooth
  permission belongs to the *responsible process* (usually your terminal app)
  — an unsigned process touching CoreBluetooth is killed without a prompt, not
  asked. Dry-runs never touch the radio.
- **Opcode claims are per-SKU.** The colour opcode is verified on the H6009
  (RGBWW). Other SKUs are driven with the same frame on a stated assumption;
  a lamp that powers and dims but ignores colour is the signature of a wrong
  per-class opcode — file a compatibility report.

Prior art, for BLE control embedded in a larger system or per-model opcode
research: [homebridge-govee](https://github.com/homebridge-plugins/homebridge-govee),
[chvolkmann/govee_btled](https://github.com/chvolkmann/govee_btled),
[egold555/Govee-Reverse-Engineering](https://github.com/egold555/Govee-Reverse-Engineering),
and [wez/govee2mqtt](https://github.com/wez/govee2mqtt)'s `ptReal`
BLE-over-LAN tunnel.

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

## Genealogy

Two lineages meet here, and crediting both keeps the project honest about what
it invented — which is neither the protocol nor the colour science, but the
contract around them.

**The per-LED channel** originated as a proprietary integration: Govee firmware
implementing a private protocol for Razer Synapse's Chroma ecosystem, later
used by Govee's own Desktop app. Adam Honse reverse-engineered it for
[OpenRGB](https://gitlab.com/CalcProgrammer1/OpenRGB/-/merge_requests/2172)
(GPL-2.0-or-later, December 2023) — the write-up where the byte layout first
became public. [LedFx](https://github.com/LedFx/LedFx) (GPL-3.0) implemented it
independently for audio-reactive rendering; SignalRGB's community `Govee.js`
addons spread it through the ambient-lighting scene; and
[LumiSync](https://github.com/Minlor/LumiSync) (MIT) published its own research
and a permissively licensed implementation. Suffuse's implementation was
re-derived from the byte layout as protocol fact, hardware-verified, and adds
what none of the roughly three dozen public implementations carry: typed tools,
write gates, receipts, bounded holds, and evidence-classed claims. The full
chain, with each claim tagged by its source, is
[references/lan-razer.md](references/lan-razer.md).

**The control discipline** comes from [Psychodeli+](https://psychodeli.com)'s
Room Lights: a year of driving real fixtures over cloud, LAN, and BLE is where
the hard lessons were measured — commands that queue rather than drop, devices
that fail silently when a pixel count is wrong, writers that flatten each
other's work, restores that cannot be captured on a mute channel. Suffuse is
those lessons extracted, given a schema, and pointed at agents.

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

**Resolved for the LAN path (2026-08-15):** the same fixture renders 15
independent pixels over the local `razer` channel — verified by a discrete
chase, every pixel individually lit. The cloud negative stands; the capability
was real and the advertised route to it was not.

Because the per-LED channel is mute, "verified" is a claim only a camera or an
eye can make — so Suffuse ships the instrument: [verify/](verify/README.md) is
a camera-in-the-loop harness that drives known patterns (sync clapper,
per-fixture calibration, split, discrete chase, latency step) and scores a
phone recording into PASS/WEAK/FAIL. It is how a contributor promotes a
`RAZER_PROFILES` entry to `verified: true` on hardware the authors have never
seen, and its analyzer self-tests against synthetic footage — including the
negative cases — in CI.

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
