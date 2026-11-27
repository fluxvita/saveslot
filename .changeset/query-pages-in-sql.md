---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
---

A query reads only the page it returns, instead of every matching row: the first page on event tables and on state tables read at a point, the first page of a state table read over an interval with no order asked for, and later pages where they can be. Large tables page much faster; the rows, their order, `total` and the pages are the same. A later page's position now carries `total`, so an earlier build does not read a position made by this one.
