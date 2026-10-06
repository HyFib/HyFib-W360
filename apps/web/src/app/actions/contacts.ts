'use server';
import { refresh } from 'next/cache';
import { AppError } from '@w360/core';
import {
  IMPORT_LIMITS,
  bulkTagSummary,
  queueTemplateMessage,
  type ImportResult,
} from '@w360/domain';
import { getRuntime } from '@/server/runtime';
import { runAction, type ActionResult } from '@/server/action';
import { requestMeta } from '@/server/session';
import { tenantForAction } from '@/server/tenant-action';

/** Reads an uploaded CSV from form data with the import size limit enforced before reading. */
async function readCsv(form: FormData): Promise<{ fileName: string; text: string }> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    throw new AppError('validation_failed', 'Choose a CSV file to import.');
  }
  if (file.size > IMPORT_LIMITS.maxBytes) {
    throw new AppError(
      'validation_failed',
      `The file is larger than the ${Math.floor(IMPORT_LIMITS.maxBytes / 1000)} KB import limit. Split it into smaller files.`,
    );
  }
  const name = file.name.replace(/[^\w.\- ]/g, '_').slice(0, 200) || 'contacts.csv';
  return { fileName: name, text: await file.text() };
}

export async function createContactAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    return contacts.createContact(ctx, input, await requestMeta());
  });
}

export async function updateContactAction(
  slug: string,
  contactId: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    await contacts.updateContact(ctx, String(contactId), input, await requestMeta());
    refresh();
    return null;
  });
}

export async function addTagsAction(
  slug: string,
  contactId: string,
  tags: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    await contacts.addTags(ctx, String(contactId), String(tags ?? '').split(','));
    refresh();
    return null;
  });
}

export async function removeTagAction(
  slug: string,
  contactId: string,
  tag: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    await contacts.removeTag(ctx, String(contactId), String(tag));
    refresh();
    return null;
  });
}

/** Adds or removes a tag on every contact the filters match (ADR-213); says what it did. */
export async function bulkTagContactsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ message: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    const result = await contacts.bulkTagContacts(ctx, input, await requestMeta());
    refresh();
    return { message: bulkTagSummary(result) };
  });
}

export async function recordConsentAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { consent } = await getRuntime();
    await consent.recordConsent(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function eraseContactAction(
  slug: string,
  input: { contactId: string; suppress: boolean },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    await contacts.eraseContact(
      ctx,
      { contactId: String(input.contactId), suppress: input.suppress === true },
      await requestMeta(),
    );
    refresh();
    return null;
  });
}

/** Merges one contact into another (ADR-224); the kept contact's page is shown next. */
export async function mergeContactsAction(
  slug: string,
  input: { keepContactId: string; mergeContactId: string },
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contactMerges } = await getRuntime();
    await contactMerges.mergeContacts(
      ctx,
      { keepContactId: String(input.keepContactId), mergeContactId: String(input.mergeContactId) },
      await requestMeta(),
    );
    refresh();
    return null;
  });
}

export async function previewImportAction(slug: string, form: FormData) {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    return contacts.previewImport(ctx, await readCsv(form));
  });
}

export async function importContactsAction(
  slug: string,
  form: FormData,
): Promise<ActionResult<ImportResult>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    const csv = await readCsv(form);
    let options: unknown;
    try {
      options = JSON.parse(String(form.get('options') ?? '{}'));
    } catch {
      throw new AppError('validation_failed', 'The import settings could not be read.');
    }
    const result = await contacts.importContacts(
      ctx,
      { ...(options as Record<string, unknown>), fileName: csv.fileName, text: csv.text },
      await requestMeta(),
    );
    refresh();
    return result;
  });
}

export async function createFieldAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ id: string; key: string }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    const result = await contacts.createField(ctx, input, await requestMeta());
    refresh();
    return result;
  });
}

export async function deleteFieldAction(slug: string, fieldId: string): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { contacts } = await getRuntime();
    await contacts.deleteField(ctx, String(fieldId), await requestMeta());
    refresh();
    return null;
  });
}

export async function updateMessagingSettingsAction(
  slug: string,
  input: unknown,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { consent } = await getRuntime();
    await consent.updateSettings(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function addSuppressionAction(slug: string, input: unknown): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { consent } = await getRuntime();
    await consent.addSuppression(ctx, input, await requestMeta());
    refresh();
    return null;
  });
}

export async function removeSuppressionAction(
  slug: string,
  suppressionId: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { consent } = await getRuntime();
    await consent.removeSuppression(ctx, String(suppressionId), await requestMeta());
    refresh();
    return null;
  });
}

export async function sendTemplateAction(
  slug: string,
  input: unknown,
): Promise<ActionResult<{ messageId: string; conversationId: string | null }>> {
  return runAction(async () => {
    const ctx = await tenantForAction(slug);
    const { outbound } = await getRuntime();
    const result = await queueTemplateMessage(outbound, ctx, input);
    refresh();
    return {
      messageId: result.messageId,
      conversationId: 'conversationId' in result ? (result.conversationId ?? null) : null,
    };
  });
}
