# Cross-agent distribution

The repository root is the canonical Agent Skill. Do not maintain separate instruction copies for each agent.

## Discovery targets

- Codex: user `~/.agents/skills/suffuse` or project `.agents/skills/suffuse`.
- Claude Code: user `~/.claude/skills/suffuse` or project `.claude/skills/suffuse`.
- Hermes: user `~/.hermes/skills/suffuse`. At project scope Hermes scans both `.hermes/skills` and `.agents/skills`, so the managed installer deliberately shares the Codex `.agents/skills` link rather than minting a second one for the same checkout.

A project-scope skill is only discovered after the project root is trusted (`hermes skills trust`); until then Hermes prints a notice and loads nothing from it.

The repository also includes a Claude skills-directory plugin manifest. Claude Code can load the root `SKILL.md` as its single skill and start the bundled `.mcp.json` server. Codex and Hermes use the standard Agent Skill directly.

## Managed local workflow

Preview destinations without writing:

```bash
node scripts/manage.mjs plan --target all --scope user
```

Install canonical symbolic links:

```bash
node scripts/manage.mjs install --target all --scope user
```

Check the runtime without exposing the API key:

```bash
node scripts/manage.mjs doctor
```

If credentials live in a private `.env`, run `node --env-file=/private/path/.env scripts/manage.mjs doctor`. The manager reports only whether the key is configured, never its value.

Removal is conservative: `uninstall` removes only links that still point at this exact repository. It refuses real directories, files, or links to another source.

Use `--scope project --project /absolute/project/path` for repository-specific discovery. The default symlink workflow is for a trusted local checkout; registry or marketplace distribution should package real files rather than symlinks.

## Agent-native API

Run `node scripts/manage.mjs mcp-config` for Codex TOML, Hermes YAML, and the Claude note. Read [mcp.md](mcp.md) before enabling live tools.

Hermes needs one extra step that Codex does not. It does not forward ambient shell
environment to a stdio MCP server — it passes a fixed allowlist (`PATH`, `HOME`, `USER`,
`LANG`, `LC_ALL`, `TERM`, `SHELL`, `TMPDIR`, `XDG_*`) plus keys it recognizes as secrets.
Put `GOVEE_API_KEY` in `~/.hermes/.env` and reference it as `${GOVEE_API_KEY}` in the
server's `env:` block. Do not inline the literal value: `~/.hermes/config.yaml` is
plaintext. With neither, the server still starts — palette authoring, score compilation,
and the LAN path keep working, and every cloud call fails with a missing key.

Primary specifications and product documentation:

- https://agentskills.io/specification
- https://learn.chatgpt.com/docs/build-skills
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/mcp
