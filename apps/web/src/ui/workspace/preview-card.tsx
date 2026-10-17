'use client';
import { siteHost } from './safe-url';
import { jobCopy } from './content/job';

/*
 * The preview of a build opens in its own tab, never in a frame of this page. The client site
 * forbids framing (`frame-ancestors 'none'` and X-Frame-Options DENY, in the locked security
 * headers of the template), and a framed site would not behave like the real one anyway: wallet
 * extensions do not inject into cross-site frames and the browser partitions its storage, so the
 * wallet connection could not be tried. A real tab, at a desktop or a phone size, shows the site
 * as its visitors will see it.
 */

/** Window sizes of the device preview (CSS pixels): a laptop and a common phone. */
export const PREVIEW_DEVICES = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

export type PreviewDevice = keyof typeof PREVIEW_DEVICES;

/** `window.open` features of a device preview: a sized popup with no access back to FORGE. */
export function previewFeatures(device: PreviewDevice): string {
  const { width, height } = PREVIEW_DEVICES[device];
  return `popup=yes,width=${width},height=${height},noopener,noreferrer`;
}

/**
 * Opens the preview in a window of the device size. Phones and tablets ignore the size and open
 * a tab. `noopener`: the preview cannot reach this page.
 */
export function openPreview(url: string, device: PreviewDevice) {
  window.open(url, `forge-preview-${device}`, previewFeatures(device));
}

export function PreviewCard({ url }: { url: string }) {
  const host = siteHost(url) ?? url;
  const copy = jobCopy.previewCard;
  return (
    <div className="fw-preview-card">
      <div className="fw-preview-window" aria-hidden="true">
        <span className="fw-preview-dots">
          <i />
          <i />
          <i />
        </span>
        <span className="fw-preview-host">{host}</span>
      </div>
      <div className="fw-preview-body">
        <p>{copy.body}</p>
        <a
          className="fw-button fw-button-primary fw-preview-open"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {copy.open}
          <span aria-hidden="true">↗</span>
        </a>
        <div className="fw-preview-devices" role="group" aria-label={copy.devices}>
          <button
            type="button"
            className="fw-button fw-button-secondary"
            onClick={() => openPreview(url, 'desktop')}
          >
            {copy.desktop}
            <span aria-hidden="true">↗</span>
          </button>
          <button
            type="button"
            className="fw-button fw-button-secondary"
            onClick={() => openPreview(url, 'mobile')}
          >
            {copy.mobile}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        <p className="fw-caption">{copy.check}</p>
      </div>
    </div>
  );
}
