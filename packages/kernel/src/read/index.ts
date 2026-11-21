// Reads (docs/zh-CN/spec/02-architecture.md §4 `read`): `query` in this version.

export {
  type CatalogInput,
  type CatalogListResult,
  type CatalogResult,
  type CatalogSchemaResult,
  type CatalogTablesResult,
  catalogInTx,
} from "./catalog.ts";
export { changesInTx } from "./changes.ts";
export { draftDocument, ruleTexts, ruleTextsOf, slotDocument } from "./documents.ts";
export { FORMER_VERSIONS, formerVersions } from "./former.ts";
export {
  asOfInTx,
  type HistoryInput,
  type HistoryOutput,
  historyMode,
  historyTarget,
} from "./history.ts";
export { historyInTx } from "./history-op.ts";
export {
  MAX_NOTICES,
  type NoticeRefs,
  type PendingItemsNotice,
  pendingItemsNotices,
} from "./notices.ts";
// Paging, for lists outside this module (the management operations).
export { digest, limitOf, pageAfter, positionOf } from "./page.ts";
export { type PendingInput, type PendingReadResult, pendingInTx } from "./pending.ts";
export {
  profileOf,
  SCALE_BOUNDS,
  type Scale,
  type ScaleBounds,
  scaleOf,
  type TableProfile,
} from "./profile.ts";
export { fingerprint, type QueryInput, type QueryOutput, queryInTx } from "./query.ts";
export { type ReadsListResult, readsListInTx } from "./reads-list.ts";
export { logPosition, restoreCount } from "./select.ts";
export {
  slotCreators,
  type Visibility,
  type VisibleSlot,
  visibleSlots,
  wholeSlot,
} from "./slots.ts";
export {
  SEARCH_SCAN,
  type SourcesGetResult,
  type SourcesListItem,
  type SourcesListResult,
  type SourcesResult,
  searchForm,
  sourcesInTx,
} from "./sources.ts";
export {
  READ_ROWS_THRESHOLD,
  SQL_DEFAULT_ROWS,
  SQL_MAX_ROWS,
  SQL_TIMEOUT_MS,
  type SqlColumn,
  type SqlInput,
  type SqlOutput,
  type SqlReadResult,
  sqlInTx,
} from "./sql.ts";
export { timelineInTx } from "./timeline.ts";
export * from "./types.ts";
