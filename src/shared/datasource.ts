import { DataSourceInstanceSettings } from '@grafana/data';
import { getDataSourceSrv } from '@grafana/runtime';
import { getConfiguredMetricTables } from 'clickhouse/metrics';
import { CHConfig, MetricType, SignalType } from 'clickhouse/types';
import { CLICKHOUSE_DS_TYPE } from '../constants';

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
  /** The metric tables, by data point type. */
  metricTables: Record<MetricType, string>;
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
  const database = section?.defaultDatabase || config.defaultDatabase || exporterDatabase;
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
    metricTables: getConfiguredMetricTables(config.metrics),
  };
};
