import { AppError, type Keyring } from '@w360/core';

/**
 * Cursors of the change feeds (ADR-114, ADR-116). A position is a database transaction id and a row
 * id, which would show how busy the whole platform is (transaction ids are shared by every
 * company), so a cursor is sealed with the keyring and bound to its feed and its company: another
 * company's cursor, another feed's, a changed one or one sealed with a key the platform no longer
 * holds does not open.
 */
export type ChangeFeed = 'contact-changes' | 'message-changes';

/** A place in a company's feed: after the change with this transaction and id. */
export interface ChangePosition {
  xact: string;
  id: string;
}

const START: ChangePosition = { xact: '0', id: '0' };
const POSITION_RE = /^(\d{1,20})\.(\d{1,19})$/;
const INVALID_CURSOR =
  'Invalid cursor: give the nextCursor of a page of this feed, or no cursor to start again from the first change.';

const cursorAad = (feed: ChangeFeed, tenantId: string) => `${feed}|tenant:${tenantId}`;

const invalidCursor = () =>
  new AppError('validation_failed', INVALID_CURSOR, {
    issues: [{ path: 'cursor', message: INVALID_CURSOR }],
  });

export function sealChangeCursor(
  keyring: Keyring,
  feed: ChangeFeed,
  tenantId: string,
  at: ChangePosition,
): string {
  return Buffer.from(keyring.encrypt(`${at.xact}.${at.id}`, cursorAad(feed, tenantId))).toString(
    'base64url',
  );
}

/** The position a cursor seals; the feed's start without one. */
export function openChangeCursor(
  keyring: Keyring,
  feed: ChangeFeed,
  tenantId: string,
  cursor: string | undefined,
): ChangePosition {
  if (cursor === undefined) return START;
  let position: string;
  try {
    position = keyring.decryptString(
      Buffer.from(cursor, 'base64url').toString('utf8'),
      cursorAad(feed, tenantId),
    );
  } catch {
    // Tampered, another company's or feed's, or sealed with a key the platform no longer holds.
    throw invalidCursor();
  }
  const match = POSITION_RE.exec(position);
  if (!match?.[1] || !match[2]) throw invalidCursor();
  return { xact: match[1], id: match[2] };
}
