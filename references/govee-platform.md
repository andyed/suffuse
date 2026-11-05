# Govee Developer Platform reference

Use only the documented public Developer Platform. This repository is unofficial and is not affiliated with Govee.

For community LAN, MQTT, MCP, and BLE implementations that can inform or eventually back this skill, see [ecosystem.md](ecosystem.md). The current CLI and MCP server use only the public endpoints below.

## Public endpoints used

- Discover devices: `GET https://openapi.api.govee.com/router/api/v1/user/devices`
- Query state: `POST https://openapi.api.govee.com/router/api/v1/device/state`
- Control device: `POST https://openapi.api.govee.com/router/api/v1/device/control`
- Query dynamic scenes: `POST https://openapi.api.govee.com/router/api/v1/device/scenes`
- Query DIY scenes: `POST https://openapi.api.govee.com/router/api/v1/device/diy-scenes`

Send the API key only as the `Govee-API-Key` request header. Apply for it through the Govee Home app. Do not put it in a score, receipt, command-line argument, fixture, or committed file.

The key turns local authoring into account-aware operation: device discovery, fresh installed-device capabilities, current queryable state, scene discovery, and authenticated control requests. It does not enable Suffuse writes by itself; the MCP and CLI confirmation gates still apply.

As of May 15, 2026, generating a new Govee API key immediately invalidates older active keys for the same account. Update every application or service using the old key when rotating it.

Official documentation:

- https://developer.govee.com/reference/apply-you-govee-api-key
- https://developer.govee.com/reference/get-you-devices
- https://developer.govee.com/reference/get-devices-status
- https://developer.govee.com/reference/control-you-devices
- https://developer.govee.com/reference/get-light-scene

## Capability truth

Use the capabilities returned for the selected installed device. Relevant instances include:

- `devices.capabilities.on_off` / `powerSwitch`
- `devices.capabilities.toggle` / `gradientToggle`
- `devices.capabilities.range` / `brightness`
- `devices.capabilities.color_setting` / `colorRgb`
- `devices.capabilities.color_setting` / `colorTemperatureK`
- `devices.capabilities.segment_color_setting` / `segmentedColorRgb`
- `devices.capabilities.segment_color_setting` / `segmentedBrightness`
- `devices.capabilities.dynamic_scene` / `lightScene`, `diyScene`, or `snapshot`

Device discovery contains only a smaller static scene set. Resolve live `lightScene` names through `/device/scenes` and `diyScene` names through `/device/diy-scenes`, then merge those returned capability options before compiling a scene command.

The public API documents retrieval and triggering of advertised DIY scenes. It does not document creating or uploading a new DIY effect or arbitrary palette. Keep custom palette authoring local and compile it to supported controls or an explicitly declared fallback.

For `segmentedColorRgb`, use only segment indices explicitly returned in the capability's `segment` field. Govee responses have used both `options` and `elementRange`. Honor `segment.size.min` and `segment.size.max` for every control request; split one authored color band across multiple requests when necessary. If the instance is present but its segment domain or declared array limits are unsafe, report that the command cannot be compiled safely.

If `gradientToggle` is advertised, enable it before sending segmented colors. Some devices accept segment payloads while rendering them as whole-fixture colors when gradient mode is not active. The state endpoint may return an empty value for this toggle, so visual confirmation remains necessary.

## Device names

The device list (`GET /router/api/v1/user/devices`) documents `deviceName`
beside `sku` and `device`: the name the user gave the lamp in Govee Home. The
large example responses in Govee's reference omit it even though the field
table lists it, so check a real response before relying on it, and treat a
missing or blank name as valid. Bluetooth-only devices may not appear in the
account list at all. (Checked against Govee's documentation 2026-10-10 by
psychodeli-webgl-port, which labels its room with these names.)

Suffuse already reads `deviceName`: `inspect --show-identifiers` prints it, a
`LightScore` may target an exact name, and the MCP surface keeps it redacted
like every other household identifier. Rules for any tool that shows names:

- **A name is a label, never an identity.** Duplicate names are normal. Join a
  name to a fixture only on the exact, complete `(sku, device)` pair, unique on
  both sides; never on a name, an IP address, a suffix or discovery order.
- **Refreshing names changes labels only.** It must never restart, rescan,
  capture state, change which lamps are included, run a test, or interrupt a
  running look, and names stay out of any restore journal so a label refresh
  cannot rewrite a pending restore.
- **Account access is not local membership.** A light that appears only in the
  cloud list never becomes a discovered, included or controllable local
  fixture because of it.
- **Failures keep the last good labels.** On 401/403, stop automatic requests
  until the key is replaced: generating a new key invalidates the old one (see
  above), so a working key that starts failing usually means someone made a
  new one. On 429, honour `Retry-After`. Space refreshes well inside the
  30 requests/minute discovery limit (psychodeli-webgl-port uses a 60 s
  minimum gap) and do not retry in a loop.
- Treat names as untrusted plain text: trim, drop control and bidirectional
  override characters, and cap the length before display.

## Published rate limits

At the time this reference was authored, Govee documented these principal limits:

- device control: 2 requests per second per device, burst 6;
- device control: 12 requests per second per account, burst 80;
- device discovery: 30 requests per minute per account;
- device state and scene queries: 30 requests per minute per device.

Treat current response headers and `429` results as authoritative. Recheck the official documentation before changing pacing. The CLI spaces device writes by at least 550 ms.

These cloud limits make the API suitable for authored looks, gradients, scene changes, and coarse cues—not frame-rate music visualization. Put continuous reactive rendering in a local runtime with its own tested transport.

## Proprietary AI boundary

Govee markets CogniGlow and AI Lighting Bot as AI lighting systems. The public Developer Platform documentation above does not document a supported generation endpoint for either system. Do not scrape app traffic, reproduce private authentication, or describe locally authored LightScores as output from Govee's proprietary models.
