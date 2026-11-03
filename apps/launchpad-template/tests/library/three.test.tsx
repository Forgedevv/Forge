// @vitest-environment jsdom
import '../helpers/dom-setup';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ reduced: false }));

vi.mock('@/components/library/shared/useReducedMotion', () => ({
  useReducedMotion: () => h.reduced,
}));

import { entries } from '@/components/library/three';
import { SceneFrame } from '@/components/library/three/lib/SceneFrame';

const SRC = join(process.cwd(), 'src');
const FAMILY_DIR = join(SRC, 'components/library/three');

let webglAvailable = false;

beforeEach(() => {
  h.reduced = false;
  webglAvailable = false;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (kind: string) {
    return (webglAvailable && kind.startsWith('webgl') ? {} : null) as never;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('3D catalogue', () => {
  it('has unique kebab-case ids and complete heavy entries', () => {
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      expect(entry.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(entry.family).toBe('three');
      expect(entry.weight).toBe('heavy');
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.moods.length).toBeGreaterThan(0);
    }
  });

  it('points every importPath at a file that exports the named component', async () => {
    for (const entry of entries) {
      expect(entry.importPath).toBe(`@/components/library/three/${entry.exportName}`);
      const file = join(SRC, `${entry.importPath.replace('@/', '')}.tsx`);
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(
        `../../src/components/library/three/${entry.exportName}.tsx`
      )) as Record<string, unknown>;
      expect(typeof mod[entry.exportName], entry.exportName).toBe('function');
    }
  });

  it('loads three.js lazily: entry files only reach the scene through next/dynamic', () => {
    for (const entry of entries) {
      const source = readFileSync(join(FAMILY_DIR, `${entry.exportName}.tsx`), 'utf8');
      // Type-only imports are erased at build time.
      expect(source, entry.id).not.toMatch(
        /^import (?!type ).* from '(three|@react-three\/[a-z]+)'/m,
      );
      expect(source, entry.id).not.toMatch(/^import (?!type ).* from '\.\/scenes\//m);
      expect(source, entry.id).toMatch(/dynamic\(\s*\(\) => import\('\.\/scenes\//);
      expect(source, entry.id).toContain('ssr: false');
    }
  });
});

describe('3D demos', () => {
  it('render on the server with their static fallback', () => {
    for (const entry of entries) {
      const html = renderToString(<entry.Demo />);
      expect(html, entry.id).toContain('aria-hidden="true"');
      expect(html, entry.id).not.toContain('<canvas');
    }
  });

  it('keep their fallback in a browser without WebGL', () => {
    for (const entry of entries) {
      const { container, unmount } = render(<entry.Demo />);
      expect(container.querySelector('[aria-hidden="true"]'), entry.id).not.toBeNull();
      expect(container.querySelector('canvas'), entry.id).toBeNull();
      unmount();
    }
  });

  it('fall back to the static look when a scene fails at runtime', () => {
    webglAvailable = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('context lost');
    }
    const { container } = render(
      <SceneFrame fallback={<p>static coin</p>}>{() => <Broken />}</SceneFrame>,
    );
    expect(container.textContent).toBe('static coin');
    expect(warn).toHaveBeenCalled();
  });
});

describe('safety', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
    );

  it('never downloads models, textures, HDRs or fonts', () => {
    for (const file of files(FAMILY_DIR)) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(
        /\bfetch\(|useGLTF|useTexture|useFBX|TextureLoader|GLTFLoader|preset=|<Text\b|https?:\/\//,
      );
      expect(source, file).not.toMatch(/new Function|\beval\(|new Worker|WebAssembly/);
    }
  });
});
