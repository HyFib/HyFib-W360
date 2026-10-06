import { describe, expect, it } from 'vitest';
import {
  TYPO_MIN_LENGTH,
  TYPO_TWO_LENGTH,
  equalsKeyword,
  equalsKeywordWithTypos,
  matchesKeyword,
  matchesKeywordWithTypos,
  typoAllowance,
  withinEdits,
} from './keywords';

describe('keywords with small typos (ADR-240)', () => {
  it('allow none in short words or words with digits, one up to eight characters, two from nine', () => {
    expect([TYPO_MIN_LENGTH, TYPO_TWO_LENGTH]).toEqual([5, 9]);
    expect(typoAllowance('menu')).toBe(0);
    expect(typoAllowance('price')).toBe(1);
    expect(typoAllowance('delivery')).toBe(1);
    expect(typoAllowance('cancellation')).toBe(2);
    expect(typoAllowance('order66')).toBe(0);
    expect(typoAllowance('१२३४५')).toBe(0);
    // Characters, not UTF-16 units: four emoji are a short word.
    expect(typoAllowance('😀😀😀😀')).toBe(0);
    expect(typoAllowance('नमस्ते')).toBe(1);
  });

  it('count inserted, deleted, replaced and swapped characters', () => {
    expect(withinEdits('refund', 'refund', 0)).toBe(true);
    expect(withinEdits('refnd', 'refund', 1)).toBe(true);
    expect(withinEdits('refuund', 'refund', 1)).toBe(true);
    expect(withinEdits('refond', 'refund', 1)).toBe(true);
    expect(withinEdits('refnud', 'refund', 1)).toBe(true);
    expect(withinEdits('rfeund', 'refund', 1)).toBe(true);
    expect(withinEdits('rfnud', 'refund', 1)).toBe(false);
    expect(withinEdits('rfnud', 'refund', 2)).toBe(true);
    expect(withinEdits('refunded', 'refund', 1)).toBe(false);
    expect(withinEdits('refunded', 'refund', 2)).toBe(true);
    expect(withinEdits('', 'ab', 1)).toBe(false);
    expect(withinEdits('', 'ab', 2)).toBe(true);
    // Typos early in a word are not hidden by the rest matching.
    expect(withinEdits('xxlivery', 'delivery', 2)).toBe(true);
    expect(withinEdits('xxxivery', 'delivery', 2)).toBe(false);
    expect(withinEdits('dleivery', 'delivery', 1)).toBe(true);
    // An emoji is one character.
    expect(withinEdits('a😀bcd', 'abcd', 1)).toBe(true);
  });

  it('match the words of a keyword in a message, each with its typos, the first letter as written', () => {
    expect(matchesKeywordWithTypos('I want a refnud please', 'refund')).toBe(true);
    expect(matchesKeywordWithTypos('Where is my delivry?', 'delivery')).toBe(true);
    expect(matchesKeywordWithTypos('cancelatoin of order', 'cancellation')).toBe(true);
    // Each word of a keyword allows its own typos, and every word must match.
    expect(matchesKeywordWithTypos('track my ordr staus', 'order status')).toBe(true);
    expect(matchesKeywordWithTypos('track my order stat', 'order status')).toBe(false);
    expect(matchesKeywordWithTypos('order status', 'order status')).toBe(true);
    // The first letter must match; short words and words with digits must match exactly.
    expect(matchesKeywordWithTypos('a gefund please', 'refund')).toBe(false);
    expect(matchesKeywordWithTypos('the meny please', 'menu')).toBe(false);
    expect(matchesKeywordWithTypos('order 12346', 'order 12345')).toBe(false);
    expect(matchesKeywordWithTypos('price list', 'price 2')).toBe(false);
    expect(matchesKeywordWithTypos('price2', 'price1')).toBe(false);
    expect(matchesKeywordWithTypos('my r3fund', 'refund')).toBe(false);
    // Whole words only: a typo never joins or splits words.
    expect(matchesKeywordWithTypos('refundplease', 'refund')).toBe(false);
    expect(matchesKeywordWithTypos('', 'refund')).toBe(false);
    expect(matchesKeywordWithTypos('refund', '!!!')).toBe(false);
  });

  it('match a message that is only a keyword, with its typos', () => {
    expect(equalsKeywordWithTypos('Refnud!', 'refund')).toBe(true);
    expect(equalsKeywordWithTypos('refnud please', 'refund')).toBe(false);
    expect(equalsKeywordWithTypos('ordr status', 'order status')).toBe(true);
    expect(equalsKeywordWithTypos('order', 'order status')).toBe(false);
    expect(equalsKeywordWithTypos('', 'refund')).toBe(false);
    // Without typos the existing matches are unchanged.
    expect(equalsKeyword('Refnud!', 'refund')).toBe(false);
    expect(matchesKeyword('I want a refnud', 'refund')).toBe(false);
  });
});
