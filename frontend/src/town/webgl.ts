// Whether this browser can draw the town. The town needs WebGL; without it the World page keeps
// the tile grid, which needs only a 2D canvas.
export function supportsWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
