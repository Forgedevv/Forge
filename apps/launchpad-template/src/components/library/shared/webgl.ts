/**
 * Whether this browser can run a WebGL effect well enough. False on the server, without WebGL, when
 * the visitor saves data, or on devices reporting little memory: heavy effects then show their static
 * fallback instead.
 */
export function canRunWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
