# saveslot · Data-layer mechanisms · 10 Field types, same value and units

English · [简体中文](../../zh-CN/spec/03-data-model/10-types-and-units.md)

> Part of the data-layer mechanisms; for the contents see [`README.md`](README.md). A section quoted with "…" in the text may be in another file in the same directory; look it up by the contents.

How the value of a field type is taken, when two values count as "the same", when two keys count as written similarly, and how numbers with units are converted and rounded. These rules are shared by write validation, the same-value judgement, conflict judgement, suspected duplicates, literal match and the hints in write receipts, so they are collected in one place.

## Field types and value ranges

| Type | What it is | Value range |
|---|---|---|
| `text` | Text | At most 8 KB (UTF-8); neither the caller's original text nor the result after NFC may exceed it. Unicode NFC normalization is applied before it is recorded; leading and trailing whitespace and case are kept as they are. It must be well-formed Unicode and must not contain NUL (U+0000, which PostgreSQL's `text` cannot store). The empty string is a value, not empty |
| `integer` | Integer | 64-bit signed |
| `decimal` | Decimal | At most 18 digits in the integer part; the number of decimal places `scale` is 0–12 |
| `quantity` | A number with a unit | The numeric value is the same as `decimal`; the unit is taken from the "Unit vocabulary" |
| `boolean` | Boolean | — |
| `enum` | Enumeration | At most 200 values, each at most 64 characters; case-sensitive. A value must be in NFC normal form, contain no control characters, and have no leading or trailing whitespace: at write time they are compared as the same string, and a value declared in any other form can never match afterwards |
| `date` | A calendar day | 0001-01-01 to 9999-12-31; understood as a natural day in the slot time zone |
| `zoned_datetime` | An instant + an IANA time zone | Millisecond precision; the instant falls within 0001-01-01 to 9999-12-31 in UTC, and the wall-clock time converted to the recorded time zone (the slot's when no time zone name is written) also falls within this range, so that it can always be written with a four-digit year; the value to be stored must also give the same instant when written as text by the form of §1.3 and read back, otherwise it is likewise out of range (this blocks only a few seconds at the point where the clock is set back by less than a minute); values in query conditions are not subject to these two limits; a value for which both an offset and a time zone name are written and they do not match is rejected (for what matching means see [`04-contract-types.md`](../04-contract-types.md) §1.3 `ZonedDateTime`) |
| `ref` | Points to a row or an entity of one table of the same slot (it may be the table it is in) | See "The write request · Reference fields" |

- **Names**: slot names, table names and field names match `[A-Za-z][A-Za-z0-9_]{0,62}` and are written directly as identifiers in restricted SQL. They must not begin with `_`; a field name must not be `valid`, `valid_from`, `valid_to` (reserved keys in write and query parameters), `row_id` or `entity_id` (`valid_from`, `valid_to` and these two are at the same time system columns in restricted SQL, see ["Restricted SQL"](11-restricted-sql.md) "Names"). A violation is reported at compile time as `validation_failed` (`reserved_name`).
- **Names are unique regardless of ASCII case**: slot names within a tenant, table names within a slot and field names within a table must differ pairwise after ASCII case folding (`Runs` and `runs` cannot coexist), and a violation is reported at compile time as `validation_failed` (`duplicate_name`). Unquoted identifiers in restricted SQL are resolved case-insensitively, so names that differ only in case would point to the same object, and uniqueness is therefore also counted case-insensitively. The name itself is stored and displayed in the case it was written in.
- **Description** (`description`): at most 500 characters, with no restriction on content.
- **Aliases** (`aliases`, optional on tables and fields): at most 8, each at most 64 characters (the same length limit as enum values). For the rules on their content and on "not taking part in name resolution" see "Schema document format".
- Numeric values are always decimal in events and storage, never floating point (see "Derivation rules · Boundary of determinism").

## Clearing a field

- Writing the value of a field as `null` in a write clears an **optional** field. It is a **contribution**: the value is empty, and the value source is as usual the evidence of this write.
- **A required field cannot be cleared**: it reports `validation_failed` (`required_missing`). To get rid of the row, use revoke.
- In a deletion replay, an empty-value contribution takes part in "the last contribution that is still present" like any other contribution: when its source is deleted, the earlier value comes back (see "Deletion · Replay rules").
- An optional field not carried on insertion has no contribution. Explicitly writing `null` on insertion has the same value as "there was no value before", and by the same-value rule it is a no-op or a corroboration.
- On a state table, an optional field being empty over an interval is "the value is empty", not an interval without a value; its value ↔ empty is a change of value and counts as a stop point (see "Time · Intervals without a value").
- Literal match records "not applicable" for an empty value.

## Criteria for the same value

"The same value as the version seen", "the value did not change", "a suspected duplicate hit", "located by `entity_key`" and "located by `external_key`" all use this one table.

| Field type | The same value if and only if |
|---|---|
| `quantity` | after conversion to the unit declared by the field and rounding by `scale`, the numeric values are equal (`1.0` and `1.00` are the same) |
| `decimal` | after rounding by `scale`, the numeric values are equal |
| `integer` | the numeric values are equal |
| `text` | after NFC normalization, identical code point by code point. Leading and trailing whitespace is not stripped, and case is not folded |
| `enum` | the values are the same |
| `boolean` | the same |
| `date` | the same day |
| `zoned_datetime` | the same instant **and** the same time zone (with a different time zone, "which day it is" may differ) |
| `ref` | points to the same row or the same entity (a temporary name in the request is first resolved to an ID and then compared) |
| Empty | empty and empty are the same; empty differs from any value |

On a state table, "the same value" additionally requires the values to be the same over the whole resolved interval (see "Time · Writing with the same value").

The "same time zone" of `zoned_datetime` compares time zone names after normalization: a spelling that differs from the canonical name given by the runtime only in case is recorded by the canonical name (`asia/shanghai` is recorded as `Asia/Shanghai`); an alias that the runtime maps to another name (`US/Eastern`) is recorded as the caller wrote it, and is for now not counted as the same time zone as its canonical name (`America/New_York`). Unifying aliases with canonical names is the same piece of work as pinning the time zone library, and is done together with it. A time zone name in the original value is always recorded as the caller wrote it.

## Similar keys

When writing by `entity_key` creates a new entity because the key does not exist, `similar_keys` in the receipt lists the existing keys of that table whose spelling is similar to the new key (see "Time · Writing by `entity_key`"). "Similar" is computed by the criteria below, algorithm version `keymatch@1`, released with the kernel.

- **It is a hint, not a judgement**: it does not enter events, does not occupy a rule version and does not change any state. With the same state, the same new key and the same `keymatch` version, the result is the same; a different `keymatch` version may give a different hint, which does not affect replay.
- **The Unicode data used is fixed with `keymatch@1` and packaged in the kernel**: `keymatch@1` uses **Unicode 17.0.0**. In the implementation it is generated from data files (UnicodeData, DerivedNormalizationProps, CaseFolding and PropList of the Unicode Character Database), not copied by hand, and no normalization or locale facility of the operating system or runtime is called (the Unicode version may differ between runtimes). NFKC and case folding use the same Unicode version.

**Step one, folding** N(s), doing three things in order:

| Step | What is done | What it smooths out |
|---|---|---|
| ① | Unicode NFKC normalization | full-width and half-width forms, compatibility characters |
| ② | Unicode simple case folding (the C and S classes of the CaseFolding table) | case |
| ③ | Remove all whitespace characters (Unicode `White_Space`) | leading, trailing and inner whitespace |

No conversion between glyph forms is done (such as Traditional and Simplified Chinese): that would need a character-by-character mapping table, the correspondence of many characters depends on the word, and the source and version of the table would have to be pinned separately. `keymatch@1` uses only the data that comes with Unicode and is fixed by version.

**Step two, comparing** the new key a with an existing key b. Length is counted in code points after folding, and the first level that holds is taken:

| Level | `match` | Condition |
|---|---|---|
| 1 | `fold` | N(a) = N(b) |
| 2 | `affix` | one of N(a), N(b) is a prefix or suffix of the other, and the shorter has at least 2 code points |
| 3 | `edit` | the shorter has at least 3 code points and the edit distance of the two is ≤ 1; when the shorter has at least 8 code points the threshold is relaxed to ≤ 2 (initial value) |

- **Edit distance** is the Levenshtein distance counted in code points: insertion, deletion and substitution each count 1, and **transposition is not included** (swapping two adjacent code points counts 2). There are two mutually different definitions of a distance that includes transposition, which give different answers for the same pair of keys at threshold 2; the one without transposition has only one reading, so the results of all implementations are necessarily the same. The cost is that swapping two characters in a short key is not flagged.
- **`edit` requires at least 3 code points**: keys of two Chinese characters that differ by one character are very common ("房租" and "房贷"), and flagging them would mostly be a false alarm.
- **Keys with several fields**: key fields that are not `text` must have the same value (by "Criteria for the same value"); `text` key fields are compared one by one, each being either identical as it is or holding at some level, with at least one not identical as it is. The level of the whole key is the widest level among its fields, and the edit distance (used for ordering) is the sum over the `text` fields. A table whose key has no `text` field gives no `similar_keys`.
- **Comparison range**: all the entities of that table visible to this call, including revoked ones (after a revoke the entity and its key remain), with the revoked ones marked `revoked` in the result. When there are more than 5,000 entities, only the 5,000 most recently written are compared (initial value).
- **Ordering**: first by level (`fold`, `affix`, `edit`), within a level by edit distance, then by most recent write, and finally by entity ID; the first 5 are taken.
- **"Most recently written" means the entity's latest version**: what is compared is the operation that gave the entity its current `ver`, the larger operation number first. A write that gives the entity no new version does not count (a corroboration, a no-op, a write that is still a candidate or awaiting confirmation), and the entity does not move forward because of it. Within one request, the entities that its earlier ops gave a new version come before the stored ones, the latest first. The comparison range above, the ordering here, and "the rest by most recent write" in `existing_keys` all mean this.

**Test vectors** (every implementation must pass them):

| New key a | Existing key b | Edit distance | Result | Note |
|---|---|---|---|---|
| `q4 推广` | `Q4推广` | — | `fold` | case and whitespace |
| `ＡＢＣ部` | `abc部` | — | `fold` | full-width becomes half-width through NFKC, and then case is folded |
| `STRAẞE` | `straße` | — | `fold` | U+1E9E becomes U+00DF through simple folding. The result of folding is not necessarily still in NFKC form, and the criteria compare by code points and do not normalize again |
| `Q4推广预算` | `Q4推广` | — | `affix` | the latter is a prefix of the former |
| `marketting` | `marketing` | 1 | `edit` | one extra letter |
| `marketnig` | `marketing` | 2 | `edit` | transposition counts 2; the shorter has 9 code points, so the threshold is 2 |
| `abdc` | `abcd` | 2 | not similar | transposition counts 2; the shorter has 4 code points, so the threshold is 1 |
| `CA` | `ABC` | 3 | not similar | a vector for the distance function itself (the unrestricted Damerau–Levenshtein distance would give 2); the shorter has fewer than 3 code points and would not enter `edit` anyway |
| `房贷` | `房租` | 1 | not similar | fewer than 3 code points |
| `推廣` | `推广` | 1 | not similar | no glyph conversion; fewer than 3 code points |

When the `nearest` of `unknown_table` / `unknown_field` in an error judges "whether an alias is the same as the name in the request", it also uses the folding N here (see the clause on aliases in "Schema document format").

## Precision and rounding

Each `quantity` and `decimal` field has a precision, written into the compiled definition.

| Key | Values | When not declared |
|---|---|---|
| `scale` | the number of decimal places, 0–12 | for currencies, the number of digits of the minor unit in ISO 4217 (CNY 2, JPY 0, KWD 3); otherwise 6 |
| `rounding` | `half_up` (round half up: exactly at the half, away from zero) / `half_even` (exactly at the half, to the even digit) | `half_up` |

- **At write time**: the value is first converted to the unit declared by the field, then rounded by the precision and recorded. When the number of decimal places exceeds `scale` and the value is rounded, `warnings` in the receipt gives `rounded`; the raw value delivered by the caller stays in the logical write header. Exception: a value whose unit was converted gives only `unit_converted` (with the value after conversion and rounding) and no separate `rounded`: the exact value after conversion is not necessarily a finite decimal, so there is no original value that could be written into `rounded`.
- **What is done with the rounded value**: the same-value judgement, the `min` / `max` validation, suspected duplicates, and "whether the values differ" in the conflict judgement.
- **What is done with the raw value**: literal match (what the evidence says is the raw number and unit).
- **The precision of a derived field** is inferred by the compiler and filled back in; when it cannot be inferred, `scale` must be written on that field. Inference goes layer by layer through the expression, and if any input of a layer cannot be inferred, that layer cannot be inferred:
  - A field takes the precision it declares; the `scale` of `integer` and of an integer literal is 0, and a decimal literal takes the number of decimal places it is written with.
  - `sum` / `min` / `max` keep that of the input; `avg` takes the larger of the input's `scale` and 6; `count` is an integer.
  - Addition, subtraction and modulo take the larger of the two sides; multiplication takes the sum of the two sides, and when it exceeds 12 takes 12; division takes the largest of the two sides and 6.
  - `round(x, n)` / `trunc(x, n)` take `n` when `n` is an integer constant (0 if less than 0, 12 if greater than 12), and 0 when only `x` is given; when `n` is not a constant it cannot be inferred. `floor`, `ceil`, `sign` and `EXTRACT` take 0; `abs` and unary minus keep that of the argument.
  - `CASE` / `COALESCE` / `GREATEST` / `LEAST` take the largest of the branches, and a `NULL` branch does not take part.
  - A conversion to `numeric(p, s)` takes `s`; `s` is at most 12, and a conversion with `s` greater than 12 is not accepted.
  - The rounding mode keeps the one common to the inputs; when the inputs' rounding modes differ or none exists, the `rounding` written on the field is taken, and `half_up` if none is written.
  - When it can be inferred, the `scale` / `rounding` written on the field must agree with the inference, otherwise `rule_sql_rejected` is reported.
- `half_up` is the default because it agrees with PostgreSQL `round(numeric, n)` (`numeric` rounds exactly at the half away from zero): the `round()` written in a derivation rule and the rounding of the kernel are the same, and the two backends need no separate implementation.
- PostgreSQL has no built-in function for `numeric` for `half_even` (rounding to even is only the common behavior of floating-point types, and varies by platform), so the kernel has to implement a deterministic version itself, shared by the two backends and included in the experiment on replay consistency (see "Required experiments" in the scope document, experiment 5).
- The default `scale` of a currency is taken from the current table of ISO 4217. The implementation generates it from this table and does not copy it by hand; when the table changes, a new version of the unit vocabulary is issued.

## Unit vocabulary

**The vocabulary is a fixed list (`units@1`) and does no arithmetic on unit expressions.** Each unit has a code, a dimension and a factor of conversion to the base unit of that dimension. `units@1` means the content of this table when event format v1 is frozen; changing the table after the freeze means issuing a new vocabulary version.

- **Code**: ASCII, case-sensitive. Metric units are written the same as in UCUM; for imperial units the common abbreviations are used, with the UCUM code listed separately for interoperability outward.
- **The same dimension** = the same dimension identifier. Units of the same dimension are converted automatically: value × the factor of the source unit ÷ the factor of the target unit, and then rounded by the field precision.
- A factor is an exact decimal number, written as a string.

| Dimension | Base | Units: code (factor) |
|---|---|---|
| `length` (length) | meter | `mm` (0.001), `cm` (0.01), `m` (1), `km` (1000), `in` (0.0254), `ft` (0.3048), `yd` (0.9144), `mi` (1609.344) |
| `mass` (mass) | gram | `ug` (0.000001), `mg` (0.001), `g` (1), `kg` (1000), `oz` (28.349523125), `lb` (453.59237) |
| `duration` (duration) | second | `ms` (0.001), `s` (1), `min` (60), `h` (3600), `d` (86400), `wk` (604800) |
| `volume` (volume) | liter | `mL` (0.001), `L` (1), `floz` (0.0295735295625, US fluid ounce) |
| `energy` (energy) | joule | `J` (1), `kJ` (1000), `cal` (4.184), `kcal` (4184) |
| `frequency` (frequency) | per day | `/d` (1), `/h` (24), `/min` (1440), `/s` (86400) |
| `speed` (speed) | kilometers per hour | `km/h` (1), `m/s` (3.6), `mi/h` (1.609344) |
| `dimensionless` (dimensionless) | 1 | `1` (1, a count or a ratio), `%` (0.01) |
| `temperature:<code>` (temperature) | — | `Cel`, `degF`, `K`: **each is a dimension of its own, and the first version does not convert between them** |
| `currency:<code>` (currency) | — | the three-letter codes currently in ISO 4217 (`CNY`, `USD`, `EUR`…): **each currency is a dimension of its own, with no conversion between them** |

- **The choice of base unit** has only one requirement: that every factor is a finite decimal. That is why frequency takes "per day" and speed takes "kilometers per hour" as the base; the base is not exposed outward and is used only for conversion.
- **Months and years are not accepted**: they are not fixed lengths.
- **Currency**: a write unit that differs from the currency declared by the field reports `validation_failed` (`unit_dimension`). To convert, bring the exchange rate in as base data and compute it in a derivation rule (see "Derivation rules").
- **Temperature**: conversion between Celsius and Fahrenheit has an offset, which a single factor cannot express. In the first version only the unit that is declared is accepted; conversion between them is added later, at which point an optional offset is added to the unit definition and existing definitions do not change.
- **The UCUM spelling of the imperial codes**: `in` = `[in_i]`, `ft` = `[ft_i]`, `yd` = `[yd_i]`, `mi` = `[mi_i]`, `oz` = `[oz_av]`, `lb` = `[lb_av]`, `floz` = `[foz_us]`, `degF` = `[degF]`, `mi/h` = `[mi_i]/h`. `ug` is the same as the ASCII spelling of UCUM (the prefix "micro" is written `u`). Codes contain no whitespace: `floz` is `fl oz` with the space removed.
- **The origin of the factors**: the international yard = 0.9144 m and the international pound = 0.45359237 kg are the values agreed internationally in 1959; the foot, inch, mile and ounce are derived from them by integer ratios (1 mi = 5280 ft, 1 lb = 16 oz); `cal` takes the thermochemical calorie, exactly 4.184 J. The US gallon is defined as 231 cubic inches, so 1 gallon = 3.785411784 L; the fluid ounce is 1/128 of a gallon, exactly 29.5735295625 mL.
- **Units outside the vocabulary**: a draft that uses one reports `validation_failed` (`unit_unknown`), and `allowed_units` gives candidates, possibly none: a Latin-letter unit that equals a code regardless of case, or is its spelling in the "Unit synonym table", or is its full English spelling (`kilometer` → `km`; this is used only to give candidates, does not enter the synonym table and does not affect literal match); when there is none, strip a trailing plural `s` / `es` and look again (`kcals` → `kcal`), and this pass does not recognize currency codes. No guessing by edit distance: unit codes are short, and those that differ by one or two letters are often another unit (`ml` and `mg`). At most 3; at write time a unit that is not in the vocabulary reports `unit_unknown`, and a dimension that differs from the field's reports `unit_dimension`. For a quantity that truly has no suitable unit, use a `decimal` or `integer` field and state the unit in the description.
- **Only units that can be defined exactly and mean the same everywhere are accepted**, and every row of the vocabulary is a promise that "saveslot guarantees the conversion is correct":

  | Not accepted | Why | Alternative |
  |---|---|---|
  | The imperial fluid ounce | differs from the US one by 4%, and when users say "ounce" they overwhelmingly mean the US one | for a field kept in imperial, use `mL` |
  | Cup, tablespoon, teaspoon | the same word is a different quantity in different places (a cup is about 236.6, 240, 250 or 200 mL, a tablespoon about 14.8, 15 or 20 mL); accepting them would choose one for the user, and the converted number would quietly be off by more than 20% | declare the field as `mL`, the agent converts before writing, and the user's own words ("two cups") stay in the evidence; or use a `decimal` field and write "cup (this table uses 240 mL)" in the description |
  | The international unit IU | not a fixed quantity; the conversion differs for each substance, and it cannot be put under mass | a `decimal` field, with "IU" in the description |
  | Pint, quart, gallon | rare in everyday records, and likewise split into US and imperial | `floz` or `L` |
  | `dL`, `cL` | merely a different prefix, and converting to `mL` is never wrong | `mL` |
  | Portion, item, slice | not physical units | the dimensionless `1`, with the field description stating how much one portion is |
  | Concentration (`mg/dL`, `mmol/L`) | the vocabulary has no concentration dimension, and the dimension has to be decided before it is accepted | a `decimal` field, with the unit in the description |

- US food labels count 1 fluid ounce as 30 mL, which is the rounding convention of labels, not the definition of the unit; the vocabulary takes the defined value. For a field that copies numbers from labels, writing `mL` is less likely to drift.
- **The unit of a derived field** is inferred by the compiler (`sum` / `avg` / `min` / `max`, multiplication and division by a constant); when multiplying or dividing two fields that have units does not yield a unit in the vocabulary, an error is reported, requiring the result to be declared as `decimal` with a description, or `unit` to be written on that field.

## Unit synonym table (for literal match)

Literal match (see "Source level") has to judge "whether the original text of the evidence has this number plus this unit". A unit has many spellings in the original text, and the table below is the spellings that `units@1` recognizes (likewise meaning the content when event format v1 is frozen); it goes with the checker version (`literal@1` includes `units@1`), and changing this table means issuing a new checker version, while the hit results recorded in old events do not change.

- Spellings in Latin letters are case-insensitive.
- Currency symbols (`¥`, `￥`, `$`, `€`, `£`, `HK$`) are written only **before** the number (`¥45`, `$12.5`), and must not be directly adjacent on the left to a Latin letter or a digit ("US$12" does not count as `USD`, and the `$` in "HK$" does not count either); other spellings come **after** the number; both kinds may be separated from the number by whitespace.
- The spelling after a number is the longest one of all spellings in the table at that place, and counts only if it belongs to the original unit of the request ("5 公里/小时" and "5 km/h" do not let km hit). No spelling may be followed immediately by `/`, `^` or a superscript digit ("5 m²" and "5 m^2" do not let 5 m hit); a spelling in Latin letters additionally must not be followed immediately by a Latin letter or a digit ("5 mi" and "5 m2" do not let 5 m hit); apart from this one, a Chinese spelling has no boundary ("5 公里路" hits).
- The unit `1` does not require a spelling of the unit, and a number hit is enough.

| Code | Accepted spellings |
|---|---|
| `CNY` | 元, 块, 块钱, 圆, 人民币, RMB, CNY, ¥, ￥ |
| `USD` | 美元, 美金, USD, dollar(s), $ |
| `EUR` | 欧元, EUR, euro(s), € |
| `JPY` | 日元, 円, JPY, yen |
| `HKD` | 港币, 港元, HKD, HK$ |
| `GBP` | 英镑, GBP, pound(s), £ |
| Other currencies | only the ISO code is recognized |
| `km` | 公里, 千米, km |
| `m` | 米, m, meter(s) |
| `cm`, `mm` | 厘米, 公分, cm; 毫米, mm |
| `mi`, `ft`, `in`, `yd` | 英里, mile(s), mi; 英尺, foot, feet, ft; 英寸, inch(es), in; 码, yard(s), yd |
| `kg`, `g`, `mg` | 公斤, 千克, kg; 克, g; 毫克, mg |
| `ug` | 微克, µg, μg, ug, mcg |
| `lb`, `oz` | 磅, lb, lbs, pound(s); 盎司, oz |
| `h`, `min`, `s`, `ms` | 小时, 钟头, h, hr(s), hour(s); 分钟, 分, min(s), minute(s); 秒, 秒钟, s, sec(s); 毫秒, ms |
| `d`, `wk` | 天, 日, d, day(s); 周, 星期, 礼拜, wk, week(s) |
| `L`, `mL` | 升, L; 毫升, mL |
| `floz` | 液量盎司, 液体盎司, 盎司, fl oz, fl. oz., floz, oz |
| `kcal`, `cal`, `kJ`, `J` | 千卡, 大卡, kcal; 卡, cal; 千焦, kJ; 焦, 焦耳, J |
| `/min`, `/s`, `/h`, `/d` | 次/分, 次/分钟, 每分钟, bpm, /min; 每秒, /s; 每小时, /h; 每天, /d |
| `km/h`, `m/s`, `mi/h` | 公里/小时, 公里每小时, km/h, kph; 米/秒, 米每秒, m/s; 英里/小时, mph, mi/h |
| `%` | %, ％, percent |
| `Cel`, `degF`, `K` | 度, 摄氏度, ℃, °C; 华氏度, ℉, °F; 开, K |

- Units such as "斤", "两" and "亩" that are not in the vocabulary are not accepted: their numeric values differ from those of the units in the vocabulary, and counting them as a hit would be wrong.
- `GBP` and `lb` both recognize `pound(s)`, and `floz` and `oz` both recognize "盎司" and "oz": literal match looks only at the spellings of the unit that the field declares, so they are not mixed up.
- Both spellings of `µg` (U+00B5 micro sign, U+03BC Greek letter) are recognized.
