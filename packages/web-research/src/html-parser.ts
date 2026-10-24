/**
 * In-house HTML parsing utilities (regex-based, zero external dependencies).
 * Adapted from apps/customer-portal/lib/search/html-parser.ts.
 *
 * IMPORTANT: No ES2018+ regex flags (no `s` flag). Uses [\s\S] instead.
 */

/**
 * Remove all HTML tags from a string.
 */
export function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Decode common HTML entities (named + numeric).
 */
export function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
    '&copy;': '(c)',
    '&reg;': '(R)',
    '&trade;': '(TM)',
  };

  let decoded = text;
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.split(entity).join(char);
  }

  // Numeric entities (decimal and hex)
  decoded = decoded.replace(/&#(\d+);/g, (_, num) =>
    String.fromCharCode(parseInt(num, 10))
  );
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );

  return decoded;
}

/**
 * Remove all instances of a tag and its content, handling nested instances
 * by stripping innermost matches first and looping outward.
 */
function removeTagDeep(html: string, tag: string): string {
  const innerRegex = new RegExp(
    `<${tag}\\b[^>]*>(?:(?!<${tag}\\b)[\\s\\S])*?<\\/${tag}>`,
    'gi'
  );

  let text = html;
  let prev: string;
  let iterations = 0;
  do {
    prev = text;
    text = text.replace(innerRegex, '');
    iterations++;
  } while (text !== prev && iterations < 50);

  // Clean up orphaned closing tags
  text = text.replace(new RegExp(`<\\/${tag}>`, 'gi'), '');

  return text;
}

/**
 * Extract raw text from HTML by removing scripts, styles, and all tags.
 * Optionally remove additional element types (e.g. 'nav', 'footer').
 */
export function extractRawText(
  html: string,
  removeElements?: string[]
): string {
  let text = html;

  // Remove scripts and styles
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove additional element types with nested-safe removal
  if (removeElements) {
    for (const tag of removeElements) {
      text = removeTagDeep(text, tag);
    }
  }

  // Convert block-level elements to newlines for readability
  text = text.replace(/<\/?(div|p|h[1-6]|li|tr|br|hr)[^>]*>/gi, '\n');

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeHtmlEntities(text);
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();
  return text;
}

/**
 * Extract the <title> content from an HTML document.
 */
export function extractTitle(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : '';
}

/**
 * Extract all links from HTML.
 * Returns array of {text, href}.
 */
export function extractLinks(
  html: string,
  maxLinks: number = 50
): Array<{ text: string; href: string }> {
  const linkRegex = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: Array<{ text: string; href: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null && links.length < maxLinks) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').trim();
    if (href && text && !href.startsWith('#') && !href.startsWith('javascript:')) {
      links.push({ text, href });
    }
  }

  return links;
}
