import Head from 'next/head';
import { themeCss } from './index';

/** Injects the generated theme variables. Colours are validated hex strings (shared zod schema). */
export function ThemeStyle() {
  return (
    <Head>
      <style id="forge-theme">{themeCss}</style>
    </Head>
  );
}
