/**
 * Whether this browser can run a WebGL effect well enough. False on the server, without WebGL, when
 * the visitor saves data, or on devices reporting little memory: heavy effects then show their static
 * fallback instead.
 */
let probed: boolean | undefined;

export function canRunWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  probed ??= probeWebGL();
  return probed;
}

/** Creates one throwaway context and releases it at once: browsers keep only about 16 alive. */
function probeWebGL(): boolean {
  const nav = navigator as Navigator & {
    connection?: { saveData?: boolean };
    deviceMemory?: number;
  };
  if (nav.connection?.saveData) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 2) return false;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return false;
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // Releasing early is only an optimisation: the context is collected with the canvas anyway.
    }
    return true;
  } catch {
    return false;
  }
}

/** Forgets the cached answer of `canRunWebGL`. For tests that switch WebGL on and off. */
export function forgetWebGLProbe(): void {
  probed = undefined;
}
