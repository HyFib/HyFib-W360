import Link from 'next/link';
import { limitNoticeText, type LimitNotice } from '@w360/domain';
import { Alert, Button } from '@w360/ui';
import { HiddenOnPath } from '@/components/hidden-on-path';

/**
 * The company's monthly limits nearly or fully used (ADR-140), on every page of the company. The
 * members who read billing get a link to Billing, except on Billing itself, whose plan card shows
 * the counts.
 */
export function LimitNotices({
  notices,
  slug,
  timeZone,
}: {
  notices: LimitNotice[];
  slug: string;
  timeZone: string;
}) {
  return notices.map((notice) => {
    const text = limitNoticeText(notice, timeZone);
    return (
      <Alert
        key={notice.metric}
        tone={text.tone}
        title={text.title}
        action={
          notice.forBilling ? (
            <HiddenOnPath suffix="/billing">
              <Button asChild size="sm" variant="outline">
                <Link href={`/c/${slug}/billing`}>See the plan</Link>
              </Button>
            </HiddenOnPath>
          ) : undefined
        }
      >
        {text.body}
      </Alert>
    );
  });
}
