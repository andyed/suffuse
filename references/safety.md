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
