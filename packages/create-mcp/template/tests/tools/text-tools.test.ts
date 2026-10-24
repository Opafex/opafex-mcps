import { describe, it, expect } from 'vitest';
import { textTools } from '../../src/tools/text-tools.js';
import { TextService } from '../../src/services/text-service.js';

describe('textTools', () => {
  const service = new TextService();
  const tools = textTools(service);

  it('registers 2 tools', () => {
    expect(tools).toHaveLength(2);
  });

  describe('reverse_string', () => {
    const tool = tools.find((t) => t.name === 'reverse_string')!;

    it('reverses a string', async () => {
      const result = await tool.handler({ text: 'hello' }) as { reversed: string };
      expect(result.reversed).toBe('olleh');
    });

    it('handles empty string', async () => {
      const result = await tool.handler({ text: '' }) as { reversed: string; length: number };
      expect(result.reversed).toBe('');
      expect(result.length).toBe(0);
    });
  });

  describe('word_count', () => {
    const tool = tools.find((t) => t.name === 'word_count')!;

    it('counts words', async () => {
      const result = await tool.handler({ text: 'hello world' }) as { wordCount: number };
      expect(result.wordCount).toBe(2);
    });

    it('counts unique words', async () => {
      const result = await tool.handler({ text: 'the cat sat on the mat', unique: true }) as { wordCount: number; uniqueWords: number };
      expect(result.wordCount).toBe(6);
      expect(result.uniqueWords).toBe(5);
    });
  });
});
