// Values (02-architecture §4, L1 `values`): exact decimal arithmetic, conversion between units of a
// dimension, rounding to a precision. Pure functions; no module below.

export {
  type Converted,
  convertValue,
  DECIMAL_INTEGER_DIGITS,
  type NumberShape,
} from "./convert-value.ts";
export {
  canonical,
  compare,
  divide,
  exceedsScale,
  integerDigits,
  isInteger,
  multiply,
  type ParsedDecimal,
  parseDecimal,
  type Rational,
  rationalOf,
  round,
} from "./decimal.ts";
