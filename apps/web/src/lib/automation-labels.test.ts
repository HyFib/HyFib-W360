import { describe, expect, it } from 'vitest';
import { describeDetail, STEP_OUTCOMES } from './automation-labels';

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
