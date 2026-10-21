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
  'templates.write',
  'templates.submit',
  'contacts.read',
  'contacts.write',
  'contacts.merge',
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
  'chat_links.read',
  'chat_links.write',
  'ads.read',
  'automations.start',
  'flows.read',
  'orders.read',
  'orders.write',
  'orders.request_payment',
  'deals.read',
  'deals.write',
  'pipelines.manage',
  'tasks.read',
  'tasks.write',
  'notes.read',
  'notes.write',
  'teams.manage',
  'availability.write',
  'business_hours.read',
  'business_hours.manage',
  'saved_replies.manage',
  'reports.read',
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
    description:
      "List approved templates and their variables, and read every template of the company, drafts and those Meta reviews included, with Meta's review and each template's latest status changes.",
    permission: 'templates.read',
    writes: false,
  },
  'templates.write': {
    label: 'Write templates',
    description:
      'Add template drafts, change their content and delete drafts Meta never received, as members who write templates do on the Templates page, recorded as added through the API and in the audit log as done by the key. Deleting templates Meta has also needs the scope that submits them to Meta.',
    permission: 'templates.write',
    writes: true,
  },
  'templates.submit': {
    label: 'Submit templates',
    description:
      'Submit template drafts to Meta for review and, with the scope that writes templates, delete templates Meta has, which can then no longer be sent, as members who submit templates do on the Templates page, in the audit log as done by the key.',
    permission: 'templates.submit',
    writes: true,
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
  'contacts.merge': {
    label: 'Merge contacts',
    description:
      'Merge two contacts of the same person: everything of one moves to the other, which keeps its details, and the merged contact is deleted. A merge cannot be undone.',
    // Merging deletes a contact, so only members who may delete contacts grant it (ADR-227).
    permission: 'contacts.delete',
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
      "List the company's conversations and read their messages, one conversation or all of them, including what contacts wrote and the files they sent, follow the messages as they change, and read the conversations' internal notes and the satisfaction surveys sent when members resolve them, with the teams and the members conversations can be assigned to (names only).",
    permission: 'inbox.read_all',
    writes: false,
  },
  'conversations.write': {
    label: 'Resolve, reopen, assign and add notes to conversations',
    description:
      'Mark conversations resolved, or open again, assign them to members, move them between teams and tag them, as members do in the inbox, and add internal notes the team reads there (WhatsApp never receives them). Resolving a conversation or assigning it to a member stops an automation answering it.',
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
  'chat_links.read': {
    label: 'Read chat links',
    description:
      "List the company's chat links, the short links and QR codes that open a chat with one of its numbers with a message ready to send, and read each one with its clicks per day and the conversations it started in the last 30 days.",
    permission: 'campaigns.read',
    writes: false,
  },
  'chat_links.write': {
    label: 'Write chat links',
    description:
      "Create chat links on the company's active numbers, change their name, number and message and whether the message carries the link's reference, and archive or restore them, as members who write campaigns do on the Growth pages. Links a key creates name it as their author.",
    permission: 'campaigns.write',
    writes: true,
  },
  'ads.read': {
    label: 'Read ads',
    description:
      'List the click-to-WhatsApp ads customers wrote from in the last 30 days, with the conversations each started and the messages that came from it, as members who read campaigns see them on the Growth pages; never the ad click id, which is not kept.',
    permission: 'campaigns.read',
    writes: false,
  },
  'automations.start': {
    label: 'Start automations',
    description:
      'Start published automations made to start through the API, for one contact at a time with the inputs they need, and read and stop the runs keys started. With the scope that reads contacts, also enrol the contacts a tag and marketing consent find, or with the one that reads campaigns a saved segment’s members (up to 10,000 at once), and read and stop every enrolment of the company. They message contacts who have not written first, with templates.',
    permission: 'automations.publish',
    writes: true,
  },
  'flows.read': {
    label: 'Read flows',
    description:
      "List the company's WhatsApp Flows, the forms members send in chats, and the forms customers completed with them, newest first. Who completed them and what they typed are given only to keys that also hold the scope that reads contacts, as members see them.",
    permission: 'flows.read',
    writes: false,
  },
  'orders.read': {
    label: 'Read WhatsApp orders',
    description:
      "List the orders customers send from the company's WhatsApp catalog and read each one's items, total, note and status, with its conversation and contact ids. Also find contacts, and build segments and campaign audiences, by how many orders they placed in the company's connected stores and what they spent there. Also read each order's Payment Links, with their status, amounts and whether they were sent, never their address or Razorpay's ids. Needs Commerce in the company's plan.",
    permission: 'commerce.read',
    writes: false,
  },
  'orders.write': {
    label: 'Confirm, fulfil and cancel WhatsApp orders',
    description:
      "Move the company's WhatsApp orders on as members do: confirm or cancel a received order, fulfil or cancel a confirmed one, fulfil a paid one. Never payments: asking customers to pay with Payment Links is a scope of its own. Needs Commerce in the company's plan.",
    permission: 'inbox.reply',
    writes: true,
  },
  'orders.request_payment': {
    label: 'Ask customers to pay WhatsApp orders',
    description:
      "Ask a customer to pay a received or confirmed order with a Payment Link from the company's own Razorpay account, sent in the order's conversation as members ask for payment on the order page, and cancel an order's open link. Payment statuses still come only from Razorpay. Needs Commerce in the company's plan and its Razorpay account checked.",
    permission: 'inbox.reply',
    writes: true,
  },
  'deals.read': {
    label: 'Read CRM deals',
    description:
      "List the company's CRM pipelines with their stages and each stage's chance of winning, and its deals with their pipeline, stage, status, value, expected close date and owner, and their contact and conversation ids, and read each pipeline's weighted forecast as Reports shows it and the products listed on each deal. Never notes, tasks or the timeline. Needs the CRM in the company's plan.",
    permission: 'crm.read',
    writes: false,
  },
  'deals.write': {
    label: 'Create and change CRM deals',
    description:
      "Create deals for the company's contacts in its active pipelines and change them as members do on the board: their title, value, owner and expected close date, their stage or pipeline, and closing them as won or lost or reopening them, and remove products listed on them, recorded as done through the API. With the scope that reads WhatsApp orders, also list products of the company's catalogs on deals. Needs the CRM in the company's plan.",
    permission: 'crm.write',
    writes: true,
  },
  'pipelines.manage': {
    label: 'Manage CRM pipelines',
    description:
      "Add CRM pipelines with their stages and each stage's chance of winning, rename them, add, rename, reorder and remove their stages and change the chances, and archive and restore them, as owners and administrators do in Settings → Pipelines, recorded in the audit log as done by the key. Never deletes a pipeline or its deals. Needs the CRM in the company's plan.",
    permission: 'tenant.settings.manage',
    writes: true,
  },
  'tasks.read': {
    label: 'Read CRM tasks',
    description:
      "List the company's CRM tasks with their title, notes, due time, reminder, status and assignee, and their contact and deal ids, and read each one. Never the CRM timeline. Needs the CRM in the company's plan.",
    permission: 'crm.read',
    writes: false,
  },
  'tasks.write': {
    label: 'Create and change CRM tasks',
    description:
      "Create tasks as members do on the Tasks page and the contact and deal pages: for one of the company's contacts or deals or for nobody, assigned to an active member who can use the CRM, with notes, a due time and a reminder emailed to the assignee; and change, complete, cancel and reopen them as members do, recorded as done through the API. Needs the CRM in the company's plan.",
    permission: 'crm.write',
    writes: true,
  },
  'notes.read': {
    label: 'Read CRM notes',
    description:
      "List the notes on the CRM timelines of the company's contacts and deals, with their text, the contact and deal each is about, and whether a member or a key wrote it (a key by its id), and read each one. Never which member wrote a note, or the rest of the timeline. Needs the CRM in the company's plan.",
    permission: 'crm.read',
    writes: false,
  },
  'notes.write': {
    label: 'Add notes to the CRM timeline',
    description:
      "Add notes to the timeline of one of the company's contacts, or of one of its deals and so the deal's contact, as members do on the contact and deal pages, recorded as written through the API. Never read the timeline. Needs the CRM in the company's plan.",
    permission: 'crm.write',
    writes: true,
  },
  'teams.manage': {
    label: 'Manage teams',
    description:
      "Read the company's teams with their settings, members and numbers, add teams, change how they give out conversations, their routing keywords, members and numbers, and delete them, as members who supervise the inbox do in Settings → Teams, recorded in the audit log as done by the key. A deleted team's conversations leave it and keep their assignees.",
    permission: 'inbox.supervise',
    writes: true,
  },
  'availability.write': {
    label: "Set members' availability",
    description:
      "Set whether each of the company's members takes the conversations routing gives out, as members who assign conversations switch it in Settings → Teams, recorded in the audit log as done by the key. Only active members whose role answers conversations are made available, and making one available routes waiting conversations again.",
    permission: 'inbox.assign',
    writes: true,
  },
  'business_hours.read': {
    label: 'Read business hours',
    description:
      "Read the company's business hours, whether it is open now and when it next opens or closes, and its closed days, as members see them in Settings → Inbox.",
    permission: 'tenant.read',
    writes: false,
  },
  'business_hours.manage': {
    label: 'Manage business hours',
    description:
      "Read and set the company's weekly business hours, turn them on or off, and add and remove closed days, as owners and administrators do in Settings → Inbox, recorded in the audit log as done by the key. Reply-due timers and automations' off-hours branches follow them.",
    permission: 'tenant.settings.manage',
    writes: true,
  },
  'saved_replies.manage': {
    label: 'Manage saved replies',
    description:
      "Read, add, change and delete the company's saved replies, the answers members put in the reply box, as members who supervise the inbox do in Settings → Saved replies, recorded as changed through the API and in the audit log as done by the key. Keys that send replies read them too.",
    permission: 'inbox.supervise',
    writes: true,
  },
  'reports.read': {
    label: 'Read reports',
    description:
      "Read the numbers the Reports page shows for a period: messaging outcomes, estimated Meta charges, the inbox's reply and resolution times, satisfaction surveys, automation runs, CRM deals and forecasts, each member's activity and the funnel of campaigns, with what each metric counts. Counts, with the names of members, campaigns, automations and pipelines: never a message, contact or conversation.",
    permission: 'reports.read',
    writes: false,
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
  /**
   * The most an answer kept with an Idempotency-Key may take as jsonb, counted by `jsonbSize`
   * (ADR-339): the check of `app.api_idempotency_keys.response` (0259). An answer can give more
   * than its request carried (a webhook endpoint's whole configuration, an order with its items).
   */
  idempotentResponseBytes: 262_144,
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
