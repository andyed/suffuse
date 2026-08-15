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
- `look.bands`: Alternatively, 3-5 ordered inline bands. Each band has `color` as `#RRGGBB`, an optional positive `weight`, and an optional positive `lightness`.
- `band.lightness`: Relative lightness for spatial hierarchy. `1` leaves a band alone; above 1 makes it a focus, below 1 makes it ground. **Conserved**: the factors are normalized to a weighted mean of 1 before they are applied, so lightness taken from one band is returned to the others and the fixture's overall level stays at `look.brightness`. Composes with all three band sources — catalog palette, recipe, or inline bands.
- `look.recipe`: Alternatively, a sequential OKLCH palette recipe as specified in [palettes.md](palettes.md). Use exactly one of `look.palette`, `look.bands`, or `look.recipe`.
- `look.color`: Required for a solid look as `#RRGGBB`.
- `look.scene`: Required for a scene look. Match an advertised scene option name.
- `look.sceneInstance`: Optional `lightScene`, `diyScene`, or `snapshot`; omit to search all advertised scene instances.
- `look.fallbackScene`: Optional advertised scene name used only when `fallback` contains `"scene"`.
- `fallback`: Ordered subset of `"scene"` and `"solid"`. A gradient's solid fallback uses its middle band.
- `restore.mode`: `"capture"` or `"none"`. Capture is best-effort because Govee state responses do not necessarily expose prior per-segment colors.

## Authoring rules

- Preserve spatial order. The first band maps to the lowest advertised segment positions and the last to the highest.
- Use weights for unequal spatial EXTENT and `lightness` for spatial HIERARCHY. They are separate fields because they answer separate questions: how much of the fixture a band occupies, and how it sits against its neighbours. Neither changes overall level — `look.brightness` alone does that.
- Reach for `lightness` when hue differences alone are not carrying the structure, rather than widening chroma until the atmosphere goes. Because the factors are conserving, adding a focus band cannot brighten the room as a side effect.
- Prefer a named catalog palette when the look should be reused across agents or rooms.
- Prefer a recipe when interpolation and diagnostics should be reproducible; prefer explicit bands when every authored swatch must remain exact.
- Prefer 3 bands for decisive looks and 4-5 for more nuanced gradients.
- Keep adjacent colors distinguishable after diffusion. Avoid near-identical bands that consume requests without creating a visible boundary.
- Declare fallbacks deliberately. An empty fallback list means fail rather than change the artistic form.
- Use scenes by advertised option name. Never invent a scene identifier.

Conserved lightness is applied at the end of the palette stage, on the resolved bands, and the
plan carries a `paletteDiagnostics.lightness` block reporting the requested mean, the achieved
mean, the drift between them, and whether conservation held. Gamut mapping is where it can fail:
a band asked to brighten past sRGB clips, and the residual can only be given away to bands that
still have headroom. Whatever drift survives that is reported as a `lightness-drift` warning
rather than silently delivering a room brighter or dimmer than the author asked for. Adjacent
distance and color-vision diagnostics are computed AFTER shading, because they are properties of
the colors actually sent.

The palette stage resolves recipes to concrete bands before device compilation. Its adjacent-distance, gamut, curve, and simulated color-vision diagnostics are advisory and are copied into the plan. The device compiler then partitions every advertised segment exactly once and records the final execution mode. A band may compile to multiple operations when the device advertises a per-command `segment.size.max` smaller than that band.
