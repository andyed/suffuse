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

## LAN: all lamps found, none captured

When every LAN lamp answers the discovery scan but none answers `devStatus`,
the evidence points at the host, not the lamps. On Windows the usual cause is
the firewall: a `node` path with no Allow rule gets inbound Block rules, which
pass the multicast scan's replies and drop every `devStatus` reply (measured
6/6 discovered, 0/36 asks answered). Do not record those lamps as offline or
as lacking LAN support. See [lan.md](lan.md) for the event log to check and
the fix. A single lamp that misses capture once is the Wi-Fi case instead;
`lanDevStatusRead` asks three times before calling it silent.

## Retest rule

After a firmware update or on a different unit:

1. inspect fresh capabilities and segment limits;
2. dry-run a high-contrast 3-band score;
3. explicitly confirm the experimental segment write;
4. visually check whether at least three spatial regions differ;
5. record accepted operations and the visible result separately.

Do not repeatedly write the same failed sequence without a meaningful changed condition such as firmware, capability document, or device.
