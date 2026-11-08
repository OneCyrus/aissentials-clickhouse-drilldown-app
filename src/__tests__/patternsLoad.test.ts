/**
 * The Patterns tab's load state machine, on the real PatternsScene with the query layer stubbed.
 */
const runSql = jest.fn();

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mock.
import { PatternsScene } from '../logs-drilldown/PatternsScene';
import { SignalSource } from '../shared/datasource';

const source = {
  uid: 'logs',
  type: 'grafana-clickhouse-datasource',
  name: 'logs',
  database: 'otel',
  table: 'otel_logs',
  metricTables: {},
} as unknown as SignalSource;

const patternRows = (patterns: string[]) => [
  {
    fields: [
      { name: 'pattern', values: patterns },
      { name: 'total', values: patterns.map(() => 1) },
      { name: 'levels', values: patterns.map(() => ['info']) },
      { name: 'series', values: patterns.map(() => []) },
    ],
    length: patterns.length,
  },
];

const scene = () => {
  const patterns = new PatternsScene({});
  const exploration = { getSource: () => source, setState: jest.fn() };
  patterns.getExploration = () => exploration as never;
  return { patterns, exploration };
};

describe('patterns load', () => {
  beforeEach(() => runSql.mockReset());

  it('clears a previous error when a reload succeeds', async () => {
    const { patterns } = scene();
    runSql.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce(patternRows(['GET <_>']));
    await patterns.load();
    expect(patterns.state.load).toEqual({ status: 'error', message: 'timeout' });
    await patterns.load();
    expect(patterns.state.load).toEqual({ status: 'done' });
    expect(patterns.state.rows.map((row) => row.pattern)).toEqual(['GET <_>']);
  });

  it('ignores a slower response of superseded filters', async () => {
    const { patterns, exploration } = scene();
    let resolveSlow: (value: unknown) => void = () => undefined;
    runSql
      .mockReturnValueOnce(new Promise((resolve) => (resolveSlow = resolve)))
      .mockResolvedValueOnce(patternRows(['new <_>']));
    const first = patterns.load();
    await patterns.load();
    resolveSlow(patternRows(['old <_>']));
    await first;
    expect(patterns.state.rows.map((row) => row.pattern)).toEqual(['new <_>']);
    expect(exploration.setState).toHaveBeenCalledTimes(1);
  });
});
