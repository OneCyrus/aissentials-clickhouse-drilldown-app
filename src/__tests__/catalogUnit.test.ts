import { catalogSql } from '../metrics-drilldown/sql';
import { SignalSource } from '../shared/datasource';

const source = {
  uid: 'metrics',
  database: 'otel',
  metricTables: { histogram: 'otel_metrics_histogram', gauge: 'otel_metrics_gauge' },
} as unknown as SignalSource;

describe('catalogSql', () => {
  it('takes the unit and description deterministically, so a metric with and without them keeps them', () => {
    const sql = catalogSql(source, '1');
    // any() would pick a different row per run for a metric whose unit is set on only some rows.
    expect(sql).not.toMatch(/\bany\(Metric(Unit|Description)\)/);
    expect(sql).toContain('max(MetricUnit) AS unit');
    expect(sql).toContain('max(MetricDescription) AS description');
  });
});
