/**
 * The "Group by labels" list of the metrics overview is its own load state machine. These run the
 * real MetricsExploration.loadGroups with the query layer stubbed, so the transitions are tested,
 * not a copy of the pattern.
 */
const runSql = jest.fn();

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mock.
import { MetricsExploration } from '../metrics-drilldown/MetricsExploration';
import { SignalSource } from '../shared/datasource';

const source = {
  uid: 'metrics',
  type: 'grafana-clickhouse-datasource',
  name: 'metrics',
  database: 'otel',
  table: '',
  metricTables: { gauge: 'otel_metrics_gauge' },
} as unknown as SignalSource;

const groupRows = (values: string[]) => [
  {
    fields: [
      { name: 'value', values },
      { name: 'names', values: values.map(() => ['http.server.request.count']) },
    ],
    length: values.length,
  },
];

const deferred = <T>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

/** Lets pending promise callbacks run, so a started load reaches its query. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const exploration = (groupBy?: string) => {
  const scene = new MetricsExploration({ groupBy });
  scene.loadSource = jest.fn().mockResolvedValue(source);
  scene.refresh = jest.fn();
  return scene;
};

describe('metrics "Group by labels" load', () => {
  beforeEach(() => runSql.mockReset());

  it('drops a response superseded by another label', async () => {
    const scene = exploration('resource.k8s.pod.name');
    const slow = deferred<unknown>();
    runSql.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(groupRows(['checkout']));
    const first = scene.loadGroups();
    await flush();
    expect(runSql).toHaveBeenCalledTimes(1);
    scene.setState({ groupBy: 'resource.service.name' });
    await scene.loadGroups();
    slow.resolve(groupRows(['pod-1']));
    await first;
    expect(scene.state.groups.map((g) => g.value)).toEqual(['checkout']);
    expect(scene.state.groupsLoad).toEqual({ status: 'done' });
  });

  it('is not stuck loading when the grouping is cleared while a request is in flight', async () => {
    const scene = exploration('resource.k8s.pod.name');
    const slow = deferred<unknown>();
    runSql.mockReturnValueOnce(slow.promise);
    const first = scene.loadGroups();
    await flush();
    expect(scene.state.groupsLoad).toEqual({ status: 'loading' });
    scene.setState({ groupBy: undefined });
    await scene.loadGroups();
    expect(scene.state.groupsLoad).toEqual({ status: 'done' });
    slow.resolve(groupRows(['pod-1']));
    await first;
    expect(scene.state.groups).toEqual([]);
    expect(scene.state.groupsLoad).toEqual({ status: 'done' });
  });

  it('keeps the metric list state separate from the group list state', async () => {
    const scene = exploration('resource.k8s.pod.name');
    runSql.mockRejectedValueOnce(new Error('bad label'));
    await scene.loadGroups();
    expect(scene.state.groupsLoad).toEqual({ status: 'error', message: 'bad label' });
    expect(scene.state.catalogLoad).toEqual({ status: 'loading' });
  });
});
