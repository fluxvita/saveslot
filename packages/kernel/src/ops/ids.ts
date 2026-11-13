// New identifiers (docs/zh-CN/spec/03-data-model/01-objects.md「标识的写法」): a prefix and random
// Crockford Base32 characters.

import { randomBytes } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `n` random Crockford Base32 characters (5 random bits each). */
export function randomCrockford(n: number): string {
  // 256 is a multiple of 32, so taking each byte modulo 32 is uniform.
  return [...randomBytes(n)].map((b) => CROCKFORD[b % 32]).join("");
}

export const newNodeId = () => `n_${randomCrockford(26)}` as const;
export const newConnectionId = () => `ci_${randomCrockford(26)}` as const;
