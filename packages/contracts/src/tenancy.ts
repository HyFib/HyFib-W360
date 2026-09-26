import { z } from 'zod';

/** Validation shared by browser forms and server services. Servers always re-validate. */
export const TENANT_ROLE_VALUES = ['owner', 'admin', 'supervisor', 'agent', 'marketer', 'analyst', 'billing'] as const;

export const roleSchema = z.enum(TENANT_ROLE_VALUES);
export const rolesSchema = z
  .array(roleSchema)
  .min(1, 'Choose at least one role')
  .max(7)
  .transform((roles) => [...new Set(roles)]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/, 'Use 3–48 lowercase letters, numbers or hyphens');

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z.string().trim().min(1).max(64).refine(isValidTimeZone, 'Unknown time zone');
export const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Invalid locale');

export const companyNameSchema = z.string().trim().min(2, 'At least 2 characters').max(120);

export const createCompanySchema = z.object({
  name: companyNameSchema,
  slug: slugSchema,
  timezone: timezoneSchema.default('Asia/Kolkata'),
});
export type CreateCompanyInput = z.input<typeof createCompanySchema>;

export const updateCompanySettingsSchema = z.object({
  name: companyNameSchema,
  timezone: timezoneSchema,
  locale: localeSchema,
});

export const updateCompanySecuritySchema = z.object({
  requireMfaAllMembers: z.boolean(),
});

export const emailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email('Enter a valid email address'));

export const inviteMemberSchema = z.object({
  email: emailSchema,
  roles: rolesSchema,
});

export const changeMemberRolesSchema = z.object({
  membershipId: z.uuid(),
  roles: rolesSchema,
});

export const memberStatusSchema = z.object({
  membershipId: z.uuid(),
  status: z.enum(['active', 'suspended', 'removed']),
});

export const invitationIdSchema = z.object({ invitationId: z.uuid() });

export const invitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/, 'Invalid invitation link');

export const auditQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().regex(/^[a-z][a-z0-9_.]{2,99}$/).optional(),
});

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');

export const signUpSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(200),
  email: emailSchema,
  password: passwordSchema,
});

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Required').max(128),
});

/** Suggests a URL slug from a company name. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 3 ? base : `${base || 'company'}-co`.slice(0, 40);
}
