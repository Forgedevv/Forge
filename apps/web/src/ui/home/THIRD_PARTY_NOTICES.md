# Third-party notices

FORGE's scroll motion (`motion.ts`), camera path (`camera-path.ts`), scene geometry, character, textures, copy, and application code are newly authored; no reference artwork or character-animation tracks are included. Earlier revisions adapted the spring response of Junni's MIT-licensed `Scroller` ([next.junni.co.jp](https://github.com/junni-inc/next.junni.co.jp)); that code has been replaced by FORGE's own continuous scroll model and is no longer included.

Three.js, Cannon ES, and Lethargy retain their respective notices in their installed packages. Lethargy is still declared in `apps/web/package.json` but is no longer imported by the homepage. The rendering dependencies are pinned in `apps/web/package.json`: `three` 0.186.1, `cannon-es` 0.20.0, and `lethargy` 1.0.9 (MIT), with `@types/three` 0.186.0 (MIT) for development.
