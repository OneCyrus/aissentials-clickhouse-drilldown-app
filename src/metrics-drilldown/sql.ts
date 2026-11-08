import {
  buildMetricQuery,
  generateMetricsQuery,
  getMetricLabelExpression,
  MetricCatalogEntry,
  metricColumnLabels,
  metricTypes,
  quoteString,
} from 'clickhouse/metrics';
import { MetricFunction, MetricLabel, MetricQuery, MetricType } from 'clickhouse/types';
import { metricTableOf, SignalSource, tableSql } from '../shared';
import { VAR_FILTERS } from '../constants';

/** The filter bar's condition, interpolated by the scene. */
export const FILTERS = `\${${VAR_FILTERS}}`;

/** Lookups read the last 6 hours of the range at most, like the query editor's. */
const discoveryCondition = 'TimeUnix >= greatest($__fromTime, subtractHours($__toTime, 6)) AND TimeUnix <= $__toTime';

const prefixedSources = ['resource', 'attribute', 'scope'] as const;

/**
 * The filter key and group-by id of a label, readable in the filter bar and URL like the
 * Drilldown apps' keys: `ServiceName` for a column, `resource.k8s.pod.name`, `attribute.http.route`
 * or `scope.<key>` for attributes.
 */
export const getMetricLabelId = (label: MetricLabel): string =>
  label.source === 'column' ? label.key : `${label.source}.${label.key}`;

export const parseMetricLabelId = (id: string): MetricLabel | undefined => {
  const source = prefixedSources.find((prefix) => id.startsWith(`${prefix}.`));
  if (source) {
    return { source, key: id.slice(source.length + 1) };
  }
  return metricColumnLabels.find((label) => label.key === id);
};

/** Filter keys are label ids such as `resource.k8s.pod.name`. */
export const metricLabelExpression = (key: string): string | undefined => {
  const label = parseMetricLabelId(key);
  return label ? getMetricLabelExpression(label) : undefined;
};

const tablesOf = (source: SignalSource, entry?: Pick<MetricCatalogEntry, 'type'>): Array<[MetricType, string]> =>
  metricTypes
    .filter((type) => (!entry || entry.type === type) && source.metricTables[type])
    .map((type) => [type, tableSql(source.database, metricTableOf(source, type))]);

/** The metrics with data matching the filters, across all metric tables. */
export const catalogSql = (source: SignalSource, condition: string): string => {
  const selects = tablesOf(source).map(([type, table]) => {
    const monotonic = type === MetricType.Sum ? 'max(toUInt8(IsMonotonic))' : 'toUInt8(0)';
    return (
      `SELECT MetricName AS name, ${quoteString(type)} AS type, any(MetricUnit) AS unit, ` +
      `any(MetricDescription) AS description, ${monotonic} AS monotonic ` +
      `FROM ${table} WHERE ${discoveryCondition} AND ${condition} GROUP BY MetricName`
    );
  });
  return `SELECT name, type, unit, description, monotonic FROM (${selects.join(' UNION ALL ')}) ORDER BY name ASC LIMIT 10000`;
};

/** Label keys of the metrics matching the filters, or of one metric. */
export const labelKeysSql = (source: SignalSource, condition: string, metric?: MetricCatalogEntry): string => {
  const selects = tablesOf(source, metric).map(
    ([, table]) =>
      `SELECT arrayJoin(arrayConcat(` +
      `arrayMap(k -> ('resource', k), groupUniqArrayArray(500)(mapKeys(ResourceAttributes))), ` +
      `arrayMap(k -> ('attribute', k), groupUniqArrayArray(500)(mapKeys(Attributes))), ` +
      `arrayMap(k -> ('scope', k), groupUniqArrayArray(100)(mapKeys(ScopeAttributes))))) AS label ` +
      `FROM ${table} WHERE ${discoveryCondition}${metric ? ` AND MetricName = ${quoteString(metric.name)}` : ''} AND ${condition}`
  );
  return (
    `SELECT DISTINCT tupleElement(label, 1) AS source, tupleElement(label, 2) AS key ` +
    `FROM (${selects.join(' UNION ALL ')}) ORDER BY key ASC`
  );
};

/** Values of a label, with how many series have each, most first. */
export const labelValuesSql = (
  source: SignalSource,
  label: MetricLabel,
  condition: string,
  metric?: MetricCatalogEntry
): string => {
  const expression = getMetricLabelExpression(label);
  const selects = tablesOf(source, metric).map(
    ([, table]) =>
      `SELECT toString(${expression}) AS value FROM ${table} WHERE ${discoveryCondition}` +
      `${metric ? ` AND MetricName = ${quoteString(metric.name)}` : ''} AND ${condition}`
  );
  return `SELECT value, count() AS n FROM (${selects.join(' UNION ALL ')}) WHERE value != '' GROUP BY value ORDER BY n DESC, value ASC LIMIT 1000`;
};

export const toMetricLabels = (rows: Array<{ source: string; key: string }>): MetricLabel[] => [
  ...metricColumnLabels,
  ...rows.map((row) => ({ source: row.source as MetricLabel['source'], key: row.key })),
];

export const labelDisplayName = (label: MetricLabel): string => label.key;

/**
 * The query a metric starts with: the editor's defaults (rate for counters, last for up-down
 * counters, p95 for histograms), except summaries, whose reported quantiles vary, and that show
 * the average value.
 */
export const defaultMetricQuery = (entry: MetricCatalogEntry, previous?: MetricQuery): MetricQuery => {
  const query = buildMetricQuery(
    { name: entry.name, type: entry.type, unit: entry.unit, isMonotonic: entry.isMonotonic },
    previous
  );
  if (entry.type === MetricType.Summary && query.fn === MetricFunction.Quantile) {
    return { ...query, fn: MetricFunction.AvgValue, quantiles: undefined };
  }
  if (entry.type === MetricType.Histogram && !previous) {
    // Like Metrics Drilldown, histograms start as a heatmap of their buckets.
    return { ...query, fn: MetricFunction.Heatmap, quantiles: undefined };
  }
  return query;
};

/** The SQL of a metric query, restricted by the filter bar. */
export const metricSql = (source: SignalSource, query: MetricQuery): string =>
  generateMetricsQuery({
    database: source.database,
    table: metricTableOf(source, query.type),
    metric: { ...query, condition: FILTERS },
  });

/** Name tokens: a metric name split on any non-alphanumeric character. */
const nameTokens = (name: string): string[] => name.split(/[^a-zA-Z0-9]+/).filter(Boolean);

/** First token of a metric name, e.g. `http` of `http.server.duration` or `go` of `go_gc_duration`. */
export const metricPrefix = (name: string): string => nameTokens(name)[0] || '<none>';

/** Last token of a metric name, e.g. `duration` of `http.server.duration`. */
export const metricSuffix = (name: string): string => nameTokens(name).slice(-1)[0] || '<none>';

const levenshtein = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
};

/**
 * How unrelated a metric name is to another, for the Related metrics order: the distance of the
 * candidate's first half of tokens plus the distance of the whole name. Lower is more related.
 */
export const nameDistance = (candidate: string, target: string): number => {
  const tokens = candidate.split(/[._]/);
  const head = tokens.slice(0, Math.floor(tokens.length / 2)).join('_');
  return levenshtein(head, target) + levenshtein(candidate, target);
};

/**
 * Search pieces split on commas, each a case-insensitive regular expression (invalid ones are
 * dropped); a name matches when any piece matches. Plain words work as substrings.
 */
export const searchMatcher = (text: string): ((name: string) => boolean) => {
  const patterns = text
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)
    .flatMap((piece) => {
      try {
        return [new RegExp(piece, 'i')];
      } catch {
        return [];
      }
    });
  return patterns.length ? (name) => patterns.some((pattern) => pattern.test(name)) : () => true;
};

/** For each value of a label, the metrics that carry it (the "Group by labels" list). */
export const metricsByLabelValueSql = (source: SignalSource, label: MetricLabel, condition: string): string => {
  const expression = getMetricLabelExpression(label);
  const selects = tablesOf(source).map(
    ([type, table]) =>
      `SELECT toString(${expression}) AS value, MetricName AS name, ${quoteString(type)} AS type FROM ${table} ` +
      `WHERE ${discoveryCondition} AND ${condition} GROUP BY value, name`
  );
  return (
    `SELECT value, groupUniqArray(200)(name) AS names FROM (${selects.join(' UNION ALL ')}) ` +
    `WHERE value != '' GROUP BY value ORDER BY length(names) DESC, value ASC LIMIT 500`
  );
};
