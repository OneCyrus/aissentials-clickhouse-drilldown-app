import { SignalSource } from '../shared/datasource';
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
 * The exporter partitions and sorts `otel_logs` on `TimestampTime` (DateTime) and keeps the precise
 * `Timestamp` (DateTime64) as an ordinary column, so a range filter on `Timestamp` cannot prune
 * partitions. On this cluster a 24 h query read 4,398,897 rows / 35 MB in 52 ms with `Timestamp`
 * against 105,407 rows / 412 kB in 11 ms with `TimestampTime`.
 */
describe('logs time filter', () => {
  it('filters on the partition column the data source is configured with', () => {
    expect(logsTimeFilter(source('TimestampTime'))).toBe('$__timeFilter(TimestampTime)');
    expect(logLinesSql(source('TimestampTime'), '1 = 1')).toContain('$__timeFilter(TimestampTime)');
    expect(countSql(source('TimestampTime'), '1 = 1')).toContain('$__timeFilter(TimestampTime)');
  });

  it('falls back to Timestamp for tables without the companion column', () => {
    expect(logsTimeFilter(source())).toBe('$__timeFilter(Timestamp)');
    expect(logLinesSql(source(), '1 = 1')).toContain('$__timeFilter(Timestamp)');
  });

  it('orders on the precise column, so rows keep their order within a second', () => {
    expect(logLinesSql(source('TimestampTime'), '1 = 1')).toContain('ORDER BY Timestamp ');
  });

  it('applies the filter column to every logs query, not only the line query', () => {
    const filtered = [countSql(source('TimestampTime'), '1 = 1'), logLinesSql(source('TimestampTime'), '1 = 1')];
    for (const sql of filtered) {
      expect(sql).not.toContain('$__timeFilter(Timestamp)');
    }
  });
});
