#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { GoveeSkillError, validateLightScore } from '../scripts/core.mjs';
import {
  loadPaletteCatalog,
  materializePaletteScore,
  summarizePalettes
} from '../scripts/palettes.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL('../scripts/govee.mjs', import.meta.url));
const VERSION = '0.4.0';
const OUTPUT_SCHEMA = z.object({ result: z.unknown() });

export const MCP_TOOL_METADATA = Object.freeze([
  { name: 'govee_list_palettes', title: 'List lighting palettes', readOnly: true },
  { name: 'govee_validate_score', title: 'Validate a LightScore', readOnly: true },
  { name: 'govee_inspect_devices', title: 'Inspect Govee devices', readOnly: true },
  { name: 'govee_list_scenes', title: 'List Govee scenes', readOnly: true },
  { name: 'govee_compile_score', title: 'Compile a LightScore', readOnly: true },
  { name: 'govee_apply_score', title: 'Apply a LightScore', readOnly: false },
  { name: 'govee_restore', title: 'Restore Govee lights', readOnly: false }
]);

function annotations(readOnly) {
  return {
    readOnlyHint: readOnly,
    destructiveHint: false,
    openWorldHint: !readOnly
  };
}

function result(value) {
  return {
    structuredContent: { result: value },
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

async function runCli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      env: process.env,
      maxBuffer: 4 * 1024 * 1024
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error?.stderr || error?.message || 'Govee CLI failed').trim();
    throw new GoveeSkillError(detail, 'cli-error');
  }
}

async function withPrivateScore(score, callback) {
  const directory = await mkdtemp(join(tmpdir(), 'suffuse-mcp-'));
  const path = join(directory, 'score.private.json');
  try {
    await writeFile(path, `${JSON.stringify(score, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function requireWriteGate(confirmWrite) {
  if (process.env.GOVEE_MCP_ALLOW_WRITES !== '1') {
    throw new GoveeSkillError('MCP writes are disabled; set GOVEE_MCP_ALLOW_WRITES=1 in the server environment', 'mcp-writes-disabled');
  }
  if (confirmWrite !== true) {
    throw new GoveeSkillError('This tool call requires confirmWrite: true', 'write-not-confirmed');
  }
}

function requireAbsoluteReceipt(path) {
  if (!isAbsolute(path)) throw new GoveeSkillError('receiptPath must be absolute', 'invalid-receipt-path');
}

export async function createMcpServer() {
  const server = new McpServer(
    { name: 'suffuse', version: VERSION },
    {
      instructions: 'Start with read-only inspection and compilation. Never claim a gradient from a scene or solid fallback. Physical writes are disabled unless GOVEE_MCP_ALLOW_WRITES=1 and each call confirms the write; segment writes need a second explicit confirmation and visual verification.'
    }
  );

  server.registerTool('govee_list_palettes', {
    title: 'List lighting palettes',
    description: 'List bundled custom 3-5-band palettes without contacting Govee.',
    inputSchema: z.object({ name: z.string().optional() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ name }) => {
    const palettes = summarizePalettes(await loadPaletteCatalog());
    const selected = name ? palettes.filter(item => item.name.toLowerCase() === name.trim().toLowerCase()) : palettes;
    if (name && !selected.length) throw new GoveeSkillError(`Unknown palette: ${name}`, 'unknown-palette');
    return result({ palettes: selected });
  });

  server.registerTool('govee_validate_score', {
    title: 'Validate a LightScore',
    description: 'Validate authored lighting intent and resolve a bundled palette without contacting Govee.',
    inputSchema: z.object({ score: z.unknown() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ score }) => {
    const materialized = materializePaletteScore(score, await loadPaletteCatalog());
    validateLightScore(materialized);
    return result({ valid: true, name: materialized.name, palette: materialized.look.palette ?? null, bandCount: materialized.look.bands?.length ?? null });
  });

  server.registerTool('govee_inspect_devices', {
    title: 'Inspect Govee devices',
    description: 'Read installed Govee devices and advertised capabilities. Household identifiers stay redacted.',
    inputSchema: z.object({ sku: z.string().optional(), name: z.string().optional() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ sku, name }) => {
    const args = ['inspect'];
    if (sku) args.push('--sku', sku);
    if (name) args.push('--name', name);
    return result(await runCli(args));
  });

  server.registerTool('govee_list_scenes', {
    title: 'List Govee scenes',
    description: 'Read native or DIY scene names advertised for one exact installed device.',
    inputSchema: z.object({
      sku: z.string().optional(),
      name: z.string().optional(),
      instance: z.enum(['lightScene', 'diyScene']).optional()
    }).refine(value => value.sku || value.name, 'sku or name is required'),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ sku, name, instance }) => {
    const args = ['scenes'];
    if (sku) args.push('--sku', sku);
    if (name) args.push('--name', name);
    if (instance) args.push('--instance', instance);
    return result(await runCli(args));
  });

  server.registerTool('govee_compile_score', {
    title: 'Compile a LightScore',
    description: 'Discover the selected device and compile a redacted, read-only execution plan.',
    inputSchema: z.object({ score: z.unknown() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ score }) => result(await withPrivateScore(score, path => runCli(['apply', '--score', path]))));

  server.registerTool('govee_apply_score', {
    title: 'Apply a LightScore',
    description: 'Change one Govee device after explicit confirmation and save a private restore receipt.',
    inputSchema: z.object({
      score: z.unknown(),
      confirmWrite: z.boolean(),
      receiptPath: z.string(),
      confirmSegments: z.boolean().optional()
    }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(false)
  }, async ({ score, confirmWrite, receiptPath, confirmSegments }) => {
    requireWriteGate(confirmWrite);
    requireAbsoluteReceipt(receiptPath);
    return result(await withPrivateScore(score, path => {
      const args = ['apply', '--score', path, '--confirm-write', '--receipt', receiptPath];
      if (confirmSegments === true) args.push('--confirm-segments');
      return runCli(args);
    }));
  });

  server.registerTool('govee_restore', {
    title: 'Restore Govee lights',
    description: 'Restore the queryable prior state recorded in a private receipt.',
    inputSchema: z.object({ receiptPath: z.string(), confirmWrite: z.boolean() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(false)
  }, async ({ receiptPath, confirmWrite }) => {
    requireWriteGate(confirmWrite);
    requireAbsoluteReceipt(receiptPath);
    return result(await runCli(['restore', '--receipt', receiptPath, '--confirm-write']));
  });

  return server;
}

async function main() {
  if (process.argv.includes('--describe')) {
    process.stdout.write(`${JSON.stringify({ name: 'suffuse', version: VERSION, tools: MCP_TOOL_METADATA }, null, 2)}\n`);
    return;
  }
  const server = await createMcpServer();
  await server.connect(new StdioServerTransport());
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`suffuse-mcp: ${error.message}\n`);
    process.exitCode = 1;
  });
}
