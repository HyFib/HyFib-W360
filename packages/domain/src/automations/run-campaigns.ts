import { and, automationRunCampaigns, campaigns, eq, type Tx } from '@w360/db';
import type { CampaignPlaceholderValues } from './graph';

/**
 * The campaign a run answers (ADR-414, migration 0324): the row written with a run started by a
 * reply to a campaign message, or with a test run of an automation that names a campaign, and the
 * campaign's name as it is now. Null for every other run. Read in the run's company scope; callers
 * decide who may see it (the run's page and webhooks name it only to those who can read campaigns,
 * and the button only to those who can see the conversation, as a run's answers).
 */
export interface RunCampaign {
  campaignId: string;
  name: string;
  /** The variant the customer was sent (A to E); null for a test run. */
  variant: string | null;
  /** The quick-reply button's text; null for a quoting reply. */
  buttonText: string | null;
}

export async function runCampaignOf(
  tx: Tx,
  tenantId: string,
  runId: string,
): Promise<RunCampaign | null> {
  const [row] = await tx
    .select({
      campaignId: automationRunCampaigns.campaignId,
      name: campaigns.name,
      variant: automationRunCampaigns.variant,
      buttonText: automationRunCampaigns.buttonText,
    })
    .from(automationRunCampaigns)
    .innerJoin(
      campaigns,
      and(
        eq(campaigns.tenantId, automationRunCampaigns.tenantId),
        eq(campaigns.id, automationRunCampaigns.campaignId),
      ),
    )
    .where(
      and(eq(automationRunCampaigns.tenantId, tenantId), eq(automationRunCampaigns.runId, runId)),
    );
  return row ?? null;
}

/** What {{campaign.<field>}} reads for a run (empty texts for what it lacks), or null. */
export function campaignPlaceholderValues(
  campaign: RunCampaign | null,
): CampaignPlaceholderValues | null {
  if (!campaign) return null;
  return {
    name: campaign.name,
    variant: campaign.variant ?? '',
    button: campaign.buttonText ?? '',
  };
}
