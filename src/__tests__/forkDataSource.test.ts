import { DataSourceInstanceSettings } from '@grafana/data';

const list = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { ...jest.requireActual('@grafana/runtime').config, publicDashboardAccessToken: undefined },
  getDataSourceSrv: () => ({ getList: (args: { type: string }) => list(args) }),
}));

// Imported after the mock.
import { CLICKHOUSE_DS_TYPES } from '../constants';
import {
  getClickHouseDataSources,
  getDataSourceOptions,
  getDataSourcesForSignal,
  getSignalSource,
} from '../shared/datasource';

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
  });

  it('queries each accepted plugin id instead of only the catalog one', () => {
    expect(getClickHouseDataSources()).toHaveLength(2);
    expect(list).toHaveBeenCalledTimes(CLICKHOUSE_DS_TYPES.length);
    expect(list.mock.calls.map(([args]) => args.type).sort()).toEqual([...CLICKHOUSE_DS_TYPES].sort());
  });

  it('offers the fork data source in the picker', () => {
    expect(getDataSourceOptions('metrics').map((option) => option.value)).toEqual(['metrics']);
    expect(getDataSourceOptions('logs').map((option) => option.value)).toEqual(['logs']);
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

  describe('the picker of a signal', () => {
    const setup = (sources: DataSourceInstanceSettings[]) =>
      list.mockImplementation(({ type }: { type: string }) => sources.filter((settings) => settings.type === type));
    const type = 'grafana-clickhouse-datasource';
    const pickerOf = (signal: 'metrics' | 'logs' | 'traces') => getDataSourcesForSignal(signal).map((s) => s.uid);

    it('offers only the data sources set up for the signal', () => {
      setup([source('m', type, 'metrics'), source('l', type, 'logs'), source('t', type, 'traces')]);
      expect(pickerOf('metrics')).toEqual(['m']);
      expect(pickerOf('logs')).toEqual(['l']);
      expect(pickerOf('traces')).toEqual(['t']);
    });

    it('offers all data sources set up for the signal, and no general one next to them', () => {
      setup([source('m1', type, 'metrics'), source('any', type, ''), source('m2', type, 'metrics')]);
      expect(pickerOf('metrics').sort()).toEqual(['m1', 'm2']);
    });

    it('offers the general data sources when none is set up for the signal, but never another signal', () => {
      setup([source('any', type, ''), source('l', type, 'logs')]);
      expect(pickerOf('metrics')).toEqual(['any']);
      expect(pickerOf('logs')).toEqual(['l']);
    });
  });
});
