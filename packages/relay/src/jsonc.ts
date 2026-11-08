/**
 * The config file is JSON with comments allowed (`//` and `/* *\/`), so `opafex-relay init`
 * can write an example that explains itself. Comments are removed outside strings only; line
 * numbers are kept so a JSON syntax error still points at the right line.
 */
export function stripJsonComments(text: string): string {
  let src = text;
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Error('a /* comment is never closed');
      out += src.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
