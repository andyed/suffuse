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
const VERSION = '0.5.0';
const OUTPUT_SCHEMA = z.object({ result: z.unknown() });

export const MCP_TOOL_METADATA = Object.freeze([
  { name: 'govee_list_palettes', title: 'List lighting palettes', readOnly: true },
  { name: 'govee_validate_score', title: 'Validate a LightScore', readOnly: true },
  { name: 'govee_inspect_devices', title: 'Inspect Govee devices', readOnly: true },
  { name: 'govee_list_scenes', title: 'List Govee scenes', readOnly: true },
  { name: 'govee_compile_score', title: 'Compile a LightScore', readOnly: true },
  { name: 'govee_apply_score', title: 'Apply a LightScore', readOnly: false },
  { name: 'govee_restore', title: 'Restore Govee lights', readOnly: false },
  { name: 'govee_lan_scan', title: 'Scan the LAN for Govee devices', readOnly: true },
  { name: 'govee_lan_paint', title: 'Paint a LightScore over LAN', readOnly: false },
  { name: 'govee_lan_release', title: 'Release a held LAN device', readOnly: false },
  { name: 'govee_ble_scan', title: 'Scan for Govee devices over Bluetooth', readOnly: true },
  { name: 'govee_ble_set', title: 'Set a Govee device over Bluetooth', readOnly: false }
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

  server.registerTool('govee_lan_scan', {
    title: 'Scan the LAN for Govee devices',
    description: 'Discover Govee devices on the local network without an API key. Reports which support per-LED painting and whether the pixel count is hardware-verified. Multicast is intermittent per device, so the scan always unicast-sweeps too; allow ~10 seconds.',
    inputSchema: z.object({ subnet: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ subnet, timeoutMs }) => {
    const args = ['lan', 'scan'];
    if (subnet) args.push('--subnet', subnet);
    if (timeoutMs) args.push('--timeout', String(timeoutMs));
    return result(await runCli(args));
  });

  server.registerTool('govee_lan_paint', {
    title: 'Paint a LightScore over LAN',
    description: 'Apply a gradient or solid LightScore over the local network — keyless, per-LED on profiled fixtures. Gradients require confirmSegments: the per-LED channel never acknowledges, so the result is only verifiable by eye. holdSeconds bounds how long the look persists (default 900, max 14400) before the device returns to its own effects; while held, whole-device writes to it are refused rather than allowed to flatten the look.',
    inputSchema: z.object({
      score: z.unknown(),
      confirmWrite: z.boolean(),
      receiptPath: z.string(),
      ip: z.string().optional(),
      holdSeconds: z.number().int().nonnegative().optional(),
      confirmSegments: z.boolean().optional()
    }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(false)
  }, async ({ score, confirmWrite, receiptPath, ip, holdSeconds, confirmSegments }) => {
    requireWriteGate(confirmWrite);
    requireAbsoluteReceipt(receiptPath);
    return result(await withPrivateScore(score, path => {
      const args = ['lan', 'paint', '--score', path, '--confirm-write', '--receipt', receiptPath];
      if (ip) args.push('--ip', ip);
      if (holdSeconds !== undefined) args.push('--hold-seconds', String(holdSeconds));
      if (confirmSegments === true) args.push('--confirm-segments');
      return runCli(args);
    }));
  });

  server.registerTool('govee_lan_release', {
    title: 'Release a held LAN device',
    description: 'End a per-LED hold early and hand the device back to its own effects. Holds also expire on their own at their recorded TTL.',
    inputSchema: z.object({ ip: z.string(), confirmWrite: z.boolean() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(false)
  }, async ({ ip, confirmWrite }) => {
    requireWriteGate(confirmWrite);
    return result(await runCli(['lan', 'release', '--ip', ip, '--confirm-write']));
  });

  server.registerTool('govee_ble_scan', {
    title: 'Scan for Govee devices over Bluetooth',
    description: 'Discover Govee BLE peripherals — keyless and Wi-Fi-free, the only local path to the H6009 class (cloud-listed, no LAN Control). Needs the optional @stoprocent/noble dependency and, on macOS, Bluetooth permission for the responsible process. A lamp currently held by another central (e.g. the Govee Home app) stops advertising and will not appear.',
    inputSchema: z.object({ timeoutMs: z.number().int().positive().optional() }),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(true)
  }, async ({ timeoutMs }) => {
    const args = ['ble', 'scan'];
    if (timeoutMs) args.push('--timeout', String(timeoutMs));
    return result(await runCli(args));
  });

  server.registerTool('govee_ble_set', {
    title: 'Set a Govee device over Bluetooth',
    description: 'One-shot power/colour/brightness over BLE after explicit confirmation, with a private receipt. BLE has NO state readback: prior state cannot be captured, so the receipt records a declared warm-white restore point, and results report what was sent, never that the lamp obeyed. The connection is held only for the seconds the write takes.',
    inputSchema: z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      power: z.boolean().optional(),
      color: z.string().optional(),
      brightness: z.number().int().min(1).max(100).optional(),
      confirmWrite: z.boolean(),
      receiptPath: z.string()
    }).refine(value => value.id || value.name, 'id or name is required'),
    outputSchema: OUTPUT_SCHEMA,
    annotations: annotations(false)
  }, async ({ id, name, power, color, brightness, confirmWrite, receiptPath }) => {
    requireWriteGate(confirmWrite);
    requireAbsoluteReceipt(receiptPath);
    const args = ['ble', 'set', '--confirm-write', '--receipt', receiptPath];
    if (id) args.push('--id', id);
    if (name) args.push('--name', name);
    if (power !== undefined) args.push('--power', power ? 'on' : 'off');
    if (color) args.push('--color', color);
    if (brightness !== undefined) args.push('--brightness', String(brightness));
    return result(await runCli(args));
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
