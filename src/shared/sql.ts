import { AdHocVariableFilter } from '@grafana/data';
import { quoteString } from 'clickhouse/metrics';

/** The filter key of the service, a column of its own in every exporter table. */
export const SERVICE_KEY = 'resource.service.name';

/**
 * The Map access of a prefixed attribute key, e.g. `resource.k8s.pod.name` to
 * `ResourceAttributes['k8s.pod.name']` with `{ resource: 'ResourceAttributes' }`; undefined for
 * other keys.
 */
export const mapAttributeExpression = (key: string, columns: Record<string, string>): string | undefined => {
  const prefix = Object.keys(columns).find((name) => key.startsWith(`${name}.`));
  return prefix ? `${columns[prefix]}[${quoteString(key.slice(prefix.length + 1))}]` : undefined;
};

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
