# Color theory for spatial light

Suffuse uses color theory to make authored relationships explicit and reproducible. It does not claim that mathematical spacing predicts the final physical experience.

## Author relationships, not isolated swatches

Start with the role of each band in the room: ground, transition, focus, or edge. A sequential gradient should have a readable direction. Lightness can create spatial hierarchy when hue differences weaken, and restrained chroma often preserves atmosphere better than maximizing every color.

The compiler currently implements sequential palettes because ordered downlights are the first product target. Diverging palettes need a meaningful center; qualitative palettes need categorical separation. Add those topologies only when their semantics are represented in the recipe rather than inferred from arbitrary swatches.

## Use OKLCH deliberately

[Culori](https://github.com/Evercoder/culori) provides the MIT-licensed color math. Recipes interpolate in OKLCH, make the hue route explicit, and gamut-map resolved bands into sRGB. OKLCH is useful for authoring perceptually smoother progressions, but equal coordinate steps do not guarantee equal appearance on a particular LED fixture.

The four hue routes are artistic choices:

- `shorter`: take the compact route between anchors; the usual default.
- `longer`: travel around the other side of the hue circle for a richer journey.
- `increasing` and `decreasing`: make direction stable when an itinerary spans multiple palettes.

CSS Color 4 describes modern color spaces, interpolation, and gamut mapping; use the [W3C specification](https://www.w3.org/TR/css-color-4/) as the standards reference.

## Treat diagnostics as prompts for review

Suffuse reports adjacent OKLab distance, sRGB gamut mapping, requested lightness/chroma shape, and adjacent collapse under protan, deutan, and tritan simulations. These thresholds are conservative authoring heuristics. They are not just-noticeable-difference claims, accessibility certification, or proof of visibility after diffusion and room reflection.

Color-vision simulation follows the class of physiologically grounded transforms described by [Machado, Oliveira, and Fernandes](https://doi.org/10.1109/TVCG.2009.113). Simulation should prompt a visual review; it should not be used to claim a universal observer experience.

## Keep color and emitted light distinct

- Palette `weight` controls spatial share, not luminance.
- `look.brightness` controls a device brightness capability, not OKLCH lightness.
- Tunable-white color temperature is a separate rendering path from RGB palette color.
- Device primaries, firmware, diffuser geometry, wall color, adaptation, and viewing angle can all change the result.

Keep exact hex bands when the authored swatches matter. Use a recipe when the relationship between anchors matters. In both cases, verify the installed device visually and retain the compiled bands in the evidence receipt.

## Design references

- [Interaction of Color](https://interactionofcolor.com/) emphasizes that color is perceived relationally and changes with context.
- [ColorBrewer](https://colorbrewer2.org/) demonstrates topology-specific palette design and practical perceptual checks.
- [Material Color Utilities](https://github.com/material-foundation/material-color-utilities) is an Apache-2.0 reference for generating role-based systems under contrast constraints; it is inspiration, not a dependency.
