import { DataSourceInstanceSettings } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { SceneObject, VariableValueOption } from '@grafana/scenes';
import {
  getConfiguredMetricTables,
  getMetricTableFeatures,
  MetricTableFeatures,
  MetricTables,
  resolveMetricTables,
} from 'clickhouse/metrics';
import { CHConfig, MetricType, SignalType } from 'clickhouse/types';
import { CLICKHOUSE_DS_TYPES } from '../constants';
import { Format, frameRows, runSql } from './query';
import { AttributeShape, hasJsonAttributes, tableSql } from './sql';

/**
 * Where a signal lives: the ClickHouse data source and the tables of the OpenTelemetry Collector
 * ClickHouse exporter. The apps work on the exporter schema, so only database and table names
 * come from the data source settings.
 */
export interface SignalSource extends AttributeShape {
  uid: string;
  /** The plugin id of the data source: a fork serves the same SQL under its own id. */
  type: string;
  name: string;
  database: string;
  /** The logs or traces table. */
  table: string;
  /**
   * The column to filter the time range on when it is not the table's own time column, because the
   * exporter partitions and sorts on a lower-precision copy (otel_logs.TimestampTime). Empty when
   * the table has one time column.
   */
  filterTimeColumn?: string;
  /**
   * The companion trace-id index table (`otel_traces_trace_id_ts`) once loadTraceIndex has found it:
   * it maps a TraceId to its Start and End, so a trace lookup can bound the scan of the spans table.
   */
  traceIndexTable?: string;
  /**
   * For logs and traces: whether loadSignalSource has detected the attribute columns' shape
   * (`jsonAttributes`, `jsonAllValues`). Until then they read as Map, the exporter's default.
   */
  attributeShapeKnown?: boolean;
  /**
   * What the metric tables support, detected from their columns once the tables are resolved:
   * the exporter can write attribute columns as `JSON` instead of `Map`, which reads differently.
   */
  metricFeatures?: MetricTableFeatures;
  /**
   * The metric tables, by data point type: only the tables that exist once loadMetricsSource has
   * run, the configured names before.
   */
  metricTables: MetricTables;
}

const exporterDatabase = 'otel';
const defaultTables: Record<Exclude<SignalType, 'metrics'>, string> = {
  logs: 'otel_logs',
  traces: 'otel_traces',
};

const jsonData = (settings: DataSourceInstanceSettings): Partial<CHConfig> =>
  (settings.jsonData || {}) as Partial<CHConfig>;

/** Whether a data source belongs to one of the accepted ClickHouse plugin ids. */
export const isClickHouseDataSource = (type: string | undefined): boolean =>
  Boolean(type) && CLICKHOUSE_DS_TYPES.includes(type!);

/** ClickHouse data sources, those set up for the signal (single-source mode) first. */
export const getClickHouseDataSources = (signal?: SignalType): DataSourceInstanceSettings[] => {
  // getList takes one plugin id, so ask per id: a fork has its own id and would otherwise
  // be invisible to the app. getList also returns Grafana's built-in data source, so keep only
  // ClickHouse data sources, each once.
  const seen = new Set<string>();
  const all = CLICKHOUSE_DS_TYPES.flatMap((type) => getDataSourceSrv().getList({ type })).filter((settings) => {
    if (!isClickHouseDataSource(settings.type) || seen.has(settings.uid)) {
      return false;
    }
    seen.add(settings.uid);
    return true;
  });
  if (!signal) {
    return all;
  }
  const rank = (settings: DataSourceInstanceSettings) => {
    const type = jsonData(settings).signalType;
    return type === signal ? 0 : type ? 2 : 1;
  };
  return [...all].sort((a, b) => rank(a) - rank(b) || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));
};

/** Whether a data source holds the signal: single-source data sources hold only their own. */
export const supportsSignal = (settings: DataSourceInstanceSettings, signal: SignalType): boolean => {
  const type = jsonData(settings).signalType;
  return !type || type === signal;
};

/** The data source to start with for a signal. */
export const getDefaultDataSourceUid = (signal: SignalType): string | undefined =>
  getDataSourcesForSignal(signal)[0]?.uid;

export const getSignalSource = (uid: string, signal: SignalType): SignalSource | undefined => {
  const settings = getDataSourceSrv().getInstanceSettings(uid);
  if (!settings || !isClickHouseDataSource(settings.type)) {
    return undefined;
  }
  const config = jsonData(settings);
  const section = signal === 'metrics' ? config.metrics : signal === 'logs' ? config.logs : config.traces;
  const resolved = signal === 'metrics' ? resolvedMetrics.get(uid) : undefined;
  const database = resolved?.database || section?.defaultDatabase || config.defaultDatabase || exporterDatabase;
  const table =
    signal === 'logs'
      ? config.logs?.defaultTable || defaultTables.logs
      : signal === 'traces'
        ? config.traces?.defaultTable || defaultTables.traces
        : '';
  const shape = signal === 'metrics' ? undefined : attributeShapes.get(attributeShapeKey(uid, database, table));
  return {
    ...shape,
    attributeShapeKnown: signal === 'metrics' ? undefined : Boolean(shape),
    uid: settings.uid,
    type: settings.type,
    name: settings.name,
    database,
    table,
    filterTimeColumn: signal === 'logs' ? config.logs?.filterTimeColumn?.trim() || undefined : undefined,
    traceIndexTable: signal === 'traces' ? traceIndexes.get(traceIndexKey(uid, database, table, config)) : undefined,
    metricTables: resolved?.tables ?? getConfiguredMetricTables(config.metrics),
    metricFeatures: resolved?.features,
  };
};

const attributeShapeKey = (uid: string, database: string, table: string) => `${uid}|${database}|${table}`;

/** The attribute shape of each data source's logs or traces table, once detected. */
const attributeShapes = new Map<string, AttributeShape>();
const detectingShapes = new Map<string, Promise<void>>();

/**
 * The logs or traces source with the shape of its attribute columns: Map, or JSON (the exporter's
 * `json: true`), and for JSON whether the server has JSONAllValues. Detected once per data source
 * and table, like the metric tables: one DESC TABLE, and for JSON tables a look at
 * system.functions. A failed detection is not remembered; the source then reads as Map, the
 * exporter's default, and the next load tries again.
 */
export const loadSignalSource = async (
  sceneObject: SceneObject,
  uid: string,
  signal: 'logs' | 'traces'
): Promise<SignalSource | undefined> => {
  const source = getSignalSource(uid, signal);
  if (!source || source.attributeShapeKnown) {
    return source;
  }
  const key = attributeShapeKey(uid, source.database, source.table);
  let pending = detectingShapes.get(key);
  if (!pending) {
    pending = (async () => {
      const columns = frameRows<{ name: string; type: string }>(
        await runSql(sceneObject, `DESC TABLE ${tableSql(source.database, source.table)}`, Format.Table, {
          datasourceUid: uid,
        })
      ).map((row) => ({ name: String(row.name), type: String(row.type) }));
      const shape: AttributeShape = { jsonAttributes: hasJsonAttributes(columns) };
      if (shape.jsonAttributes) {
        const rows = frameRows<{ count: number }>(
          await runSql(
            sceneObject,
            "SELECT count() AS count FROM system.functions WHERE name = 'JSONAllValues'",
            Format.Table,
            { datasourceUid: uid }
          )
        );
        shape.jsonAllValues = Number(rows[0]?.count) > 0;
      }
      attributeShapes.set(key, shape);
    })().finally(() => detectingShapes.delete(key));
    detectingShapes.set(key, pending);
  }
  try {
    await pending;
  } catch {
    // Without the column types the Map form stays: correct for Map tables, as before detection.
  }
  return getSignalSource(uid, signal);
};

/** The name of the trace-id index table the data source's settings point to. */
const traceIndexName = (table: string, config: Partial<CHConfig>): string =>
  `${table}${config.traces?.traceTimestampTableSuffix?.trim() || '_trace_id_ts'}`;

const traceIndexKey = (uid: string, database: string, table: string, config: Partial<CHConfig>) =>
  `${uid}|${database}|${traceIndexName(table, config)}`;

/** The index table of each data source and table, or undefined when the table does not exist. */
const traceIndexes = new Map<string, string | undefined>();

/**
 * The traces source with the trace-id index table, when it exists. Deployments without it (older
 * exporter versions, a hand-made schema) keep the unbounded trace lookup. Looked up once per data
 * source; a failed lookup counts as "no index" without being remembered.
 */
export const loadTraceIndex = async (sceneObject: SceneObject, uid: string): Promise<SignalSource | undefined> => {
  const source = getSignalSource(uid, 'traces');
  const settings = getDataSourceSrv().getInstanceSettings(uid);
  if (!source || !settings) {
    return source;
  }
  const config = jsonData(settings);
  const key = traceIndexKey(uid, source.database, source.table, config);
  if (!traceIndexes.has(key)) {
    const name = traceIndexName(source.table, config);
    try {
      const rows = frameRows<{ result: number }>(
        await runSql(sceneObject, `EXISTS TABLE ${tableSql(source.database, name)}`, Format.Table, {
          datasourceUid: uid,
        })
      );
      traceIndexes.set(key, Number(rows[0]?.result) === 1 ? name : undefined);
    } catch {
      // Without the index the trace lookup is unbounded: slower, but it still finds the trace.
      return source;
    }
  }
  return getSignalSource(uid, 'traces');
};

/** The metrics helpers of a ClickHouse data source version with OTel metrics support. */
interface MetricsDataSourceHelpers {
  getDefaultMetricsDatabase?: () => string | undefined;
  resolveMetricTables?: () => Promise<MetricTables>;
}

interface ResolvedMetrics {
  database: string;
  tables: MetricTables;
  features: MetricTableFeatures;
}

const resolvedMetrics = new Map<string, ResolvedMetrics>();
const resolvingMetrics = new Map<string, Promise<ResolvedMetrics>>();

/**
 * The metrics source with the metric tables that exist, the way the data source's own metrics
 * editor finds them: its getDefaultMetricsDatabase and resolveMetricTables when it has them,
 * otherwise the same lookup here (SHOW TABLES, configured names with the exporter defaults, and
 * the legacy exponential histogram table). Looked up once per data source, like the data source
 * does, since the exporter creates its tables up front.
 */
export const loadMetricsSource = async (sceneObject: SceneObject, uid: string): Promise<SignalSource | undefined> => {
  const configured = getSignalSource(uid, 'metrics');
  if (!configured) {
    return undefined;
  }
  let pending = resolvingMetrics.get(uid);
  if (!pending) {
    pending = (async () => {
      const ds = (await getDataSourceSrv().get(uid)) as unknown as MetricsDataSourceHelpers;
      const database = ds.getDefaultMetricsDatabase?.() || configured.database;
      const tables =
        typeof ds.resolveMetricTables === 'function'
          ? await ds.resolveMetricTables()
          : resolveMetricTables(
              getConfiguredMetricTables(jsonData(getDataSourceSrv().getInstanceSettings(uid)!).metrics),
              frameRows<{ name: string }>(
                await runSql(sceneObject, `SHOW TABLES FROM "${database.replace(/"/g, '""')}"`, Format.Table, {
                  datasourceUid: uid,
                })
              ).map((row) => String(row.name))
            );
      // One DESC per distinct table: the columns of a metric table are what tells a JSON
      // attribute column from a Map one, and the exporter writes the same shape for every kind.
      const features: MetricTableFeatures = {};
      const firstTable = Object.values(tables)[0];
      if (firstTable) {
        try {
          features.jsonAttributes = getMetricTableFeatures(
            frameRows<{ name: string; type: string }>(
              await runSql(sceneObject, `DESC TABLE ${tableSql(database, firstTable)}`, Format.Table, {
                datasourceUid: uid,
              })
            ).map((row) => ({ name: String(row.name), type: String(row.type) }))
          ).jsonAttributes;
        } catch {
          // Without the column types the Map form stays: correct for Map tables, as before detection.
        }
      }
      const result = { database, tables, features };
      resolvedMetrics.set(uid, result);
      return result;
    })();
    // Forget a failed lookup so the next load tries again; the caller still gets the error.
    pending.catch(() => resolvingMetrics.delete(uid));
    resolvingMetrics.set(uid, pending);
  }
  await pending;
  return getSignalSource(uid, 'metrics');
};

/** Whether the source has at least one metric table. */
export const hasMetricTables = (source: SignalSource): boolean => Object.values(source.metricTables).some(Boolean);

/** The table of a metric type: the resolved one, or the configured name before resolution. */
export const metricTableOf = (source: SignalSource, type: MetricType): string =>
  source.metricTables[type] ?? getConfiguredMetricTables()[type];

/**
 * The data sources a signal's picker offers: those set up for the signal (single-source mode, one
 * table per data source), and only if there are none, the data sources that are not set up for one
 * signal and hold every signal. Data sources of another signal are never offered.
 */
export const getDataSourcesForSignal = (signal: SignalType): DataSourceInstanceSettings[] => {
  const all = getClickHouseDataSources(signal);
  const own = all.filter((settings) => jsonData(settings).signalType === signal);
  return own.length ? own : all.filter((settings) => supportsSignal(settings, signal));
};

/**
 * The data source options of every accepted ClickHouse plugin id, as the data source variable
 * shows them. DataSourceVariable takes a single pluginId, so this is what lets a fork's data
 * sources appear next to the catalog ones.
 */
export const getDataSourceOptions = (signal: SignalType): VariableValueOption[] =>
  getDataSourcesForSignal(signal).map((settings) => ({ label: settings.name, value: settings.uid }));
