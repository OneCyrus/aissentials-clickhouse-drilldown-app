import {
  attributeExpression,
  attributeKeysOf,
  attributeValueSql,
  attributeValuesOf,
  AttributeShape,
  quoteString,
  SERVICE_KEY,
  SignalSource,
  tableSql,
} from '../shared';
import { VAR_FILTERS } from '../constants';

/**
 * Filter keys of the traces app follow TraceQL's naming, as in Traces Drilldown:
 * `resource.<key>` (resource attributes; `resource.service.name` reads ServiceName), `span.<key>`
 * (span attributes) and the intrinsics `name`, `kind`, `status`, `statusMessage`, `duration`.
 */
export const FILTERS = `\${${VAR_FILTERS}}`;
export const VAR_PRIMARY = 'primarySignal';
export const PRIMARY = `\${${VAR_PRIMARY}}`;
const SCOPE = `${PRIMARY} AND ${FILTERS}`;

export type MetricType = 'rate' | 'errors' | 'duration';

export const primarySignals = [
  {
    value: 'root',
    label: 'Root spans',
    sql: "ParentSpanId = ''",
    description: 'Focus your analysis on the root span of each trace',
  },
  {
    value: 'all',
    label: 'All spans',
    sql: '1 = 1',
    description: 'View and analyse raw span data. This option may result in long query times.',
  },
  {
    value: 'server',
    label: 'Server spans',
    sql: "SpanKind = 'Server'",
    description: 'Explore server-specific segments of traces',
  },
  {
    value: 'consumer',
    label: 'Consumer spans',
    sql: "SpanKind = 'Consumer'",
    description: 'Analyze interactions initiated by consumer services',
  },
  {
    value: 'database',
    label: 'Database calls',
    sql: "(SpanAttributes['db.system'] != '' OR SpanAttributes['db.system.name'] != '')",
    description: 'Evaluate the performance issues in database interactions',
  },
];

/** The condition of a primary signal for a table shape: only `database` reads an attribute. */
export const primarySignalSql = (value: string, shape: AttributeShape = {}): string => {
  if (value === 'database') {
    const system = (key: string) => attributeValueSql('SpanAttributes', key, shape.jsonAttributes);
    return `(${system('db.system')} != '' OR ${system('db.system.name')} != '')`;
  }
  return primarySignals.find((signal) => signal.value === value)?.sql || '1 = 1';
};

export const ERROR_CONDITION = "StatusCode IN ('Error', 'STATUS_CODE_ERROR')";
export { SERVICE_KEY };

const intrinsics: Record<string, string> = {
  name: 'SpanName',
  kind: 'SpanKind',
  status: 'StatusCode',
  statusMessage: 'StatusMessage',
};

/**
 * The SQL expression of an attribute key; `duration` compares in milliseconds. `json` for JSON
 * attribute columns (see AttributeShape).
 */
export const traceExpression = (key: string, json = false): string | undefined => {
  if (key === SERVICE_KEY) {
    return 'ServiceName';
  }
  if (key === 'duration') {
    return 'Duration / 1000000';
  }
  if (intrinsics[key]) {
    return intrinsics[key];
  }
  return attributeExpression(key, { resource: 'ResourceAttributes', span: 'SpanAttributes' }, json);
};

/** traceExpression for a source's table shape, for the filter bar and filtersSql. */
export const traceKeyExpression =
  (source: SignalSource | undefined) =>
  (key: string): string | undefined =>
    traceExpression(key, source?.jsonAttributes);

/** The expression of a key in a source's table, the service for unknown keys. */
const keyExpression = (source: SignalSource, key: string): string =>
  traceExpression(key, source.jsonAttributes) || 'ServiceName';

/** Default favorite attributes of Traces Drilldown that exist in OTel data. */
export const defaultFavorites = [
  SERVICE_KEY,
  'resource.service.namespace',
  'resource.service.version',
  'resource.deployment.environment',
  'resource.k8s.namespace.name',
  'resource.k8s.pod.name',
  'resource.k8s.container.name',
  'resource.k8s.node.name',
  'name',
  'kind',
  'status',
  'statusMessage',
  'span.http.response.status_code',
  'span.http.status_code',
];

const traces = (source: SignalSource) => tableSql(source.database, source.table);

/**
 * Durations that make sense: a span that ends before it starts (clock skew) is stored as a huge
 * unsigned value, which would stretch every duration chart. About 11 days at most.
 */
const VALID_DURATION = 'Duration < 1000000000000000';
const timeFilter = '$__timeFilter(Timestamp)';

/** Span rate (or error rate) per second over time. */
export const rateSql = (source: SignalSource, errors: boolean): string =>
  `SELECT $__timeInterval(Timestamp) AS time, count() / $__interval_s AS "${errors ? 'error/s' : 'span/s'}" ` +
  `FROM ${traces(source)} WHERE ${timeFilter} AND ${SCOPE}${errors ? ` AND ${ERROR_CONDITION}` : ''} ` +
  `GROUP BY time ORDER BY time ASC`;

/** Duration buckets: powers of two in seconds, labelled by upper bound like a Prometheus `le`. */
const durationBucketExpression = 'pow(2, ceil(log2(greatest(Duration, 1000) / 1e9)))';

/** Span counts per time bucket and duration bucket, for the duration heatmap. */
export const durationHeatmapSql = (source: SignalSource): string =>
  `SELECT $__timeInterval(Timestamp) AS time, toString(${durationBucketExpression}) AS le, count() AS count ` +
  `FROM ${traces(source)} WHERE ${timeFilter} AND ${SCOPE} AND ${VALID_DURATION} GROUP BY time, le ORDER BY time ASC`;

/** The duration buckets that have spans, for the default comparison selection. */
export const durationBucketsSql = (source: SignalSource): string =>
  `SELECT ${durationBucketExpression} AS bucket, count() AS count FROM ${traces(source)} ` +
  `WHERE ${timeFilter} AND ${SCOPE} AND ${VALID_DURATION} GROUP BY bucket ORDER BY bucket ASC`;

/**
 * The default comparison selection of the duration metric: the slowest quarter of the buckets that
 * have spans, i.e. spans slower than the upper bound of the bucket below them (in seconds).
 */
export const slowestQuarterThreshold = (buckets: number[]): number | undefined => {
  if (!buckets.length) {
    return undefined;
  }
  const sorted = [...buckets].sort((a, b) => a - b);
  const top = Math.max(1, Math.floor(sorted.length / 4));
  const first = sorted.length - top;
  return first > 0 ? sorted[first - 1] : sorted[0] / 2;
};

/** The comparison selection: errors for rate and errors, slow spans for duration. */
export const selectionSql = (metric: MetricType, threshold?: number): string =>
  metric === 'duration' ? `Duration >= ${Math.round((threshold ?? 0) * 1e9)} AND ${VALID_DURATION}` : ERROR_CONDITION;

/** The metric over time grouped by an attribute (Breakdown). */
export const breakdownSql = (source: SignalSource, metric: MetricType, key: string, percentiles: number[]): string => {
  const expression = `toString(${keyExpression(source, key)})`;
  const where =
    `${timeFilter} AND ${SCOPE}${metric === 'errors' ? ` AND ${ERROR_CONDITION}` : ''} AND ${expression} != ''` +
    (metric === 'duration' ? ` AND ${VALID_DURATION}` : '');
  if (metric === 'duration') {
    const ps = percentiles.length ? percentiles : [0.9];
    return (
      `SELECT $__timeInterval(Timestamp) AS time, ${expression} AS value, ` +
      ps
        .map((p, i) => `quantilesTDigest(${ps.join(', ')})(Duration)[${i + 1}] / 1e9 AS "p${Math.round(p * 100)}"`)
        .join(', ') +
      ` FROM ${traces(source)} WHERE ${where} GROUP BY time, value ORDER BY time ASC`
    );
  }
  return (
    `SELECT $__timeInterval(Timestamp) AS time, ${expression} AS value, count() / $__interval_s AS "${metric === 'errors' ? 'error/s' : 'span/s'}" ` +
    `FROM ${traces(source)} WHERE ${where} GROUP BY time, value ORDER BY time ASC`
  );
};

/** Every attribute of the spans in scope as (key, value), for keys and comparison. */
const attributePairs = (source: SignalSource) => {
  const prefixed = (prefix: string, column: string) =>
    `arrayMap((k, v) -> (concat('${prefix}.', k), v), ${attributeKeysOf(column, source)}, ${attributeValuesOf(column, source)})`;
  return (
    "arrayConcat([('resource.service.name', toString(ServiceName)), ('name', toString(SpanName)), ('kind', toString(SpanKind)), ('status', toString(StatusCode))], " +
    `${prefixed('resource', 'ResourceAttributes')}, ${prefixed('span', 'SpanAttributes')})`
  );
};

/** Only the keys of every attribute, for the attribute list: no values to read. */
const attributeKeys = (source: SignalSource) =>
  "arrayConcat(['resource.service.name', 'name', 'kind', 'status'], " +
  `arrayMap(k -> concat('resource.', k), ${attributeKeysOf('ResourceAttributes', source)}), ` +
  `arrayMap(k -> concat('span.', k), ${attributeKeysOf('SpanAttributes', source)}))`;

/** Attribute keys of the spans in scope (for the sidebar and the filter bar). */
export const attributeKeysSql = (source: SignalSource, condition: string): string =>
  `SELECT DISTINCT key FROM (SELECT arrayJoin(${attributeKeys(source)}) AS key ` +
  `FROM ${traces(source)} WHERE ${timeFilter} AND ${condition}) ORDER BY key ASC LIMIT 1000`;

export const attributeValuesSql = (source: SignalSource, key: string, condition: string): string => {
  const expression = `toString(${keyExpression(source, key)})`;
  return (
    `SELECT ${expression} AS value, count() AS count FROM ${traces(source)} WHERE ${timeFilter} AND ${condition} ` +
    `GROUP BY value HAVING value != '' ORDER BY count DESC LIMIT 1000`
  );
};

/**
 * Selection vs baseline: for each attribute its 10 most frequent values with their span counts in
 * the selection and in the baseline (the rest), plus the totals of both populations.
 *
 * One scan: every span also yields a marker pair ('', ''), whose counts are the totals, spread to
 * every row with a window. Before, the totals came from a second scan of the span set. Values with
 * the same count are ordered by value, so the 10 shown don't depend on the query plan.
 */
export const comparisonSql = (source: SignalSource, selection: string): string =>
  `SELECT key, value, selection, baseline, selection_total, baseline_total FROM (` +
  `SELECT key, value, selection, baseline, ` +
  `sumIf(selection, key = '') OVER () AS selection_total, sumIf(baseline, key = '') OVER () AS baseline_total FROM (` +
  `SELECT tupleElement(kv, 1) AS key, tupleElement(kv, 2) AS value, countIf(sel) AS selection, countIf(NOT sel) AS baseline ` +
  `FROM (SELECT arrayJoin(arrayConcat([('', '')], ${attributePairs(source)})) AS kv, ${selection} AS sel ` +
  `FROM ${traces(source)} WHERE ${timeFilter} AND ${SCOPE}) ` +
  `WHERE key = '' OR value != '' GROUP BY key, value)) ` +
  `WHERE key != '' ORDER BY key ASC, selection + baseline DESC, value ASC LIMIT 10 BY key`;

/** Spans for the trace list, slowest first. */
export const spanListSql = (source: SignalSource, condition: string, columns: string[]): string =>
  `SELECT Timestamp AS "Start time", StatusCode AS "status", ServiceName AS "Service", SpanName AS "Name", ` +
  `Duration / 1000000 AS "Duration (ms)", TraceId AS "Trace ID", SpanId AS "Span ID"` +
  columns
    .map((key) => `, toString(${traceExpression(key, source.jsonAttributes) || "''"}) AS ${quoteIdentifier(key)}`)
    .join('') +
  ` FROM ${traces(source)} WHERE ${timeFilter} AND ${SCOPE} AND ${condition} AND ${VALID_DURATION} ORDER BY Duration DESC LIMIT 200`;

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** An attribute of the event in `event` (a (name, attributes) tuple), empty when missing. */
const eventAttribute = (source: SignalSource, key: string): string =>
  source.jsonAttributes
    ? `ifNull(getSubcolumn(tupleElement(event, 2), ${quoteString(key)})::Nullable(String), '')`
    : `tupleElement(event, 2)[${quoteString(key)}]`;

/** Exception events of error spans, latest first. */
export const exceptionsSql = (source: SignalSource): string =>
  `SELECT Timestamp AS time, ServiceName AS service, ` +
  `${eventAttribute(source, 'exception.type')} AS type, ${eventAttribute(source, 'exception.message')} AS message, TraceId AS traceId ` +
  `FROM ${traces(source)} ARRAY JOIN arrayZip(Events.Name, Events.Attributes) AS event ` +
  `WHERE ${timeFilter} AND ${SCOPE} AND ${ERROR_CONDITION} AND tupleElement(event, 1) = 'exception' ` +
  `ORDER BY Timestamp DESC LIMIT 400`;

/** An attribute column as the trace view's tags: [{ key, value }]. */
const traceTags = (source: SignalSource, column: string): string =>
  source.jsonAttributes
    ? `arrayMap((key, value) -> map('key', key, 'value', value), ${attributeKeysOf(column, source)}, ${attributeValuesOf(column, source)})`
    : `arrayMap(key -> map('key', key, 'value', ${column}[key]), mapKeys(${column}))`;

/** One trace in the format of the data source's trace view. */
export const traceSql = (source: SignalSource, traceId: string): string =>
  `SELECT TraceId AS traceID, SpanId AS spanID, ParentSpanId AS parentSpanID, ServiceName AS serviceName, ` +
  `SpanName AS operationName, multiply(toUnixTimestamp64Nano(Timestamp), 0.000001) AS startTime, ` +
  `multiply(Duration, 0.000001) AS duration, ` +
  `${traceTags(source, 'SpanAttributes')} AS tags, ${traceTags(source, 'ResourceAttributes')} AS serviceTags, ` +
  `if(StatusCode IN ('Error', 'STATUS_CODE_ERROR'), 2, 0) AS statusCode ` +
  `FROM ${traces(source)} WHERE TraceId = ${quoteString(traceId)}${traceIdBounds(source, traceId)}`;

/**
 * Bounds the scan of a trace lookup with the exporter's trace-id index table, the way the data
 * source's own trace query does: the index maps a TraceId to Start/End, which are the table's
 * partition and sort keys, so the spans table reads only the part holding that trace. Without it
 * ClickHouse reads every part: measured 4,869 rows for a 56-span trace against 3 rows bounded.
 * Falls back to no bound when the deployment has no index table — the trace is still found, just
 * by scanning.
 */
const traceIdBounds = (source: SignalSource, traceId: string): string => {
  if (!source.traceIndexTable) {
    return '';
  }
  const index = tableSql(source.database, source.traceIndexTable);
  const id = quoteString(traceId);
  // A trace missing from the index (e.g. a shorter TTL there) makes the subqueries return NULL, so
  // the bounds fall back to "any time" and the trace is still found by scanning.
  return (
    ` AND Timestamp >= ifNull((SELECT min(Start) FROM ${index} WHERE TraceId = ${id} HAVING count() > 0), toDateTime(0))` +
    ` AND Timestamp <= ifNull((SELECT max(End) + 1 FROM ${index} WHERE TraceId = ${id} HAVING count() > 0), toDateTime('2105-12-31 00:00:00'))`
  );
};

/** Normalizes an exception message so variants group together, like Traces Drilldown. */
export const normalizeMessage = (message: string): string =>
  message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<timestamp>')
    .replace(/(\w*id)=\S+/gi, '$1=<id>')
    .replace(/\d+/g, '<num>');
