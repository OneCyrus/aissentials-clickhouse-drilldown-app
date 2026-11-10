/**
 * Panels of a lazy grid must not query before their renderer reports them in view. A runner that
 * queried on activation sent one request per panel of the metrics list (124 for 120 tiles) while
 * six were visible. These activate the real runners with the data source lookup stubbed: a query
 * starts with that lookup, so its calls count the queries.
 */
const getDataSource = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => ({
    get: (...args: unknown[]) => getDataSource(...args),
    getInstanceSettings: () => undefined,
  }),
}));

// Imported after the mock.
import { SceneDataProvider, SceneDataTransformer, SceneQueryRunner, VizPanel } from '@grafana/scenes';
import { MetricType } from '../clickhouse/types';
import { metricGridItem } from '../metrics-drilldown/panels';
import { SignalSource } from '../shared/datasource';
import { panelQueryRunner, queryRunner, sqlQuery } from '../shared/query';

const source = {
  uid: 'metrics',
  type: 'grafana-clickhouse-datasource',
  name: 'metrics',
  database: 'otel',
  table: '',
  metricTables: { gauge: 'otel_metrics_gauge' },
} as unknown as SignalSource;

/** Lets the runner's asynchronous steps (timeouts, the data source lookup) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The query runner under a panel's data, through any transformers. */
const runnerOf = (data: SceneDataProvider | undefined): SceneQueryRunner => {
  if (data instanceof SceneDataTransformer) {
    return runnerOf(data.state.$data);
  }
  if (data instanceof SceneQueryRunner) {
    return data;
  }
  throw new Error('no query runner');
};

describe('lazy panel queries', () => {
  beforeEach(() => {
    getDataSource.mockReset();
    // Never resolves: the test only counts started queries.
    getDataSource.mockReturnValue(new Promise(() => undefined));
  });

  it('a panel runner waits until its panel is reported in view', async () => {
    const runner = panelQueryRunner([sqlQuery('A', 'SELECT 1')], 120);
    const deactivate = runner.activate();
    await flush();
    expect(getDataSource).not.toHaveBeenCalled();
    runner.isInViewChanged(false);
    await flush();
    expect(getDataSource).not.toHaveBeenCalled();
    runner.isInViewChanged(true);
    await flush();
    expect(getDataSource).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it('keeps the requested number of data points', () => {
    expect(panelQueryRunner([sqlQuery('A', 'SELECT 1')], 120).state.maxDataPoints).toBe(120);
  });

  it('a runner shared by several panels still runs on activation', async () => {
    const runner = queryRunner([sqlQuery('A', 'SELECT 1')], 80);
    const deactivate = runner.activate();
    await flush();
    expect(getDataSource).toHaveBeenCalledTimes(1);
    deactivate();
  });

  it('metric tiles of the list do not query before they are in view', async () => {
    const entry = { name: 'up', type: MetricType.Gauge, unit: '', description: '', isMonotonic: false };
    const tiles: VizPanel[] = Array.from({ length: 10 }, (_, index) =>
      metricGridItem(source, entry, index, () => undefined)
    );
    const runners = tiles.map((tile) => runnerOf(tile.state.$data));
    const deactivations = runners.map((runner) => runner.activate());
    await flush();
    expect(getDataSource).not.toHaveBeenCalled();
    runners.slice(0, 2).forEach((runner) => runner.isInViewChanged(true));
    await flush();
    expect(getDataSource).toHaveBeenCalledTimes(2);
    deactivations.forEach((deactivate) => deactivate());
  });
});
