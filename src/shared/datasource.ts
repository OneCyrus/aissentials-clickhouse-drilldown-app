import { DataSourceInstanceSettings } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { SceneObject } from '@grafana/scenes';
import { getConfiguredMetricTables, MetricTables, resolveMetricTables } from 'clickhouse/metrics';
import { CHConfig, MetricType, SignalType } from 'clickhouse/types';
import { CLICKHOUSE_DS_TYPE } from '../constants';
import { Format, frameRows, runSql } from './query';

/**
 * Where a signal lives: the ClickHouse data source and the tables of the OpenTelemetry Collector
 * ClickHouse exporter. The apps work on the exporter schema, so only database and table names
 * come from the data source settings.
 */
export interface SignalSource {
  uid: string;
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

/** ClickHouse data sources, those set up for the signal (single-source mode) first. */
export const getClickHouseDataSources = (signal?: SignalType): DataSourceInstanceSettings[] => {
  const all = getDataSourceSrv().getList({ type: CLICKHOUSE_DS_TYPE });
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
  getClickHouseDataSources(signal).find((settings) => supportsSignal(settings, signal))?.uid;

export const getSignalSource = (uid: string, signal: SignalType): SignalSource | undefined => {
  const settings = getDataSourceSrv().getInstanceSettings(uid);
  if (!settings || settings.type !== CLICKHOUSE_DS_TYPE) {
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
  return {
    uid: settings.uid,
    name: settings.name,
    database,
    table,
    metricTables: resolved?.tables ?? getConfiguredMetricTables(config.metrics),
  };
};

/** The metrics helpers of a ClickHouse data source version with OTel metrics support. */
interface MetricsDataSourceHelpers {
  getDefaultMetricsDatabase?: () => string | undefined;
  resolveMetricTables?: () => Promise<MetricTables>;
}

interface ResolvedMetrics {
  database: string;
  tables: MetricTables;
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
                await runSql(sceneObject, `SHOW TABLES FROM "${database.replace(/"/g, '""')}"`, Format.Table, uid)
              ).map((row) => String(row.name))
            );
      const result = { database, tables };
      resolvedMetrics.set(uid, result);
      return result;
    })();
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
