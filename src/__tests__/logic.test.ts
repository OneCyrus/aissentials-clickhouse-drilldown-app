import { DataFrame, FieldType, toDataFrame } from '@grafana/data';
import { sortSeries, searchMatches } from '../shared/panels';
import { groupExceptions, toComparison } from '../traces-drilldown/components';
import { getDrilldownPath } from '../module';

const series = (name: string, values: number[]): DataFrame =>
  toDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: values.map((_, i) => i) },
      { name: 'value', type: FieldType.number, values, labels: { label: name } },
    ],
  });

describe('sortSeries', () => {
  const frames = [series('b', [1, 1, 1]), series('a', [0, 10, 0]), series('c', [1, 2, 1])];
  it('sorts by name and by statistics', () => {
    expect(sortSeries(frames, 'name').map((f) => f.fields[1].labels!.label)).toEqual(['a', 'b', 'c']);
    expect(sortSeries(frames, 'name-desc').map((f) => f.fields[1].labels!.label)).toEqual(['c', 'b', 'a']);
    expect(sortSeries(frames, 'max-desc')[0].fields[1].labels!.label).toBe('a');
    expect(sortSeries(frames, 'min-asc')[0].fields[1].labels!.label).toBe('a');
    expect(sortSeries(frames, 'sum-desc')[0].fields[1].labels!.label).toBe('a');
  });
  it('puts the series furthest from the others first for outliers', () => {
    expect(sortSeries(frames, 'outliers')[0].fields[1].labels!.label).toBe('a');
  });
  it('matches values by comma separated regexes', () => {
    expect(searchMatches('pod-1$, ^cart')('checkout-pod-1')).toBe(true);
    expect(searchMatches('pod-1$')('checkout-pod-10')).toBe(false);
  });
});

describe('toComparison', () => {
  const row = (key: string, value: string, selection: number, baseline: number) => ({
    key,
    value,
    selection,
    baseline,
    selection_total: 10,
    baseline_total: 100,
  });
  it('compares shares of each population and ranks by the highest difference', () => {
    const result = toComparison(
      [
        row('resource.k8s.pod.name', 'pod-4', 8, 5),
        row('resource.k8s.pod.name', 'pod-1', 1, 90),
        row('resource.k8s.pod.name', 'pod-2', 1, 5),
        row('span.http.route', '/pay', 5, 50),
        row('span.http.route', '/cart', 5, 50),
      ],
      false
    );
    expect(result[0].key).toBe('resource.k8s.pod.name');
    // pod-1: 10% of the selection but 90% of the baseline, the largest difference (signed).
    expect(result[0].maxDifference).toBeCloseTo(-0.8);
    expect(result[0].maxDifferenceValue).toBe('pod-1');
    expect(result[0].values[0]).toEqual({ value: 'pod-4', selection: 0.8, baseline: 0.05 });
    expect(result[1].maxDifference).toBe(0);
  });
  it('falls back to the shown counts when totals are missing', () => {
    const result = toComparison([{ ...row('k', 'v', 3, 3), selection_total: 0, baseline_total: 0 }], false);
    expect(result[0].values[0]).toEqual({ value: 'v', selection: 1, baseline: 1 });
  });
});

describe('groupExceptions', () => {
  it('groups messages that differ only in variable parts', () => {
    const groups = groupExceptions([
      { time: 1, service: 'a', type: 'Timeout', message: 'timeout after 10ms', traceId: 't1' },
      { time: 3, service: 'b', type: 'Timeout', message: 'timeout after 20ms', traceId: 't2' },
      { time: 2, service: 'a', type: 'Reset', message: 'connection reset', traceId: 't3' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ type: 'Timeout', count: 2, lastSeen: 3, service: 'b', traceId: 't2' });
    expect(groups[0].variants).toEqual(['timeout after 10ms', 'timeout after 20ms']);
  });
});

describe('getDrilldownPath', () => {
  const ds = { type: 'grafana-clickhouse-datasource', uid: 'ch' };
  it('opens the metric of a metrics query in the panel time range', () => {
    expect(
      getDrilldownPath({
        targets: [{ refId: 'A', datasource: ds, builderOptions: { metric: { name: 'cpu', type: 'gauge' } } }] as never,
        timeRange: { from: 'now-6h', to: 'now' },
      })
    ).toBe('/a/aissentials-clickhousedrilldown-app/metrics?var-ds=ch&from=now-6h&to=now&metric=cpu');
  });
  it('passes absolute times as epoch milliseconds', () => {
    expect(
      getDrilldownPath({
        targets: [{ refId: 'A', datasource: ds, queryType: 'logs' }] as never,
        timeRange: { from: '2026-11-07T09:58:00Z', to: '1794045480000' } as never,
      })
    ).toBe('/a/aissentials-clickhousedrilldown-app/logs?var-ds=ch&from=1794045480000&to=1794045480000');
  });

  it('opens the app of the query type', () => {
    expect(getDrilldownPath({ targets: [{ refId: 'A', datasource: ds, queryType: 'logs' }] as never })).toBe(
      '/a/aissentials-clickhousedrilldown-app/logs?var-ds=ch'
    );
    expect(
      getDrilldownPath({
        targets: [
          { refId: 'A', datasource: { ...ds, uid: '${ds}' }, builderOptions: { queryType: 'traces' } },
        ] as never,
      })
    ).toBe('/a/aissentials-clickhousedrilldown-app/traces?');
  });
  it('offers no link for other data sources', () => {
    expect(
      getDrilldownPath({ targets: [{ refId: 'A', datasource: { type: 'prometheus' } }] as never })
    ).toBeUndefined();
  });
});
