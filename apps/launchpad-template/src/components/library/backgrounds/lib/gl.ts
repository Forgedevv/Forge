/**
 * A minimal WebGL 1 renderer for a full-screen fragment shader: one triangle covering the canvas,
 * uniforms set by name. No library, so the shader backgrounds add only their own few kilobytes.
 */

export type UniformValue = number | readonly number[];

export interface FullscreenProgram {
  setUniforms(values: Readonly<Record<string, UniformValue>>): void;
  /** Sizes the drawing buffer (CSS size times the pixel ratio) and the viewport. */
  resize(width: number, height: number, pixelRatio: number): void;
  draw(): void;
  /** Frees the GPU objects and the context itself. */
  dispose(): void;
  readonly lost: boolean;
}

const VERTEX = `attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    console.warn('[visual-library] shader did not compile:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Creates the program on `canvas`, or returns null when WebGL or the shader is not available (the
 * caller then keeps its CSS fallback). The derivatives extension is enabled when present, and
 * `HAS_DERIVATIVES` is defined for the shader.
 */
export function createFullscreenProgram(
  canvas: HTMLCanvasElement,
  fragment: string,
): FullscreenProgram | null {
  let gl: WebGLRenderingContext | null;
  try {
    gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;
  const derivatives = Boolean(context.getExtension('OES_standard_derivatives'));
  const prefix = derivatives
    ? '#extension GL_OES_standard_derivatives : enable\n#define HAS_DERIVATIVES 1\n'
    : '';
  const vs = compile(context, context.VERTEX_SHADER, VERTEX);
  const fs = compile(context, context.FRAGMENT_SHADER, prefix + fragment);
  const program = context.createProgram();
  const loseContext = () => context.getExtension('WEBGL_lose_context')?.loseContext();
  if (!vs || !fs || !program) {
    loseContext();
    return null;
  }
  context.attachShader(program, vs);
  context.attachShader(program, fs);
  context.bindAttribLocation(program, 0, 'aPosition');
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    console.warn('[visual-library] shader did not link:', context.getProgramInfoLog(program));
    loseContext();
    return null;
  }
  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    context.STATIC_DRAW,
  );
  context.enableVertexAttribArray(0);
  context.vertexAttribPointer(0, 2, context.FLOAT, false, 0, 0);
  context.useProgram(program);
  context.clearColor(0, 0, 0, 0);

  const locations = new Map<string, WebGLUniformLocation | null>();
  const location = (name: string) => {
    if (!locations.has(name)) locations.set(name, context.getUniformLocation(program, name));
    return locations.get(name) ?? null;
  };
  let lost = false;
  const onLost = (event: Event) => {
    event.preventDefault();
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    get lost() {
      return lost || context.isContextLost();
    },
    setUniforms(values) {
      if (lost) return;
      for (const [name, value] of Object.entries(values)) {
        const loc = location(name);
        if (!loc) continue;
        if (typeof value === 'number') context.uniform1f(loc, value);
        else if (value.length === 2) context.uniform2f(loc, value[0] ?? 0, value[1] ?? 0);
        else if (value.length === 3)
          context.uniform3f(loc, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0);
        else if (value.length === 4) {
          context.uniform4f(loc, value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0);
        }
      }
    },
    resize(width, height, pixelRatio) {
      const w = Math.max(1, Math.round(width * pixelRatio));
      const h = Math.max(1, Math.round(height * pixelRatio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      context.viewport(0, 0, w, h);
      const loc = location('uResolution');
      if (loc && !lost) context.uniform2f(loc, w, h);
    },
    draw() {
      if (lost) return;
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawArrays(context.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener('webglcontextlost', onLost);
      if (!context.isContextLost()) {
        context.deleteBuffer(buffer);
        context.deleteProgram(program);
        context.deleteShader(vs);
        context.deleteShader(fs);
      }
      loseContext();
    },
  };
}
