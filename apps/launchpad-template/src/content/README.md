# src/content - FREE ZONE

Texts of the site. The tagline and the about text come from `forge.config.json#content`; UI strings
live in `index.ts`. Plain text only: no network call, no dynamic URL.

Every section reads its copy from `content` (`values`, `market`, `howItWorks`, `launchpadCoin`, `faq`,
`closing`, `create`, `footer`): lists are arrays of plain objects rendered with `.map()`.
