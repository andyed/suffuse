# Palette authoring

A palette is named, reusable color intent. It is not proof that a device can render independent segments.

## Catalog schema

```json
{
  "version": 2,
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

A version 2 catalog entry may use a deterministic recipe instead of literal bands:

```json
{
  "name": "dusk-perceptual",
  "description": "A perceptually even violet-nightfall to ember-gold progression.",
  "recipe": {
    "topology": "sequential",
    "space": "oklch",
    "anchors": ["#24134F", "#F2A65A"],
    "huePath": "shorter",
    "bands": 4,
    "lightnessCurve": "rising",
    "chromaCurve": "free",
    "safeguards": {
      "adjacentSimilarity": "warn",
      "cvdCollapse": "warn"
    }
  }
}
```

Rules:

- Use a lowercase kebab-case unique name.
- Use exactly one of `bands` or `recipe`.
- Author 3-5 ordered `#RRGGBB` bands, or ask a recipe to resolve 3-5 bands from 2-5 anchors.
- Optional positive weights allocate spatial share, not luminance.
- Recipes currently support sequential topology in OKLCH. `huePath` is `shorter`, `longer`, `increasing`, or `decreasing`.
- `lightnessCurve` (`free`, `rising`, or `falling`) and `chromaCurve` (`free` or `crest`) are diagnostic constraints. They warn; they do not rewrite authored anchors.
- `adjacentSimilarity` and simulated color-vision `cvdCollapse` safeguards are `warn` or `off`.
- Keep descriptions about visible intent, not unsupported device behavior.
- Store reusable bundled palettes in `assets/palettes.json`; pass `--catalog /private/path/palettes.json` for a private or experimental catalog.

Reference a palette from a score with `"look": { "kind": "gradient", "palette": "dusk" }`. Alternatively provide `look.bands` or `look.recipe` inline. Use exactly one. The CLI resolves recipes before core validation and records the normalized recipe, final bands, and advisory diagnostics in the compiled plan.

The diagnostics operate on idealized sRGB/OKLab values. They identify authoring risks; they are not visibility thresholds or proof of how an uncalibrated fixture, diffuser, wall, or observer will render the colors.

The palette may execute as direct segments, a declared scene fallback, or a solid fallback. Report that actual execution mode. Triggering a pre-existing DIY scene is not equivalent to uploading this palette to Govee.
