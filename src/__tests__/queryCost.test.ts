/**
 * Guards for the query cost changes: the Patterns chart reuses the list query, the traces
 * comparison scans the span set once, the metrics list loads label names only for the open
 * "Group by labels" section, and superseded loads cancel their request through Grafana's
 * requestId without showing the cancellation as an error.
 */
import { dateTime, FieldType } from '@grafana/data';
import { EMPTY, of, throwError } from 'rxjs';

const runSql = jest.fn();
const fetch = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getBackendSrv: () => ({ fetch: (...args: unknown[]) => fetch(...args) }),
}));

jest.mock('../shared/query', () => {
  const actual = jest.requireActual('../shared/query');
  return { ...actual, runSql: (...args: unknown[]) => runSql(...args), realRunSql: actual.runSql };
});

// Imported after the mocks.
import { SceneTimeRange } from '@grafana/scenes';
import { PatternsScene } from '../logs-drilldown/PatternsScene';
import { patternsBucketSeconds, patternsVolumeFrame } from '../logs-drilldown/patterns';
import { MetricsExploration } from '../metrics-drilldown/MetricsExploration';
import { SignalSource } from '../shared/datasource';
import { LatestRequest } from '../shared/load';
import * as query from '../shared/query';
import { comparisonSql, selectionSql } from '../traces-drilldown/sql';
import { TracesExploration } from '../traces-drilldown/TracesExploration';

const realRunSql = (query as unknown as { realRunSql: typeof query.runSql }).realRunSql;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const logsSource = {
  uid: 'logs',
  type: 'grafana-clickhouse-datasource',
  name: 'logs',
  database: 'otel',
  table: 'otel_logs',
  metricTables: {},
} as unknown as SignalSource;

describe('patterns chart from the list', () => {
  it('sums the levels per bucket, keeps the 20 most frequent and orders them by pattern', () => {
    const rows = [
      {
        pattern: 'b <_>',
        series: [
          [10, 2],
          [10, 3],
          [20, 1],
        ] as Array<[number, number]>,
      },
      { pattern: 'a <_>', series: [[20, 4]] as Array<[number, number]> },
      ...Array.from({ length: 30 }, (_, i) => ({ pattern: `z${i}`, series: [] as Array<[number, number]> })),
    ];
    const frame = patternsVolumeFrame(rows);
    expect(frame.fields).toHaveLength(21);
    expect(frame.fields[0]).toMatchObject({ name: 'time', type: FieldType.time, values: [10000, 20000] });
    expect(frame.fields[1]).toMatchObject({ labels: { pattern: 'a <_>' }, values: [null, 4] });
    expect(frame.fields[2]).toMatchObject({ labels: { pattern: 'b <_>' }, values: [5, 1] });
    expect(frame.length).toBe(2);
  });

  it('buckets at the interval of a 120-point panel', () => {
    const range = { from: dateTime(0), to: dateTime(20 * 60 * 1000), raw: { from: '', to: '' } };
    expect(patternsBucketSeconds(range)).toBe(10);
  });

  it('loads the tab with one query and fills the chart from it', async () => {
    runSql.mockReset();
    runSql.mockResolvedValueOnce([
      {
        fields: [
          { name: 'pattern', values: ['GET <_>'] },
          { name: 'total', values: [3] },
          { name: 'levels', values: [['info']] },
          { name: 'series', values: [[[60, 3]]] },
        ],
        length: 1,
      },
    ]);
    const patterns = new PatternsScene({});
    patterns.getExploration = () => ({ getSource: () => logsSource, setState: jest.fn() }) as never;
    await patterns.load();
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(String(runSql.mock.calls[0][1])).toMatch(/^SELECT pattern, sum\(count\) AS total/);
    // The chart's data node got the list's counts.
    const node = patterns.state.volume?.state.$data?.state.$data;
    expect(node?.state.data?.series[0].fields[1].values).toEqual([3]);
  });
});

describe('traces comparison', () => {
  it('scans the span set once', () => {
    const source = { ...logsSource, table: 'otel_traces' } as SignalSource;
    const sql = comparisonSql(source, selectionSql('errors'));
    expect(sql.split('FROM "otel"."otel_traces"')).toHaveLength(2);
    expect(sql).not.toContain('CROSS JOIN');
    expect(sql).toContain("sumIf(selection, key = '') OVER () AS selection_total");
  });
});

describe('metrics list label names', () => {
  const metricsSource = {
    uid: 'metrics',
    type: 'grafana-clickhouse-datasource',
    name: 'metrics',
    database: 'otel',
    table: '',
    metricTables: { gauge: 'otel_metrics_gauge' },
  } as unknown as SignalSource;

  const exploration = () => {
    const scene = new MetricsExploration({ $timeRange: new SceneTimeRange({ from: 'now-1h', to: 'now' }) });
    scene.loadSource = jest.fn().mockResolvedValue(metricsSource);
    scene.getSource = () => metricsSource;
    scene.refresh = jest.fn();
    return scene;
  };
  const catalogRows = [{ fields: [{ name: 'name', values: ['up'] }], length: 1 }];
  const labelRows = [
    {
      fields: [
        { name: 'source', values: ['resource'] },
        { name: 'key', values: ['service.name'] },
      ],
      length: 1,
    },
  ];

  beforeEach(() => runSql.mockReset());

  it('loads the catalog only while the "Group by labels" section is closed', async () => {
    const scene = exploration();
    runSql.mockResolvedValue(catalogRows);
    await scene.load();
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(String(runSql.mock.calls[0][1])).not.toContain("('resource', k)");
  });

  it('loads the label names when the section opens, and not again for the same filters and range', async () => {
    const scene = exploration();
    runSql.mockResolvedValueOnce(catalogRows);
    await scene.load();
    runSql.mockResolvedValueOnce(labelRows);
    scene.setSidebar('labels');
    await flush();
    expect(runSql).toHaveBeenCalledTimes(2);
    expect(String(runSql.mock.calls[1][1])).toContain("('resource', k)");
    expect(scene.state.labels).toContainEqual({ source: 'resource', key: 'service.name' });
    expect(scene.state.labelsLoad).toEqual({ status: 'done' });
    scene.setSidebar(undefined);
    scene.setSidebar('labels');
    await flush();
    expect(runSql).toHaveBeenCalledTimes(2);
  });
});

describe('cancelling superseded requests', () => {
  beforeEach(() => fetch.mockReset());

  const scene = new SceneTimeRange({ from: 'now-1h', to: 'now' });

  it('passes the requestId to Grafana', async () => {
    fetch.mockReturnValue(of({ data: { results: { A: { frames: [] } } } }));
    await realRunSql(scene, 'SELECT 1', query.Format.Table, { datasourceUid: 'ds', requestId: 'r-1' });
    expect(fetch.mock.calls[0][0]).toMatchObject({ requestId: 'r-1' });
  });

  it('reports a request cancelled by a newer one as cancelled, not as a failure', async () => {
    // Grafana completes the superseded request's observable without a response.
    fetch.mockReturnValue(EMPTY);
    await expect(realRunSql(scene, 'SELECT 1', query.Format.Table, { datasourceUid: 'ds' })).rejects.toBeInstanceOf(
      query.RequestCancelledError
    );
    fetch.mockReturnValue(throwError(() => ({ cancelled: true, status: -1 })));
    const error = await realRunSql(scene, 'SELECT 1', query.Format.Table, { datasourceUid: 'ds' }).catch((e) => e);
    expect(query.isRequestCancelled(error)).toBe(true);
  });

  it('gives each kind of request its own id, and each query of a load its own name', () => {
    const a = new LatestRequest();
    const b = new LatestRequest();
    expect(a.requestId()).toBe(a.requestId());
    expect(a.requestId()).not.toBe(b.requestId());
    expect(a.requestId('keys')).not.toBe(a.requestId('buckets'));
  });

  it('switching tabs reuses the body request id and a cancelled tab shows no error', async () => {
    runSql.mockReset();
    const traces = new TracesExploration({ actionView: 'comparison' });
    const source = { ...logsSource, table: 'otel_traces' } as SignalSource;
    let rejectSlow: (error: unknown) => void = () => undefined;
    runSql
      .mockReturnValueOnce(new Promise((_, reject) => (rejectSlow = reject)))
      .mockResolvedValueOnce([{ fields: [{ name: 'Trace ID', values: ['abc'] }], length: 1 }]);
    const comparison = traces.buildBody(source);
    traces.setState({ actionView: 'traceList' });
    await traces.buildBody(source);
    // Grafana cancels the comparison when the span list's request with the same id starts.
    expect(runSql.mock.calls[0][3].requestId).toBe(runSql.mock.calls[1][3].requestId);
    rejectSlow(new query.RequestCancelledError());
    await comparison;
    expect(traces.state.bodyLoad).toEqual({ status: 'done' });
    expect(traces.state.spans).toHaveLength(1);
  });
});
