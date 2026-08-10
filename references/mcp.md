# MCP surface

`mcp/server.mjs` is a local stdio MCP server built with the official MCP v2 TypeScript SDK. It exposes focused tools for palette listing, score validation, device inspection, scene discovery, compilation, apply, and restore.

The server is the stable agent-facing authoring and safety facade, not a new device transport for its own sake. Existing Govee MCP servers and the mature `govee2mqtt` bridge are compared in [ecosystem.md](ecosystem.md). Keep tool and `LightScore` contracts independent of the execution provider so an opt-in MQTT or LAN backend can be added later without changing agent workflows.

## Safety defaults

- The server inherits `GOVEE_API_KEY` from its process environment; no tool accepts a key.
- Local palette listing and score validation need no credentials.
- Device and scene reads need `GOVEE_API_KEY`.
- Physical writes are disabled unless the server process has `GOVEE_MCP_ALLOW_WRITES=1`.
- Every write tool also requires `confirmWrite: true` and an absolute private receipt path.
- A score that compiles to `segmentedColorRgb` additionally requires `confirmSegments: true`.

Run a metadata-only smoke check:

```bash
node mcp/server.mjs --describe
```

Run the stdio server:

```bash
GOVEE_API_KEY=... node mcp/server.mjs
```

When the key already lives in a private `.env`, Node 20+ can load it without adding dotenv code or moving the secret:

```bash
node --env-file=/private/path/.env mcp/server.mjs
```

Do not place the key in checked-in MCP configuration. Configure the client to forward the existing environment variable. Keep `GOVEE_MCP_ALLOW_WRITES` unset for a read-only connection; use a separate explicitly write-enabled connection when physical control is intended.

This is a local development surface. A public connector would need a stable streamable-HTTP endpoint, authenticated per-user authorization, rate limiting, logging that excludes secrets, and deployment/review work beyond this repository.
