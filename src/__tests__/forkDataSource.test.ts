import { DataSourceInstanceSettings } from '@grafana/data';

const list = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { ...jest.requireActual('@grafana/runtime').config, publicDashboardAccessToken: undefined },
  getDataSourceSrv: () => ({ getList: (args: { type: string }) => list(args) }),
}));

// Imported after the mock.
import { CLICKHOUSE_DS_TYPES } from '../constants';
import { getClickHouseDataSources, getDataSourceOptions, getSignalSource } from '../shared/datasource';

const source = (uid: string, type: string, signalType: string) =>
  ({ uid, name: uid, type, jsonData: { signalType } }) as unknown as DataSourceInstanceSettings;

/**
 * A fork installs under its own plugin id, so its data sources are invisible to a lookup that asks
 * for the catalog id alone. The app must list and accept every accepted ClickHouse plugin id.
 */
describe('fork data sources', () => {
  beforeEach(() => {
    list.mockReset();
    const catalog = source('logs', 'grafana-clickhouse-datasource', 'logs');
    const fork = source('metrics', 'onecyrus-clickhouse-datasource', 'metrics');
    // Like Grafana, getList also returns the built-in Grafana data source for every call.
    const grafana = source('grafana', 'grafana', '');
    list.mockImplementation(({ type }: { type: string }) => [
      ...(type === fork.type ? [fork] : type === catalog.type ? [catalog] : []),
      grafana,
    ]);
  });

  it('lists only ClickHouse data sources, each once', () => {
    expect(getClickHouseDataSources().map((settings) => settings.uid)).toEqual(['logs', 'metrics']);
    expect(getDataSourceOptions().map((option) => option.value)).toEqual(['logs', 'metrics']);
  });

  it('queries each accepted plugin id instead of only the catalog one', () => {
    expect(getClickHouseDataSources()).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(CLICKHOUSE_DS_TYPES.length);
    expect(list.mock.calls.map(([args]) => args.type).sort()).toEqual([...CLICKHOUSE_DS_TYPES].sort());
  });

  it('offers the fork data source in the picker', () => {
    const values = getDataSourceOptions().map((option) => option.value);
    expect(values).toEqual(expect.arrayContaining(['logs', 'metrics']));
  });

  it('ranks a data source set up for the signal first', () => {
    expect(getClickHouseDataSources('metrics')[0].uid).toBe('metrics');
    expect(getClickHouseDataSources('logs')[0].uid).toBe('logs');
  });

  it('resolves a source under the fork plugin id', () => {
    const runtime = jest.requireMock('@grafana/runtime');
    runtime.getDataSourceSrv = () => ({
      getList: (args: { type: string }) => list(args),
      getInstanceSettings: (uid: string) =>
        (({ metrics: source('metrics', 'onecyrus-clickhouse-datasource', 'metrics') }) as Record<string, unknown>)[uid],
    });
    const resolved = getSignalSource('metrics', 'metrics');
    expect(resolved?.type).toBe('onecyrus-clickhouse-datasource');
    expect(resolved?.metricTables).toBeDefined();
  });
});
