import type { ApiScope } from '@w360/db';
import type { Permission } from '../authz/permissions';

export type { ApiScope } from '@w360/db';

/**
 * The public API (P5-08, ADR-052): the parts the settings page and the services share. Pure
 * definitions without server dependencies, so pages can use them in the browser.
 */

export const API_SCOPE_KEYS = [
  'channels.read',
  'templates.read',
  'contacts.read',
  'contacts.write',
  'contact_fields.manage',
  'messages.send',
  'messages.send_marketing',
  'messages.reply',
  'conversations.read',
  'conversations.write',
  'campaigns.read',
  'campaigns.write',
  'campaigns.stop',
  'campaigns.resume',
  'automations.start',
  'orders.read',
  'orders.write',
  'webhooks.manage',
] as const satisfies readonly ApiScope[];

/**
 * What each scope allows, the member permission needed to grant it, and whether it writes
 * (writing scopes are refused while the company is suspended or restricted, as in the app).
 */
export const API_SCOPE_INFO: Record<
  ApiScope,
  { label: string; description: string; permission: Permission; writes: boolean }
> = {
  'channels.read': {
    label: 'Read WhatsApp numbers',
    description:
      "List the company's WhatsApp numbers with each one's number, verified name and status, and the id messages, conversations, orders and webhook events name it by and a send takes to choose it. Never Meta's ids or credentials.",
    permission: 'channels.read',
    writes: false,
  },
  'templates.read': {
    label: 'Read templates',
    description: 'List approved templates and their variables.',
    permission: 'templates.read',
    writes: false,
  },
  'contacts.read': {
    label: 'Read contacts',
    description:
      "Find contacts by number, email, tag or custom field, read their details, custom fields and consent and follow their changes, and list the company's custom fields.",
    permission: 'contacts.read',
    writes: false,
  },
  'contacts.write': {
    label: 'Create and change contacts and record consent',
    description:
      'Create contacts, change their name, email, custom fields and tags, and record opt-ins and opt-outs with their evidence.',
    permission: 'contacts.write',
    writes: true,
  },
  'contact_fields.manage': {
    label: 'Define contact fields',
    description:
      'Add custom contact fields, rename them, and delete them with their values on every contact, as owners and administrators do in Settings.',
    permission: 'tenant.settings.manage',
    writes: true,
  },
  'messages.send': {
    label: 'Send utility templates',
    description: 'Send approved utility templates and read the status of messages the API sent.',
    permission: 'inbox.reply',
    writes: true,
  },
  'messages.send_marketing': {
    label: 'Send marketing templates',
    description:
      'Send approved marketing templates to contacts who opted in, within the frequency cap.',
    permission: 'campaigns.send',
    writes: true,
  },
  'messages.reply': {
    label: 'Reply with text, media and other messages',
    description:
      'Send text, reply buttons, list messages, products from the company’s WhatsApp catalogs, reactions, photos, videos, audio, documents or stickers from links, or files uploaded for the number, locations and contact cards, to contacts who wrote to the number in the last 24 hours, quoting their messages if wanted, and read the status of messages the API sent.',
    permission: 'inbox.reply',
    writes: true,
  },
  'conversations.read': {
    label: 'Read conversations',
    description:
      "List the company's conversations and read their messages, one conversation or all of them, including what contacts wrote and the files they sent, follow the messages as they change, and read the conversations' internal notes, with the teams and the members conversations can be assigned to (names only).",
    permission: 'inbox.read_all',
    writes: false,
  },
  'conversations.write': {
    label: 'Resolve, reopen, assign and add notes to conversations',
    description:
      'Mark conversations resolved, or open again, assign them to members or move them between teams, as members do in the inbox, and add internal notes the team reads there (WhatsApp never receives them). Resolving a conversation or assigning it to a member stops an automation answering it.',
    permission: 'inbox.supervise',
    writes: true,
  },
  'campaigns.read': {
    label: 'Read campaigns',
    description:
      "List the company's campaigns and read each one's progress and results: messages sent, delivered, read and failed, replies and opt-outs, and why recipients were skipped. Also read the company's saved segments, their conditions and how many contacts each matches. With contacts read as well, list the contacts each segment holds. A key that also reads contacts lists each campaign's recipients and what happened to each. Never members or costs.",
    permission: 'campaigns.read',
    writes: false,
  },
  'campaigns.write': {
    label: 'Create, edit and submit campaign drafts',
    description:
      "Create campaign drafts and edit them as members do: the name, the number and template, the variables, the audience (a segment or conditions), the schedule, the sending window and the caps; review drafts as members do before they submit them (who they would reach and what they would cost); submit drafts, which then always wait for a member's approval, and take back what it submitted; and cancel drafts. A key never starts a campaign: a member approves a key's submission, or submits a draft, in the app, and the campaign sends under the authority of a member allowed to send campaigns. Also create, change and archive the company's saved segments.",
    permission: 'campaigns.write',
    writes: true,
  },
  'campaigns.stop': {
    label: 'Pause and cancel campaigns',
    description:
      "Pause a scheduled or sending campaign and cancel one that has not finished, as members who send campaigns can. Approving, scheduling and editing stay in the app, under a member's authority, and so does resuming, except a campaign a key paused.",
    permission: 'campaigns.send',
    writes: true,
  },
  'campaigns.resume': {
    label: 'Resume campaigns keys paused',
    description:
      'Resume a campaign a key paused, after the checks members’ resuming makes: the template still approved, the number active, neither cap reached. It sends again under the authority of the member who launched it, who must still be allowed to send campaigns. A campaign a member or HyFib paused stays for members to resume in the app.',
    permission: 'campaigns.send',
    writes: true,
  },
  'automations.start': {
    label: 'Start automations',
    description:
      'Start published automations made to start through the API, for one contact at a time with the inputs they need, and read and stop the runs keys started. They message contacts who have not written first, with templates.',
    permission: 'automations.publish',
    writes: true,
  },
  'orders.read': {
    label: 'Read WhatsApp orders',
    description:
      "List the orders customers send from the company's WhatsApp catalog and read each one's items, total, note and status, with its conversation and contact ids. Never Payment Links or payment ids. Needs Commerce in the company's plan.",
    permission: 'commerce.read',
    writes: false,
  },
  'orders.write': {
    label: 'Confirm, fulfil and cancel WhatsApp orders',
    description:
      "Move the company's WhatsApp orders on as members do: confirm or cancel a received order, fulfil or cancel a confirmed one, fulfil a paid one. Never payments: members ask for and cancel Payment Links in the app. Needs Commerce in the company's plan.",
    permission: 'inbox.reply',
    writes: true,
  },
  'webhooks.manage': {
    label: 'Manage webhook endpoints',
    description:
      "Add webhook endpoints that receive the company's events, including what contacts write, and read, change, rotate the secret of and delete the endpoints keys added, with their deliveries, test events and replays. Owners and administrators are emailed when a key adds one.",
    permission: 'developer.manage',
    writes: true,
  },
};

/** The scopes that send messages; any of them reads the status of messages the API sent. */
export const API_SEND_SCOPES = [
  'messages.send',
  'messages.send_marketing',
  'messages.reply',
] as const satisfies readonly ApiScope[];

/** Days until a new key expires; 0 means it does not expire. */
export const API_KEY_EXPIRY_DAYS = [30, 90, 365, 0] as const;

/** How long before a key expires owners and administrators are reminded (ADR-067). */
export const API_KEY_REMINDER_DAYS = 7;

export const API_KEY_LIMITS = {
  activeKeys: 20,
  nameLength: 80,
  rotationOverlapHours: 72,
  /** Networks a key may list (ADR-076), and the characters of the settings field that lists them. */
  allowedNetworks: 20,
  allowedNetworksText: 2000,
  /** The highest monthly request limit a key can be given (ADR-097), as the plan's limit. */
  monthlyRequests: 1_000_000_000,
} as const;

export const API_LIMITS = {
  bodyBytes: 65_536,
  pageSize: 100,
  /** A text message's characters, as WhatsApp and the inbox allow. */
  textLength: 4096,
  /** A media message's link (ADR-194): HyFib's own bound, an address meant to be fetched. */
  mediaLinkLength: 2000,
  /** A media message's caption (research M-191). */
  captionLength: 1024,
  /** A location's name and address (ADR-195): HyFib's own bound; Meta's spec gives none (M-192). */
  locationTextLength: 1000,
  /** Contacts one contact card shares (research M-193). */
  contactsPerCard: 5,
  /** A contact card's phones, emails, links or addresses, each (ADR-197): HyFib's own bound. */
  contactCardEntries: 5,
  /** Any text of a contact card but a link (ADR-197): HyFib's own bound; Meta's spec gives none. */
  contactCardTextLength: 256,
  idempotencyKeyLength: 255,
  idempotencyHours: 24,
  /** Conversations one call to POST /conversations/update-many changes (ADR-120). */
  conversationsPerChange: 100,
  /** Contacts one call to POST /contacts/update-many changes (ADR-122). */
  contactsPerChange: 100,
  /**
   * Runs one call to POST /automations/{id}/runs/start-many starts (ADR-161). Each run started keeps
   * its savepoint's transaction id until the call commits, and PostgreSQL caches 64 per transaction:
   * beyond them, every snapshot taken while the call runs looks subtransactions up on disk.
   */
  runsPerStart: 50,
  /** Runs one call to POST /automation-runs/stop-many stops (ADR-162). */
  runsPerStop: 100,
  /**
   * Numbers one call to POST /messages/send-many sends to (ADR-163): each send keeps its
   * savepoint's transaction id until the call commits, as each start of runsPerStart does.
   */
  messagesPerSend: 50,
  keyRate: { capacity: 50, refillPerSecond: 10 },
  companyRate: { capacity: 200, refillPerSecond: 30 },
  authFailureRate: { capacity: 20, refillPerSecond: 0.2 },
} as const;

/** `w360_` + 12 base32 characters (the key's public part), `_`, 43 base64url characters. */
export const API_TOKEN_RE = /^w360_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/;

/** Printable ASCII without spaces, as the idempotency key column accepts. */
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/** Whether a key is usable now. */
export function apiKeyState(
  key: { revokedAt: Date | null; expiresAt: Date | null },
  now: Date,
): 'active' | 'revoked' | 'expired' {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && key.expiresAt <= now) return 'expired';
  return 'active';
}

/** A network a key accepts (ADR-076) as settings show it: a single address without /32 or /128. */
export function formatAllowedNetwork(network: string): string {
  const single = network.includes(':') ? '/128' : '/32';
  return network.endsWith(single) ? network.slice(0, -single.length) : network;
}

/**
 * Whether a usable key expires within API_KEY_REMINDER_DAYS days and was not rotated: the keys
 * owners and administrators are reminded about (ADR-067).
 */
export function apiKeyExpiresSoon(
  key: { revokedAt: Date | null; expiresAt: Date | null; replacedByKeyId: string | null },
  now: Date,
): boolean {
  if (apiKeyState(key, now) !== 'active' || key.replacedByKeyId || !key.expiresAt) return false;
  return key.expiresAt.getTime() - now.getTime() <= API_KEY_REMINDER_DAYS * 86_400_000;
}
