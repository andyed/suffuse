# Device-control safety

## Classify the action

- `inspect` and fixture compilation are read-only.
- `apply` without `--confirm-write` is a live capability read followed by a redacted preview.
- `apply --confirm-write` and `restore --confirm-write` change physical devices.

A direct instruction such as “set the downlights to this gradient” authorizes the described change. Exploratory language such as “can these lights do a gradient?” authorizes inspection and preview only.

## Match one exact device

Select by exact case-insensitive name and/or SKU. Fail on zero or multiple matches. Never pick the first partial match and never infer that every unit of a SKU exposes identical firmware capabilities.

Device names and identifiers are household/account data. Redact them on stdout by default. Files containing full identifiers must be created with owner-only permissions and must not be committed.

## Preserve evidence

Require a receipt path for writes. Store:

- the compiled operations;
- per-operation HTTP outcome;
- queryable pre-write state converted into restore operations;
- restoration coverage and warnings;
- timestamps and selected device identity.

The receipt intentionally excludes the API key.

## State restoration limits

The state endpoint may expose power, brightness, and a global color while omitting the prior per-segment arrangement. Mark restoration as partial whenever applying segmented operations and no exact restorable segmented state was returned.

Do not promise bit-for-bit restoration. Prefer a user-created advertised snapshot when exact room recovery matters. Stop and explain if the requested safety requirement cannot be met by the advertised capabilities.

## Fail closed

Do not write when:

- the key is missing or rejected;
- device selection is ambiguous;
- the score is invalid;
- segmented color is missing or lacks an explicit segment domain and no declared fallback compiles;
- a scene name is not advertised;
- `--confirm-write` or a receipt path is absent;
- fixture data is supplied to an apply command;
- the service reports authentication, validation, or rate-limit errors.

## Patterns for sustained and multi-device control

Suffuse today performs bounded one-shot writes. These rules were each learned
by getting them wrong in the Psychodeli implementations that drive rooms for
hours; they become load-bearing the moment a tool does sustained streaming or
owns more than one device. Recorded now so a future capability inherits them
instead of rediscovering them.

**Restore discipline** (each rule bought with a real failure):

1. Capture state **before** driving, never after — post-hoc capture reads back
   your own writes as "the user's state".
2. Never re-capture over an existing restore point. A crash-recovery pass that
   recaptures records the crashed session's output as the thing to restore to.
3. Stop submitting before restoring — a restore racing live writes loses
   (last writer wins), and on queueing channels the queue replays over it.

**Durable restore journal** (crash recovery for physical state):

- Journal the restore point on disk **before** the device becomes active.
- A partial restore keeps the unrestored entries; delete the journal only when
  nothing is owed.
- Recovery of a pending journal is a **gate on new sessions, not a badge** —
  a device with an unresolved restore must not be re-enrolled until it is
  restored or the user explicitly discharges the debt.
- When in doubt, keep the evidence.

**One writer per lamp, arbitrated once.** When a device answers on more than
one transport, pick one owner up front rather than writing on both — two
transports on one lamp is two writers fighting, and only some channels have
readback to detect it. (Psychodeli's rule: LAN wins over BLE when a SKU
answers on both, because LAN has `devStatus`.) This is the multi-transport
generalization of the hold-based contention lock.

**Fail-closed device inclusion.** In a multi-device room, discovered is not
included: a newly found compatible device stays excluded until the user
includes it, and filtering happens before capture, enrolment, or write — an
excluded lamp is never journalled, never touched, never even read into
session state.

**Channel alternation under a shared budget.** On rate-limited channels where
colour and brightness are separate commands, a fixed priority starves the
loser under sustained load. Alternate when both have pending changes.
