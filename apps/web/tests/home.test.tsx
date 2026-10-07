import { expect, it } from 'vitest';
import HomePage from '../app/page';
import { homeContent } from '../src/ui/home/content';

// The immersive homepage needs WebGL and browser stubs; its rendering and interactions are
// covered in src/ui/home/home.test.tsx. This test only guards the route wiring.
it('exposes the home route and its English copy', () => {
  expect(typeof HomePage).toBe('function');
  expect(homeContent.title).toContain('FORGE');
  expect(homeContent.create).toBe('Create my launchpad');
});
