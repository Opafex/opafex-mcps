import type { ReverseStringInput, ReverseStringResult, WordCountInput, WordCountResult } from '../types.js';

/**
 * Example service layer — business logic separate from tool definitions.
 * In a real MCP server, this would call external APIs, databases, etc.
 */
export class TextService {
  reverseString(input: ReverseStringInput): ReverseStringResult {
    return {
      original: input.text,
      reversed: input.text.split('').reverse().join(''),
      length: input.text.length,
    };
  }

  wordCount(input: WordCountInput): WordCountResult {
    const words = input.text.trim().split(/\s+/).filter(Boolean);
    const result: WordCountResult = {
      text: input.text,
      wordCount: words.length,
      characterCount: input.text.length,
    };
    if (input.unique) {
      result.uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
    }
    return result;
  }
}
