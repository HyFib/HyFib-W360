import { describe, expect, it } from 'vitest';
import type { TenantRole } from '@w360/db';
import type { TenantContext } from '../authz/context';
import { permissionsForRoles } from '../authz/permissions';
import { setupSteps, type SetupFacts } from './setup-checklist';

const ctxOf = (roles: TenantRole[]) =>
  ({
    tenant: { slug: 'acme' },
    permissions: permissionsForRoles(roles),
  }) as unknown as TenantContext;

const everything: SetupFacts = {
  twoFactorEnabled: false,
  numbers: { active: 0, needAttention: 0 },
  approvedTemplate: false,
  anyContact: false,
  teammates: false,
  responseTargetMinutes: null,
};

describe('the setup checklist (ADR-233)', () => {
  it('lists the steps in order, each linked to where it is taken', () => {
    const steps = setupSteps(ctxOf(['owner']), everything, true);
    expect(steps.map((s) => [s.key, s.done, s.href])).toEqual([
      ['two_factor', false, '/account#security'],
      ['number', false, '/c/acme/settings/channels'],
      ['template', false, '/c/acme/templates/new'],
      ['contacts', false, '/c/acme/contacts'],
      ['team', false, '/c/acme/settings/members'],
      ['response_target', false, '/c/acme/settings/inbox'],
    ]);
    expect(steps.find((s) => s.key === 'template')?.note).toContain('HyFib’s starters');
    expect(steps.find((s) => s.key === 'contacts')?.note).toBe(
      'Import them from a CSV file or add them one by one.',
    );
    expect(steps.find((s) => s.key === 'number')?.note).toBeNull();
  });

  it('marks each step done from the company’s data', () => {
    const steps = setupSteps(
      ctxOf(['owner']),
      {
        twoFactorEnabled: true,
        numbers: { active: 1, needAttention: 0 },
        approvedTemplate: true,
        anyContact: true,
        teammates: true,
        responseTargetMinutes: 30,
      },
      true,
    );
    expect(steps.every((s) => s.done)).toBe(true);
    // Any target set counts, however short.
    expect(
      setupSteps(ctxOf(['owner']), { ...everything, responseTargetMinutes: 5 }, true).find(
        (s) => s.key === 'response_target',
      )?.done,
    ).toBe(true);
  });

  it('shows only the steps whose data the member can read', () => {
    const steps = setupSteps(
      ctxOf(['agent']),
      { twoFactorEnabled: false, numbers: { active: 1, needAttention: 0 }, anyContact: true },
      true,
    );
    expect(steps.map((s) => s.key)).toEqual(['two_factor', 'number', 'contacts']);
    // Agents do not import contacts, so the step does not suggest it.
    expect(steps.find((s) => s.key === 'contacts')?.note).toBeNull();
    // Without the right to write templates, the step opens the list instead of a new draft.
    const reader = setupSteps(
      ctxOf(['analyst']),
      { twoFactorEnabled: true, approvedTemplate: false },
      true,
    );
    expect(reader.map((s) => s.key)).toEqual(['two_factor', 'template']);
    expect(reader.find((s) => s.key === 'template')).toMatchObject({
      href: '/c/acme/templates',
      note: null,
    });
  });

  it('says when numbers need reconnecting, or cannot be connected in this deployment', () => {
    const note = (numbers: SetupFacts['numbers'], connectable: boolean) =>
      setupSteps(ctxOf(['owner']), { ...everything, numbers }, connectable).find(
        (s) => s.key === 'number',
      )?.note;
    expect(note({ active: 1, needAttention: 1 }, true)).toBe(
      'A number needs reconnecting: see Settings → Channels.',
    );
    expect(note({ active: 0, needAttention: 2 }, false)).toBe(
      '2 numbers need reconnecting: see Settings → Channels.',
    );
    expect(note({ active: 0, needAttention: 0 }, false)).toBe(
      'Connecting a number needs Meta’s Embedded Signup set up for this HyFib deployment.',
    );
    expect(note({ active: 1, needAttention: 0 }, false)).toBeNull();
  });
});
