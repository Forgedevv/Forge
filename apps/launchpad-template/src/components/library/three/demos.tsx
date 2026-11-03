import { DemoStage } from '../backgrounds/lib/DemoStage';
import { CoinRain } from './CoinRain';
import { FloatingCoin } from './FloatingCoin';
import { GlossySculpture } from './GlossySculpture';
import { OrbMascot } from './OrbMascot';
import { ParticleBlob } from './ParticleBlob';

/** Showcase demos of the 3D family: each scene beside a sample launchpad hero. */

const RIGHT_HALF = { position: 'absolute', inset: 0, left: '42%' } as const;

export function FloatingCoinDemo() {
  return (
    <DemoStage align="left">
      <div style={RIGHT_HALF}>
        <FloatingCoin monogram="M" />
      </div>
    </DemoStage>
  );
}

export function ParticleBlobDemo() {
  return (
    <DemoStage align="left" title="A coin with a pulse">
      <div style={RIGHT_HALF}>
        <ParticleBlob />
      </div>
    </DemoStage>
  );
}

export function OrbMascotDemo() {
  return (
    <DemoStage align="left" title="Say hi to Orbi">
      <div style={RIGHT_HALF}>
        <OrbMascot />
      </div>
    </DemoStage>
  );
}

export function GlossySculptureDemo() {
  return (
    <DemoStage align="left" title="Built to last">
      <div style={RIGHT_HALF}>
        <GlossySculpture />
      </div>
    </DemoStage>
  );
}

export function CoinRainDemo() {
  return (
    <DemoStage title="Your coin is live">
      <CoinRain />
    </DemoStage>
  );
}
