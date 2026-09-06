# Evidence transactions

A lighting write is a reversible state-transition attempt over infrastructure
with uneven observability. Suffuse records the facts it can establish without
collapsing them into a single success boolean.

The private v1 restore receipt remains the recovery artifact. New receipts add
an `evidence` member with schema `suffuse/evidence-transaction`, version `1`, a
transaction ID, and typed timestamped events. This is additive: existing v0.6.0
receipts remain valid and restorable.

## Event contract

| Kind | Statuses | What it establishes |
| --- | --- | --- |
| `request` | `recorded` | The compiled execution mode and requested channels or operation count |
| `transport` | `selected` | The chosen cloud, LAN, or BLE path and its acknowledgment/query limits |
| `query` | `captured`, `unavailable`, `failed` | Whether pre-write state was available for restoration |
| `protocol` | `accepted`, `sent-unacknowledged`, `failed` | What the service or local transport established for each operation |
| `visual` | `confirmed`, `mismatch`, `uncertain`, `not-observed` | Appearance evidence, kept independent of protocol evidence |
| `restoration` | `started`, `completed`, `failed` | What happened when replaying the receipt's restore operations |
| `uncertainty` | `open`, `resolved` | A named residual fact that must survive concise summaries |

Only status values defined for the event kind are accepted. Unknown states fail
closed rather than entering the receipt as plausible-looking free text.

## Transport meanings

- Cloud control can produce `accepted` from Govee's service response. This does
  not establish visible output.
- LAN `razer` and `colorwc` writes produce `sent-unacknowledged`. A successful
  UDP send is not a device acknowledgment. `devStatus` is a separate pre-write
  whole-device query and cannot observe a prior or resulting per-LED look.
- BLE writes produce `sent-unacknowledged`. The operating system accepting a
  write-without-response buffer is not proof that the lamp applied it, and the
  protocol exposes no prior-state query.

The summary therefore uses bounded statements such as “Command accepted but
appearance unverified” or “Command sent without device acknowledgment;
appearance unverified.”

## Restoration journal

`restore --confirm-write` adds a `restoration/started` event and persists the
receipt before sending a restore command. It then records `completed` or
`failed` and persists again. Completion establishes that Suffuse finished the
known restore operations; it does not erase partial coverage or claim the
appearance was observed. The original restoration warning remains open as
residual uncertainty.

If a v0.6.0 receipt has no `evidence` member, inspection or restoration derives
a conservative transaction from its status, outcomes, sent records, restore
operations, and coverage warning. Inferred events identify `legacy-receipt` as
their source.

## Read-only inspection

```bash
node scripts/govee.mjs evidence --receipt /private/path/look.receipt.json
```

The `govee_inspect_receipt` MCP tool exposes the same summary. It returns no
compiled operations, stable device identifiers, IP addresses, or restoration
payloads. Visual confirmation is not inferred by this command; it must come
from a separate human or camera observation path.
