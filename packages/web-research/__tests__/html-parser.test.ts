import { describe, it, expect } from 'vitest';
import {
  stripTags,
  decodeHtmlEntities,
  extractRawText,
  extractTitle,
  extractLinks,
} from '../src/html-parser.js';

describe('stripTags', () => {
  it('removes tags and keeps text', () => {
    expect(stripTags('<b>bold</b> and <i class="x">italic</i>')).toBe('bold and italic');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes named entities', () => {
    expect(decodeHtmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f')).toBe(`a & b <c> "d" 'e' f`);
  });

  it('decodes decimal and hex numeric entities', () => {
    expect(decodeHtmlEntities('&#65;&#x42;&#X43;')).toBe('ABC');
  });
});

describe('extractTitle', () => {
  it('returns the decoded title', () => {
    expect(extractTitle('<html><head><title> Tom &amp; Jerry </title></head></html>')).toBe('Tom & Jerry');
  });

  it('returns an empty string when there is no title', () => {
    expect(extractTitle('<html><body>no title</body></html>')).toBe('');
  });
});

describe('extractRawText', () => {
  it('drops scripts and styles, including multi-line ones', () => {
    const doc = `<p>Visible</p><script type="text/javascript">
      var secret = "x";
    </script><style>
      body { color: red; }
    </style><p>Also visible</p>`;
    const text = extractRawText(doc);
    expect(text).toContain('Visible');
    expect(text).toContain('Also visible');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('color');
  });

  it('removes requested elements, including nested instances', () => {
    const doc = '<nav>Menu<nav>Sub menu</nav>More menu</nav><main>Article body</main><footer>Footer text</footer>';
    const text = extractRawText(doc, ['nav', 'footer']);
    expect(text).toContain('Article body');
    expect(text).not.toContain('Menu');
    expect(text).not.toContain('Sub menu');
    expect(text).not.toContain('More menu');
    expect(text).not.toContain('Footer text');
  });

  it('turns block elements into line breaks and collapses whitespace', () => {
    const text = extractRawText('<h1>Heading</h1><p>First    para</p><p>Second</p>');
    expect(text.split('\n').filter((l) => l.trim())).toEqual(['Heading', 'First para', 'Second']);
  });

  it('decodes entities in the text', () => {
    expect(extractRawText('<p>Fish &amp; chips</p>')).toBe('Fish & chips');
  });
});

describe('extractLinks', () => {
  it('extracts href and text, skipping anchors and javascript: links', () => {
    const doc = `
      <a href="https://example.com/a">Link <b>A</b></a>
      <a href="#top">Top</a>
      <a href="javascript:void(0)">JS</a>
      <a class="x" href="/relative">Relative</a>
      <a href="https://example.com/empty"></a>`;
    expect(extractLinks(doc)).toEqual([
      { text: 'Link A', href: 'https://example.com/a' },
      { text: 'Relative', href: '/relative' },
    ]);
  });

  it('respects maxLinks', () => {
    const doc = Array.from({ length: 10 }, (_, i) => `<a href="/p${i}">P${i}</a>`).join('');
    expect(extractLinks(doc, 3)).toHaveLength(3);
  });
});
