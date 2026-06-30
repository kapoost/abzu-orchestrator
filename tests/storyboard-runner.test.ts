import { describe, expect, test } from 'bun:test';
import { getPath, runValidation } from '../storyboards/runner.ts';

const sample = {
  status: 'completed',
  plans: [
    {
      plan_id: 'p1',
      status: 'active',
      summary: { checks_performed: 3, outcomes_reported: 1 },
      entries: [{ id: 'e1', type: 'check' }, { id: 'e2', type: 'outcome' }],
    },
  ],
  governance_check: { verdict: 'approved', check_id: 'chk_1' },
};

describe('getPath', () => {
  test('reads simple fields', () => {
    expect(getPath(sample, 'status')).toBe('completed');
  });
  test('reads nested array indices', () => {
    expect(getPath(sample, 'plans[0].plan_id')).toBe('p1');
    expect(getPath(sample, 'plans[0].entries[1].type')).toBe('outcome');
  });
  test('reads array.length synthetic key', () => {
    expect(getPath(sample, 'plans[0].entries.length')).toBe(2);
  });
  test('returns undefined for missing path', () => {
    expect(getPath(sample, 'plans[0].nonexistent')).toBeUndefined();
    expect(getPath(sample, 'plans[5].plan_id')).toBeUndefined();
  });
});

describe('runValidation', () => {
  test('http_status pass', () => {
    expect(runValidation({ check: 'http_status', value: 200 }, 200, {}).ok).toBe(true);
  });
  test('http_status fail', () => {
    expect(runValidation({ check: 'http_status', value: 200 }, 502, {}).ok).toBe(false);
  });
  test('field_present pass on nested array', () => {
    expect(
      runValidation({ check: 'field_present', path: 'plans[0].plan_id' }, 200, sample).ok,
    ).toBe(true);
  });
  test('field_present fail on missing', () => {
    expect(
      runValidation({ check: 'field_present', path: 'plans[0].missing' }, 200, sample).ok,
    ).toBe(false);
  });
  test('field_value pass', () => {
    expect(
      runValidation(
        { check: 'field_value', path: 'governance_check.verdict', value: 'approved' },
        200,
        sample,
      ).ok,
    ).toBe(true);
  });
  test('field_value fail with detail', () => {
    const r = runValidation(
      { check: 'field_value', path: 'governance_check.verdict', value: 'denied' },
      200,
      sample,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('approved');
  });
  test('field_value_min pass', () => {
    expect(
      runValidation(
        { check: 'field_value_min', path: 'plans[0].summary.checks_performed', value: 1 },
        200,
        sample,
      ).ok,
    ).toBe(true);
  });
  test('field_value_min fail', () => {
    expect(
      runValidation(
        { check: 'field_value_min', path: 'plans[0].summary.outcomes_reported', value: 5 },
        200,
        sample,
      ).ok,
    ).toBe(false);
  });
  test('not_field_present pass on missing', () => {
    expect(
      runValidation({ check: 'not_field_present', path: 'plans[0].error' }, 200, sample).ok,
    ).toBe(true);
  });
  test('not_field_present fail on existing', () => {
    expect(
      runValidation(
        { check: 'not_field_present', path: 'governance_check.verdict' },
        200,
        sample,
      ).ok,
    ).toBe(false);
  });
  test('error_code pass on body.code', () => {
    expect(
      runValidation(
        { check: 'error_code', allowed_values: ['governance_denied'] },
        409,
        { code: 'governance_denied' },
      ).ok,
    ).toBe(true);
  });
  test('error_code pass on nested error.code', () => {
    expect(
      runValidation(
        { check: 'error_code', allowed_values: ['BAD'] },
        400,
        { error: { code: 'BAD' } },
      ).ok,
    ).toBe(true);
  });
  test('error_code fail when not allowed', () => {
    expect(
      runValidation(
        { check: 'error_code', allowed_values: ['X'] },
        409,
        { code: 'Y' },
      ).ok,
    ).toBe(false);
  });
});
