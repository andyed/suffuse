# Household device registry

The household registry is a read-only observation layer above Suffuse's cloud,
LAN, and future transport providers. It answers a narrower question than the
control engine: what devices did each source report, when did it report them,
and which observations can be joined without guessing?

Run it through:

```bash
node scripts/govee.mjs doctor
node scripts/govee.mjs household
```

Agents can use the equivalent read-only MCP tool, `govee_inspect_household`.
Household names, device ids, and network addresses remain redacted on that
surface. CLI users may add `--show-identifiers` when inspecting locally.

## Current v1 contract

Each device entry retains:

- a snapshot-local reference that must not be persisted as a write target;
- model and capability information reported by cloud inventory;
- every available transport observed in this run;
- one observation record per source, including `observedAt`, reachability, and
  the fact that established it;
- identity confidence and any cross-source field conflicts.

Cloud account listing establishes membership and advertised capability, not
current reachability. Its reachability is therefore `unknown`. A LAN scan reply
establishes that the device was observed at that address at that moment; it does
not promise the address will remain valid.

The implementation does not cache registry snapshots yet. When caching is
added, observations must keep their original timestamps and become explicitly
stale; reading a cache must never mint a new observation time.

## Identity rules

Automatic cloud/LAN merging requires one unique, exact normalized device id on
both sides. Normalization removes separators and case differences only. Suffuse
does not merge by SKU, friendly name, IP address, identifier suffix, or discovery
order. Duplicate exact ids remain separate and ambiguous. A false negative costs
some convenience; a false positive can route a future command or restoration to
the wrong physical fixture.

### LAN and BLE: one fixture, two transports

A BLE advertisement never carries the full device id. The most it names is a
model and a short suffix, as in `Govee_H6009_EED7` or `ihoment_H6009_EED7`.
So the exact-id rule above cannot join a BLE record to anything, and the
registry has no BLE provider yet. When one lands, it follows the rule
psychodeli-webgl-port uses to show one row per physical fixture
(`room-selection.js`, 2026-10-13):

1. **A model alone is never an identity.** Many rooms hold several identical
   bulbs. A LAN record and a BLE record are candidates only when both yield
   the same model AND the same 4-hex-digit device suffix.
2. **The LAN suffix comes from a real device address only**, the last four
   hex digits of a 12- or 16-digit id, never from an IP address or a name. The
   BLE suffix comes from a name that matches `Govee|ihoment _ H#### _ ####`
   exactly; an unnamed or differently shaped advertisement yields no key.
3. **Pair only when the key is unique on both sides.** Two LAN lamps or two
   BLE advertisements with the same model and suffix are a collision. Every
   record in a collision stays a separate, visible row; none is paired by
   order or by guess.
4. **Pairing groups records; it does not replace them.** The paired row keeps
   both original transport records intact (ids, addresses, names), because
   capture, delivery and crash recovery must address the transport that wrote,
   with that transport's own identity. Both ids remain valid aliases for the
   row, so an inclusion or exclusion recorded against either still applies.
5. One writer per paired fixture (see [safety.md](safety.md)): LAN is preferred
   when a fixture answers on both, because LAN has `devStatus` readback and BLE
   has none.

A 4-digit suffix is a much weaker key than a full id. That is why rule 3 is
not optional: uniqueness on both sides is what keeps a weak key from routing a
write or a restore to the wrong bulb.

## Routing boundary

Registry v1 does not choose a writer and no control command accepts its
snapshot-local references. Before the registry can route commands, a later
change must define and test all of the following:

1. revalidation and maximum observation age for each transport;
2. one selected writer per device, recorded in the private receipt before the
   first physical write;
3. capability-aware routing rather than a global "LAN first" rule;
4. a failure policy that distinguishes "not sent" from a mute transport's
   "possibly sent", so cloud fallback cannot silently become a second writer;
5. restore ownership pinned to the transport and identity evidence captured for
   the original write;
6. explicit user inclusion before a discovered device can join a room or group;
7. for a BLE provider, the LAN/BLE pairing rule above, with collisions left
   visible.

This preserves the existing `LightScore` compiler, confirmation gates, evidence
transaction, and restoration journal as the control authority. The registry is
an input to that authority, not a replacement for it.

## Verification

Pure tests cover exact merging, ambiguity, conflicts, redaction, and partial
doctor results. A loopback UDP fake device separately exercises real discovery
and `devStatus` socket behavior without an API key or physical hardware.
