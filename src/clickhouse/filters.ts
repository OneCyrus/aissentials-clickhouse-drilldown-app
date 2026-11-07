import { Filter, FilterOperator, MetricLabel } from './types';
import { metricAttributeColumns } from './metrics';

/**
 * A builder filter of the ClickHouse data source for a metric label, so metrics queries opened in
 * Explore show their filters in the data source's query editor.
 */
export const toMetricLabelFilter = (
  label: MetricLabel,
  operator: FilterOperator,
  value: string | string[],
  jsonAttributes = false
): Filter => {
  const common =
    label.source === 'column'
      ? { key: label.key, type: 'LowCardinality(String)' }
      : {
          key: metricAttributeColumns[label.source],
          mapKey: label.key,
          type: jsonAttributes ? 'JSON' : 'Map(LowCardinality(String), String)',
        };
  const multi = operator === FilterOperator.In || operator === FilterOperator.NotIn;
  return {
    filterType: 'custom',
    condition: 'AND',
    ...common,
    operator,
    value: multi ? (Array.isArray(value) ? value : [value]) : Array.isArray(value) ? value.join(',') : value,
  };
};
