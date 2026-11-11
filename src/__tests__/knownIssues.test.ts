import { getMetricLabelTitle } from 'clickhouse/metrics';
import { MetricLabel } from 'clickhouse/types';

const label = (source: MetricLabel['source'], key: string): MetricLabel => ({ source, key });

describe('getMetricLabelTitle', () => {
  const labels = [
    label('column', 'ServiceName'),
    label('resource', 'server.port'),
    label('attribute', 'server.port'),
    label('attribute', 'http.route'),
  ];

  it('names a label by its key', () => {
    expect(getMetricLabelTitle(label('attribute', 'http.route'), labels)).toBe('http.route');
    expect(getMetricLabelTitle(label('column', 'ServiceName'), labels)).toBe('ServiceName');
  });

  it('adds the source when another label has the same key', () => {
    expect(getMetricLabelTitle(label('resource', 'server.port'), labels)).toBe('server.port (resource)');
    expect(getMetricLabelTitle(label('attribute', 'server.port'), labels)).toBe('server.port (attribute)');
  });
});
