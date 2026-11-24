# Unicode Character Database 17.0.0 (excerpt)

The four files `keymatch@1` is generated from (docs/zh-CN/spec/03-data-model/10-types-and-units.md
«相近的键»): UnicodeData.txt, DerivedNormalizationProps.txt, CaseFolding.txt and PropList.txt; and
NormalizationTest.txt, for the conformance tests. As published at
https://www.unicode.org/Public/17.0.0/ucd/, unchanged. `SHA256SUMS`
lists their digests; the kernel's tests check them and generate the tables again from them
(`scripts/gen-keymatch.ts`), offline.

`NormalizationTest.txt` is for the conformance tests only. None of these files is in a published
package: the kernel ships the generated tables.

Licensed under the Unicode License v3: see `LICENSE.txt`.
