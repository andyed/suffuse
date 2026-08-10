# Palette authoring

A palette is named, reusable color intent. It is not proof that a device can render independent segments.

## Catalog schema

```json
{
  "version": 1,
  "palettes": [
    {
      "name": "dusk",
      "description": "Violet nightfall through ember gold.",
      "bands": [
        { "color": "#24134F", "weight": 1 },
        { "color": "#6D245F", "weight": 1 },
        { "color": "#D05B58", "weight": 1 },
        { "color": "#F2A65A", "weight": 1 }
      ]
    }
  ]
}
```

Rules:

- Use a lowercase kebab-case unique name.
- Author 3-5 ordered `#RRGGBB` bands.
- Optional positive weights allocate spatial share, not luminance.
- Keep descriptions about visible intent, not unsupported device behavior.
- Store reusable bundled palettes in `assets/palettes.json`; pass `--catalog /private/path/palettes.json` for a private or experimental catalog.

Reference a palette from a score with `"look": { "kind": "gradient", "palette": "dusk" }`. Do not provide both `look.palette` and `look.bands`. The CLI resolves the palette before validation and records its name in the compiled plan.

The palette may execute as direct segments, a declared scene fallback, or a solid fallback. Report that actual execution mode. Triggering a pre-existing DIY scene is not equivalent to uploading this palette to Govee.
