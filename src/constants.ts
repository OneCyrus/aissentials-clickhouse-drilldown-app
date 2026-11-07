import pluginJson from './plugin.json';

export const PLUGIN_ID = pluginJson.id;
export const PLUGIN_BASE_URL = `/a/${PLUGIN_ID}`;
export const CLICKHOUSE_DS_TYPE = 'grafana-clickhouse-datasource';

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
