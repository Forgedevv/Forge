import { AsciiMonogram } from './AsciiMonogram';
import { Aurora } from './Aurora';
import { ConicGlow } from './ConicGlow';
import { ContourField } from './ContourField';
import { DotGrid } from './DotGrid';
import { FilamentStrands } from './FilamentStrands';
import { FloatingLines } from './FloatingLines';
import { GrainMesh } from './GrainMesh';
import { LaserBeam } from './LaserBeam';
import { DemoStage } from './lib/DemoStage';
import { LightRays } from './LightRays';
import { LiquidBlob } from './LiquidBlob';
import { NoiseGradient } from './NoiseGradient';
import { PerspectiveGrid } from './PerspectiveGrid';
import { SilkVeil } from './SilkVeil';
import { WovenTorus } from './WovenTorus';

/** Showcase demos of the backgrounds family: each effect behind a sample launchpad hero. */

export function SilkVeilDemo() {
  return (
    <DemoStage align="left">
      <SilkVeil />
    </DemoStage>
  );
}

export function LightRaysDemo() {
  return (
    <DemoStage>
      <LightRays />
    </DemoStage>
  );
}

export function LaserBeamDemo() {
  return (
    <DemoStage align="left" title="Ignite the launch">
      <LaserBeam x={0.72} />
    </DemoStage>
  );
}

export function FloatingLinesDemo() {
  return (
    <DemoStage>
      <FloatingLines />
    </DemoStage>
  );
}

export function AuroraDemo() {
  return (
    <DemoStage align="bottom">
      <Aurora height={0.62} />
    </DemoStage>
  );
}

export function LiquidBlobDemo() {
  return (
    <DemoStage align="left">
      <LiquidBlob x={0.72} />
    </DemoStage>
  );
}

export function ContourFieldDemo() {
  return (
    <DemoStage align="bottom">
      <ContourField />
    </DemoStage>
  );
}

export function GrainMeshDemo() {
  return (
    <DemoStage>
      <GrainMesh />
    </DemoStage>
  );
}

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

export function NoiseGradientDemo() {
  return (
    <DemoStage>
      <NoiseGradient />
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
