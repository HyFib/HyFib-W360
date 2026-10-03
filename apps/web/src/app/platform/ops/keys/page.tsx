import type { Metadata } from 'next';
import {
  Alert,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from '@w360/ui';
import {
  JOB_SIGNING_KEY_ROLE_LABELS,
  SEALED_VALUE_LABELS,
  SEALING_KEY_STATE_LABELS,
  type JobSigningKeyRole,
  type SealingKeyState,
} from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { requirePlatformActor } from '@/server/session';

export const metadata: Metadata = { title: 'Keys · Operations' };
export const dynamic = 'force-dynamic';

const STATE_TONES: Record<SealingKeyState, 'success' | 'neutral' | 'danger' | 'warning'> = {
  primary: 'success',
  configured: 'neutral',
  not_configured: 'danger',
  unknown_format: 'warning',
};

const ROLE_TONES: Record<JobSigningKeyRole, 'success' | 'neutral' | 'danger' | 'warning'> = {
  signing: 'success',
  next: 'neutral',
  previous: 'warning',
  none: 'neutral',
  not_configured: 'danger',
};

const jobs = (n: number) => `${n} ${n === 1 ? 'job' : 'jobs'}`;

export default async function OpsKeysPage() {
  const actor = await requirePlatformActor();
  const { platformOps } = await getRuntime();
  const o = await platformOps.keyring(actor);
  const j = await platformOps.jobSigning(actor);
  const others = o.keys.filter((k) => k.state === 'configured');
  const left = others.reduce((sum, k) => sum + k.sealed, 0);
  const unreadable = o.keys
    .filter((k) => k.state === 'not_configured' || k.state === 'unknown_format')
    .reduce((sum, k) => sum + k.sealed, 0);
  return (
    <div className="grid grid-cols-1 gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Encryption keys</CardTitle>
          <CardDescription>
            Stored secrets (WhatsApp tokens, HTTP and webhook secrets, store and Razorpay
            credentials, Flow keys, queued emails and provider webhook bodies) are sealed with the
            encryption keyring. New values use the primary key. While another key is configured, the
            worker seals the values that key sealed again with the primary key, up to 500 a minute.
            Key ids and counts only: no key or value is shown.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Only the primary key <span className="font-mono">{o.primaryKeyId}</span> is
              configured: there is nothing to re-encrypt.
            </p>
          ) : left > 0 ? (
            <Alert tone="info" title="Re-encrypting">
              {left} stored {left === 1 ? 'value is' : 'values are'} still sealed with another
              configured key. Keep every configured key until this reaches zero.
            </Alert>
          ) : (
            <Alert tone="success" title="Re-encrypted">
              Nothing stored is sealed with {o.unused.map((k) => `“${k}”`).join(', ')}. Remove{' '}
              {o.unused.length === 1 ? 'it' : 'them'} from the configuration once every server runs
              with it and integrations have read their change feeds since (see the runbook).
            </Alert>
          )}
          {unreadable > 0 ? (
            <Alert tone="danger" title="Values that cannot be opened">
              {unreadable} stored {unreadable === 1 ? 'value is' : 'values are'} sealed with a key
              that is not configured, or not sealed with the keyring at all. Nothing can open them.
            </Alert>
          ) : null}
          <Table aria-label="Encryption keys">
            <THead>
              <TR>
                <TH>Key id</TH>
                <TH>State</TH>
                <TH>Values sealed</TH>
              </TR>
            </THead>
            <TBody>
              {o.keys.map((k) => (
                <TR key={k.keyId ?? '(none)'}>
                  <TD className="font-mono">{k.keyId ?? '—'}</TD>
                  <TD>
                    <Badge tone={STATE_TONES[k.state]}>{SEALING_KEY_STATE_LABELS[k.state]}</Badge>
                  </TD>
                  <TD className="tabular-nums">{k.sealed}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By kind of value</CardTitle>
          <CardDescription>
            How many stored values of each kind each key sealed now. An automation&apos;s HTTP
            request counts until its call finishes, an email until it is sent and a provider webhook
            body for the 7 days it is kept.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {o.kinds.length === 0 ? (
            <EmptyState title="Nothing is stored sealed yet" />
          ) : (
            <Table aria-label="Sealed values by kind">
              <THead>
                <TR>
                  <TH>What</TH>
                  <TH>Primary key</TH>
                  <TH>Other configured keys</TH>
                  <TH>Cannot be opened</TH>
                </TR>
              </THead>
              <TBody>
                {o.kinds.map((k) => (
                  <TR key={k.kind}>
                    <TD>{SEALED_VALUE_LABELS[k.kind]}</TD>
                    <TD className="tabular-nums">{k.primary}</TD>
                    <TD className="tabular-nums">{k.configured}</TD>
                    <TD className="tabular-nums">{k.other}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Job signing keys</CardTitle>
          <CardDescription>
            Every job is signed when it is queued, and the worker refuses one whose signature does
            not verify. During a rotation the next key is accepted before any server signs with it;
            then the previous key is accepted while the worker signs the jobs it signed again with
            the signing key, up to 500 a minute. Jobs that can still run are counted: waiting,
            running, and failed jobs pg-boss keeps. Key ids (derived from the keys) and counts only.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {j.previousKeyId !== null ? (
            j.toResign > 0 ? (
              <Alert tone="info" title="Signing jobs again">
                {jobs(j.toResign)} signed with the previous key, or before key ids, can still run.
                Keep the previous key until this reaches zero.
              </Alert>
            ) : (
              <Alert tone="success" title="Signed again">
                No job that can still run was signed with the previous key “{j.previousKeyId}”.
                Remove it from the configuration once every server signs with the signing key (see
                the runbook).
              </Alert>
            )
          ) : j.nextKeyId !== null ? (
            <Alert tone="info" title="Next key accepted">
              Jobs signed with the next key “{j.nextKeyId}” are accepted. Once every server runs
              with it, make it the signing key and the signing key the previous one (see the
              runbook).
            </Alert>
          ) : (
            <p className="text-sm text-muted-foreground">
              Only the signing key <span className="font-mono">{j.keyId}</span> is configured: no
              rotation is in progress.
            </p>
          )}
          {j.unverifiable > 0 ? (
            <Alert tone="danger" title="Jobs that will be refused">
              {jobs(j.unverifiable)} that can still run name a key that is not configured: the
              worker refuses them when they run.
            </Alert>
          ) : null}
          <Table aria-label="Job signing keys">
            <THead>
              <TR>
                <TH>Key id</TH>
                <TH>Role</TH>
                <TH>Waiting</TH>
                <TH>Running</TH>
                <TH>Failed</TH>
              </TR>
            </THead>
            <TBody>
              {j.keys.map((k) => (
                <TR key={k.keyId ?? '(none)'}>
                  <TD className="font-mono">{k.keyId ?? '—'}</TD>
                  <TD>
                    <Badge tone={ROLE_TONES[k.role]}>{JOB_SIGNING_KEY_ROLE_LABELS[k.role]}</Badge>
                  </TD>
                  <TD className="tabular-nums">{k.queued}</TD>
                  <TD className="tabular-nums">{k.active}</TD>
                  <TD className="tabular-nums">{k.failed}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
