import { SignalSource } from '../shared/datasource';
import { traceSql } from '../traces-drilldown/sql';

const source = (traceIndexTable?: string): SignalSource => ({
  uid: 'clickhouse-traces',
  name: 'ClickHouse Traces',
  database: 'default',
  table: 'otel_traces',
  traceIndexTable,
  metricTables: {} as never,
});

const id = 'dbf9f31bcf2fad87fe6f03d5c31773e4';

/**
 * The exporter writes a companion index table mapping each TraceId to its Start and End. The data
 * source's own trace query reads it first to bound the scan; the app's did not, so ClickHouse read
 * every part — measured 4,869 rows for a 56-span trace against 3 rows when bounded by the index.
 */
describe('trace lookup', () => {
  it('bounds the spans scan with the trace-id index table', () => {
    const sql = traceSql(source('otel_traces_trace_id_ts'), id);
    expect(sql).toContain('FROM "default"."otel_traces_trace_id_ts"');
    expect(sql).toContain(`TraceId = '${id}'`);
    expect(sql).toContain('Timestamp >= (SELECT min(Start)');
    expect(sql).toContain('Timestamp <= (SELECT max(End) + 1');
  });

  it('uses the indexed bounds, not the dashboard range, so old traces still open', () => {
    const sql = traceSql(source('otel_traces_trace_id_ts'), id);
    expect(sql).not.toContain('$__timeFilter');
  });

  it('still returns the trace when the deployment has no index table', () => {
    const sql = traceSql(source(), id);
    expect(sql).toContain('FROM "default"."otel_traces" WHERE TraceId =');
    expect(sql).not.toContain('min(Start)');
  });
});
