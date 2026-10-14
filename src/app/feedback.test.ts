import { describe, expect, it } from 'vitest';
import { feedbackName } from './feedback';

describe('feedback screenshot names', () => {
  it('name the stage and the local date and time', () => {
    expect(feedbackName('aar', new Date(2026, 9, 14, 9, 5, 7))).toBe(
      'feedback-aar-20261014-090507',
    );
    expect(feedbackName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('feedback-page-20260102-030405');
  });
});
