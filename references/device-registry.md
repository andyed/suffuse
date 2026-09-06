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
6. explicit user inclusion before a discovered device can join a room or group.

This preserves the existing `LightScore` compiler, confirmation gates, evidence
transaction, and restoration journal as the control authority. The registry is
an input to that authority, not a replacement for it.

## Verification

Pure tests cover exact merging, ambiguity, conflicts, redaction, and partial
doctor results. A loopback UDP fake device separately exercises real discovery
and `devStatus` socket behavior without an API key or physical hardware.
