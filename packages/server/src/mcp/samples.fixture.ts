// Results of each tool as the service gives them, taken from a running service: the samples the
// renderers are checked on (the text they give, and that no string of a result stands outside the
// boundary unless it is of a checked shape).

import type { ToolName } from "./names.ts";

export const SAMPLES: Readonly<
  Record<string, { tool: ToolName; result: Record<string, unknown> }>
> = {
  catalog_list: {
    tool: "saveslot_catalog",
    result: {
      level: "list",
      total: 2,
      slots: [
        {
          slot: "ledger",
          slot_id: "sl_MPG1CD4R15VDJKYT",
          sv: 1,
          timezone: "Asia/Shanghai",
          tables: [
            {
              table: "expenses",
              kind: "base",
              description: "one row per expense",
            },
            {
              table: "budgets",
              kind: "base",
              description: "by the day",
            },
          ],
        },
      ],
    },
  },
  catalog_table: {
    tool: "saveslot_catalog",
    result: {
      level: "table",
      tables: [
        {
          table: "expenses",
          slot: "ledger",
          sv: 1,
          timezone: "Asia/Shanghai",
          kind: "base",
          description: "one row per expense",
          fields: [
            {
              name: "date",
              type: "date",
              description: "the day",
              required: true,
            },
            {
              name: "note",
              type: "text",
              description: "what for",
            },
            {
              name: "amount",
              type: "quantity",
              description: "how much",
              unit: "CNY",
              precision: {
                scale: 2,
                rounding: "half_up",
              },
            },
          ],
          time: {
            type: "event",
            field: "date",
          },
        },
        {
          table: "budgets",
          slot: "ledger",
          sv: 1,
          timezone: "Asia/Shanghai",
          kind: "base",
          description: "by the day",
          fields: [
            {
              name: "amount",
              type: "integer",
              description: "how much",
              required: true,
            },
          ],
          time: {
            type: "state",
            granularity: "date",
          },
        },
      ],
    },
  },
  catalog_schema: {
    tool: "saveslot_catalog",
    result: {
      level: "schema",
      slot: "ledger",
      sv: 1,
      document: {
        base_version: 1,
        slot: "ledger",
        tables: [
          {
            description: "one row per expense",
            fields: [
              {
                description: "the day",
                name: "date",
                required: true,
                type: "date",
                id: "f1",
              },
              {
                description: "what for",
                name: "note",
                type: "text",
                id: "f2",
              },
              {
                description: "how much",
                name: "amount",
                type: "quantity",
                unit: "CNY",
                id: "f3",
              },
            ],
            kind: "base",
            name: "expenses",
            time: {
              field: "date",
              type: "event",
            },
            id: "t1",
          },
          {
            description: "by the day",
            fields: [
              {
                description: "how much",
                name: "amount",
                required: true,
                type: "integer",
                id: "f1",
              },
            ],
            kind: "base",
            name: "budgets",
            time: {
              granularity: "date",
              type: "state",
            },
            id: "t2",
          },
        ],
        timezone: "Asia/Shanghai",
      },
      policy: {
        slot: "ledger",
        policy_version: 1,
        effective_value_rule: "keep_current",
        rank: {
          agent_inferred: 1,
          miss: 0,
          user_stated: 2,
        },
        auto_apply: [
          "add_table",
          "add_derived_table",
          "add_optional_field",
          "description",
          "rename_unused",
          "loosen_constraint",
          "duplicate_keys",
          "restructure_unused",
        ],
        set_by: {
          kind: "user",
          id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
        },
        set_at: "2026-11-16T14:00:43.060Z",
        seq: 2,
      },
    },
  },
  query: {
    tool: "saveslot_query",
    result: {
      table: "ledger.expenses",
      slot: "ledger",
      sv: 1,
      total: 1,
      rows: [
        {
          table: "ledger.expenses",
          row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
          ver: "v10.0",
          values: {
            date: "2026-11-10",
            note: "lunch",
            amount: {
              value: "54",
              unit: "CNY",
            },
          },
          marks: {
            disputed: [
              {
                item: "pi_8VEZWJ3J7BMKMXTV",
                fields: ["amount"],
              },
            ],
            corrected: true,
          },
        },
      ],
    },
  },
  query_state: {
    tool: "saveslot_query",
    result: {
      table: "ledger.budgets",
      slot: "ledger",
      sv: 1,
      total: 1,
      rows: [
        {
          table: "ledger.budgets",
          entity: "e_AJHYVH12E09RC5S6PB56MPRJNV",
          ver: "v17.0",
          values: {
            amount: "3000",
          },
          valid_from: "2026-11-01",
          valid_to: null,
        },
      ],
    },
  },
  history: {
    tool: "saveslot_history",
    result: {
      mode: "timeline",
      timezone: "Asia/Shanghai",
      target: {
        table: "ledger.expenses",
        row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
      },
      sv: 1,
      ver: "v10.0",
      total: 3,
      entries: [
        {
          seq: 13,
          recorded_at: "2026-11-16T14:00:43.198Z",
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
          intent: "update",
          fields: {
            amount: {
              result: "candidate",
              after: {
                unit: "CNY",
                value: "50",
              },
              sources: {
                value: [
                  {
                    id: "s_HBDMDCG0KNEF8V0V",
                    kind: "user_message",
                    level: "user_stated",
                    text: "it was 50",
                  },
                ],
                operation: [],
              },
            },
          },
        },
        {
          seq: 10,
          recorded_at: "2026-11-16T14:00:43.176Z",
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
          intent: "correct",
          fields: {
            amount: {
              result: "applied",
              before: {
                value: "45",
                unit: "CNY",
              },
              after: {
                unit: "CNY",
                value: "54",
              },
              sources: {
                value: [
                  {
                    id: "s_17WYXZYX5QZH0HZ1",
                    kind: "user_message",
                    correction: true,
                    level: "user_stated",
                    text: "no, 54",
                  },
                ],
                operation: [],
              },
            },
          },
        },
        {
          seq: 7,
          recorded_at: "2026-11-16T14:00:43.139Z",
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
          intent: "insert",
          fields: {
            date: {
              result: "applied",
              after: "2026-11-10",
              sources: {
                value: [
                  {
                    id: "s_RKD83RVT3NA4ZKAP",
                    kind: "user_message",
                    level: "user_stated",
                    text: "lunch 45 yuan",
                  },
                ],
                operation: [],
              },
            },
            note: {
              result: "applied",
              after: "lunch",
              sources: {
                value: [
                  {
                    id: "s_RKD83RVT3NA4ZKAP",
                    kind: "user_message",
                    level: "user_stated",
                    text: "lunch 45 yuan",
                  },
                ],
                operation: [],
              },
            },
            amount: {
              result: "applied",
              after: {
                unit: "CNY",
                value: "45",
              },
              sources: {
                value: [
                  {
                    id: "s_RKD83RVT3NA4ZKAP",
                    kind: "user_message",
                    level: "user_stated",
                    text: "lunch 45 yuan",
                  },
                ],
                operation: [],
              },
            },
          },
        },
      ],
      reads: [
        {
          read: "rd_VE4MY5TRXJHK2HQ7",
          seq: 10,
          at: "2026-11-16T14:00:43.233Z",
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
        },
        {
          read: "rd_TY9C4XD9NQK8WQPJ",
          seq: 7,
          at: "2026-11-16T14:00:43.170Z",
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
        },
      ],
    },
  },
  history_asof: {
    tool: "saveslot_history",
    result: {
      mode: "as_of",
      timezone: "Asia/Shanghai",
      as_of: {
        seq: 7,
        recorded_at: "2026-11-16T14:00:43.139Z",
      },
      sv: 1,
      total: 1,
      rows: [
        {
          table: "ledger.expenses",
          row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
          ver: "h7.0",
          historical: true,
          values: {
            date: "2026-11-10",
            note: "lunch",
            amount: {
              value: "45",
              unit: "CNY",
            },
          },
        },
      ],
    },
  },
  pending_list: {
    tool: "saveslot_pending",
    result: {
      total: 1,
      items: [
        {
          id: "pi_8VEZWJ3J7BMKMXTV",
          type: "conflict",
          status: "open",
          slot: "ledger",
          target: {
            table: "ledger.expenses",
            row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
            unit: ["amount"],
          },
          reason: "stale_write",
          opened_at: "2026-11-16T14:00:43.198Z",
          opened_by: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
        },
      ],
    },
  },
  pending_detail: {
    tool: "saveslot_pending",
    result: {
      id: "pi_8VEZWJ3J7BMKMXTV",
      type: "conflict",
      item_ver: "iv_8VEZWJ3J7BMKMXTV.13.0",
      status: "open",
      slot: "ledger",
      reason: "stale_write",
      opened_at: "2026-11-16T14:00:43.198Z",
      opened_by: {
        kind: "user",
        id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
        name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
      },
      decisions: ["keep_effective", "take_candidate", "take_previous"],
      target: {
        table: "ledger.expenses",
        row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
        unit: ["amount"],
      },
      effective: {
        seq: 10,
        actor: {
          kind: "user",
          id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
        },
        values: {
          amount: {
            value: "54",
            unit: "CNY",
          },
        },
        exists: true,
      },
      candidates: [
        {
          index: 0,
          seq: 13,
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
          intent: "update",
          ver: "v7.0",
          values: {
            amount: {
              unit: "CNY",
              value: "50",
            },
          },
          cause: "stale_write",
        },
      ],
      previous: {
        seq: 7,
        exists: true,
        values: {
          amount: {
            value: "45",
            unit: "CNY",
          },
        },
      },
      reverted_by_previous: [
        {
          seq: 10,
          actor: {
            kind: "user",
            id: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
            name: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
          },
        },
      ],
    },
  },
  write_insert: {
    tool: "saveslot_write",
    result: {
      status: "saved",
      sv: 1,
      seq: 7,
      ops: [
        {
          target: {
            table: "ledger.expenses",
            row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
          },
          intent: "insert",
          ver: "v7.0",
          fields: {
            date: {
              result: "applied",
              after: "2026-11-10",
            },
            note: {
              result: "applied",
              after: "lunch",
            },
            amount: {
              result: "applied",
              after: {
                unit: "CNY",
                value: "45",
              },
            },
          },
        },
      ],
      derived: [],
      derived_total: 0,
      pending: [],
      superseded: [],
    },
  },
  write_conflict: {
    tool: "saveslot_write",
    result: {
      status: "pending",
      sv: 1,
      seq: 13,
      ops: [
        {
          target: {
            table: "ledger.expenses",
            row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
          },
          intent: "update",
          ver: "v10.0",
          fields: {
            amount: {
              result: "candidate",
              after: {
                unit: "CNY",
                value: "50",
              },
              item: "pi_8VEZWJ3J7BMKMXTV",
              effective: {
                unit: "CNY",
                value: "54",
              },
              current_ver: "v10.0",
              by: {
                seq: 10,
                actor: "u_SHB4YXDGYB8V7P0REQDCX8SGT4",
              },
              previous: {
                seq: 7,
                exists: true,
                values: {
                  amount: {
                    unit: "CNY",
                    value: "45",
                  },
                },
              },
            },
          },
        },
      ],
      derived: [],
      derived_total: 0,
      pending: [
        {
          id: "pi_8VEZWJ3J7BMKMXTV",
          type: "conflict",
          reason: "stale_write",
          item_ver: "iv_8VEZWJ3J7BMKMXTV.13.0",
        },
      ],
      superseded: [],
    },
  },
  write_state: {
    tool: "saveslot_write",
    result: {
      status: "saved",
      sv: 1,
      seq: 17,
      ops: [
        {
          target: {
            table: "ledger.budgets",
            entity: "e_AJHYVH12E09RC5S6PB56MPRJNV",
          },
          intent: "insert",
          ver: "v17.0",
          created_entity: true,
          fields: {
            amount: [
              {
                result: "applied",
                after: "3000",
                valid: {
                  valid_from: "2026-11-01",
                  valid_to: null,
                },
              },
            ],
          },
        },
      ],
      derived: [],
      derived_total: 0,
      pending: [],
      superseded: [],
    },
  },
  write_replay: {
    tool: "saveslot_write",
    result: {
      status: "saved",
      sv: 1,
      seq: 7,
      ops: [
        {
          target: {
            table: "ledger.expenses",
            row: "r_4KWKRM296X61WJ89DY5XJNVA4P",
          },
          intent: "insert",
          ver: "v7.0",
          fields: {
            date: {
              result: "applied",
              after: "2026-11-10",
            },
            note: {
              result: "applied",
              after: "lunch",
            },
            amount: {
              result: "applied",
              after: {
                unit: "CNY",
                value: "45",
              },
            },
          },
        },
      ],
      derived: [],
      derived_total: 0,
      pending: [],
      superseded: [],
      replayed: true,
    },
  },
  resolve: {
    tool: "saveslot_resolve",
    result: {
      id: "pi_8VEZWJ3J7BMKMXTV",
      type: "conflict",
      decision: "keep_effective",
      item_ver: "iv_8VEZWJ3J7BMKMXTV.20.0",
      status: "resolved",
    },
  },
};

export const ERRORS: Readonly<Record<string, Record<string, unknown>>> = {
  error_unknown_table: {
    param: "table",
    name: "expensez",
    nearest: ["expenses", "budgets"],
    code: "unknown_table",
    message: 'unknown table "expensez"',
  },
  error_unknown_field: {
    param: "fields/0",
    name: "amout",
    nearest: ["amount", "note", "date"],
    code: "unknown_field",
    message: 'unknown field "amout"',
  },
  error_invalid: {
    code: "validation_failed",
    reason: "write",
    details: [
      {
        op: 0,
        field: "note",
        code: "type_mismatch",
      },
      {
        op: 0,
        field: "date",
        code: "required_missing",
      },
    ],
    message: "the request is refused: validation_failed",
  },
  write_state: {
    code: "invalid_argument",
    reason: "missing",
    param: "ops/0/entity",
    message: "the request is refused: invalid_argument",
  },
};
