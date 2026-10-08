import { hexRGB, type RGB } from './paint';

/** The moods a Muse can show. Each maps to a moment of the FORGE journey. */
export const MUSE_MOODS = [
  'idle',
  'listening',
  'thinking',
  'building',
  'waiting_approval',
  'success',
  'error',
  'sleeping',
] as const;
export type MuseMood = (typeof MUSE_MOODS)[number];
/** Moods reached through interaction only. */
export type MuseState = MuseMood | 'dizzy';

export interface EyePose {
  lid: number;
  tilt: number;
  smile: number;
  star: number;
  closed: number;
  ring: number;
  size: number;
  asym: number;
}

/** Values that ease towards the current mood every frame. */
export interface SmoothPose {
  glow: number;
  orbit: number;
  orbitR: number;
  sag: number;
  breathe: number;
  breatheRate: number;
  float: number;
  roll: number;
  sink: number;
  bounce: number;
}
export const SMOOTH_KEYS = [
  'glow',
  'orbit',
  'orbitR',
  'sag',
  'breathe',
  'breatheRate',
  'float',
  'roll',
  'sink',
  'bounce',
] as const satisfies readonly (keyof SmoothPose)[];

export interface MoodConfig extends SmoothPose {
  label: string;
  tint: RGB | null;
  tintAmt: number;
  dim: number;
  look: readonly [number, number] | null;
  beat: number;
  zz: number;
  ripple: number;
  flicker: number;
  wobble: number;
  sparkle: number;
  think: number;
  eye: EyePose;
}

export const EYE_REST: EyePose = {
  lid: 0,
  tilt: 0,
  smile: 0,
  star: 0,
  closed: 0,
  ring: 0,
  size: 1,
  asym: 0,
};
const BASE: Omit<MoodConfig, 'label' | 'eye'> = {
  glow: 1,
  orbit: 0.55,
  orbitR: 1,
  sag: 0,
  breathe: 0.022,
  breatheRate: 1.6,
  float: 1,
  roll: 0,
  sink: 0,
  bounce: 0,
  tint: null,
  tintAmt: 0,
  dim: 1,
  look: null,
  beat: 0,
  zz: 0,
  ripple: 0,
  flicker: 0,
  wobble: 0,
  sparkle: 0,
  think: 0,
};
type MoodInput = Partial<Omit<MoodConfig, 'eye' | 'tint'>> & {
  label: string;
  tint?: string;
  eye?: Partial<EyePose>;
};
const mood = ({ tint, eye, ...rest }: MoodInput): MoodConfig => ({
  ...BASE,
  ...rest,
  tint: tint ? hexRGB(tint) : null,
  eye: { ...EYE_REST, ...eye },
});

export const MOODS: Record<MuseState, MoodConfig> = {
  idle: mood({ label: 'Idle' }),
  listening: mood({
    label: 'Listening',
    glow: 1.2,
    orbit: 0.3,
    orbitR: 0.94,
    breathe: 0.03,
    breatheRate: 2.1,
    float: 0.7,
    tint: '#C9B2FF',
    tintAmt: 0.16,
    roll: 0.05,
    ripple: 1,
    eye: { size: 1.12, smile: 0.12 },
  }),
  thinking: mood({
    label: 'Thinking',
    orbit: 1.1,
    tint: '#6E7CFF',
    tintAmt: 0.34,
    look: [0.62, -0.7],
    think: 1,
    eye: { lid: 0.14, size: 0.98, tilt: -0.05, asym: -0.07 },
  }),
  building: mood({
    label: 'Building',
    glow: 1.28,
    orbit: 3.6,
    orbitR: 0.9,
    breathe: 0,
    float: 0.35,
    tint: '#FF5FCF',
    tintAmt: 0.14,
    beat: 1,
    look: [0, 0.3],
    eye: { lid: 0.34, tilt: -0.07, size: 0.94 },
  }),
  waiting_approval: mood({
    label: 'Waiting for approval',
    glow: 1.1,
    orbit: 0.8,
    roll: 0.26,
    bounce: 1,
    tint: '#FF8BE0',
    tintAmt: 0.12,
    eye: { size: 1.14, asym: 0.16 },
  }),
  success: mood({
    label: 'Live',
    glow: 1.55,
    orbit: 1.8,
    orbitR: 1.1,
    float: 1.2,
    tint: '#FFC4F2',
    tintAmt: 0.18,
    bounce: 0.55,
    sparkle: 1,
    eye: { star: 1, size: 1.1 },
  }),
  error: mood({
    label: 'Error',
    glow: 0.5,
    orbit: 0.2,
    orbitR: 0.96,
    sag: 1,
    breathe: 0.012,
    float: 0.3,
    sink: 0.07,
    roll: -0.06,
    tint: '#6E4566',
    tintAmt: 0.5,
    dim: 0.66,
    flicker: 1,
    look: [0, 0.4],
    eye: { lid: 0.44, tilt: 0.34, size: 0.9 },
  }),
  sleeping: mood({
    label: 'Sleeping',
    glow: 0.6,
    orbit: 0.1,
    breathe: 0.05,
    breatheRate: 0.85,
    float: 0.45,
    sink: 0.04,
    roll: 0.08,
    tint: '#3E3670',
    tintAmt: 0.4,
    dim: 0.82,
    zz: 1,
    look: [0, 0.18],
    eye: { closed: 1 },
  }),
  dizzy: mood({
    label: 'Dizzy',
    orbit: 2.6,
    wobble: 1,
    tint: '#FF7BE5',
    tintAmt: 0.15,
    eye: { ring: 1, size: 1.05 },
  }),
};

export const isMuseMood = (value: unknown): value is MuseMood =>
  typeof value === 'string' && (MUSE_MOODS as readonly string[]).includes(value);
