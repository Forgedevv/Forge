// Lethargy 1.0.9 ships CommonJS JavaScript without declarations.
declare module 'lethargy' {
  type WheelInput = { deltaY: number } | { wheelDelta: number } | { detail: number };

  interface WheelFilter {
    check(event: WheelInput | { originalEvent: WheelInput }): -1 | 1 | false;
    isInertia(direction: -1 | 1): -1 | 1 | false;
    showLastUpDeltas(): Array<number | null>;
    showLastDownDeltas(): Array<number | null>;
  }

  const lethargy: {
    Lethargy: new (
      stability?: number,
      sensitivity?: number,
      tolerance?: number,
      delay?: number,
    ) => WheelFilter;
  };
  export = lethargy;
}
