/**
 * The traces tab body's load state machine, on the real TracesExploration with the query layer
 * stubbed.
 */
const runSql = jest.fn();

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mock.
import { TracesExploration } from '../traces-drilldown/TracesExploration';
import { SignalSource } from '../shared/datasource';

const source = {
  uid: 'traces',
  type: 'grafana-clickhouse-datasource',
  name: 'traces',
  database: 'otel',
  table: 'otel_traces',
  metricTables: {},
} as unknown as SignalSource;

describe('traces tab load', () => {
  beforeEach(() => runSql.mockReset());

  it('clears a tab error when switching to another tab', async () => {
    const traces = new TracesExploration({ actionView: 'comparison' });
    runSql.mockRejectedValueOnce(new Error('comparison failed'));
    await traces.buildBody(source);
    expect(traces.state.bodyLoad).toEqual({ status: 'error', message: 'comparison failed' });
    traces.setState({ actionView: 'breakdown' });
    await traces.buildBody(source);
    expect(traces.state.bodyLoad).toEqual({ status: 'done' });
  });

  it('does not let a slow comparison land on the span list', async () => {
    const traces = new TracesExploration({ actionView: 'comparison' });
    let resolveSlow: (value: unknown) => void = () => undefined;
    runSql
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce([{ fields: [{ name: 'Trace ID', values: ['abc'] }], length: 1 }]);
    const comparison = traces.buildBody(source);
    traces.setState({ actionView: 'traceList' });
    await traces.buildBody(source);
    resolveSlow([
      {
        fields: ['key', 'value', 'selection', 'baseline', 'selection_total', 'baseline_total'].map((name) => ({
          name,
          values: [name === 'key' ? 'http.route' : name === 'value' ? '/pay' : 1],
        })),
        length: 1,
      },
    ]);
    await comparison;
    expect(traces.state.comparison).toEqual([]);
    expect(traces.state.spans).toHaveLength(1);
    expect(traces.state.bodyLoad).toEqual({ status: 'done' });
  });
});
