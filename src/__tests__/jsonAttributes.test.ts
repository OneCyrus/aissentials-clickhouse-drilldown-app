import { SceneObject } from '@grafana/scenes';
import { MetricType } from 'clickhouse/types';

const settings: Record<string, { uid: string; name: string; type: string; jsonData: object }> = {};
const instances: Record<string, object> = {};
const runSql = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { ...jest.requireActual('@grafana/runtime').config, publicDashboardAccessToken: undefined },
  getDataSourceSrv: () => ({
    getInstanceSettings: (uid: string) => settings[uid],
    get: async (uid: string) => instances[uid],
    getList: () => Object.values(settings),
  }),
}));

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mocks.
import { labelKeysSql, metricSql } from '../metrics-drilldown/sql';
import { loadMetricsSource } from '../shared/datasource';

const addDataSource = (uid: string, jsonData: object, instance: object = {}) => {
  settings[uid] = { uid, name: uid, type: 'grafana-clickhouse-datasource', jsonData };
  instances[uid] = instance;
};

const tableFrame = (names: string[]) => [{ fields: [{ name: 'name', values: names }], length: names.length }];
const descFrame = (rows: Array<{ name: string; type: string }>) => [
  {
    fields: [
      { name: 'name', values: rows.map((r) => r.name) },
      { name: 'type', values: rows.map((r) => r.type) },
    ],
    length: rows.length,
  },
];

const scene = {} as SceneObject;
const metric = { name: 'container.cpu.usage', type: MetricType.Gauge };

/**
 * The exporter writes attribute columns as JSON with `json: true`, and a JSON column rejects the
 * Map syntax (`mapKeys requires ... of type Map`). The app had the detection helper and the query
 * support, but never filled `jsonAttributes`, so JSON deployments queried the wrong shape.
 */
describe('JSON attribute columns', () => {
  beforeEach(() => runSql.mockReset());

  it('detects the column type from the metric table', async () => {
    addDataSource('json', { metrics: {} });
    runSql
      .mockResolvedValueOnce(tableFrame(['otel_metrics_gauge']))
      .mockResolvedValueOnce(descFrame([{ name: 'Attributes', type: 'JSON' }]));
    const source = await loadMetricsSource(scene, 'json');
    expect(source?.metricFeatures?.jsonAttributes).toBe(true);
  });

  it('reports Map columns as not JSON', async () => {
    addDataSource('map', { metrics: {} });
    runSql
      .mockResolvedValueOnce(tableFrame(['otel_metrics_gauge']))
      .mockResolvedValueOnce(descFrame([{ name: 'Attributes', type: 'Map(LowCardinality(String), String)' }]));
    const source = await loadMetricsSource(scene, 'map');
    expect(source?.metricFeatures?.jsonAttributes).toBe(false);
  });

  it('reads JSON attribute keys with JSONAllPaths', async () => {
    const source = {
      uid: 'json',
      type: 'grafana-clickhouse-datasource',
      name: 'json',
      database: 'default',
      table: '',
      metricTables: { [MetricType.Gauge]: 'otel_metrics_gauge' } as never,
      metricFeatures: { jsonAttributes: true },
    };
    const sql = labelKeysSql(source, '1 = 1', { ...metric, unit: '', description: '', isMonotonic: false });
    expect(sql).toContain('JSONAllPaths(ResourceAttributes)');
    expect(sql).not.toContain('mapKeys(');
  });

  it('keeps mapKeys for Map columns', async () => {
    const source = {
      uid: 'map',
      type: 'grafana-clickhouse-datasource',
      name: 'map',
      database: 'default',
      table: '',
      metricTables: { [MetricType.Gauge]: 'otel_metrics_gauge' } as never,
      metricFeatures: { jsonAttributes: false },
    };
    const sql = labelKeysSql(source, '1 = 1');
    expect(sql).toContain('mapKeys(ResourceAttributes)');
    expect(sql).not.toContain('JSONAllPaths');
  });

  it('passes the detected shape into metric queries', async () => {
    const jsonSource = {
      uid: 'json',
      type: 'grafana-clickhouse-datasource',
      name: 'json',
      database: 'default',
      table: '',
      metricTables: { [MetricType.Gauge]: 'otel_metrics_gauge' } as never,
      metricFeatures: { jsonAttributes: true },
    };
    const sql = metricSql(jsonSource, {
      ...metric,
      fn: 'last' as never,
      aggregation: 'avg' as never,
      groupBy: [{ source: 'resource', key: 'k8s.pod.name' }],
    });
    // The JSON path form, not Map bracket access.
    expect(sql).toContain('`k8s`');
  });
});
