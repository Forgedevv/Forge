import Explore from '@/components/Explore';
import Page from '@/components/ui/Page/Page';
import { HomeHero } from '@/components/home/HomeHero';
import { ValueStrip } from '@/components/home/ValueStrip';
import { HowItWorks } from '@/components/home/HowItWorks';
import { LaunchpadCoin } from '@/components/home/LaunchpadCoin';
import { Faq } from '@/components/home/Faq';
import { ClosingCta } from '@/components/home/ClosingCta';

/**
 * Home page (FREE ZONE). A complete page on day one, before any coin exists: hero, selling points,
 * the market (compact while empty), how it works, the launchpad coin, questions and a closing call
 * to action. Every section is optional and can be reordered, restyled or replaced.
 */
export default function Index() {
  return (
    <Page>
      <div className="launchpad-home">
        <HomeHero />
        <ValueStrip />
        <Explore />
        <HowItWorks />
        <LaunchpadCoin />
        <Faq />
        <ClosingCta />
      </div>
    </Page>
  );
}
