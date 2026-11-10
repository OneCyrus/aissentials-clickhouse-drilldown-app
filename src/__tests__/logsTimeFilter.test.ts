const instanceSettings: Record<string, object> = {};

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { ...jest.requireActual('@grafana/runtime').config, publicDashboardAccessToken: undefined },
  getDataSourceSrv: () => ({ getInstanceSettings: (uid: string) => instanceSettings[uid] }),
}));

// Imported after the mock.
import { getSignalSource, SignalSource } from '../shared/datasource';
import { countSql, logLinesSql, logsTimeFilter } from '../logs-drilldown/sql';

const source = (filterTimeColumn?: string): SignalSource => ({
  uid: 'clickhouse-logs',
  type: 'grafana-clickhouse-datasource',
  name: 'ClickHouse Logs',
  database: 'default',
  table: 'otel_logs',
  filterTimeColumn,
  metricTables: {} as never,
});

/**
 * Newer exporter versions partition and sort `otel_logs` on `TimestampTime` (DateTime) and keep the
 * precise `Timestamp` (DateTime64) as an ordinary column, so a range filter on `Timestamp` alone
 * cannot prune partitions. On a production cluster a 24 h query read 4,398,897 rows / 35 MB in
 * 52 ms with `Timestamp` against 105,407 rows / 412 kB in 11 ms with `TimestampTime`.
 */
describe('logs time filter', () => {
  it('filters on the configured partition column and keeps the exact range on Timestamp', () => {
    expect(logsTimeFilter(source('TimestampTime'))).toBe('$__timeFilter("TimestampTime") AND $__timeFilter(Timestamp)');
    expect(logLinesSql(source('TimestampTime'), '1 = 1')).toContain('$__timeFilter("TimestampTime")');
    expect(countSql(source('TimestampTime'), '1 = 1')).toContain('$__timeFilter("TimestampTime")');
  });

  it('quotes the configured column as an identifier, so a setting cannot inject SQL', () => {
    expect(logsTimeFilter(source('x) OR 1 = 1 OR ("y'))).toBe(
      '$__timeFilter("x) OR 1 = 1 OR (""y") AND $__timeFilter(Timestamp)'
    );
  });

  it('filters on Timestamp only without a configured column, or when it is Timestamp itself', () => {
    expect(logsTimeFilter(source())).toBe('$__timeFilter(Timestamp)');
    expect(logsTimeFilter(source('Timestamp'))).toBe('$__timeFilter(Timestamp)');
    expect(logLinesSql(source(), '1 = 1')).not.toContain('TimestampTime');
  });

  it('orders on the precise column, so rows keep their order within a second', () => {
    expect(logLinesSql(source('TimestampTime'), '1 = 1')).toContain('ORDER BY Timestamp ');
  });

  it('reads the column from the data source settings', () => {
    instanceSettings['with-column'] = {
      uid: 'with-column',
      name: 'with-column',
      type: 'grafana-clickhouse-datasource',
      jsonData: { logs: { defaultTable: 'otel_logs', filterTimeColumn: ' TimestampTime ' } },
    };
    instanceSettings['without-column'] = {
      uid: 'without-column',
      name: 'without-column',
      type: 'grafana-clickhouse-datasource',
      jsonData: { logs: { defaultTable: 'otel_logs' } },
    };
    expect(getSignalSource('with-column', 'logs')?.filterTimeColumn).toBe('TimestampTime');
    expect(getSignalSource('with-column', 'traces')?.filterTimeColumn).toBeUndefined();
    expect(getSignalSource('without-column', 'logs')?.filterTimeColumn).toBeUndefined();
  });
});
