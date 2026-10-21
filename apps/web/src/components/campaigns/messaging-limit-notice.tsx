import type { CampaignMessagingLimitNotice } from '@w360/domain';
import { Alert } from '@w360/ui';

/**
 * A campaign's messaging-limit notice (ADR-400), worded by the domain
 * (`campaignMessagingLimitNotice`): a warning only when its recipients are over the figure of its
 * number's limit, otherwise informational. It never blocks anything.
 */
export function MessagingLimitNotice({ notice }: { notice: CampaignMessagingLimitNotice }) {
  return (
    <Alert tone={notice.tone} title={notice.title}>
      <div className="grid gap-1">
        {notice.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </Alert>
  );
}
