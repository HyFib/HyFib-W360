import { describe, expect, it } from 'vitest';
import {
  dealFieldComparisonLabel,
  describeDetail,
  describeDroppedValues,
  STEP_OUTCOMES,
} from './automation-labels';

describe('answers a web request left out for safety (ADR-406)', () => {
  it('names each answer with its reason, and nothing when none was left out', () => {
    expect(describeDroppedValues({})).toBeNull();
    expect(describeDroppedValues({ ref: 'echoed_secret', sid: 'refused_header' })).toBe(
      'Not saved: ref (it held a secret the request sent, which the server echoed); sid (the header can carry credentials or a session).',
    );
    expect(describeDroppedValues({ key: 'secret_header' })).toBe(
      'Not saved: key (the step sends a secret in that header, or it is named like a secret).',
    );
    // In the step's order, whatever order the database keeps the names in.
    expect(
      describeDroppedValues({ zed: 'possible_cut_echo', alpha: 'refused_header', other: 'x' }, [
        'alpha',
        'zed',
      ]),
    ).toBe(
      'Not saved: alpha (the header can carry credentials or a session); zed (it ended with the start of a secret the request sent, perhaps a cut echo); other (x).',
    );
  });
});

describe('conditions on deal fields (ADR-393)', () => {
  it('name a comparison for the field’s type: dates as days, the rest as other rules do', () => {
    expect(dealFieldComparisonLabel('date', 'equals')).toBe('is on');
    expect(dealFieldComparisonLabel('date', 'not_equals')).toBe('is not on');
    expect(dealFieldComparisonLabel('date', 'less_than')).toBe('is before');
    expect(dealFieldComparisonLabel('date', 'greater_than')).toBe('is after');
    expect(dealFieldComparisonLabel('date', 'is_set')).toBe('has a value');
    expect(dealFieldComparisonLabel('number', 'greater_than')).toBe('is more than');
    expect(dealFieldComparisonLabel('number', 'less_than')).toBe('is less than');
    expect(dealFieldComparisonLabel('text', 'contains')).toBe('contains');
    expect(dealFieldComparisonLabel('boolean', 'equals')).toBe('is');
    expect(dealFieldComparisonLabel('choice', 'not_equals')).toBe('is not');
    expect(dealFieldComparisonLabel('choice', 'is_not_set')).toBe('is empty');
  });

  it('say why a rule could not read the deal or its field', () => {
    expect(describeDetail('deal_rule_invalid:tier')).toBe(
      'the condition’s value for the deal field “tier” is no longer one the field takes',
    );
    expect(describeDetail('deal_field_missing:tier')).toBe(
      'the deal field “tier” no longer exists',
    );
    expect(describeDetail('deal_ambiguous')).toBe(
      'the contact has more than one open deal in the pipeline, so which one is meant is not known',
    );
    expect(describeDetail('deal_stage_unavailable')).toBe(
      'the pipeline or the stage was archived or removed',
    );
  });
});

describe('step log details of steps that set deal fields (ADR-386)', () => {
  it('name the field a step could not set', () => {
    expect(describeDetail('deal_field_missing:tier')).toBe(
      'the deal field “tier” no longer exists',
    );
    expect(describeDetail('deal_field_empty:region')).toBe(
      'the value for the deal field “region” was empty after filling in placeholders',
    );
    expect(describeDetail('deal_field_invalid:seats')).toBe(
      'the value for the deal field “seats” is not one it takes',
    );
  });

  it('say why nothing else changed, and keep the other codes as they were', () => {
    expect(describeDetail('deal_fields_unchanged')).toBe('the deal already had these values');
    expect(describeDetail('deal_fields_too_large')).toBe(
      'the deal’s custom field values would be more than 12 KiB in all',
    );
    expect(describeDetail('deal_not_open')).toBe('the contact has no open deal in the pipeline');
    expect(describeDetail('failed:131047')).toBe(
      'WhatsApp did not accept or deliver the message (error 131047)',
    );
    expect(describeDetail('store_event:order_placed')).toBe('a new order in a store');
    expect(describeDetail('404')).toBe('the server answered with status 404');
    expect(describeDetail('something_else:x')).toBe('something_else:x');
    expect(describeDetail('constructor:x')).toBe('constructor:x');
    // A step that updates the contact, the conversation or the deal.
    expect(STEP_OUTCOMES.updated).toBe('Updated details');
  });
});
