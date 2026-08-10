import { readFile } from 'node:fs/promises';
import { GoveeSkillError, rgbInteger, validateLightScore } from './core.mjs';

export const DEFAULT_PALETTE_URL = new URL('../assets/palettes.json', import.meta.url);

const text = value => String(value ?? '').trim();
const lower = value => text(value).toLowerCase();

function validateBands(bands, label) {
  if (!Array.isArray(bands) || bands.length < 3 || bands.length > 5) {
    throw new GoveeSkillError(`${label} must contain 3 through 5 bands`, 'invalid-palette');
  }
  bands.forEach((band, index) => {
    rgbInteger(band?.color);
    if (band?.weight !== undefined && (!Number.isFinite(band.weight) || band.weight <= 0)) {
      throw new GoveeSkillError(`${label} band ${index + 1} weight must be positive`, 'invalid-palette');
    }
  });
}

export function validatePaletteCatalog(document) {
  if (document?.version !== 1 || !Array.isArray(document?.palettes)) {
    throw new GoveeSkillError('Palette catalog must have version 1 and a palettes array', 'invalid-palette');
  }
  const names = new Set();
  for (const palette of document.palettes) {
    const name = lower(palette?.name);
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new GoveeSkillError('Palette names must use lowercase kebab-case', 'invalid-palette');
    }
    if (names.has(name)) throw new GoveeSkillError(`Duplicate palette name: ${name}`, 'invalid-palette');
    names.add(name);
    validateBands(palette.bands, `Palette ${name}`);
  }
  return document;
}

export async function loadPaletteCatalog(pathOrUrl = DEFAULT_PALETTE_URL) {
  try {
    return validatePaletteCatalog(JSON.parse(await readFile(pathOrUrl, 'utf8')));
  } catch (error) {
    if (error instanceof GoveeSkillError) throw error;
    throw new GoveeSkillError(`Could not read palette catalog: ${error.message}`, 'invalid-palette');
  }
}

export function summarizePalettes(catalog) {
  return validatePaletteCatalog(catalog).palettes.map(palette => ({
    name: palette.name,
    description: text(palette.description),
    bandCount: palette.bands.length,
    colors: palette.bands.map(band => band.color.toUpperCase())
  }));
}

export function materializePaletteScore(scoreInput, catalog) {
  const score = structuredClone(scoreInput);
  if (score?.look?.kind !== 'gradient' || !text(score.look.palette)) {
    return validateLightScore(score);
  }
  if (Array.isArray(score.look.bands)) {
    throw new GoveeSkillError('A gradient must use look.palette or look.bands, not both', 'invalid-score');
  }
  const paletteName = lower(score.look.palette);
  const palette = validatePaletteCatalog(catalog).palettes.find(item => lower(item.name) === paletteName);
  if (!palette) throw new GoveeSkillError(`Unknown palette: ${paletteName}`, 'unknown-palette');
  score.look.palette = palette.name;
  score.look.bands = structuredClone(palette.bands);
  return validateLightScore(score);
}
