import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${PLUGIN_ID}`;
/**
 * The ClickHouse plugin ids the app accepts. The catalog plugin is the default; a fork that
 * changes `src/plugin.json`'s `id` (to install alongside the catalog one) is a different plugin
 * id in Grafana, so it has to be listed here or its data sources never appear in the app.
 */
export const CLICKHOUSE_DS_TYPES = ['grafana-clickhouse-datasource', 'onecyrus-clickhouse-datasource'];

/** The catalog plugin id: a fallback for queries whose data source type cannot be resolved. */
export const CLICKHOUSE_DS_TYPE = CLICKHOUSE_DS_TYPES[0];

export enum ROUTES {
  Metrics = 'metrics',
  Logs = 'logs',
  Traces = 'traces',
}

export const prefixRoute = (route: string): string => `${PLUGIN_BASE_URL}/${route}`;

/** Name of the data source variable in every app. */
export const VAR_DATASOURCE = 'ds';
/** Name of the label filter variable in every app. */
export const VAR_FILTERS = 'filters';
