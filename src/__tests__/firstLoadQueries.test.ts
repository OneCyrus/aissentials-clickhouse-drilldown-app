/**
 * The number and shape of the queries each page sends on its first load, on the real scene classes
 * with runSql stubbed (the table shape detection is stubbed as loaded). These guard the regressions
 * found so far: a query per tile instead of one per page (logs landing), label names loaded with every
 * catalog load (metrics list), a second chart query (patterns), and panels querying before they are
 * in view (see lazyPanelLoad.test.ts for the panels themselves).
 */
const runSql = jest.fn();

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mock.
import { SceneDataTransformer, SceneQueryRunner, SceneTimeRange, VizPanel } from '@grafana/scenes';
import { LogsExploration } from '../logs-drilldown/LogsExploration';
import { MetricsExploration } from '../metrics-drilldown/MetricsExploration';
import { SignalSource } from '../shared/datasource';
import { TracesExploration } from '../traces-drilldown/TracesExploration';

const source = (table: string): SignalSource =>
  ({
    uid: 'ds',
    type: 'grafana-clickhouse-datasource',
    name: 'ds',
    database: 'otel',
    table,
    attributeShapeKnown: true,
    jsonAttributes: false,
    metricTables: { gauge: 'otel_metrics_gauge', sum: 'otel_metrics_sum' },
  }) as unknown as SignalSource;

const frame = (columns: Record<string, unknown[]>) => [
  {
    fields: Object.entries(columns).map(([name, values]) => ({ name, values })),
    length: Object.values(columns)[0]?.length ?? 0,
  },
];

/** Lets started loads reach and finish their queries. */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const sqlOf = (call: unknown[]) => String(call[1]);
const range = () => new SceneTimeRange({ from: 'now-1h', to: 'now' });

/** The SQL of a panel's query runner, through any transformers. */
const panelSql = (panel: VizPanel | undefined): string => {
  let data = panel?.state.$data;
  while (data instanceof SceneDataTransformer) {
    data = data.state.$data;
  }
  return data instanceof SceneQueryRunner ? String((data.state.queries[0] as { rawSql?: string }).rawSql) : '';
};

beforeEach(() => runSql.mockReset());

describe('metrics list, first load', () => {
  it('sends one catalog query; label names wait for their sidebar section', async () => {
    const scene = new MetricsExploration({ $timeRange: range() });
    scene.loadSource = jest.fn().mockResolvedValue(source(''));
    scene.getSource = () => source('');
    runSql.mockResolvedValue(frame({ name: ['up', 'requests'], type: ['gauge', 'sum'], unit: ['', ''] }));
    await scene.load();
    await settle();
    expect(runSql).toHaveBeenCalledTimes(1);
    const sql = sqlOf(runSql.mock.calls[0]);
    expect(sql).toContain('"otel"."otel_metrics_gauge"');
    expect(sql).toContain('"otel"."otel_metrics_sum"');
    expect(sql).not.toContain('groupUniqArrayArray');
    // The grid has a tile per metric; tiles query only once in view (lazyPanelLoad.test.ts).
    expect(scene.state.grid?.state.children).toHaveLength(2);
  });
});

describe('logs, first load', () => {
  it('landing: one value list, then one volume and one lines query for all tiles', async () => {
    const logs = new LogsExploration({ $timeRange: range() });
    logs.loadSource = jest.fn().mockResolvedValue(source('otel_logs'));
    logs.getSource = () => source('otel_logs');
    runSql.mockImplementation((_scene: unknown, sql: string) =>
      Promise.resolve(
        sql.includes('AS value, count() AS count')
          ? frame({ value: ['cart', 'payments', 'checkout'], count: [3, 2, 1] })
          : frame({ time: [] })
      )
    );
    await logs.refresh();
    await settle();
    const queries = runSql.mock.calls.map(sqlOf);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toMatch(/^SELECT toString\(ServiceName\) AS value, count\(\) AS count/);
    expect(queries.filter((sql) => sql.includes('__tile'))).toHaveLength(2);
    expect(queries.some((sql) => sql.includes('LIMIT 100 BY "__tile"'))).toBe(true);
    expect(
      queries.every((sql) => sql.includes("ServiceName IN ('cart', 'payments', 'checkout')") || sql === queries[0])
    ).toBe(true);
  });

  it('service page: the count and the detected labels and fields; the panels run their own queries', async () => {
    const logs = new LogsExploration({ $timeRange: range(), view: 'logs' });
    logs.loadSource = jest.fn().mockResolvedValue(source('otel_logs'));
    logs.getSource = () => source('otel_logs');
    runSql.mockResolvedValue(frame({ key: [], cardinality: [] }));
    await logs.refresh();
    await settle();
    const queries = runSql.mock.calls.map(sqlOf);
    expect(queries).toHaveLength(3);
    expect(queries.filter((sql) => sql.startsWith('SELECT count() AS count'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("concat('resource.'"))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes("concat('log.'"))).toHaveLength(1);
  });
});

describe('traces, first load', () => {
  it('sends the attribute list and the duration buckets; the panels and the breakdown run their own', async () => {
    const traces = new TracesExploration({ $timeRange: range() });
    traces.loadSource = jest.fn().mockResolvedValue(source('otel_traces'));
    traces.getSource = () => source('otel_traces');
    runSql.mockResolvedValue(frame({ key: ['resource.service.name'] }));
    await traces.refresh(true);
    await settle();
    const queries = runSql.mock.calls.map(sqlOf);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^SELECT DISTINCT key FROM \(SELECT arrayJoin\(/);
    expect(queries[1]).toMatch(/^SELECT pow\(2, ceil\(log2/);
    // The RED panels: span rate, error rate and the duration heatmap, one query each.
    expect(panelSql(traces.state.ratePanel)).toContain('AS "span/s"');
    expect(panelSql(traces.state.errorsPanel)).toContain('AS "error/s"');
    expect(panelSql(traces.state.durationPanel)).toContain('AS le, count() AS count');
    expect(traces.state.bodyLoad).toEqual({ status: 'done' });
  });
});
