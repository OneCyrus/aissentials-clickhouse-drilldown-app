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
import { loadMetricsSource, metricTableOf } from '../shared/datasource';

const addDataSource = (uid: string, jsonData: object, instance: object = {}) => {
  settings[uid] = { uid, name: uid, type: 'grafana-clickhouse-datasource', jsonData };
  instances[uid] = instance;
};

const tableFrame = (names: string[]) => [{ fields: [{ name: 'name', values: names }], length: names.length }];

const scene = {} as SceneObject;

describe('loadMetricsSource', () => {
  beforeEach(() => runSql.mockReset());

  it('uses the data source helpers when the data source has them', async () => {
    addDataSource(
      'with-helpers',
      { metrics: { defaultDatabase: 'ignored' } },
      {
        getDefaultMetricsDatabase: () => 'metrics_db',
        resolveMetricTables: async () => ({ [MetricType.Gauge]: 'g', [MetricType.Sum]: 's' }),
      }
    );
    const source = await loadMetricsSource(scene, 'with-helpers');
    // One DESC to learn the attribute column type; the tables themselves come from the helper.
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(String(runSql.mock.calls[0][1])).toMatch(/^DESC TABLE/);
    expect(source?.database).toBe('metrics_db');
    expect(source?.metricTables).toEqual({ [MetricType.Gauge]: 'g', [MetricType.Sum]: 's' });
  });

  it('looks the tables up itself otherwise: configured names, only existing tables, legacy names', async () => {
    addDataSource('without-helpers', { metrics: { defaultDatabase: 'otel2', gaugeTable: 'my_gauge' } });
    runSql.mockResolvedValue(tableFrame(['my_gauge', 'otel_metrics_sum', 'otel_metrics_exponential_histogram']));
    const source = await loadMetricsSource(scene, 'without-helpers');
    expect(runSql.mock.calls[0][1]).toBe('SHOW TABLES FROM "otel2"');
    expect(source?.database).toBe('otel2');
    expect(source?.metricTables).toEqual({
      [MetricType.Gauge]: 'my_gauge',
      [MetricType.Sum]: 'otel_metrics_sum',
      [MetricType.ExponentialHistogram]: 'otel_metrics_exponential_histogram',
    });
    // Looked up once per data source: SHOW TABLES plus one DESC for the column shape, and the
    // second call is served from the cache.
    const calls = runSql.mock.calls.length;
    expect(calls).toBe(2);
    expect(runSql.mock.calls.map((call) => String(call[1]).split(' ')[0])).toEqual(['SHOW', 'DESC']);
    await loadMetricsSource(scene, 'without-helpers');
    expect(runSql).toHaveBeenCalledTimes(calls);
  });

  it('retries after a failed lookup', async () => {
    addDataSource('flaky', {});
    runSql.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(tableFrame(['otel_metrics_gauge']));
    await expect(loadMetricsSource(scene, 'flaky')).rejects.toThrow('down');
    const source = await loadMetricsSource(scene, 'flaky');
    expect(source?.database).toBe('otel');
    expect(source?.metricTables).toEqual({ [MetricType.Gauge]: 'otel_metrics_gauge' });
  });

  it('falls back to the configured name for a type without a resolved table', async () => {
    addDataSource('partial', {});
    runSql.mockResolvedValue(tableFrame(['otel_metrics_gauge']));
    const source = (await loadMetricsSource(scene, 'partial'))!;
    expect(metricTableOf(source, MetricType.Gauge)).toBe('otel_metrics_gauge');
    expect(metricTableOf(source, MetricType.Summary)).toBe('otel_metrics_summary');
  });
});
