/** Curated gallery previews; the full matching collections live in the scene manifest. */
export const IMAGERY_MODES = [
  {
    id: 'coasts', label: 'Coasts', description: 'Oceans, islands & coastlines',
    previewIndex: 2,
    sourceIndices: [1, 2, 3, 9, 11, 1, 2, 9, 11, 3, 2, 1, 9, 2, 11, 1],
  },
  {
    id: 'terrain', label: 'Terrain', description: 'Mountains, deserts & fields',
    previewIndex: 4,
    sourceIndices: [0, 4, 5, 6, 7, 12, 13, 14, 15, 4, 12, 6, 15, 14, 5, 7],
  },
  {
    id: 'satellite', label: 'Satellite', description: 'The whole Earth, mixed together',
    previewIndex: 8,
    sourceIndices: Array.from({ length: 16 }, (_, index) => index),
  },
] as const;

export type ImageryMode = typeof IMAGERY_MODES[number]['id'];
export const DEFAULT_IMAGERY_MODE: ImageryMode = 'satellite';

export function getImageryMode(id: ImageryMode) {
  return IMAGERY_MODES.find(mode => mode.id === id)!;
}

export function isImageryMode(value: string | undefined): value is ImageryMode {
  return IMAGERY_MODES.some(mode => mode.id === value);
}

export function atlasPosition(index: number): string {
  return `${index % 4 / 3 * 100}% ${Math.floor(index / 4) / 3 * 100}%`;
}
