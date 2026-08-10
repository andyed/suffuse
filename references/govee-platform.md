# Govee Developer Platform reference

Use only the documented public Developer Platform. This repository is unofficial and is not affiliated with Govee.

## Public endpoints used

- Discover devices: `GET https://openapi.api.govee.com/router/api/v1/user/devices`
- Query state: `POST https://openapi.api.govee.com/router/api/v1/device/state`
- Control device: `POST https://openapi.api.govee.com/router/api/v1/device/control`
- Query dynamic scenes: `POST https://openapi.api.govee.com/router/api/v1/device/scenes`
- Query DIY scenes: `POST https://openapi.api.govee.com/router/api/v1/device/diy-scenes`

Send the API key only as the `Govee-API-Key` request header. Apply for it through the Govee Home app. Do not put it in a score, receipt, command-line argument, fixture, or committed file.

Official documentation:

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

For `segmentedColorRgb`, use only segment indices explicitly returned in the capability's `segment` field. Govee responses have used both `options` and `elementRange`. Honor `segment.size.min` and `segment.size.max` for every control request; split one authored color band across multiple requests when necessary. If the instance is present but its segment domain or declared array limits are unsafe, report that the command cannot be compiled safely.

If `gradientToggle` is advertised, enable it before sending segmented colors. Some devices accept segment payloads while rendering them as whole-fixture colors when gradient mode is not active. The state endpoint may return an empty value for this toggle, so visual confirmation remains necessary.

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
