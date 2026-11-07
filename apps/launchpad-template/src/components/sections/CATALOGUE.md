# Visual library catalogue

<!-- Generated from src/components/sections/registry.ts and src/components/library/registry.ts. -->

Ready-made sections and effects for the home page and footer. Every section reads its copy from
`src/content/index.ts` by default and takes the same copy as props; every effect follows the
theme colours (`--color-primary`, `--color-accent`, `--color-bg`, `--color-text`), works on phones
and stops moving under "reduce motion". Heavy effects load after the page, only on screens
that can run them, and show a static look elsewhere.

## Section variants

Pick one variant per slot, or keep the template section and restyle it. Use a variant by
importing it in place of the template section it replaces; give it copy props only where the
brief needs other words than `content`.

### Hero (top of the home page)

Replaces `src/components/home/HomeHero.tsx`.

- `hero-split-coin` **Split with 3D coin**: Name rising letter by letter beside a spinning 3D coin stamped with the monogram, tagline coming into focus.
  `import { HeroSplitCoin } from '@/components/sections/hero/HeroSplitCoin';`
  Moods: playful, premium, bold. Weight: heavy. Options: monogram.
- `hero-particle-field` **Particle field**: Centred headline over a breathing sphere of thousands of particles; the eyebrow decodes like a signal.
  `import { HeroParticleField } from '@/components/sections/hero/HeroParticleField';`
  Moods: tech, premium, dark. Weight: heavy.
- `hero-poster-type` **Poster type**: The name in giant uppercase type, one word per line rising out of its mask, with a draggable ticker band below.
  `import { HeroPosterType } from '@/components/sections/hero/HeroPosterType';`
  Moods: bold, playful, retro. Weight: medium. Options: tickerWords.
- `hero-terminal` **Terminal**: The monogram drawn in live ASCII glyphs that ripple around the pointer, lines typing themselves under the name.
  `import { HeroTerminal } from '@/components/sections/hero/HeroTerminal';`
  Moods: tech, retro, dark. Weight: medium. Options: phrases, monogram.
- `hero-retro-grid` **Retro horizon**: A neon floor scrolling towards a striped sun, the name flipping up letter by letter with a glow.
  `import { HeroRetroGrid } from '@/components/sections/hero/HeroRetroGrid';`
  Moods: retro, playful, bold. Weight: light. Options: sun.
- `hero-sculpture` **Glossy sculpture**: A glossy 3D knot, ring or gem turning in studio light beside a name uncovered like a curtain.
  `import { HeroSculpture } from '@/components/sections/hero/HeroSculpture';`
  Moods: premium, calm, organic. Weight: heavy. Options: shape: 'knot' | 'torus' | 'gem', reverse.
- `hero-dot-field` **Dot field**: A calm field of dots lighting up around the pointer, a big name and a line rotating through the selling points.
  `import { HeroDotField } from '@/components/sections/hero/HeroDotField';`
  Moods: tech, calm, premium. Weight: medium. Options: words.
- `hero-halo` **Halo**: A rotating halo of the brand colours behind a centred name in the flowing brand gradient, with a magnetic button.
  `import { HeroHalo } from '@/components/sections/hero/HeroHalo';`
  Moods: premium, bold, dark. Weight: light.

### Selling points (under the hero)

Replaces `src/components/home/ValueStrip.tsx`.

- `values-spotlight` **Spotlight bento**: Selling points as a bento of cards lit by a soft light following the pointer.
  `import { ValuesSpotlight } from '@/components/sections/values/ValuesSpotlight';`
  Moods: tech, premium, dark. Weight: medium. Options: eyebrow, title (optional heading).
- `values-tilt` **Tilt cards**: Cards tilting towards the pointer with a glare and a big outlined number each.
  `import { ValuesTilt } from '@/components/sections/values/ValuesTilt';`
  Moods: playful, bold, premium. Weight: medium. Options: eyebrow, title (optional heading).
- `values-marquee` **Ticker bands**: Two giant draggable ticker bands of the selling points drifting in opposite directions, details below.
  `import { ValuesMarquee } from '@/components/sections/values/ValuesMarquee';`
  Moods: bold, playful, retro. Weight: medium.
- `values-editorial` **Editorial list**: Thin rules, big numbers and a highlighter stroke drawn behind each title as it enters.
  `import { ValuesEditorial } from '@/components/sections/values/ValuesEditorial';`
  Moods: calm, premium, organic. Weight: light. Options: eyebrow, title (optional heading).
- `values-terminal` **Terminal log**: Selling points printed in a terminal window, each title decoding like a signal as it scrolls in.
  `import { ValuesTerminal } from '@/components/sections/values/ValuesTerminal';`
  Moods: tech, dark, retro. Weight: medium. Options: eyebrow, title (optional heading).

### How it works

Replaces `src/components/home/HowItWorks.tsx`.

- `steps-stack` **Stacking cards**: Steps as cards that pin and stack on top of each other while the page scrolls.
  `import { StepsStack } from '@/components/sections/steps/StepsStack';`
  Moods: bold, premium, tech, playful. Weight: medium.
- `steps-timeline` **Timeline**: A vertical gradient line with glowing nodes beside a sticky heading, steps rising in turn.
  `import { StepsTimeline } from '@/components/sections/steps/StepsTimeline';`
  Moods: calm, premium, tech. Weight: medium.
- `steps-rings` **Progress rings**: Rings filling one more third each step, like a bonding curve reaching graduation.
  `import { StepsRings } from '@/components/sections/steps/StepsRings';`
  Moods: tech, playful. Weight: medium.
- `steps-scroll-story` **Scroll story**: Each step as a large sentence whose words light up one by one as the reader scrolls.
  `import { StepsScrollStory } from '@/components/sections/steps/StepsScrollStory';`
  Moods: calm, premium, organic. Weight: medium.
- `steps-deck` **Card deck**: Steps as a fanned deck of cards with giant numbers; a click or the arrow keys bring one to the front.
  `import { StepsDeck } from '@/components/sections/steps/StepsDeck';`
  Moods: playful, bold, premium. Weight: medium.

### The launchpad coin

Replaces `src/components/home/LaunchpadCoin.tsx`.

- `coin-spotlight` **Coin on stage**: The launchpad coin as a spinning 3D coin in a pool of light, its ticker in the flowing brand gradient.
  `import { CoinSpotlight } from '@/components/sections/coin/CoinSpotlight';`
  Moods: playful, premium, bold. Weight: heavy.
- `coin-rain-banner` **Coin rain**: 3D coins stamped with the ticker tumbling behind a centred celebration banner.
  `import { CoinRainBanner } from '@/components/sections/coin/CoinRainBanner';`
  Moods: playful, bold. Weight: heavy.
- `coin-torus` **Woven ring**: The coin beside a ring woven from glowing threads that turns and tilts towards the pointer.
  `import { CoinTorus } from '@/components/sections/coin/CoinTorus';`
  Moods: tech, premium, dark. Weight: medium.
- `coin-ticker` **Giant ticker**: The ticker in giant outlined letters dropping in one by one, name and description beneath.
  `import { CoinTicker } from '@/components/sections/coin/CoinTicker';`
  Moods: bold, retro. Weight: light.

### Questions

Replaces `src/components/home/Faq.tsx`.

- `faq-accordion` **Accordion**: Questions in a centred column, answers gliding open.
  `import { FaqAccordion } from '@/components/sections/faq/FaqAccordion';`
  Moods: calm, premium, tech, playful. Weight: medium.
- `faq-split` **Sticky split**: A sticky heading on the left, answers opening on the right, the first one open.
  `import { FaqSplit } from '@/components/sections/faq/FaqSplit';`
  Moods: premium, tech, calm. Weight: medium. Options: intro.
- `faq-cards` **Question cards**: All answers visible in a grid of cards marked with a big brand-coloured "?".
  `import { FaqCards } from '@/components/sections/faq/FaqCards';`
  Moods: playful, bold. Weight: medium.

### Closing call to action

Replaces `src/components/home/ClosingCta.tsx`.

- `closing-grid` **Neon floor**: The closing call to action in a card over a neon floor scrolling towards the viewer.
  `import { ClosingGrid } from '@/components/sections/closing/ClosingGrid';`
  Moods: retro, tech. Weight: light.
- `closing-filaments` **Filaments**: Glowing filaments rising and parting around the pointer behind a title rising word by word.
  `import { ClosingFilaments } from '@/components/sections/closing/ClosingFilaments';`
  Moods: premium, organic, dark. Weight: medium.
- `closing-magnetic` **Magnetic statement**: A big statement rising line by line beside a magnetic button glowing in a soft halo.
  `import { ClosingMagnetic } from '@/components/sections/closing/ClosingMagnetic';`
  Moods: bold, premium. Weight: light.
- `closing-marquee` **Giant ticker**: The primary action repeating in huge type across a draggable band, title beneath.
  `import { ClosingMarquee } from '@/components/sections/closing/ClosingMarquee';`
  Moods: bold, playful, retro. Weight: medium.

### Footer (every page)

Replaces `src/components/SiteFooter.tsx`.

- `footer-wordmark` **Giant wordmark**: The site name in giant type across the full width, uncovered like a curtain.
  `import { FooterWordmark } from '@/components/sections/footer/FooterWordmark';`
  Moods: bold, premium. Weight: light. Options: links.
- `footer-columns` **Three columns**: Logo and tagline, the links stacked, the legal note: a quiet classic ending.
  `import { FooterColumns } from '@/components/sections/footer/FooterColumns';`
  Moods: calm, tech, premium. Weight: light. Options: links.
- `footer-marquee` **Name ticker**: A slow ticker of the site name in outlined giant type above the links.
  `import { FooterMarquee } from '@/components/sections/footer/FooterMarquee';`
  Moods: playful, retro, bold. Weight: medium. Options: links.
- `footer-minimal` **Minimal line**: Logo, links and the legal note on a single centred line.
  `import { FooterMinimal } from '@/components/sections/footer/FooterMinimal';`
  Moods: calm, premium. Weight: light. Options: links.

## Effects

The building blocks of the sections, to compose sections of your own. Read the props in the
file before using one: each prop is documented there.

### Animated backgrounds

- `dot-grid` **Dot grid glow**: A quiet grid of small dots that swell and light up in the theme colours around the pointer, with a soft ripple; a hero, features grid or footer.
  `import { DotGrid } from '@/components/library/backgrounds/DotGrid';`
  Moods: tech, calm, premium. Weight: medium (JS or 2D canvas).
- `ascii-monogram` **ASCII monogram**: A character (the coin initial, a symbol) drawn as a flickering ASCII glyph field with a sweeping light, pulsing rings and a pointer wake; a retro-tech hero visual.
  `import { AsciiMonogram } from '@/components/library/backgrounds/AsciiMonogram';`
  Moods: retro, tech, playful, dark. Weight: medium (JS or 2D canvas).
- `filament-strands` **Filament strands**: A sheaf of fine glowing fibres rising, pinching and fanning out, with sparks travelling along them and parting around the pointer; a hero visual or a horizontal divider.
  `import { FilamentStrands } from '@/components/library/backgrounds/FilamentStrands';`
  Moods: organic, premium, tech, calm. Weight: medium (JS or 2D canvas).
- `woven-torus` **Woven torus**: A ring woven from dozens of fine threads turning slowly in perspective, front threads glowing and the weave flowing; a hypnotic hero visual beside the headline.
  `import { WovenTorus } from '@/components/library/backgrounds/WovenTorus';`
  Moods: premium, tech, calm, dark. Weight: medium (JS or 2D canvas).
- `perspective-grid` **Perspective grid**: A glowing grid floor gliding towards a bright horizon, with an optional striped retro sun, in pure CSS; a retro, arcade or tech hero and footer band.
  `import { PerspectiveGrid } from '@/components/library/backgrounds/PerspectiveGrid';`
  Moods: retro, tech, bold, playful. Weight: light (CSS or SVG).
- `conic-glow` **Conic glow**: A soft halo of the theme colours turning slowly around a calm centre, with a thin spinning ring, in pure CSS; frames a headline, countdown or mint button.
  `import { ConicGlow } from '@/components/library/backgrounds/ConicGlow';`
  Moods: premium, bold, calm. Weight: light (CSS or SVG).

### Text and numbers

- `split-reveal` **Split reveal**: Hero headline whose letters or words slide up out of masks (or flip up) one after the other when it enters the screen; for the hero title and big section titles.
  `import { SplitReveal } from '@/components/library/text/SplitReveal';`
  Moods: premium, bold, tech. Weight: medium (JS or 2D canvas).
- `blur-words` **Blur-in words**: Words rise and come into focus one by one, like a camera pulling focus; for a hero subtitle, a manifesto line or a section intro.
  `import { BlurWords } from '@/components/library/text/BlurWords';`
  Moods: premium, calm, dark. Weight: medium (JS or 2D canvas).
- `scroll-words` **Scroll-lit paragraph**: A mission paragraph whose words light up from dim and blurred to full colour as the visitor scrolls through it; between two sections.
  `import { ScrollWords } from '@/components/library/text/ScrollWords';`
  Moods: premium, calm, dark. Weight: medium (JS or 2D canvas).
- `scramble-text` **Scramble decode**: Letters cycle through random glyphs and lock in from left to right, like a terminal decoding; for tech labels, a contract teaser or a "$COIN IS LIVE" headline.
  `import { ScrambleText } from '@/components/library/text/ScrambleText';`
  Moods: tech, dark, retro. Weight: medium (JS or 2D canvas).
- `shimmer-text` **Shimmer and gradient text**: Pure CSS light inside the letters: a bright band sweeping across muted status text, or the brand gradient flowing through a headline word.
  `import { ShimmerText } from '@/components/library/text/ShimmerText';`
  Moods: premium, playful, tech. Weight: light (CSS or SVG).
- `flip-text` **Flip label**: Button and link labels whose letters roll over like little cubes on hover or focus, revealing a coloured face; pure CSS, for calls to action and navigation.
  `import { FlipText } from '@/components/library/text/FlipText';`
  Moods: playful, bold, tech. Weight: light (CSS or SVG).
- `odometer` **Odometer counter**: Mechanical digit columns that roll right to left to each new value with a small overshoot; for headline stats and live figures such as coins launched or volume.
  `import { Odometer } from '@/components/library/text/Odometer';`
  Moods: tech, premium, retro. Weight: light (CSS or SVG).
- `count-up` **Count-up number**: A number that counts up fast then settles softly when it enters the screen, in any Intl format ("$12.4M", "48,920+"); for the stats strip of a launchpad.
  `import { CountUp } from '@/components/library/text/CountUp';`
  Moods: bold, premium, calm. Weight: medium (JS or 2D canvas).
- `rotating-words` **Rotating words**: One slot of a headline that cycles words with a slide-up swap in the brand gradient: "Launch your [meme coin / community / next big idea]".
  `import { RotatingWords } from '@/components/library/text/RotatingWords';`
  Moods: playful, bold. Weight: light (CSS or SVG).
- `typewriter-text` **Typewriter**: Phrases typed character by character behind a blinking caret, held, erased and replaced; for a terminal-style launch status or a retro, tech-flavoured hero.
  `import { TypewriterText } from '@/components/library/text/TypewriterText';`
  Moods: tech, retro, dark. Weight: light (CSS or SVG).
- `mask-lines` **Masked lines**: A multi-line title whose lines slide up from behind masks or are uncovered like a curtain, one after the other; the editorial way to open a section.
  `import { MaskLines } from '@/components/library/text/MaskLines';`
  Moods: premium, calm, bold. Weight: medium (JS or 2D canvas).
- `marker-highlight` **Marker highlight**: Key words get a highlighter stroke, a self-drawing underline or a hand-drawn circle when they enter the screen; to stress the promise of a section.
  `import { MarkerHighlight } from '@/components/library/text/MarkerHighlight';`
  Moods: playful, organic, calm. Weight: light (CSS or SVG).

### Scroll, cards and navigation

- `smooth-scroll` **Smooth scroll**: Opt-in inertial wheel scrolling (Lenis) for the whole page, with anchor links travelling on the same soft curve; wrap the layout once. Off on touch and for reduced motion.
  `import { SmoothScroll } from '@/components/library/motion/SmoothScroll';`
  Moods: premium, calm. Weight: medium (JS or 2D canvas).
- `scroll-progress` **Scroll progress bar**: A thin primary-to-accent bar with a soft glow that fills along the top of the window as the visitor reads; for long pages such as the coin page or the docs.
  `import { ScrollProgress } from '@/components/library/motion/ScrollProgress';`
  Moods: tech, calm, premium. Weight: medium (JS or 2D canvas).
- `section-reveal` **Section reveal**: Blocks, or each card of a grid one after the other, fade in, rise and come into focus as they enter the screen; the everyday reveal for sections and card grids.
  `import { Reveal } from '@/components/library/motion/Reveal';`
  Moods: calm, premium, organic. Weight: medium (JS or 2D canvas).
- `stack-cards` **Stacked cards**: Cards that stick near the top and pile up as the visitor scrolls, the previous ones shrinking and dimming; for "How it works" steps, a roadmap or tokenomics.
  `import { StackCards } from '@/components/library/motion/StackCards';`
  Moods: premium, bold, dark. Weight: medium (JS or 2D canvas).
- `drag-marquee` **Draggable marquee**: An endless ticker that drifts, can be grabbed and thrown with inertia, and stops on hover or focus; for trending coins ("$PEPE $BONK $NAPS") or a slogan band.
  `import { DragMarquee } from '@/components/library/motion/DragMarquee';`
  Moods: playful, bold, tech. Weight: medium (JS or 2D canvas).
- `tilt-card` **Tilt card**: A card that tilts in 3D toward the pointer on a spring with a coloured reflection gliding across it; for a featured coin, a launch tier or a value card.
  `import { TiltCard } from '@/components/library/motion/TiltCard';`
  Moods: premium, playful, tech. Weight: medium (JS or 2D canvas).
- `spotlight-grid` **Spotlight bento grid**: A bento grid of value cards lit by one shared spotlight that follows the pointer, glowing on the borders it passes; for "Why launch here" or a features overview.
  `import { SpotlightGrid } from '@/components/library/motion/SpotlightGrid';`
  Moods: premium, dark, tech. Weight: light (CSS or SVG).
- `hover-preview-list` **Hover preview list**: Rows that light up and slide on hover while a preview card follows the pointer on a spring; for a coin list, recent launches or articles.
  `import { HoverPreviewList } from '@/components/library/motion/HoverPreviewList';`
  Moods: premium, bold, calm. Weight: medium (JS or 2D canvas).
- `card-deck` **Card deck**: A fanned hand of cards where the chosen one stands in front and the others lean away; click or use the arrow keys to deal. For a community wall or featured launches.
  `import { CardDeck } from '@/components/library/motion/CardDeck';`
  Moods: playful, organic. Weight: light (CSS or SVG).
- `staggered-menu` **Staggered menu**: A full-height menu that opens in layers: brand-colour bands sweep in, then big numbered links rise one by one; for the header of a bolder launchpad.
  `import { StaggeredMenu } from '@/components/library/motion/StaggeredMenu';`
  Moods: bold, premium, playful. Weight: medium (JS or 2D canvas).
- `pill-nav` **Pill navigation**: A floating pill navigation bar where a solid pill glides to the current link and a soft one follows the pointer; the compact header of a launchpad.
  `import { PillNav } from '@/components/library/motion/PillNav';`
  Moods: calm, premium, playful. Weight: medium (JS or 2D canvas).
- `magnetic-button` **Magnetic button**: A call to action pulled toward the pointer like a magnet, its label drifting further for depth, with a brand glow on hover; for "Launch your coin".
  `import { MagneticButton } from '@/components/library/motion/MagneticButton';`
  Moods: playful, premium, bold. Weight: medium (JS or 2D canvas).
- `progress-ring` **Progress ring**: An SVG ring whose gradient arc sweeps to the value with a glowing head and fine ticks; for the bonding curve progress ("72% to graduation") or a holder goal.
  `import { ProgressRing } from '@/components/library/motion/ProgressRing';`
  Moods: tech, premium, dark. Weight: light (CSS or SVG).
- `arc-gauge` **Arc gauge**: A speedometer half gauge: segments light up from primary to accent while a needle swings to the value; for a hype meter, buy pressure or the curve.
  `import { ArcGauge } from '@/components/library/motion/ArcGauge';`
  Moods: tech, bold, retro. Weight: light (CSS or SVG).
- `bar-list` **Bar list**: A ranked list whose bars grow one after the other, the leader in the brand gradient; for top coins by volume, biggest holders or a leaderboard.
  `import { BarList } from '@/components/library/motion/BarList';`
  Moods: calm, tech. Weight: light (CSS or SVG).
- `smooth-accordion` **Smooth accordion**: FAQ rows that unfold with a natural height animation while the plus turns into a cross and the open row takes a brand tint; for the questions section.
  `import { SmoothAccordion } from '@/components/library/motion/SmoothAccordion';`
  Moods: calm, premium, organic. Weight: light (CSS or SVG).

### 3D scenes

- `floating-coin` **Floating coin**: A polished 3D metal coin with the ticker monogram embossed, spinning and floating under a soft studio light with sparkles; the signature object beside a hero headline or on a mint section.
  `import { FloatingCoin } from '@/components/library/three/FloatingCoin';`
  Moods: premium, playful, bold. Weight: heavy (WebGL or 3D, loaded after the page).
- `particle-blob` **Particle blob**: Thousands of glowing particles forming a breathing, swirling blob in the theme colours that swells towards the pointer; an AI, community or countdown hero centrepiece.
  `import { ParticleBlob } from '@/components/library/three/ParticleBlob';`
  Moods: tech, organic, dark, premium. Weight: heavy (WebGL or 3D, loaded after the page).
- `glossy-sculpture` **Glossy sculpture**: An abstract iridescent object (torus knot, ring or faceted gem) turning slowly in a soft studio light with theme-coloured reflections; a premium hero or features centrepiece.
  `import { GlossySculpture } from '@/components/library/three/GlossySculpture';`
  Moods: premium, bold, calm. Weight: heavy (WebGL or 3D, loaded after the page).
- `coin-rain` **Coin rain**: Dozens of small embossed metal coins tumbling down at different depths in the theme tints; a festive launch-success moment, closing call to action or meme-coin hero.
  `import { CoinRain } from '@/components/library/three/CoinRain';`
  Moods: playful, bold. Weight: heavy (WebGL or 3D, loaded after the page).
