# LightScore reference

A `LightScore` is the portable authored intent. It contains no API key or stable device identifier. The compiler resolves it against a fresh capability response.

## Schema

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

## Fields

- `version`: Must be `1`.
- `name`: Human-readable authored look.
- `target.sku`: Optional exact, case-insensitive SKU selector.
- `target.name`: Optional exact, case-insensitive Govee Home device-name selector. Use both when known. Selection fails if more than one device matches.
- `power`: `"on"`, `"off"`, or `"unchanged"`.
- `look.kind`: `"gradient"`, `"solid"`, or `"scene"`.
- `look.brightness`: Optional integer from 0 through 100.
- `look.palette`: For gradients, an exact name from the selected palette catalog.
- `look.bands`: Alternatively, 3-5 ordered inline bands. Each band has `color` as `#RRGGBB` and optional positive `weight`. Do not combine it with `look.palette`.
- `look.color`: Required for a solid look as `#RRGGBB`.
- `look.scene`: Required for a scene look. Match an advertised scene option name.
- `look.sceneInstance`: Optional `lightScene`, `diyScene`, or `snapshot`; omit to search all advertised scene instances.
- `look.fallbackScene`: Optional advertised scene name used only when `fallback` contains `"scene"`.
- `fallback`: Ordered subset of `"scene"` and `"solid"`. A gradient's solid fallback uses its middle band.
- `restore.mode`: `"capture"` or `"none"`. Capture is best-effort because Govee state responses do not necessarily expose prior per-segment colors.

## Authoring rules

- Preserve spatial order. The first band maps to the lowest advertised segment positions and the last to the highest.
- Use weights for unequal spatial bands, not for brightness.
- Prefer a named catalog palette when the look should be reused across agents or rooms.
- Prefer 3 bands for decisive looks and 4-5 for more nuanced gradients.
- Keep adjacent colors distinguishable after diffusion. Avoid near-identical bands that consume requests without creating a visible boundary.
- Declare fallbacks deliberately. An empty fallback list means fail rather than change the artistic form.
- Use scenes by advertised option name. Never invent a scene identifier.

The compiler partitions every advertised segment exactly once and records the final execution mode. A band may compile to multiple operations when the device advertises a per-command `segment.size.max` smaller than that band.
