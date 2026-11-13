// Byte forms and hashes of the log (docs/zh-CN/spec/09-event-format.md §1.2, §1.5).
//
// The event header and every content block are stored as their RFC 8785 (JCS) text; that text is
// authoritative. The header hash is SHA-256 over the header's UTF-8 bytes; a block's checksum is
// SHA-256 over the block's UTF-8 bytes. Both are lowercase hex and computed in the application,
// never by the database (§1.5), so both backends agree.

import { createHash } from "node:crypto";
import { canonicalize, type JcsValue } from "@fluxvita/saveslot-contract-core";

/** SHA-256 of a text's UTF-8 bytes, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A value's JCS text and the SHA-256 of that text. */
export function encode(value: JcsValue): { readonly text: string; readonly hash: string } {
  const text = canonicalize(value);
  return { text, hash: sha256Hex(text) };
}

/**
 * Parses a stored JCS text. Returns undefined when the text is not JSON or not in canonical form
 * (re-encoding it gives different bytes): the stored bytes are not what was hashed.
 */
export function decodeCanonical(text: string): JcsValue | undefined {
  let value: JcsValue;
  try {
    value = JSON.parse(text) as JcsValue;
    return canonicalize(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}
