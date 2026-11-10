/**
 * Checks for state read from the URL, which anyone can edit or paste: a value that would select
 * no view, or reach SQL in a form the app never writes, is dropped and the default kept.
 */

/** The value when it is one of the allowed ones. */
export const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/** Probabilities strictly between 0 and 1 (quantiles, percentiles); others are dropped. */
export const probabilities = (values: unknown[]): number[] =>
  values.map(Number).filter((value) => Number.isFinite(value) && value > 0 && value < 1);
