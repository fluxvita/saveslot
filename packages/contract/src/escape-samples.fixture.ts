// Code points and whether the renderers write them escaped, context aside: one table, asserted
// by the MCP renderer's tests (server/src/mcp/text.ts) and the CLI's (cli/src/untrusted.ts), whose
// sets are written twice because the CLI cannot depend on the server. A change to one set that the
// other does not follow fails one of the two. Left out: what each adds for its own writing (a
// character whose compatibility form is one of its syntax characters, the CLI's 「 」), and the
// space characters other than U+0020, which the CLI escapes (a terminal wraps lines) and the MCP
// renderer does not (a host is no terminal).

/** [code point, written escaped]. */
export const ESCAPE_SAMPLES: readonly (readonly [number, boolean])[] = [
  // Controls: C0, DEL, C1.
  [0x0, true],
  [0x9, true],
  [0xa, true],
  [0x1b, true],
  [0x1f, true],
  [0x7f, true],
  [0x80, true],
  [0x9b, true],
  [0x9f, true],
  // Default ignorable, bidi controls, separators.
  [0xad, true],
  [0x34f, true],
  [0x61c, true],
  [0x115f, true],
  [0x180e, true],
  [0x200b, true],
  [0x200c, true],
  [0x200d, true],
  [0x200e, true],
  [0x200f, true],
  [0x202a, true],
  [0x202e, true],
  [0x2060, true],
  [0x2066, true],
  [0x2069, true],
  [0x206f, true],
  [0x2028, true],
  [0x2029, true],
  [0x3164, true],
  [0xfe00, true],
  [0xfe0f, true],
  [0xfeff, true],
  [0x1d173, true],
  [0xe0001, true],
  [0xe0020, true],
  [0xe007f, true],
  [0xe0100, true],
  // The few that are none of these; noncharacters; lone surrogates.
  [0x2800, true],
  [0xfff9, true],
  [0xfffa, true],
  [0xfffb, true],
  [0xfffc, true],
  // Compatibility forms of a backslash: a syntax character of both writings.
  [0xff3c, true],
  [0xfe68, true],
  [0xfdd0, true],
  [0xfffe, true],
  [0xffff, true],
  [0x1fffe, true],
  [0x10ffff, true],
  [0xd800, true],
  [0xdfff, true],
  // Shown as they are.
  [0x20, false],
  [0x41, false],
  [0x7e, false],
  [0xe9, false],
  [0x301, false],
  [0x4e2d, false],
  [0x20e3, false],
  [0xfffd, false],
  [0x10000, false],
  [0x1f3fd, false],
  [0x1f600, false],
];

/**
 * Strings, as code points, and which of them the renderers write escaped in context (neither's
 * own short forms involved): the combining rule and the two exceptions, at their edges.
 */
export const CONTEXT_SAMPLES: readonly (readonly [readonly number[], readonly boolean[]])[] = [
  // A combining mark: kept after a character shown as it is; escaped first, or after an escape.
  [
    [0x61, 0x301],
    [false, false],
  ],
  [
    [0x301, 0x61],
    [true, false],
  ],
  [
    [0x200b, 0x301],
    [true, true],
  ],
  [
    [0x61, 0x301, 0x302],
    [false, false, false],
  ],
  // A zero-width joiner or non-joiner: kept only between two characters shown as they are.
  [
    [0x61, 0x200d, 0x62],
    [false, false, false],
  ],
  [
    [0x61, 0x200c, 0x62],
    [false, false, false],
  ],
  [
    [0x200d, 0x62],
    [true, false],
  ],
  [
    [0x61, 0x200d],
    [false, true],
  ],
  [
    [0x61, 0x20, 0x200d, 0x62],
    [false, false, true, false],
  ],
  [
    [0x61, 0x200d, 0x200d, 0x62],
    [false, true, true, false],
  ],
  [
    [0x1f468, 0x200d, 0x1f469],
    [false, false, false],
  ],
  // An emoji presentation selector: one, right after an emoji; a keycap's after its ASCII base.
  [
    [0x1f600, 0xfe0f],
    [false, false],
  ],
  [
    [0x2764, 0xfe0f],
    [false, false],
  ],
  [
    [0x61, 0xfe0f],
    [false, true],
  ],
  [
    [0x1f600, 0xfe0f, 0xfe0f],
    [false, false, true],
  ],
  [
    [0x23, 0xfe0f, 0x20e3],
    [false, false, false],
  ],
  [
    [0x23, 0xfe0f],
    [false, true],
  ],
  [
    [0x1f600, 0xfe00],
    [false, true],
  ],
  // A selector kept by its exception is a neighbour a joiner may sit by.
  [
    [0x2764, 0xfe0f, 0x200d, 0x1f525],
    [false, false, false, false],
  ],
];
