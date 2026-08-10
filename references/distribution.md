# Cross-agent distribution

The repository root is the canonical Agent Skill. Do not maintain separate instruction copies for each agent.

## Discovery targets

- Codex: user `~/.agents/skills/suffuse` or project `.agents/skills/suffuse`.
- Claude Code: user `~/.claude/skills/suffuse` or project `.claude/skills/suffuse`.
- OpenClaw: it reads the shared user and project `.agents/skills` roots. The managed installer deliberately shares that link with Codex.

The repository also includes a Claude skills-directory plugin manifest. Claude Code can load the root `SKILL.md` as its single skill and start the bundled `.mcp.json` server. Codex and OpenClaw use the standard Agent Skill directly.

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

Run `node scripts/manage.mjs mcp-config` for a Codex configuration snippet and Claude/OpenClaw notes. Read [mcp.md](mcp.md) before enabling live tools.

Primary specifications and product documentation:

- https://agentskills.io/specification
- https://learn.chatgpt.com/docs/build-skills
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/mcp
- https://docs.openclaw.ai/skills
