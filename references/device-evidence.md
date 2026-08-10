# Device evidence ledger

Capability advertisement is necessary for compilation, but visible output is the acceptance test for spatial claims.

## H608B observation — 2026-08-10

One installed H608B string-downlight fixture advertised:

- `segmentedColorRgb` with 15 segment indices;
- a maximum of 3 segment indices per control request;
- `gradientToggle`;
- native scenes and DIY scenes.

The cloud API returned success for correctly chunked segment requests, both before and after enabling `gradientToggle`, but the fixture did not visibly render independent colors. It remained uniform or unchanged. This is negative evidence for that tested unit and firmware state, not a global SKU blacklist.

The same fixture visibly changed when the advertised native `Sunset Glow` scene was resolved by name and triggered. That is positive evidence for named native-scene replay, not for arbitrary palette upload or per-puck control.

## Retest rule

After a firmware update or on a different unit:

1. inspect fresh capabilities and segment limits;
2. dry-run a high-contrast 3-band score;
3. explicitly confirm the experimental segment write;
4. visually check whether at least three spatial regions differ;
5. record accepted operations and the visible result separately.

Do not repeatedly write the same failed sequence without a meaningful changed condition such as firmware, capability document, or device.
