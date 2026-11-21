// Strict parsing of a stored event (docs/zh-CN/spec/09-event-format.md §1.6, §2.1, §3.1, §5).
//
// `apply` parses strictly: at a known `v`, the header fields, the paths, the keys inside blocks and
// the enum values form a closed set, and anything outside it makes the event invalid — it may
// change the event's meaning, so it is never skipped. This module checks shapes only (keys,
// paths, enums, required fields). Whether the kernel knows a version string recorded inside a
// block (ruleset, checker, compiler) is the kernel's check, not a shape.
//
// Block shapes are added type by type. A block whose shape has no checker yet makes the result
// `unsupported` (not `ok`): the caller must stop, as for an invalid event.

import { check, type Issues, isObject, type Json, keys, type ShapeChecker, str } from "./check.ts";
import {
  EVENT_TYPES,
  type EventType,
  PENDING_DELETIONS_MODES,
  PRINCIPAL_VIAS,
  SCOPES,
  TRIGGERS,
} from "./enums.ts";
import { HEADER_FIELDS, HEADER_RULES, type HeaderField } from "./header.ts";
import { SCHEMA_EVENT_RULES, SCHEMA_SHAPES } from "./shapes-schema.ts";
import { WRITE_EVENT_RULES, WRITE_SHAPES } from "./shapes-write.ts";
import { isEventInteger, isHash, isId, isInstant } from "./values.ts";
import { matchPath, VOCABULARY, type VocabularyEntry } from "./vocabulary.ts";

export type ParseResult =
  | { readonly ok: true; readonly type: EventType }
  /** Not a valid v1 event: the reasons, by position (`header.<field>` or a block path). */
  | { readonly ok: false; readonly kind: "invalid"; readonly issues: readonly string[] }
  /** Valid as far as checked, but a block's shape has no checker yet. */
  | { readonly ok: false; readonly kind: "unsupported"; readonly shapes: readonly string[] };

// --- block shapes (§5.1–§5.3) ------------------------------------------------------------------

const SHAPES: Partial<Record<string, ShapeChecker>> = {
  // §5.2 tenant.genesis
  GenesisTenant(v, at, issues) {
    if (!keys(v, at, ["tenant_id", "storage_format", "event_format"], [], issues)) return;
    check(str(v["tenant_id"]) && isId("tenant", v["tenant_id"]), at, "tenant_id", issues);
    check(isEventInteger(v["storage_format"]), at, "storage_format", issues);
    check(v["event_format"] === 1, at, "event_format", issues);
  },
  // §5.2 tenant.imported: the target tenant and the one the export came from, and the manifest's
  // export time and mode (the first segment's).
  ImportedTenant(v, at, issues) {
    if (
      !keys(
        v,
        at,
        ["tenant_id", "previous_tenant_id", "storage_format", "event_format"],
        [],
        issues,
      )
    ) {
      return;
    }
    check(str(v["tenant_id"]) && isId("tenant", v["tenant_id"]), at, "tenant_id", issues);
    check(
      str(v["previous_tenant_id"]) && isId("tenant", v["previous_tenant_id"]),
      at,
      "previous_tenant_id",
      issues,
    );
    check(isEventInteger(v["storage_format"]), at, "storage_format", issues);
    check(v["event_format"] === 1, at, "event_format", issues);
  },
  ImportedExport(v, at, issues) {
    if (!keys(v, at, ["exported_at", "pending_deletions"], [], issues)) return;
    check(str(v["exported_at"]) && isInstant(v["exported_at"]), at, "exported_at", issues);
    check(
      (PENDING_DELETIONS_MODES as readonly Json[]).includes(v["pending_deletions"]),
      at,
      "pending_deletions",
      issues,
    );
  },
  UserPrincipal(v, at, issues) {
    if (!keys(v, at, ["principal", "kind"], [], issues)) return;
    check(str(v["principal"]) && isId("user", v["principal"]), at, "principal", issues);
    check(v["kind"] === "user", at, "kind", issues);
  },
  SystemPrincipal(v, at, issues) {
    if (!keys(v, at, ["principal", "kind"], [], issues)) return;
    check(v["principal"] === "system", at, "principal", issues);
    check(v["kind"] === "system", at, "kind", issues);
  },
  // §5.1 ctx of principal.* (no slot: no today, no policy_version)
  PrincipalCtx(v, at, issues) {
    if (!keys(v, at, ["now", "ruleset_version"], [], issues)) return;
    check(str(v["now"]) && isInstant(v["now"]), at, "now", issues);
    check(isEventInteger(v["ruleset_version"]), at, "ruleset_version", issues);
  },
  // §5.3
  RegisteredPrincipal(v, at, issues) {
    if (!keys(v, at, ["principal", "kind", "scopes", "via"], ["slots", "client"], issues)) return;
    check(str(v["principal"]) && isId("connection", v["principal"]), at, "principal", issues);
    check(v["kind"] === "connection", at, "kind", issues);
    // Known scopes, including saveslot.read, unique, in the order SCOPES lists them.
    const scopes = v["scopes"];
    const order = (s: Json) => (SCOPES as readonly Json[]).indexOf(s);
    check(
      Array.isArray(scopes) &&
        scopes.includes("saveslot.read") &&
        scopes.every((s, i) => order(s) >= 0 && (i === 0 || order(scopes[i - 1]) < order(s))),
      at,
      "scopes",
      issues,
    );
    if ("slots" in v) {
      // Slot IDs, ascending, unique, non-empty; absent = all slots.
      const slots = v["slots"];
      check(
        Array.isArray(slots) &&
          slots.length > 0 &&
          slots.every(
            (s, i) => str(s) && isId("slot", s) && (i === 0 || (slots[i - 1] as string) < s),
          ),
        at,
        "slots",
        issues,
      );
    }
    const via = v["via"];
    check((PRINCIPAL_VIAS as readonly Json[]).includes(via), at, "via", issues);
    // `client` is present exactly when `via` is `oauth`.
    if (via === "oauth") check(str(v["client"]), at, "client required with via oauth", issues);
    else check(!("client" in v), at, "client only with via oauth", issues);
  },
  PrincipalRef(v, at, issues) {
    if (!keys(v, at, ["principal"], [], issues)) return;
    check(str(v["principal"]) && isId("connection", v["principal"]), at, "principal", issues);
  },
  PrincipalName(v, at, issues) {
    if (!keys(v, at, ["name"], [], issues)) return;
    check(str(v["name"]), at, "name", issues);
  },
  // §5.4 slot.removed: the slot's ID and its version then; the name a data block.
  SlotRemovedTarget(v, at, issues) {
    if (!keys(v, at, ["slot_id", "sv"], [], issues)) return;
    check(str(v["slot_id"]) && isId("slot", v["slot_id"]), at, "slot_id", issues);
    check(isEventInteger(v["sv"]) && (v["sv"] as number) >= 1, at, "sv", issues);
  },
  SlotName(v, at, issues) {
    if (!keys(v, at, ["name"], [], issues)) return;
    check(str(v["name"]), at, "name", issues);
  },
  // §5.4, §5.5, §7
  ...SCHEMA_SHAPES,
  // §5.6–§5.8
  ...WRITE_SHAPES,
};

const EVENT_RULES = { ...SCHEMA_EVENT_RULES, ...WRITE_EVENT_RULES };

/** The block shapes this module checks so far. */
export const CHECKED_SHAPES: readonly string[] = Object.keys(SHAPES);

// --- header (§2.1, §4.1) -------------------------------------------------------------------------

function parseHeader(h: Json, issues: Issues): EventType | undefined {
  if (!isObject(h)) {
    issues.push("header: not an object");
    return undefined;
  }
  for (const k of Object.keys(h)) {
    if (!(HEADER_FIELDS as readonly string[]).includes(k))
      issues.push(`header: unknown field ${k}`);
  }
  const type = h["type"];
  if (!(EVENT_TYPES as readonly Json[]).includes(type)) {
    issues.push("header.type: unknown event type");
    return undefined;
  }
  const t = type as EventType;
  // Every v1 type is at v = 1; an unknown v stops apply (§1.6).
  check(h["v"] === 1, "header.v", "unknown format version", issues);
  check(isEventInteger(h["seq"]) && (h["seq"] as number) >= 1, "header.seq", "not a seq", issues);
  check(str(h["at"]) && isInstant(h["at"]), "header.at", "not an instant", issues);
  check(str(h["prev_hash"]) && isHash(h["prev_hash"]), "header.prev_hash", "not a hash", issues);
  const actor = h["actor"];
  const isUser = str(actor) && isId("user", actor);
  const isCaller = isUser || (str(actor) && isId("connection", actor));
  check(isCaller || actor === "system", "header.actor", "not a principal", issues);

  const rules = HEADER_RULES[t];
  const member = "op" in h;
  if (member) check(isEventInteger(h["op"]), "header.op", "not an operation number", issues);
  if (rules.head === "head") check(!member, "header.op", "on a head event", issues);
  if (rules.head === "member") check(member, "header.op", "missing on a member event", issues);
  if (!member) {
    // Head event: who may be its actor, and `trigger` exactly on head events by system.
    const actorRule = rules.head === "either" ? "system" : rules.actor;
    const allowed =
      actorRule === "user"
        ? isUser
        : actorRule === "caller"
          ? isCaller
          : actorRule === "system"
            ? actor === "system"
            : actorRule === "caller_or_system"
              ? isCaller || actor === "system"
              : true;
    check(allowed, "header.actor", "not allowed for this type", issues);
    if (actor === "system") {
      check(
        (rules.triggers as readonly Json[]).includes(h["trigger"]),
        "header.trigger",
        "missing or not allowed",
        issues,
      );
    } else check(!("trigger" in h), "header.trigger", "only on head events by system", issues);
  } else check(!("trigger" in h), "header.trigger", "on a member event", issues);
  if ("trigger" in h) {
    check(
      (TRIGGERS as readonly Json[]).includes(h["trigger"]),
      "header.trigger",
      "unknown",
      issues,
    );
  }
  if (rules.slot)
    check(str(h["slot"]) && isId("slot", h["slot"]), "header.slot", "required", issues);
  else check(!("slot" in h), "header.slot", "not allowed", issues);

  const extra = rules.extra as readonly HeaderField[];
  for (const f of [
    "node_id",
    "restore_id",
    "restore_count",
    "restored_to",
    "high_water",
    "imported_upto",
  ] as const) {
    if (extra.includes(f) !== f in h) {
      issues.push(`header.${f}: ${f in h ? "not allowed" : "required"}`);
      continue;
    }
    if (!(f in h)) continue;
    const v = h[f];
    if (f === "node_id") check(str(v) && isId("node", v), `header.${f}`, "malformed", issues);
    else if (f === "restore_id")
      check(str(v) && isId("restore", v), `header.${f}`, "malformed", issues);
    else check(isEventInteger(v), `header.${f}`, "not an event integer", issues);
  }
  return t;
}

/**
 * Parses an event strictly. `blocks` maps each present block's path to its value; `removed` lists
 * the paths of blocks a tombstone cleared (they count as present for "required", and have no
 * shape to check). Only data blocks can be removed, and a removed path cannot also be present.
 */
export function parseEvent(
  header: Json,
  blocks: Readonly<Record<string, Json>>,
  removed: Iterable<string> = [],
): ParseResult {
  const issues: Issues = [];
  const type = parseHeader(header, issues);
  if (type === undefined) return { ok: false, kind: "invalid", issues };
  const removedSet = new Set(removed);
  const unsupported = new Set<string>();
  for (const path of removedSet) {
    const entry = matchPath(type, path);
    if (entry === undefined) issues.push(`${path}: not in the vocabulary of ${type}`);
    // A tombstone clears data blocks only (§1.1).
    else if (entry.kind !== "data") issues.push(`${path}: removed, but not a data block`);
    if (path in blocks) issues.push(`${path}: both present and removed`);
  }
  for (const path of Object.keys(blocks)) {
    const entry = matchPath(type, path);
    if (entry === undefined) {
      issues.push(`${path}: not in the vocabulary of ${type}`);
      continue;
    }
    const checker = SHAPES[entry.shape];
    if (checker === undefined) unsupported.add(entry.shape);
    else checker(blocks[path], path, issues);
  }
  // Rules between the blocks of one event (§5.5–§5.8).
  if (Object.hasOwn(EVENT_RULES, type)) {
    const paths = new Set([...Object.keys(blocks), ...removedSet]);
    const h = header as Readonly<Record<string, Json>>;
    EVENT_RULES[type]?.(paths, blocks, issues, {
      seq: h["seq"] as number,
      op: (h["op"] as number | undefined) ?? (h["seq"] as number),
    });
  }
  // §5.2: an import raises the restore count, so it is at least 1; the user it registers is its
  // actor.
  if (type === "tenant.imported") {
    const h = header as Readonly<Record<string, Json>>;
    const count = h["restore_count"];
    check(typeof count === "number" && count >= 1, "header", "restore_count at least 1", issues);
    const user = blocks["user"];
    if (isObject(user) && "principal" in user) {
      check(user["principal"] === h["actor"], "user", "principal is the actor", issues);
    }
  }
  for (const entry of VOCABULARY[type] as readonly VocabularyEntry[]) {
    if (entry.always && !(entry.path in blocks) && !removedSet.has(entry.path)) {
      issues.push(`${entry.path}: required`);
    }
  }
  if (issues.length > 0) return { ok: false, kind: "invalid", issues };
  if (unsupported.size > 0)
    return { ok: false, kind: "unsupported", shapes: [...unsupported].sort() };
  return { ok: true, type };
}
