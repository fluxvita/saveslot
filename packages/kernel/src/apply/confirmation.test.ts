// The confirmation hash (09-event-format §5.8 `item.resolved` `confirmation`): SHA-256 of the entry
// blocks' checksums ordered by (seq, path), joined by newlines.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { confirmationHash } from "./confirmation.ts";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("confirmationHash", () => {
  it("orders the checksums by seq, then by path (as text), whatever order they come in", () => {
    const entries = [
      { seq: 12, path: "current/0", checksum: "c" },
      { seq: 9, path: "previous/0", checksum: "b" },
      { seq: 9, path: "candidates/0", checksum: "a" },
      { seq: 12, path: "candidates/10", checksum: "d" },
    ];
    expect(confirmationHash(entries)).toBe(sha("a\nb\nd\nc"));
    expect(confirmationHash([...entries].reverse())).toBe(sha("a\nb\nd\nc"));
  });

  it("none for no entries; removed when an entry's block was removed", () => {
    expect(confirmationHash([])).toBeUndefined();
    expect(confirmationHash([{ seq: 9, path: "current/0", checksum: null }])).toBe("removed");
  });
});
