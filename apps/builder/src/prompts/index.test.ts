import { describe, expect, it } from 'vitest';
import { specFixture } from '../pipeline/test-fakes.js';
import { builderSystemPrompt, createTaskPrompt, modifyTaskPrompt } from './index.js';

const system = builderSystemPrompt();

/** Index of a heading line of the system prompt (fails when missing). */
function section(title: string): number {
  const at = system.indexOf(`\n## ${title}\n`);
  expect(at, `section "${title}"`).toBeGreaterThan(0);
  return at;
}

describe('builder system prompt', () => {
  it('keeps the zones, locked files and security rules', () => {
    for (const locked of [
      'src/forge/',
      '`onchain`',
      'src/pages/_app.*',
      'src/pages/_document.*',
      'src/pages/creator-fees.*',
      'src/components/modes/',
      'next.config.*',
      'package.json',
    ]) {
      expect(system).toContain(locked);
    }
    for (const rule of [
      'No Solana address',
      'No external script',
      'dangerouslySetInnerHTML',
      'No environment variables',
      'getServerSideProps',
      'No hidden, zero-width or bidirectional Unicode characters',
      'A single violation discards',
      'untrusted data',
    ]) {
      expect(system).toContain(rule);
    }
  });

  it('puts the rules before the design brief', () => {
    const rules = [
      section('Zones you may change'),
      section('Never change'),
      section('Security rules'),
      section('Client input'),
    ];
    const brief = section('Design brief');
    for (const at of rules) expect(at).toBeLessThan(brief);
  });

  it('asks for the whole site, day one, a fitting layout and a logo', () => {
    const brief = system.slice(section('Design brief'));
    for (const topic of [
      '### Day one',
      '### Layout',
      '### Every page',
      '### Logo and illustrations',
      '### Quality checklist',
      'create-pool',
      'src/pages/token/[tokenId].tsx',
      'src/pages/about.tsx',
      '/creator-fees',
      'src/components/Logo.tsx',
      'prefers-reduced-motion',
      'WCAG AA',
      '390 px',
    ]) {
      expect(brief).toContain(topic);
    }
  });

  it('ends with a self-check before the summary', () => {
    const work = system.slice(section('How to work'));
    expect(work).toMatch(/Before answering, check:/);
    expect(work).toMatch(/summary of what you changed/);
  });

  it('has no hidden or bidirectional characters', () => {
    expect(system).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
  });
});

describe('createTaskPrompt', () => {
  it('asks for the whole site and keeps the brief last, as data', () => {
    const spec = specFixture();
    const prompt = createTaskPrompt(spec);
    const start = prompt.indexOf('<client_request>');
    const instructions = prompt.slice(0, start);
    expect(instructions).toContain('the whole site');
    expect(instructions).toContain('src/components/Logo.tsx');
    expect(instructions).toContain('no coins yet');
    expect(instructions).toContain('self-check');
    expect(instructions).not.toContain(spec.name);
    expect(prompt.trimEnd().endsWith('</client_request>')).toBe(true);
    const block = JSON.parse(
      prompt.slice(start + '<client_request>'.length, prompt.lastIndexOf('</')),
    );
    expect(block.launchpadCoin).toEqual({
      name: spec.launchpadCoin.name,
      symbol: spec.launchpadCoin.symbol,
      description: spec.launchpadCoin.description,
    });
  });
});

describe('modifyTaskPrompt', () => {
  it('changes only what is asked', () => {
    const prompt = modifyTaskPrompt('Make the footer green', { name: 'MoonPad', slug: 'moonpad' });
    const instructions = prompt.slice(0, prompt.indexOf('<client_request>'));
    expect(instructions).toContain('change only what the request asks for');
    expect(instructions).toContain('Do not redesign');
    expect(instructions).not.toMatch(/whole site|Logo\.tsx|self-check/);
  });
});
