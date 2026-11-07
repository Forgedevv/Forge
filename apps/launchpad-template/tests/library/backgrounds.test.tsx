// @vitest-environment jsdom
import '../helpers/dom-setup';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: false }));

// Every effect reads the preference through the shared hook.
vi.mock('@/components/library/shared/useReducedMotion', () => ({
  useReducedMotion: () => h.reduced,
}));

import { entries } from '@/components/library/backgrounds';
import { DotGrid } from '@/components/library/backgrounds/DotGrid';
import { fragmentShader } from '@/components/library/backgrounds/lib/glsl';
import { ShaderBackground } from '@/components/library/backgrounds/lib/ShaderBackground';
import {
  isDarkColor,
  mixRgb,
  parseColor,
  resolveColors,
  rgbCss,
} from '@/components/library/backgrounds/lib/color';
import { ShaderSurface } from '@/components/library/backgrounds/lib/ShaderSurface';
import { FALLBACK_THEME_COLORS } from '@/components/library/shared';
import { forgetWebGLProbe } from '@/components/library/shared/webgl';

const SRC = join(process.cwd(), 'src');
const FAMILY_DIR = join(SRC, 'components/library/backgrounds');

/** A WebGL context that records what the effect asks for. */
function fakeWebGL() {
  const calls = { draws: 0, sources: [] as string[], lost: 0, uniforms: new Set<string>() };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    COLOR_BUFFER_BIT: 9,
    createShader: () => ({}),
    shaderSource: (_s: unknown, source: string) => calls.sources.push(source),
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    useProgram: () => {},
    clearColor: () => {},
    getUniformLocation: (_p: unknown, name: string) => {
      calls.uniforms.add(name);
      return {};
    },
    uniform1f: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    uniform4f: () => {},
    viewport: () => {},
    clear: () => {},
    drawArrays: () => {
      calls.draws += 1;
    },
    isContextLost: () => false,
    getExtension: (name: string) =>
      name === 'WEBGL_lose_context' ? { loseContext: () => (calls.lost += 1) } : null,
    deleteBuffer: () => {},
    deleteProgram: () => {},
    deleteShader: () => {},
  };
  return { gl, calls };
}

/** A canvas 2D context that accepts every drawing call. */
function fake2d() {
  const calls = { fills: 0, strokes: 0, texts: 0 };
  const gradient = { addColorStop: () => {} };
  const ctx = new Proxy(
    {
      createRadialGradient: () => gradient,
      createLinearGradient: () => gradient,
      measureText: (text: string) => ({ width: text.length * 10 }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4).fill(255),
      }),
      fill: () => (calls.fills += 1),
      fillRect: () => (calls.fills += 1),
      stroke: () => (calls.strokes += 1),
      fillText: () => (calls.texts += 1),
    } as Record<string | symbol, unknown>,
    {
      get: (target, key) => (key in target ? target[key] : () => {}),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  return { ctx, calls };
}

let webgl: ReturnType<typeof fakeWebGL> | null = null;
let ctx2d: ReturnType<typeof fake2d> | null = null;

beforeEach(() => {
  forgetWebGLProbe();
  h.reduced = false;
  webgl = null;
  ctx2d = null;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (kind: string) {
    if (kind === 'webgl' || kind === 'webgl2') return (webgl?.gl ?? null) as never;
    if (kind === '2d') return (ctx2d?.ctx ?? null) as never;
    return null;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backgrounds catalogue', () => {
  it('has unique kebab-case ids and complete entries', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.family).toBe('backgrounds');
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.moods.length).toBeGreaterThan(0);
      expect(entry.demoHeight).toBeGreaterThan(200);
    }
    // A few effects must stay light (CSS or SVG only) for sites that cannot afford WebGL.
    expect(entries.filter((e) => e.weight === 'light').length).toBeGreaterThanOrEqual(2);
  });

  it('points every importPath at a file that exports the named component', async () => {
    for (const entry of entries) {
      expect(entry.importPath).toBe(`@/components/library/backgrounds/${entry.exportName}`);
      const file = join(SRC, `${entry.importPath.replace('@/', '')}.tsx`);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(
        `../../src/components/library/backgrounds/${entry.exportName}.tsx`
      )) as Record<string, unknown>;
      expect(typeof mod[entry.exportName], entry.exportName).toBe('function');
    }
  });

  it('marks WebGL effects heavy and keeps light ones free of canvas code', () => {
    for (const entry of entries) {
      const source = readFileSync(join(FAMILY_DIR, `${entry.exportName}.tsx`), 'utf8');
      if (source.includes('<ShaderBackground')) expect(entry.weight, entry.id).toBe('heavy');
      if (entry.weight === 'light') {
        expect(source, entry.id).not.toMatch(/useCanvasScene|<ShaderBackground|<canvas/);
      }
    }
  });
});

describe('backgrounds demos', () => {
  it('render on the server with their static fallback only', () => {
    for (const entry of entries) {
      const html = renderToString(<entry.Demo />);
      expect(html, entry.id).toContain('aria-hidden="true"');
      expect(html, entry.id).not.toContain('<canvas');
    }
  });

  it('render in a browser without WebGL: shader effects keep their fallback', () => {
    for (const entry of entries) {
      const { container, unmount } = render(<entry.Demo />);
      const layer = container.querySelector('[aria-hidden="true"]');
      expect(layer, entry.id).not.toBeNull();
      if (entry.weight === 'heavy') expect(container.querySelector('canvas'), entry.id).toBeNull();
      expect(container.textContent).toContain('Create a coin');
      unmount();
    }
  });

  it('render every shader effect through WebGL, then free the context', () => {
    for (const entry of entries.filter((e) => e.weight === 'heavy')) {
      webgl = fakeWebGL();
      const { container, unmount } = render(<entry.Demo />);
      expect(container.querySelector('canvas'), entry.id).not.toBeNull();
      expect(webgl.calls.draws, entry.id).toBeGreaterThan(0);
      const fragment = webgl.calls.sources[1] ?? '';
      expect(fragment, entry.id).toContain('precision');
      expect(fragment, entry.id).toContain('gl_FragColor');
      expect(webgl.calls.uniforms.has('uPrimary'), entry.id).toBe(true);
      unmount();
      expect(webgl.calls.lost, entry.id).toBe(1);
    }
  });

  it('draw every canvas effect with a 2D context', () => {
    for (const entry of entries.filter((e) => e.weight === 'medium')) {
      ctx2d = fake2d();
      const { unmount } = render(<entry.Demo />);
      const { fills, strokes, texts } = ctx2d.calls;
      expect(fills + strokes + texts, entry.id).toBeGreaterThan(0);
      unmount();
    }
  });
});

/** A minimal shader background, standing in for any WebGL effect built on `ShaderBackground`. */
const TEST_FRAGMENT = fragmentShader('void main() { gl_FragColor = vec4(1.0); }');
function TestShader() {
  return <ShaderBackground fragment={TEST_FRAGMENT} fallback={<p>static look</p>} />;
}

describe('motion and visibility', () => {
  it('draws a single still frame under reduced motion, with no animation loop', () => {
    h.reduced = true;
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    webgl = fakeWebGL();
    render(<TestShader />);
    expect(webgl.calls.draws).toBeGreaterThan(0);
    ctx2d = fake2d();
    render(<DotGrid />);
    expect(ctx2d.calls.fills).toBeGreaterThan(0);
    expect(raf).not.toHaveBeenCalled();
  });

  it('runs the loop only while the effect is on screen', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    webgl = fakeWebGL();
    const props = { fragment: 'void main() {}', colors: FALLBACK_THEME_COLORS };
    const { rerender } = render(<ShaderSurface {...props} inView={false} />);
    expect(raf).not.toHaveBeenCalled();
    rerender(<ShaderSurface {...props} inView />);
    expect(raf).toHaveBeenCalledTimes(1);
  });

  it('shows the fallback when the shader cannot be built', () => {
    webgl = fakeWebGL();
    webgl.gl.getShaderParameter = () => false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(
      <ShaderSurface
        fragment="broken"
        inView
        colors={FALLBACK_THEME_COLORS}
        fallback={<p>static look</p>}
      />,
    );
    expect(container.textContent).toBe('static look');
    expect(warn).toHaveBeenCalled();
  });

  it('follows a theme change in the still frame', async () => {
    h.reduced = true;
    webgl = fakeWebGL();
    render(<TestShader />);
    const before = webgl.calls.draws;
    await act(async () => {
      document.documentElement.style.setProperty('--color-primary', 'rgb(10 200 30)');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(webgl.calls.draws).toBeGreaterThan(before);
    document.documentElement.style.removeProperty('--color-primary');
  });
});

describe('colour helpers', () => {
  it('parses hex and rgb() colours', () => {
    expect(parseColor('#ffffff')).toEqual([1, 1, 1]);
    expect(parseColor('#f00')).toEqual([1, 0, 0]);
    expect(parseColor('rgb(0, 51, 255)')).toEqual([0, 0.2, 1]);
    expect(parseColor('rgb(0 51 255 / 0.5)')).toEqual([0, 0.2, 1]);
    expect(parseColor('tomato')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });

  it('applies valid overrides on top of the theme', () => {
    const resolved = resolveColors(FALLBACK_THEME_COLORS, { primary: '#000000', accent: 'nope' });
    expect(resolved.primary).toEqual([0, 0, 0]);
    expect(resolved.accent).toEqual(FALLBACK_THEME_COLORS.accent);
    expect(resolved.background).toEqual(FALLBACK_THEME_COLORS.background);
  });

  it('tells dark and light backgrounds apart, and writes canvas colours', () => {
    expect(isDarkColor([0.05, 0.05, 0.08])).toBe(true);
    expect(isDarkColor([0.98, 0.98, 0.99])).toBe(false);
    expect(mixRgb([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
    expect(rgbCss([1, 0, 0])).toBe('rgb(255 0 0)');
    expect(rgbCss([0, 0, 1], 0.25)).toBe('rgb(0 0 255 / 0.250)');
  });
});

describe('safety', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
    );

  it('never loads remote assets nor runs generated code', () => {
    for (const file of files(FAMILY_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /\bfetch\(|new Function|\beval\(|new Worker|WebAssembly|dangerouslySetInnerHTML|https?:\/\//,
      );
    }
  });
});
