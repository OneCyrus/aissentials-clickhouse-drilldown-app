import { AdHocVariableFilter } from '@grafana/data';
import { quoteString } from 'clickhouse/metrics';
import { buildJSONPathAccess } from 'clickhouse/sql';

/** The filter key of the service, a column of its own in every exporter table. */
export const SERVICE_KEY = 'resource.service.name';

/**
 * How a logs or traces table stores its attribute columns. The exporter writes `Map(String, String)`
 * by default and the ClickHouse `JSON` type with its `json: true` option, which reads differently.
 */
export interface AttributeShape {
  /** The attribute columns are `JSON`: keys are JSON paths, values Dynamic. */
  jsonAttributes?: boolean;
  /**
   * The server has `JSONAllValues` (ClickHouse 26.4 and later), which lists a JSON column's values
   * in the order of `JSONAllPaths`. Older servers read each path out of the column's JSON text.
   */
  jsonAllValues?: boolean;
}

/**
 * The value of an attribute key in an attribute column, e.g. `k8s.pod.name` in ResourceAttributes:
 * `ResourceAttributes['k8s.pod.name']` for a Map, the JSON path cast to a string for JSON. A missing
 * key reads as an empty string in both, so `!=` and `NOT IN` filters keep the rows without it.
 */
export const attributeValueSql = (column: string, key: string, json = false): string =>
  json ? `ifNull(${buildJSONPathAccess(column, key)}, '')` : `${column}[${quoteString(key)}]`;

/**
 * The attribute access of a prefixed key, e.g. `resource.k8s.pod.name` to
 * `ResourceAttributes['k8s.pod.name']` with `{ resource: 'ResourceAttributes' }`; undefined for
 * other keys.
 */
export const attributeExpression = (key: string, columns: Record<string, string>, json = false): string | undefined => {
  const prefix = Object.keys(columns).find((name) => key.startsWith(`${name}.`));
  return prefix ? attributeValueSql(columns[prefix], key.slice(prefix.length + 1), json) : undefined;
};

/** The keys of an attribute column, as Array(String). */
export const attributeKeysOf = (column: string, shape: AttributeShape): string =>
  shape.jsonAttributes ? `JSONAllPaths(${column})` : `mapKeys(${column})`;

/** JSON paths deeper than this read as empty on servers without JSONAllValues. */
const MAX_JSON_PATH_DEPTH = 12;

/**
 * The value of the path `p` (a lambda argument) in the JSON text `s`, for servers without
 * JSONAllValues: JSONExtractRaw takes the path segments as separate arguments, so each depth is a
 * branch. Strings come back quoted from JSONExtractRaw and are unquoted; numbers and booleans are
 * their JSON text, as JSONAllValues returns them.
 */
const jsonTextValueSql = (text: string): string => {
  const parts = "splitByChar('.', p)";
  const branches = Array.from({ length: MAX_JSON_PATH_DEPTH }, (_, depth) => {
    const segments = Array.from({ length: depth + 1 }, (_, i) => `${parts}[${i + 1}]`).join(', ');
    return `length(${parts}) = ${depth + 1}, JSONExtractRaw(${text}, ${segments})`;
  }).join(', ');
  const raw = `multiIf(${branches}, '')`;
  return `if(startsWith(${raw}, '"'), JSONExtractString(${raw}), ${raw})`;
};

/** The values of an attribute column as Array(String), in the order of attributeKeysOf. */
export const attributeValuesOf = (column: string, shape: AttributeShape): string => {
  if (!shape.jsonAttributes) {
    return `mapValues(${column})`;
  }
  if (shape.jsonAllValues) {
    return `JSONAllValues(${column})`;
  }
  return `arrayMap(p -> ${jsonTextValueSql(`toJSONString(${column})`)}, JSONAllPaths(${column}))`;
};

/** An attribute column as Map(String, String), e.g. for the labels of log lines. */
export const attributeMapOf = (column: string, shape: AttributeShape): string =>
  shape.jsonAttributes
    ? `mapFromArrays(${attributeKeysOf(column, shape)}, ${attributeValuesOf(column, shape)})`
    : column;

/**
 * Whether the attribute columns of a logs or traces table are JSON, from its columns (DESC TABLE):
 * the exporter writes all of them in one shape, so ResourceAttributes tells.
 */
export const hasJsonAttributes = (columns: ReadonlyArray<{ name: string; type: string }>): boolean =>
  columns.some((column) => column.name === 'ResourceAttributes' && column.type.startsWith('JSON'));

export { quoteString };

/**
 * A filter of the filter bar. Scenes' operators: =, !=, =~, !~, <, >, and the multi value
 * operators =| and !=| (with the values in `values`).
 */
export type FilterLike = Pick<AdHocVariableFilter, 'key' | 'operator' | 'value'> & { values?: string[] };

const numberOrNull = (value: string): string => {
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : 'NULL';
};

/** The SQL condition of one filter on an expression, such as ResourceAttributes['k8s.pod.name']. */
export const filterConditionSql = (expression: string, filter: FilterLike): string => {
  const values = filter.values?.length ? filter.values : [filter.value];
  const list = values.map(quoteString).join(', ');
  switch (filter.operator) {
    case '!=':
      return `${expression} != ${quoteString(filter.value)}`;
    case '=~':
      return `match(${expression}, ${quoteString(filter.value)})`;
    case '!~':
      return `NOT match(${expression}, ${quoteString(filter.value)})`;
    case '=|':
      return `${expression} IN (${list})`;
    case '!=|':
      return `${expression} NOT IN (${list})`;
    case '>':
    case '<':
    case '>=':
    case '<=':
      return `toFloat64OrNull(toString(${expression})) ${filter.operator} ${numberOrNull(filter.value)}`;
    case '=':
    default:
      return `${expression} = ${quoteString(filter.value)}`;
  }
};

/** All filters ANDed, or a condition that is always true. */
export const filtersSql = (
  filters: readonly FilterLike[],
  expressionOf: (key: string) => string | undefined
): string => {
  const conditions = filters
    .map((filter) => {
      const expression = expressionOf(filter.key);
      return expression ? `(${filterConditionSql(expression, filter)})` : undefined;
    })
    .filter(Boolean);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
};

export const tableSql = (database: string, table: string): string =>
  `"${database.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}"`;
