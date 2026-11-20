/**
 * Byte order: the order `COLLATE "C"` gives every server text column (`0023_byte_order`), so the
 * order the in-memory fakes and caches sort and page text in.
 *
 * Not `<`: that compares UTF-16 code units, and "C" compares UTF-8 bytes, which is code-point order.
 * The two agree below U+E000 and disagree when a character from U+E000 to U+FFFF (fullwidth forms,
 * common in Japanese credit lines) meets one past U+FFFF (emoji, rare CJK), since UTF-16 spells the
 * second with surrogates that sort below U+E000. Every id, DID, hash and key is ASCII; attribution
 * is free text.
 */
export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
