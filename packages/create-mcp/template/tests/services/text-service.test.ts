import { describe, it, expect } from 'vitest';
import { TextService } from '../../src/services/text-service.js';

describe('TextService', () => {
  const service = new TextService();

  describe('reverseString', () => {
    it('reverses text', () => {
      const result = service.reverseString({ text: 'abc' });
      expect(result.reversed).toBe('cba');
      expect(result.original).toBe('abc');
      expect(result.length).toBe(3);
    });

    it('handles palindrome', () => {
      const result = service.reverseString({ text: 'racecar' });
      expect(result.reversed).toBe('racecar');
    });
  });

  describe('wordCount', () => {
    it('counts words correctly', () => {
      const result = service.wordCount({ text: 'one two three' });
      expect(result.wordCount).toBe(3);
      expect(result.characterCount).toBe(13);
    });

    it('counts unique words', () => {
      const result = service.wordCount({ text: 'hello Hello HELLO', unique: true });
      expect(result.uniqueWords).toBe(1);
    });

    it('handles multiple spaces', () => {
      const result = service.wordCount({ text: '  spaced   out  ' });
      expect(result.wordCount).toBe(2);
    });
  });
});
