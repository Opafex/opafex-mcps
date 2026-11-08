/** stdout, stderr and an MCP result are each capped at this many bytes. */
export const OUTPUT_CAP_BYTES = 256 * 1024;

/** Drops a UTF-8 character left incomplete at the end of a buffer by a cut. */
export function dropPartialTail(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  let i = buf.length - 1;
  let back = 0;
  while (i > 0 && back < 3 && (buf[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  const lead = buf[i];
  const needed = lead < 0x80 ? 1 : lead >> 5 === 0b110 ? 2 : lead >> 4 === 0b1110 ? 3 : lead >> 3 === 0b11110 ? 4 : 1;
  return buf.length - i < needed ? buf.subarray(0, i) : buf;
}

/** Collects a stream's bytes up to a cap, keeps reading past it (so the child never blocks), and says if it cut. */
export class CappedBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number = OUTPUT_CAP_BYTES) {}

  push(chunk: Buffer): void {
    if (this.size >= this.max) {
      if (chunk.length) this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
    } else {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  toString(): string {
    const all = Buffer.concat(this.chunks);
    return (this.truncated ? dropPartialTail(all) : all).toString('utf8');
  }
}
