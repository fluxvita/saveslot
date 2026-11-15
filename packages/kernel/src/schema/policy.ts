// The default slot policy, written whole into the `slot.policy_set` event of the operation creating
// a slot (docs/zh-CN/spec/03-data-model/01-objects.md «slot 包含什么»: the default policy table;
// 09-event-format.md §5.4 `slot.policy_set`, the example and its keys). A slot's policy is that
// event's text from then on, not this constant: categories added here later reach only slots
// created after (01-objects).

export const DEFAULT_SLOT_POLICY = {
  policy_version: 1,
  // Conflicts keep the value in effect: the only rule of this version.
  effective_value_rule: "keep_current",
  // Source levels ranked: user stated > agent inferred > missed; recorded, not used yet.
  rank: { user_stated: 2, agent_inferred: 1, miss: 0 },
  // The eight automatic categories, all on (07-schema-evolution «改动分类与迁移手段»).
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
  // Reserved shapes, empty in this version.
  high_impact: [],
  user_session_only: [],
} as const;
