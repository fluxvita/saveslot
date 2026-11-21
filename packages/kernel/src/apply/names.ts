// Names compared (docs/zh-CN/spec/04-contract.md §1; 03-data-model/10 «名字不分 ASCII 大小写唯一»):
// one folding for every comparison of slot, table and field names, here at the lowest module the
// others reach (schema and request re-export it). `rules` keeps its own: it imports `store` only.

/** ASCII case folding: names are unique without ASCII case. */
export const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
