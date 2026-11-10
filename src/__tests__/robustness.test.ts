/**
 * Errors that used to be swallowed now show where their data is missing, without blocking the page,
 * and URL state that would select no view or reach SQL in a form the app never writes is dropped.
 * The real scene classes run with runSql stubbed.
 */
const runSql = jest.fn();

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mock.
import { MetricSeriesAggregation, MetricType } from 'clickhouse/types';
import { LogsExploration } from '../logs-drilldown/LogsExploration';
import { validLineFilters, validPatterns } from '../logs-drilldown/sql';
import { MetricScene } from '../metrics-drilldown/MetricScene';
import { MetricsExploration } from '../metrics-drilldown/MetricsExploration';
import { SignalSource } from '../shared/datasource';
import { errorMessage } from '../shared/query';
import { oneOf, probabilities } from '../shared/url';
import { TracesExploration } from '../traces-drilldown/TracesExploration';

const source = (table: string) =>
  ({
    uid: 'ds',
    type: 'grafana-clickhouse-datasource',
    name: 'ds',
    database: 'otel',
    table,
    metricTables: { histogram: 'otel_metrics_histogram' },
  }) as unknown as SignalSource;

const keyRows = (keys: string[]) => [
  {
    fields: [
      { name: 'key', values: keys },
      { name: 'cardinality', values: keys.map(() => 2) },
    ],
    length: keys.length,
  },
];
const countRows = (n: number) => [{ fields: [{ name: 'count', values: [n] }], length: 1 }];

beforeEach(() => runSql.mockReset());

describe('errors show where their data is missing', () => {
  it('logs: a failed label or field lookup shows on those tabs, a failed count shows no badge', async () => {
    const logs = new LogsExploration({ view: 'logs' });
    logs.getSource = () => source('otel_logs');
    runSql.mockImplementation((_scene: unknown, sql: string) =>
      sql.startsWith('SELECT count()')
        ? Promise.reject(new Error('count timeout'))
        : sql.includes("'log.'")
          ? Promise.reject(new Error('fields timeout'))
          : Promise.resolve(keyRows(['resource.k8s.pod.name']))
    );
    await logs.loadCounts();
    expect(logs.state.logsCount).toBeUndefined();
    expect(logs.state.labels.map((k) => k.key)).toEqual(['resource.k8s.pod.name']);
    expect(logs.state.fields).toEqual([]);
    expect(logs.state.labelsLoad).toEqual({ status: 'done' });
    expect(logs.state.fieldsLoad).toEqual({ status: 'error', message: 'fields timeout' });
  });

  it('logs: all lookups succeeding clear the error', async () => {
    const logs = new LogsExploration({ view: 'logs', fieldsLoad: { status: 'error', message: 'old' } });
    logs.getSource = () => source('otel_logs');
    runSql.mockImplementation((_scene: unknown, sql: string) =>
      Promise.resolve(sql.startsWith('SELECT count()') ? countRows(7) : keyRows(['k']))
    );
    await logs.loadCounts();
    expect(logs.state.logsCount).toBe(7);
    expect(logs.state.fieldsLoad).toEqual({ status: 'done' });
  });

  it('traces: a failed attribute list shows in the sidebar, the page still loads', async () => {
    const traces = new TracesExploration({ actionView: 'breakdown' });
    traces.loadSource = jest.fn().mockResolvedValue(source('otel_traces'));
    traces.getSource = () => source('otel_traces');
    runSql.mockImplementation((_scene: unknown, sql: string) =>
      sql.startsWith('SELECT DISTINCT key') ? Promise.reject(new Error('keys timeout')) : Promise.resolve([])
    );
    await traces.refresh(true);
    expect(traces.state.attributesLoad).toEqual({ status: 'error', message: 'keys timeout' });
    expect(traces.state.attributes).toEqual([]);
    expect(traces.state.bodyLoad).toEqual({ status: 'done' });
  });

  it('metrics: a failed label lookup shows on the breakdown, which keeps the column labels', async () => {
    const entry = { name: 'http.duration', type: MetricType.Histogram, unit: 's', description: '', isMonotonic: false };
    const scene = new MetricScene({ entry });
    scene.getExploration = () =>
      ({ loadSource: jest.fn().mockResolvedValue(source('')), getSource: () => source('') }) as never;
    scene.build = jest.fn();
    runSql.mockRejectedValueOnce(new Error('labels timeout'));
    await scene.loadLabels();
    expect(scene.state.labelsLoad).toEqual({ status: 'error', message: 'labels timeout' });
    expect(scene.state.labels.map((label) => label.key)).toEqual(['ServiceName', 'ScopeName']);
  });
});

describe('URL state', () => {
  it('helpers', () => {
    expect(oneOf('a', ['a', 'b'] as const)).toBe('a');
    expect(oneOf('c', ['a', 'b'] as const)).toBeUndefined();
    expect(oneOf(['a'], ['a'] as const)).toBeUndefined();
    expect(probabilities(['0.5', '0', '1', '1.5', '-0.1', 'x', 0.99])).toEqual([0.5, 0.99]);
  });

  it('traces: unknown tab, signal and layout fall back, percentiles outside (0, 1) are dropped', () => {
    const traces = new TracesExploration({});
    traces.getSource = () => undefined;
    traces.updateFromUrl({
      actionView: 'nonsense',
      'var-primarySignal': '1 = 1) OR (1 = 1',
      layout: 'diagonal',
      'var-durationPercentiles': ['0.5', '2', '-1', '0.99'],
    });
    expect(traces.state.actionView).toBe('breakdown');
    expect(traces.state.primarySignal).toBe('root');
    expect(traces.state.layout).toBe('grid');
    expect(traces.state.percentiles).toEqual([0.5, 0.99]);
    traces.updateFromUrl({ 'var-durationPercentiles': ['5'] });
    expect(traces.state.percentiles).toEqual([0.5, 0.99]);
    traces.updateFromUrl({ actionView: 'comparison', 'var-primarySignal': 'database' });
    expect(traces.state.actionView).toBe('comparison');
    expect(traces.state.primarySignal).toBe('database');
  });

  it('metric: aggregation must be one the app offers, quantiles between 0 and 1', () => {
    const entry = { name: 'http.duration', type: MetricType.Histogram, unit: 's', description: '', isMonotonic: false };
    const scene = new MetricScene({ entry });
    const before = scene.state.query;
    scene.updateFromUrl({ agg: 'sleep', q: ['1.5', '0.95', '0'], 'var-histogramBreakdownFn': 'p42' });
    expect(scene.state.query.aggregation).toBe(before.aggregation);
    expect(scene.state.query.quantiles).toEqual([0.95]);
    expect(scene.state.histogramFn).toBe('sum');
    scene.updateFromUrl({ agg: 'max', 'var-histogramBreakdownFn': 'p99' });
    expect(scene.state.query.aggregation).toBe(MetricSeriesAggregation.Max);
    expect(scene.state.histogramFn).toBe('p99');
  });

  it('metrics list: unknown sort falls back to the default', () => {
    const scene = new MetricsExploration({});
    scene.refresh = jest.fn();
    scene.updateFromUrl({ sort: 'random' });
    expect(scene.state.sortBy).toBe('default');
    scene.updateFromUrl({ sort: 'alphabetical' });
    expect(scene.state.sortBy).toBe('alphabetical');
  });

  it('logs: unknown sort falls back, malformed line filters and patterns are dropped', () => {
    const logs = new LogsExploration({});
    logs.updateFromUrl({
      actionView: 'nonsense',
      sortBy: 'random',
      lineFilters: JSON.stringify([{ text: 5 }, { text: 'error', regex: true }, 'x']),
      patterns: JSON.stringify([
        { type: 'include', pattern: 'GET <_>' },
        { type: 'drop', pattern: 'x' },
        { pattern: 1 },
      ]),
    });
    expect(logs.state.view).toBeUndefined();
    expect(logs.state.sort).toBe('stddev-desc');
    expect(logs.state.lineFilters).toEqual([{ text: 'error', exclude: false, caseSensitive: false, regex: true }]);
    expect(logs.state.patterns).toEqual([{ type: 'include', pattern: 'GET <_>' }]);
    expect(validLineFilters('not a list')).toEqual([]);
    expect(validPatterns({ type: 'include' })).toEqual([]);
  });
});

describe('error messages', () => {
  it("shows the database's message of a failed query, not the HTTP status", () => {
    const error = {
      status: 400,
      statusText: 'Bad Request',
      data: { results: { A: { error: 'code: 47, message: Unknown identifier LogAttributes', status: 400 } } },
    };
    expect(errorMessage(error)).toBe('code: 47, message: Unknown identifier LogAttributes');
    expect(errorMessage({ statusText: 'Bad Request' })).toBe('Bad Request');
  });
});
