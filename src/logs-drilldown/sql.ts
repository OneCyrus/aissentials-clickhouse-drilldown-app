import { mapAttributeExpression, quoteString, SERVICE_KEY, SignalSource, tableSql } from '../shared';
import { VAR_FILTERS } from '../constants';

/**
 * Filter keys of the logs app, in the style of OTel attribute names:
 * - `resource.<key>`: a resource attribute (`resource.service.name` reads the ServiceName column),
 * - `log.<key>`: a log record attribute (LogAttributes), shown as a "field",
 * - `level`: the normalized severity,
 * - `pattern`: the log line's pattern (see `patternExpression`).
 */
export const FILTERS = `\${${VAR_FILTERS}}`;
export const VAR_LEVELS = 'levels';
export const VAR_FIELDS = 'fields';
export const VAR_LINE_FILTERS = 'lineFilters';
export const VAR_PATTERNS = 'patterns';
export const LEVELS = `\${${VAR_LEVELS}}`;
const FIELDS = `\${${VAR_FIELDS}}`;
const LINE_FILTERS = `\${${VAR_LINE_FILTERS}}`;
const PATTERNS = `\${${VAR_PATTERNS}}`;

/** Every condition of the filter header, ANDed. */
export const ALL_FILTERS = `${FILTERS} AND ${LEVELS} AND ${FIELDS} AND ${LINE_FILTERS} AND ${PATTERNS}`;

export { SERVICE_KEY };

/** The level of a log line: SeverityText lower-cased and normalized, `unknown` when empty. */
const levelExpression =
  "multiIf(SeverityText = '', if(SeverityNumber = 0, 'unknown', " +
  "multiIf(SeverityNumber <= 4, 'trace', SeverityNumber <= 8, 'debug', SeverityNumber <= 12, 'info', " +
  "SeverityNumber <= 16, 'warn', SeverityNumber <= 20, 'error', 'fatal')), " +
  "lower(SeverityText) IN ('warning'), 'warn', lower(SeverityText) IN ('err', 'eror'), 'error', " +
  "lower(SeverityText) IN ('information'), 'info', lower(SeverityText))";

/**
 * The pattern of a log line: numbers, ids, IPs and quoted values replaced by `<_>`, so lines from
 * the same template group together (ClickHouse has no pattern miner like Loki's).
 */
const patternReplacements = [
  // UUIDs, IPv4 addresses, then words with digits (ids such as ord-123, u-42, numbers, durations)
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
  '\\b(\\d{1,3}\\.){3}\\d{1,3}\\b',
  '\\b[A-Za-z]*[-_]?[0-9][A-Za-z0-9_.:-]*\\b',
  // quoted values
  '"[^"]*"',
  "'[^']*'",
];

export const patternExpression = [...patternReplacements, '(<_>[ ,;:/=]*)+<_>'].reduce(
  (expression, regex) => `replaceRegexpAll(${expression}, ${quoteString(regex)}, '<_>')`,
  'Body'
);

/** The SQL expression of a filter key. */
export const logsExpression = (key: string): string | undefined => {
  if (key === SERVICE_KEY) {
    return 'ServiceName';
  }
  if (key === 'level') {
    return levelExpression;
  }
  if (key === 'pattern') {
    return patternExpression;
  }
  return mapAttributeExpression(key, { resource: 'ResourceAttributes', log: 'LogAttributes' });
};

/** The display name of a key, as the Drilldown apps show it. */
export const keyDisplayName = (key: string): string =>
  key === SERVICE_KEY ? 'service' : key.replace(/^(resource|log)\./, '');

const logsTable = (source: SignalSource) => tableSql(source.database, source.table);

/**
 * The time-range condition of a logs query. Newer exporter versions partition and sort `otel_logs`
 * on `TimestampTime` (DateTime) and keep the precise `Timestamp` (DateTime64) as a plain column, so
 * a filter on `Timestamp` alone reads every partition in range: measured 4.4M rows / 52 ms over 24 h
 * against 105k rows / 11 ms with `TimestampTime`. The data source names that column in
 * `logs.filterTimeColumn`; when it is set, the query filters on it for pruning and still on
 * `Timestamp`, so the range stays exact to the millisecond. The configured column must exist.
 */
export const logsTimeFilter = (source: SignalSource): string =>
  source.filterTimeColumn && source.filterTimeColumn !== 'Timestamp'
    ? `$__timeFilter(${source.filterTimeColumn}) AND $__timeFilter(Timestamp)`
    : '$__timeFilter(Timestamp)';

/** The columns of the logs panel: timestamp, body, level and the attributes as labels. */
const logLineColumns =
  `Timestamp AS "timestamp", Body AS "body", ${levelExpression} AS "level", ` +
  `mapConcat(map('service.name', ServiceName), ResourceAttributes, LogAttributes) AS "labels", ` +
  `TraceId AS "traceID", SpanId AS "spanID"`;

/** Rows for the logs panel: timestamp, body, level and the attributes as labels. */
export const logLinesSql = (source: SignalSource, condition: string, limit = 1000, ascending = false): string =>
  `SELECT ${logLineColumns} ` +
  `FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} ` +
  `ORDER BY Timestamp ${ascending ? 'ASC' : 'DESC'} LIMIT ${limit}`;

/** Log volume per time bucket and level. */
export const volumeByLevelSql = (source: SignalSource, condition: string): string =>
  `SELECT $__timeInterval(Timestamp) AS time, ${levelExpression} AS level, count() AS count ` +
  `FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} ` +
  `GROUP BY time, level ORDER BY time ASC`;

/**
 * The landing page's tiles query their data together, one query per kind for the whole page,
 * instead of two queries per tile: rows carry the tile's value in this column, and the page splits
 * them per tile.
 */
export const LANDING_TILE = '__tile';

/** The landing condition: the primary label is one of the page's values. */
const landingCondition = (key: string, values: string[], condition: string) =>
  `${logsExpression(key) || 'ServiceName'} IN (${values.map(quoteString).join(', ')}) AND ${condition}`;

/** Log volume per time bucket and level of every tile of a landing page. */
export const landingVolumeSql = (source: SignalSource, key: string, values: string[], condition: string): string =>
  `SELECT $__timeInterval(Timestamp) AS time, toString(${logsExpression(key) || 'ServiceName'}) AS ${LANDING_TILE}, ` +
  `${levelExpression} AS level, count() AS count FROM ${logsTable(source)} ` +
  `WHERE ${logsTimeFilter(source)} AND ${landingCondition(key, values, condition)} ` +
  `GROUP BY time, ${LANDING_TILE}, level ORDER BY time ASC`;

/** The latest lines of every tile of a landing page, at most `perValue` each. */
export const landingLinesSql = (
  source: SignalSource,
  key: string,
  values: string[],
  condition: string,
  perValue = 100
): string =>
  `SELECT ${logLineColumns}, toString(${logsExpression(key) || 'ServiceName'}) AS "${LANDING_TILE}" ` +
  `FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${landingCondition(key, values, condition)} ` +
  `ORDER BY Timestamp DESC LIMIT ${perValue} BY "${LANDING_TILE}"`;

export const countSql = (source: SignalSource, condition: string): string =>
  `SELECT count() AS count FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition}`;

/** A line filter of the header: include or exclude text or a regular expression. */
export interface LineFilter {
  exclude: boolean;
  text: string;
  caseSensitive: boolean;
  regex: boolean;
}

export const lineFilterSql = (filter: LineFilter): string => {
  const text = quoteString(filter.text);
  const match = filter.regex
    ? `match(Body, ${quoteString(filter.caseSensitive ? filter.text : `(?i)${filter.text}`)})`
    : filter.caseSensitive
      ? `position(Body, ${text}) > 0`
      : `positionCaseInsensitiveUTF8(Body, ${text}) > 0`;
  return filter.exclude ? `NOT ${match}` : match;
};

export const lineFiltersSql = (filters: LineFilter[]): string => {
  const conditions = filters.filter((filter) => filter.text).map((filter) => `(${lineFilterSql(filter)})`);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
};

export const levelsSql = (levels: string[]): string =>
  levels.length ? `${levelExpression} IN (${levels.map(quoteString).join(', ')})` : '1 = 1';

export interface AppliedPattern {
  type: 'include' | 'exclude';
  pattern: string;
}

/** Included patterns are ORed, excluded ones ANDed, as in Logs Drilldown. */
export const patternsSql = (patterns: AppliedPattern[]): string => {
  const included = patterns.filter((p) => p.type === 'include').map((p) => quoteString(p.pattern));
  const excluded = patterns.filter((p) => p.type === 'exclude').map((p) => quoteString(p.pattern));
  const conditions = [
    included.length ? `${patternExpression} IN (${included.join(', ')})` : '',
    excluded.length ? `${patternExpression} NOT IN (${excluded.join(', ')})` : '',
  ].filter(Boolean);
  return conditions.length ? conditions.join(' AND ') : '1 = 1';
};

/** Labels (resource attributes and the service) or fields (log attributes) with their cardinality. */
export const detectedKeysSql = (source: SignalSource, kind: 'labels' | 'fields', condition: string): string => {
  const column = kind === 'labels' ? 'ResourceAttributes' : 'LogAttributes';
  const prefix = kind === 'labels' ? 'resource.' : 'log.';
  const keys =
    `SELECT concat(${quoteString(prefix)}, tupleElement(kv, 1)) AS key, uniq(tupleElement(kv, 2)) AS cardinality ` +
    `FROM (SELECT arrayJoin(arrayZip(mapKeys(${column}), mapValues(${column}))) AS kv FROM ${logsTable(source)} ` +
    `WHERE ${logsTimeFilter(source)} AND ${condition}) GROUP BY key`;
  if (kind === 'fields') {
    return `SELECT key, cardinality FROM (${keys}) ORDER BY key ASC LIMIT 500`;
  }
  // service.name and the level are labels too; the service is a column of its own.
  const extra =
    `SELECT ${quoteString(SERVICE_KEY)} AS key, uniq(ServiceName) AS cardinality FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} ` +
    `UNION ALL SELECT 'level' AS key, uniq(${levelExpression}) AS cardinality FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition}`;
  return `SELECT key, max(cardinality) AS cardinality FROM (${keys} UNION ALL ${extra}) GROUP BY key HAVING cardinality > 0 ORDER BY key ASC LIMIT 500`;
};

/** Values of a key by count, most first, for the landing page and suggestions. */
export const valueCountsSql = (source: SignalSource, key: string, condition: string, limit = 1000): string => {
  const expression = logsExpression(key) || 'ServiceName';
  return (
    `SELECT toString(${expression}) AS value, count() AS count FROM ${logsTable(source)} ` +
    `WHERE ${logsTimeFilter(source)} AND ${condition} GROUP BY value HAVING value != '' ORDER BY count DESC, value ASC LIMIT ${limit}`
  );
};

/** Count per time bucket and value of a key, for the top values (all when limit is 0). */
export const volumeByValueSql = (source: SignalSource, key: string, condition: string, limit = 20): string => {
  const expression = `toString(${logsExpression(key) || 'ServiceName'})`;
  const top = limit
    ? ` AND ${expression} IN (SELECT ${expression} FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} ` +
      `GROUP BY ${expression} ORDER BY count() DESC LIMIT ${limit})`
    : '';
  return (
    `SELECT $__timeInterval(Timestamp) AS time, ${expression} AS value, count() AS count FROM ${logsTable(source)} ` +
    `WHERE ${logsTimeFilter(source)} AND ${condition} AND ${expression} != ''${top} GROUP BY time, value ORDER BY time ASC`
  );
};

/** Patterns with total count, levels and counts per bucket (for sparklines), most frequent first. */
export const patternsListSql = (source: SignalSource, condition: string, bucketSeconds: number): string =>
  `SELECT pattern, sum(count) AS total, groupUniqArray(level) AS levels, ` +
  `arraySort(x -> tupleElement(x, 1), groupArray((t, count))) AS series FROM (` +
  `SELECT ${patternExpression} AS pattern, ${levelExpression} AS level, ` +
  `toUnixTimestamp(toStartOfInterval(Timestamp, INTERVAL ${Math.max(1, Math.round(bucketSeconds))} second)) AS t, count() AS count ` +
  `FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} GROUP BY pattern, level, t` +
  `) GROUP BY pattern ORDER BY total DESC LIMIT 500`;

/** Count over time of the most frequent patterns. */
export const patternsVolumeSql = (source: SignalSource, condition: string, limit = 20): string =>
  `SELECT $__timeInterval(Timestamp) AS time, ${patternExpression} AS pattern, count() AS count FROM ${logsTable(source)} ` +
  `WHERE ${logsTimeFilter(source)} AND ${condition} AND ${patternExpression} IN (` +
  `SELECT ${patternExpression} FROM ${logsTable(source)} WHERE ${logsTimeFilter(source)} AND ${condition} ` +
  `GROUP BY 1 ORDER BY count() DESC LIMIT ${limit}) GROUP BY time, pattern ORDER BY time ASC`;

/** Sample lines of one pattern. */
export const patternSamplesSql = (source: SignalSource, condition: string, pattern: string): string =>
  logLinesSql(source, `${condition} AND ${patternExpression} = ${quoteString(pattern)}`, 20);

export const levelOrder = ['critical', 'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'unknown'];
