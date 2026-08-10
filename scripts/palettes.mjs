import { readFile } from 'node:fs/promises';
import {
  differenceEuclidean,
  filterDeficiencyDeuter,
  filterDeficiencyProt,
  filterDeficiencyTrit,
  fixupHueDecreasing,
  fixupHueIncreasing,
  fixupHueLonger,
  fixupHueShorter,
  formatHex,
  inGamut,
  interpolate,
  interpolatorLinear,
  oklch,
  samples,
  toGamut
} from 'culori';
import { GoveeSkillError, rgbInteger, validateLightScore } from './core.mjs';

export const DEFAULT_PALETTE_URL = new URL('../assets/palettes.json', import.meta.url);

const text = value => String(value ?? '').trim();
const lower = value => text(value).toLowerCase();
const HUE_PATHS = Object.freeze({
  shorter: fixupHueShorter,
  longer: fixupHueLonger,
  increasing: fixupHueIncreasing,
  decreasing: fixupHueDecreasing
});
const CVD_FILTERS = Object.freeze({
  protan: filterDeficiencyProt(1),
  deutan: filterDeficiencyDeuter(1),
  tritan: filterDeficiencyTrit(1)
});

// These are authoring heuristics in idealized sRGB/OKLab, not visibility or
// just-noticeable-difference claims for an uncalibrated physical fixture.
export const PALETTE_DIAGNOSTIC_THRESHOLDS = Object.freeze({
  adjacentDeltaEOK: 0.04,
  cvdDeltaEOK: 0.03,
  curveTolerance: 0.005
});

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

function validateSafeguard(value, field, label) {
  if (value !== undefined && !['warn', 'off'].includes(value)) {
    throw new GoveeSkillError(`${label} ${field} must be warn or off`, 'invalid-palette');
  }
}

export function validatePaletteRecipe(recipe, label = 'Palette recipe') {
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    throw new GoveeSkillError(`${label} must be an object`, 'invalid-palette');
  }
  if ((recipe.topology ?? 'sequential') !== 'sequential') {
    throw new GoveeSkillError(`${label} currently supports only sequential topology`, 'invalid-palette');
  }
  if ((recipe.space ?? 'oklch') !== 'oklch') {
    throw new GoveeSkillError(`${label} space must be oklch`, 'invalid-palette');
  }
  if (!Array.isArray(recipe.anchors) || recipe.anchors.length < 2 || recipe.anchors.length > 5) {
    throw new GoveeSkillError(`${label} must contain 2 through 5 anchors`, 'invalid-palette');
  }
  recipe.anchors.forEach(color => rgbInteger(color));
  if (!Number.isInteger(recipe.bands) || recipe.bands < 3 || recipe.bands > 5) {
    throw new GoveeSkillError(`${label} bands must be an integer from 3 through 5`, 'invalid-palette');
  }
  if (!HUE_PATHS[recipe.huePath ?? 'shorter']) {
    throw new GoveeSkillError(`${label} huePath must be shorter, longer, increasing, or decreasing`, 'invalid-palette');
  }
  if (recipe.weights !== undefined) {
    if (!Array.isArray(recipe.weights) || recipe.weights.length !== recipe.bands
      || recipe.weights.some(weight => !Number.isFinite(weight) || weight <= 0)) {
      throw new GoveeSkillError(`${label} weights must contain one positive number per band`, 'invalid-palette');
    }
  }
  if (!['free', 'rising', 'falling'].includes(recipe.lightnessCurve ?? 'free')) {
    throw new GoveeSkillError(`${label} lightnessCurve must be free, rising, or falling`, 'invalid-palette');
  }
  if (!['free', 'crest'].includes(recipe.chromaCurve ?? 'free')) {
    throw new GoveeSkillError(`${label} chromaCurve must be free or crest`, 'invalid-palette');
  }
  validateSafeguard(recipe?.safeguards?.adjacentSimilarity, 'safeguards.adjacentSimilarity', label);
  validateSafeguard(recipe?.safeguards?.cvdCollapse, 'safeguards.cvdCollapse', label);
  return recipe;
}

function adjacentDistances(colors) {
  const difference = differenceEuclidean('oklab');
  return colors.slice(0, -1).map((color, index) => ({
    bands: [index + 1, index + 2],
    deltaEOK: Number(difference(color, colors[index + 1]).toFixed(4))
  }));
}

function curveWarnings(colors, recipe, warnings) {
  const values = colors.map(color => oklch(color));
  const tolerance = PALETTE_DIAGNOSTIC_THRESHOLDS.curveTolerance;
  if (recipe.lightnessCurve === 'rising'
    && values.some((color, index) => index > 0 && color.l + tolerance < values[index - 1].l)) {
    warnings.push({ code: 'lightness-curve', message: 'Resolved lightness is not monotonically rising.' });
  }
  if (recipe.lightnessCurve === 'falling'
    && values.some((color, index) => index > 0 && color.l - tolerance > values[index - 1].l)) {
    warnings.push({ code: 'lightness-curve', message: 'Resolved lightness is not monotonically falling.' });
  }
  if (recipe.chromaCurve === 'crest') {
    const maximum = Math.max(...values.map(color => color.c));
    const maximumIndex = values.findIndex(color => color.c === maximum);
    if (maximumIndex === 0 || maximumIndex === values.length - 1) {
      warnings.push({ code: 'chroma-curve', message: 'Resolved chroma does not crest inside the gradient.' });
    }
  }
}

export function diagnosePaletteBands(bands, options = {}) {
  validateBands(bands, 'Palette diagnostics');
  const colors = bands.map(band => band.color);
  const adjacent = adjacentDistances(colors);
  const warnings = [];
  const adjacentSimilarity = options?.safeguards?.adjacentSimilarity ?? 'warn';
  const cvdCollapse = options?.safeguards?.cvdCollapse ?? 'warn';
  if (adjacentSimilarity === 'warn') {
    adjacent.filter(pair => pair.deltaEOK < PALETTE_DIAGNOSTIC_THRESHOLDS.adjacentDeltaEOK)
      .forEach(pair => warnings.push({
        code: 'adjacent-similarity',
        bands: pair.bands,
        message: `Bands ${pair.bands.join(' and ')} are very similar before device rendering.`
      }));
  }

  const cvd = {};
  for (const [simulation, filter] of Object.entries(CVD_FILTERS)) {
    const distances = adjacentDistances(colors.map(color => filter(color)));
    const collapsedPairs = distances
      .filter(pair => pair.deltaEOK < PALETTE_DIAGNOSTIC_THRESHOLDS.cvdDeltaEOK)
      .map(pair => pair.bands);
    cvd[simulation] = { adjacent: distances, collapsedPairs };
    if (cvdCollapse === 'warn') {
      collapsedPairs.forEach(pair => warnings.push({
        code: 'cvd-collapse',
        simulation,
        bands: pair,
        message: `Bands ${pair.join(' and ')} converge under the ${simulation} simulation.`
      }));
    }
  }

  return { adjacent, cvd, warnings };
}

export function compilePaletteRecipe(recipeInput, label = 'Palette recipe') {
  const recipe = validatePaletteRecipe(structuredClone(recipeInput), label);
  const huePath = recipe.huePath ?? 'shorter';
  const gradient = interpolate(recipe.anchors, 'oklch', {
    h: { use: interpolatorLinear, fixup: HUE_PATHS[huePath] }
  });
  const rawColors = samples(recipe.bands).map(gradient);
  const isInRgb = inGamut('rgb');
  const gamutMappedBands = rawColors
    .map((color, index) => isInRgb(color) ? null : index + 1)
    .filter(Boolean);
  const mapToRgb = toGamut('rgb');
  const bands = rawColors.map((color, index) => {
    const band = { color: formatHex(mapToRgb(color)).toUpperCase() };
    if (recipe.weights) band.weight = recipe.weights[index];
    return band;
  });
  const diagnostics = diagnosePaletteBands(bands, recipe);
  diagnostics.gamutMappedBands = gamutMappedBands;
  if (gamutMappedBands.length) diagnostics.warnings.push({
    code: 'gamut-mapped',
    bands: gamutMappedBands,
    message: `Bands ${gamutMappedBands.join(', ')} required chroma reduction to fit sRGB.`
  });
  curveWarnings(bands.map(band => band.color), recipe, diagnostics.warnings);
  return {
    bands,
    recipe: {
      topology: recipe.topology ?? 'sequential',
      space: recipe.space ?? 'oklch',
      anchors: recipe.anchors.map(color => color.toUpperCase()),
      huePath,
      bands: recipe.bands,
      lightnessCurve: recipe.lightnessCurve ?? 'free',
      chromaCurve: recipe.chromaCurve ?? 'free',
      safeguards: {
        adjacentSimilarity: recipe?.safeguards?.adjacentSimilarity ?? 'warn',
        cvdCollapse: recipe?.safeguards?.cvdCollapse ?? 'warn'
      },
      ...(recipe.weights ? { weights: [...recipe.weights] } : {})
    },
    diagnostics
  };
}

export function validatePaletteCatalog(document) {
  if (![1, 2].includes(document?.version) || !Array.isArray(document?.palettes)) {
    throw new GoveeSkillError('Palette catalog must have version 1 or 2 and a palettes array', 'invalid-palette');
  }
  const names = new Set();
  for (const palette of document.palettes) {
    const name = lower(palette?.name);
    if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new GoveeSkillError('Palette names must use lowercase kebab-case', 'invalid-palette');
    }
    if (names.has(name)) throw new GoveeSkillError(`Duplicate palette name: ${name}`, 'invalid-palette');
    names.add(name);
    const hasBands = Array.isArray(palette.bands);
    const hasRecipe = palette.recipe !== undefined;
    if (hasBands === hasRecipe) {
      throw new GoveeSkillError(`Palette ${name} must use bands or recipe, not both`, 'invalid-palette');
    }
    if (hasRecipe && document.version < 2) {
      throw new GoveeSkillError(`Palette ${name} recipes require catalog version 2`, 'invalid-palette');
    }
    if (hasBands) validateBands(palette.bands, `Palette ${name}`);
    else validatePaletteRecipe(palette.recipe, `Palette ${name} recipe`);
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
  return validatePaletteCatalog(catalog).palettes.map(palette => {
    const resolved = palette.recipe
      ? compilePaletteRecipe(palette.recipe, `Palette ${palette.name} recipe`)
      : { bands: palette.bands, recipe: null, diagnostics: diagnosePaletteBands(palette.bands) };
    return {
      name: palette.name,
      description: text(palette.description),
      source: resolved.recipe ? 'recipe' : 'bands',
      bandCount: resolved.bands.length,
      colors: resolved.bands.map(band => band.color.toUpperCase()),
      recipe: resolved.recipe,
      warnings: resolved.diagnostics.warnings
    };
  });
}

export function materializePaletteScore(scoreInput, catalog) {
  const score = structuredClone(scoreInput);
  if (score?.look?.kind !== 'gradient') {
    return validateLightScore(score);
  }

  const hasPalette = !!text(score.look.palette);
  const hasBands = Array.isArray(score.look.bands);
  const hasRecipe = score.look.recipe !== undefined;
  if ([hasPalette, hasBands, hasRecipe].filter(Boolean).length !== 1) {
    throw new GoveeSkillError('A gradient must use exactly one of look.palette, look.bands, or look.recipe', 'invalid-score');
  }

  let recipe = hasRecipe ? score.look.recipe : null;
  if (hasPalette) {
    const paletteName = lower(score.look.palette);
    const palette = validatePaletteCatalog(catalog).palettes.find(item => lower(item.name) === paletteName);
    if (!palette) throw new GoveeSkillError(`Unknown palette: ${paletteName}`, 'unknown-palette');
    score.look.palette = palette.name;
    if (palette.recipe) recipe = palette.recipe;
    else score.look.bands = structuredClone(palette.bands);
  }

  if (recipe) {
    const resolved = compilePaletteRecipe(recipe, hasPalette ? `Palette ${score.look.palette} recipe` : 'LightScore recipe');
    score.look.recipe = resolved.recipe;
    score.look.bands = resolved.bands;
    score.look.paletteDiagnostics = resolved.diagnostics;
  } else {
    score.look.paletteDiagnostics = diagnosePaletteBands(score.look.bands);
  }
  return validateLightScore(score);
}
