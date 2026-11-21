// The source data a run's final histories refer to (10-evals §2.4: the `history` and `sources`
// state assertions): every `SourceRef` id under a timeline field's `sources`, value sources and
// operation sources alike (04-contract-types §4.5), in the order first met. The runner reads each
// of them through `sources` at the end, while the service still runs, so that an assertion on what
// a value came from can be judged against its text.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The source IDs a history (`history` timeline pages, as the runner keeps them) refers to. */
export function sourceIds(history: unknown, into: string[] = []): string[] {
  const seen = new Set(into);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObj(v)) return;
    const sources = v["sources"];
    if (isObj(sources)) {
      for (const k of ["value", "operation"]) {
        const refs = sources[k];
        if (!Array.isArray(refs)) continue;
        for (const r of refs) {
          const id = isObj(r) ? r["id"] : undefined;
          if (typeof id === "string" && !seen.has(id)) {
            seen.add(id);
            into.push(id);
          }
        }
      }
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(history);
  return into;
}
