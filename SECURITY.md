# Security policy

## Report privately

Use GitHub's private vulnerability-reporting or Security Advisory flow for this
repository. Do not open a public issue for a vulnerability that could expose a
Govee account, household device, local network, or physical-control path.

Never include a live API key in a report. Redact stable device identifiers,
device names, receipt contents, private file paths, and network addresses unless
they are essential to reproduce the problem and the reporting channel is private.

## Security boundary

Suffuse reads `GOVEE_API_KEY` only from its process environment. CLI and MCP
arguments do not accept credentials. The local MCP server disables physical
writes unless its process has `GOVEE_MCP_ALLOW_WRITES=1`, and each write call
must independently confirm the operation and provide a private receipt path.

Reports are especially useful for:

- credential exposure or accidental logging;
- bypasses of write or segment-confirmation gates;
- ambiguous selection that can target the wrong physical device;
- receipts created with unsafe permissions or incomplete redaction;
- path traversal or unintended file access;
- malformed capability data that can produce unsafe operations;
- dependency vulnerabilities with a credible path through Suffuse.

The documented Govee service and the behavior of third-party devices are outside
this project's control, but Suffuse should fail closed when those dependencies
return ambiguous, invalid, unauthorized, or rate-limited results.
