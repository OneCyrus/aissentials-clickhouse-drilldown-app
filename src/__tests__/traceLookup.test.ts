import { SceneObject } from '@grafana/scenes';

const instanceSettings: Record<string, object> = {};
const runSql = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  config: { ...jest.requireActual('@grafana/runtime').config, publicDashboardAccessToken: undefined },
  getDataSourceSrv: () => ({ getInstanceSettings: (uid: string) => instanceSettings[uid] }),
}));

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mocks.
import { getSignalSource, loadTraceIndex, SignalSource } from '../shared/datasource';
import { traceSql } from '../traces-drilldown/sql';

const source = (traceIndexTable?: string): SignalSource => ({
  uid: 'clickhouse-traces',
  type: 'grafana-clickhouse-datasource',
  name: 'ClickHouse Traces',
  database: 'default',
  table: 'otel_traces',
  traceIndexTable,
  metricTables: {} as never,
});

const id = 'dbf9f31bcf2fad87fe6f03d5c31773e4';
const scene = {} as SceneObject;
const exists = (value: number) => [{ fields: [{ name: 'result', values: [value] }], length: 1 }];

const addDataSource = (uid: string, traces: object) => {
  instanceSettings[uid] = { uid, name: uid, type: 'grafana-clickhouse-datasource', jsonData: { traces } };
};

/**
 * The exporter writes a companion index table mapping each TraceId to its Start and End. The data
 * source's own trace query reads it first to bound the scan; the app's did not, so ClickHouse read
 * every part: measured 4,869 rows for a 56-span trace against 3 rows when bounded by the index.
 */
describe('trace lookup', () => {
  beforeEach(() => runSql.mockReset());

  it('bounds the spans scan with the trace-id index table', () => {
    const sql = traceSql(source('otel_traces_trace_id_ts'), id);
    expect(sql).toContain('FROM "default"."otel_traces_trace_id_ts"');
    expect(sql).toContain(`TraceId = '${id}'`);
    expect(sql).toContain('Timestamp >= ifNull((SELECT min(Start)');
    expect(sql).toContain('Timestamp <= ifNull((SELECT max(End) + 1');
  });

  it('falls back to no bound when the trace is missing from the index', () => {
    const sql = traceSql(source('otel_traces_trace_id_ts'), id);
    expect(sql).toContain('HAVING count() > 0), toDateTime(0))');
  });

  it('uses the indexed bounds, not the dashboard range, so old traces still open', () => {
    expect(traceSql(source('otel_traces_trace_id_ts'), id)).not.toContain('$__timeFilter');
  });

  it('has no index table before it is looked up', () => {
    addDataSource('unchecked', { defaultDatabase: 'otel', defaultTable: 'otel_traces' });
    expect(getSignalSource('unchecked', 'traces')?.traceIndexTable).toBeUndefined();
  });

  it('uses the index table only when it exists', async () => {
    addDataSource('with-index', { defaultDatabase: 'otel', defaultTable: 'otel_traces' });
    runSql.mockResolvedValueOnce(exists(1));
    const found = await loadTraceIndex(scene, 'with-index');
    expect(runSql.mock.calls[0][1]).toBe('EXISTS TABLE "otel"."otel_traces_trace_id_ts"');
    expect(found?.traceIndexTable).toBe('otel_traces_trace_id_ts');
    expect(traceSql(found!, id)).toContain('otel_traces_trace_id_ts');

    addDataSource('without-index', { defaultDatabase: 'otel', defaultTable: 'otel_traces' });
    runSql.mockResolvedValueOnce(exists(0));
    const missing = await loadTraceIndex(scene, 'without-index');
    expect(missing?.traceIndexTable).toBeUndefined();
    expect(traceSql(missing!, id)).not.toContain('min(Start)');
  });

  it('honours the configured suffix and checks once per data source', async () => {
    addDataSource('suffix', { defaultDatabase: 'otel', defaultTable: 'spans', traceTimestampTableSuffix: '_idx' });
    runSql.mockResolvedValue(exists(1));
    await loadTraceIndex(scene, 'suffix');
    const again = await loadTraceIndex(scene, 'suffix');
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(again?.traceIndexTable).toBe('spans_idx');
  });

  it('treats a failed check as no index and tries again next time', async () => {
    addDataSource('flaky', { defaultDatabase: 'otel', defaultTable: 'otel_traces' });
    runSql.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(exists(1));
    expect((await loadTraceIndex(scene, 'flaky'))?.traceIndexTable).toBeUndefined();
    expect((await loadTraceIndex(scene, 'flaky'))?.traceIndexTable).toBe('otel_traces_trace_id_ts');
  });
});
