import { AsciiMonogram } from './AsciiMonogram';
import { ConicGlow } from './ConicGlow';
import { DotGrid } from './DotGrid';
import { FilamentStrands } from './FilamentStrands';
import { DemoStage } from './lib/DemoStage';
import { PerspectiveGrid } from './PerspectiveGrid';
import { WovenTorus } from './WovenTorus';

/** Showcase demos of the backgrounds family: each effect behind a sample launchpad hero. */

export function DotGridDemo() {
  return (
    <DemoStage>
      <DotGrid />
    </DemoStage>
  );
}

export function AsciiMonogramDemo() {
  return (
    <DemoStage align="left" title="$MOON is live">
      <div style={{ position: 'absolute', inset: 0, left: '45%' }}>
        <AsciiMonogram text="M" />
      </div>
    </DemoStage>
  );
}

export function FilamentStrandsDemo() {
  return (
    <DemoStage align="bottom">
      <FilamentStrands />
    </DemoStage>
  );
}

export function WovenTorusDemo() {
  return (
    <DemoStage align="left">
      <WovenTorus x={0.72} />
    </DemoStage>
  );
}

export function PerspectiveGridDemo() {
  return (
    <DemoStage title="Enter the arcade" align="top">
      <PerspectiveGrid sun horizon={0.72} />
    </DemoStage>
  );
}

export function ConicGlowDemo() {
  return (
    <DemoStage title="Mint opens soon">
      <ConicGlow />
    </DemoStage>
  );
}
