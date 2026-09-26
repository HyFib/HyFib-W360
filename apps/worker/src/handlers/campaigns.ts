import type { Job } from 'pg-boss';
import {
  authorizeJob,
  findDueCampaigns,
  pauseCampaignForRemovedLauncher,
  runCampaignTick,
  signalCampaignRunner,
} from '@w360/domain';
import type { WorkerRuntime } from '../runtime';

/**
 * One campaign runner tick (see campaigns/runner). The campaign row is the source of truth; the
 * tick re-checks everything under its row lock and schedules the next tick itself.
 */
export function campaignRunHandler(rt: WorkerRuntime) {
  return async ([job]: Job<unknown>[]): Promise<void> => {
    if (!job) return;
    const auth = await authorizeJob(rt, job.data, {
      expectedKind: 'campaign.run',
      requireActiveTenant: true,
      requireActiveActor: true,
    });
    if (auth.outcome === 'deferred') {
      // Suspended company: nothing is queued; the sweep signals the campaign after reactivation.
      rt.logger.info({ jobId: job.id, campaignId: auth.envelope.ref }, 'campaign tick deferred');
      return;
    }
    if (auth.outcome === 'rejected' && 'cleanupScope' in auth) {
      const paused = await pauseCampaignForRemovedLauncher(
        { db: rt.db, clock: rt.clock },
        auth.cleanupScope,
        auth.envelope.ref,
        auth.envelope.actorUserId,
      );
      rt.logger.info(
        { jobId: job.id, campaignId: auth.envelope.ref, paused },
        'campaign launcher removed',
      );
      return;
    }
    if (auth.outcome !== 'authorized' || !auth.scope) {
      rt.logger.warn({ jobId: job.id, outcome: auth.outcome }, 'campaign job dropped');
      return;
    }
    const result = await runCampaignTick(
      {
        db: rt.db,
        jobs: rt.jobs,
        signer: rt.signer,
        clock: rt.clock,
        sendRatePerSecond: rt.sendRate.refillPerSecond,
      },
      auth.scope,
      auth.envelope.ref,
    );
    rt.logger.info(
      {
        jobId: job.id,
        campaignId: auth.envelope.ref,
        outcome: result.outcome,
        queued: result.queued,
        skipped: result.skipped,
      },
      'campaign tick',
    );
  };
}

/** Signals ticks that are due or whose signal was lost (called from the messaging sweep). */
export async function signalDueCampaigns(rt: WorkerRuntime): Promise<number> {
  const due = await findDueCampaigns(rt.db);
  const at = rt.clock.now();
  for (const item of due) {
    // Tenant ids come from the database (SECURITY DEFINER sweep query), not from a payload.
    await signalCampaignRunner(rt, null, {
      tenantId: item.tenantId,
      campaignId: item.campaignId,
      actorUserId: item.launchedByUserId,
      at,
    });
  }
  return due.length;
}
