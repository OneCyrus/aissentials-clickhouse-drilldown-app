/** SQL quoting helpers, as in grafana-clickhouse-datasource. */

export const escapeIdentifier = (id: string): string => (id ? `"${id.replace(/"/g, '""')}"` : '');

export const getTableIdentifier = (database: string, table: string): string => {
  const separator = !database || !table ? '' : '.';
  return `${escapeIdentifier(database)}${separator}${escapeIdentifier(table)}`;
};

/** Escapes a string for a single-quoted ClickHouse string literal (backslash and single quote). */
export const escapeCHStringLiteral = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Backslash-escapes backslashes and backticks so a segment can't close the backtick identifier. */
const escapeJSONPathSegment = (segment: string): string => segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`');

/** A column identifier as is when it's a plain (optionally dotted) identifier, else backtick-quoted. */
const quoteColumnIfUnsafe = (column: string): string =>
  /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(column)
    ? column
    : '`' + column.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';

/**
 * A JSON sub-path access, e.g. ``attrs.`a`.`b`::Nullable(String)``. The cast is needed because JSON
 * sub-paths are Dynamic, which IN / NOT IN reject.
 */
export const buildJSONPathAccess = (column: string, path: string): string => {
  const segments = path
    .split('.')
    .map((segment) => '`' + escapeJSONPathSegment(segment) + '`')
    .join('.');
  return `${quoteColumnIfUnsafe(column)}.${segments}::Nullable(String)`;
};
