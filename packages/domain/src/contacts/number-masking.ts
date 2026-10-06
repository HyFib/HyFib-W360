import { z } from 'zod';
import { MASKABLE_ROLES, type MaskableRole } from '@w360/db';
import type { TenantContext } from '../authz/context';

export { MASKABLE_ROLES, type MaskableRole };

/**
 * Hiding customers' numbers from chosen roles (W-044, ADR-226). Owners and administrators choose
 * the roles whose members see customers' numbers masked; the tenant context then leaves out
 * `contacts.view_numbers` for a member whose every role that grants it is masked. Services mask
 * before anything leaves the server, so a masked member's pages, files and emails never hold a
 * customer's number whole. Messages' content (a number a customer wrote, a contact card) is not
 * masked: it is what the customer sent.
 */

/** The character standing for each hidden digit. */
export const MASK_DOT = '•';

/**
 * A number as a masked member sees it: the plus, at most the first three digits and the last two,
 * every other digit a dot, and at least three digits hidden. `+919845012345` reads
 * `+919•••••••45`.
 */
export function maskPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  const n = digits.length;
  const lead = Math.max(0, Math.min(3, n - 5));
  const tail = Math.min(2, Math.max(0, n - lead - 3));
  const plus = phone.trimStart().startsWith('+') ? '+' : '';
  return `${plus}${digits.slice(0, lead)}${MASK_DOT.repeat(n - lead - tail)}${digits.slice(n - tail)}`;
}

/** Who reads a number: what masking needs of a member's context. */
export type NumberViewer = Pick<TenantContext, 'permissions'>;

/** Whether the member sees customers' numbers whole. */
export const seesNumbers = (ctx: NumberViewer): boolean =>
  ctx.permissions.has('contacts.view_numbers');

/** A customer's number as this member may see it: whole, or masked. */
export function shownNumber(ctx: NumberViewer, phone: string | null | undefined): string | null {
  if (!phone) return null;
  return seesNumbers(ctx) ? phone : maskPhoneNumber(phone);
}

/** The roles to mask, once each, in the order Settings lists them. */
export const numberMaskingSchema = z.object({
  maskedNumberRoles: z
    .array(z.enum(MASKABLE_ROLES, { error: 'Choose roles from the list' }))
    .max(MASKABLE_ROLES.length)
    .transform((chosen): MaskableRole[] => MASKABLE_ROLES.filter((role) => chosen.includes(role))),
});
