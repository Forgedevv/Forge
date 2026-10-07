'use client';
import Link from 'next/link';
import { useWebClient } from './provider';
import {
  ActionLink,
  Address,
  Card,
  ErrorNotice,
  Heading,
  Loading,
  StatusBadge,
} from './components';
import { SpecSummary } from './spec-summary';
import { detailCopy as copy } from './content/detail';
import { common } from './content/common';
import { safeUrl } from './safe-url';

export function DetailScreen({ launchpadId }: { launchpadId: string }) {
  const { launchpad, loading } = useWebClient().useLaunchpad(launchpadId);
  if (loading) return <Loading />;
  if (!launchpad) return <ErrorNotice message={common.missing} />;
  return (
    <>
      <Link className="fw-back" href="/dashboard">
        ← {common.back}
      </Link>
      <div className="fw-title-row">
        <Heading eyebrow={copy.eyebrow} title={launchpad.name}>
          {copy.title}
        </Heading>
        <ActionLink href={`/launchpads/${launchpad.id}/modify`}>{copy.modify}</ActionLink>
      </div>
      <div className="fw-detail-grid">
        <Card>
          <h2>{copy.settings}</h2>
          <p className="fw-notice">{copy.final}</p>
          <SpecSummary spec={launchpad.spec} validation={{ complete: true, errors: {} }} />
          <div className="fw-onchain-addresses">
            {(
              [
                ['launchpadConfig', copy.config],
                ['launchpadCoinConfig', copy.coinConfig],
                ['launchpadCoinMint', copy.mint],
              ] as const
            ).map(([key, label]) => (
              <div key={key}>
                {launchpad.onchain[key] ? (
                  <Address label={label} value={launchpad.onchain[key]!} />
                ) : (
                  <p>
                    <span>{label}</span>
                    <br />
                    <span className="fw-muted">{copy.pending}</span>
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
        <div className="fw-detail-history">
          <Card>
            <h2>{copy.versions}</h2>
            {launchpad.versions.length ? (
              <ol className="fw-history">
                {launchpad.versions.map((version, i) => (
                  <li key={`${version.jobId}-${i}`}>
                    <span className="fw-version">V{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <time dateTime={version.createdAt}>
                        {new Date(version.createdAt).toLocaleDateString('en-GB', {
                          timeZone: 'UTC',
                        })}
                      </time>
                      <p>{version.request ?? copy.original}</p>
                      {safeUrl(version.previewUrl) && (
                        <Link href={safeUrl(version.previewUrl)!} target="_blank" rel="noreferrer">
                          {copy.preview} ↗
                        </Link>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{copy.noVersions}</p>
            )}
          </Card>
          <Card>
            <h2>{copy.jobs}</h2>
            {launchpad.jobs.length ? (
              <ol className="fw-history">
                {launchpad.jobs.map((job) => (
                  <li key={job.id}>
                    <div>
                      <StatusBadge job={job} />
                      <p>
                        {new Date(job.createdAt).toLocaleDateString('en-GB', { timeZone: 'UTC' })}
                      </p>
                      <Link href={`/jobs/${job.id}`}>{copy.openJob} ↗</Link>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p>{copy.noJobs}</p>
            )}
          </Card>
          <Card>
            <h2>{copy.claimed}</h2>
            <p className="fw-muted">{copy.noClaimHistory}</p>
          </Card>
        </div>
      </div>
    </>
  );
}
