import { z } from 'zod';
import {
  CSAT_SKIP_REASONS,
  MESSAGE_STATUSES,
  csatSurveys,
  exactTimestamp,
  messages,
  type CsatSkipReason,
  type MessageStatus,
} from '@w360/db';

/**
 * A satisfaction survey as the API reads it (ADR-292) and its webhook event gives it (ADR-293):
 * the shape, the columns it is read from and the mapping, without server dependencies.
 */

/** What a survey's `status` says. */
export const SATISFACTION_SURVEY_STATUSES = ['skipped', 'asked', 'answered'] as const;

/** A satisfaction survey as the API gives it. */
export interface ApiSatisfactionSurvey {
  id: string;
  conversationId: string;
  /**
   * `skipped`: not sent, for `skipReason`; `asked`: sent or being sent and not answered (see
   * `messageStatus`); `answered`: the customer tapped one of its buttons.
   */
  status: (typeof SATISFACTION_SURVEY_STATUSES)[number];
  skipReason: CsatSkipReason | null;
  /** The survey message, among the conversation's messages; null when skipped. */
  messageId: string | null;
  /** Its delivery status, as the conversation's messages give it; null when skipped. */
  messageStatus: MessageStatus | null;
  /** 3 for the first (best) button, 2 for the second and 1 for the third; null until answered. */
  score: 1 | 2 | 3 | null;
  /** The customer's tap, among the conversation's messages; null until answered. */
  answerMessageId: string | null;
  answeredAt: string | null;
  /** The member the conversation was assigned to when it was resolved, credited with the answer. */
  assigneeId: string | null;
  /** The member who resolved the conversation. */
  resolvedById: string | null;
  createdAt: string;
}

/** A satisfaction survey (ADR-292), as the OpenAPI document describes it. */
export const apiSatisfactionSurveySchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  status: z
    .enum(SATISFACTION_SURVEY_STATUSES)
    .describe(
      '`skipped`: not sent, for `skipReason`; `asked`: sent, or being sent, and not answered (`messageStatus` says how far it got); `answered`: the customer tapped one of its buttons.',
    ),
  skipReason: z
    .enum(CSAT_SKIP_REASONS)
    .nullable()
    .describe(
      'Why it was not sent: `window_closed` (the customer last wrote more than 24 hours before), `opted_out`, `suppressed`, `contact_erased`, `no_phone`, `channel_inactive`, or `recently_surveyed` (the conversation was asked within 24 hours).',
    ),
  messageId: z
    .uuid()
    .nullable()
    .describe('The survey message, among the conversation’s messages; null when skipped.'),
  messageStatus: z
    .enum(MESSAGE_STATUSES)
    .nullable()
    .describe('Its delivery status, as the conversation’s messages give it; null when skipped.'),
  score: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .nullable()
    .describe(
      '3 for the first (best) button, 2 for the second, 1 for the third; null until answered.',
    ),
  answerMessageId: z
    .uuid()
    .nullable()
    .describe('The customer’s tap, among the conversation’s messages; null until answered.'),
  answeredAt: z.iso.datetime().nullable(),
  assigneeId: z
    .uuid()
    .nullable()
    .describe(
      'The member the conversation was assigned to when it was resolved, credited with the answer, as GET /members lists them.',
    ),
  resolvedById: z.uuid().nullable().describe('The member who resolved the conversation.'),
  createdAt: z.iso
    .datetime()
    .describe('When it was sent, or skipped: when the conversation was resolved.'),
});

/** The columns of a survey as the API reads it, its message joined for the status. */
export const satisfactionSurveyColumns = {
  id: csatSurveys.id,
  conversationId: csatSurveys.conversationId,
  skipReason: csatSurveys.skipReason,
  messageId: csatSurveys.messageId,
  messageStatus: messages.status,
  score: csatSurveys.score,
  answerMessageId: csatSurveys.responseMessageId,
  answeredAt: csatSurveys.answeredAt,
  assigneeId: csatSurveys.assignedMembershipId,
  resolvedById: csatSurveys.resolvedByMembershipId,
  createdAt: csatSurveys.createdAt,
  cursorAt: exactTimestamp(csatSurveys.createdAt),
};

/** A survey row as the API gives it. */
export function toApiSatisfactionSurvey(row: {
  id: string;
  conversationId: string;
  skipReason: CsatSkipReason | null;
  messageId: string | null;
  messageStatus: MessageStatus | null;
  score: number | null;
  answerMessageId: string | null;
  answeredAt: Date | null;
  assigneeId: string | null;
  resolvedById: string | null;
  createdAt: Date;
}): ApiSatisfactionSurvey {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.skipReason ? 'skipped' : row.answeredAt ? 'answered' : 'asked',
    skipReason: row.skipReason,
    messageId: row.messageId,
    messageStatus: row.messageStatus,
    score: row.score as 1 | 2 | 3 | null,
    answerMessageId: row.answerMessageId,
    answeredAt: row.answeredAt?.toISOString() ?? null,
    assigneeId: row.assigneeId,
    resolvedById: row.resolvedById,
    createdAt: row.createdAt.toISOString(),
  };
}
