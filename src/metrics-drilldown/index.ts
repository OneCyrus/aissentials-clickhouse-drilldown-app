import { EmbeddedScene } from '@grafana/scenes';
import { MetricLabel } from 'clickhouse/types';
import { buildAppScene, filtersVariable, otherFiltersSql } from '../shared/scene';
import { frameRows, hasMetricTables, interpolate, loadMetricsSource, runSql } from '../shared';
import { VAR_DATASOURCE } from '../constants';
import {
  labelKeysSql,
  labelValuesSql,
  metricLabelExpression,
  parseMetricLabelId,
  toMetricLabels,
  getMetricLabelId,
} from './sql';
import { MetricsExploration } from './MetricsExploration';

const sourceLabels: Record<MetricLabel['source'], string> = {
  column: 'Columns',
  resource: 'Resource attributes',
  attribute: 'Attributes',
  scope: 'Scope attributes',
};

export const buildMetricsScene = (): EmbeddedScene => {
  const filters = filtersVariable({
    placeholder: 'Filter by label values',
    expressionOf: metricLabelExpression,
    getKeys: async (variable) => {
      const source = await loadMetricsSource(variable, interpolate(variable, `\${${VAR_DATASOURCE}}`));
      if (!source || !hasMetricTables(source)) {
        return [];
      }
      const rows = frameRows<{ source: string; key: string }>(
        await runSql(variable, labelKeysSql(source, otherFiltersSql(variable, '', metricLabelExpression)))
      );
      return toMetricLabels(rows).map((label) => ({
        text: getMetricLabelId(label),
        value: getMetricLabelId(label),
        group: sourceLabels[label.source],
      }));
    },
    getValues: async (variable, key) => {
      const source = await loadMetricsSource(variable, interpolate(variable, `\${${VAR_DATASOURCE}}`));
      const label = parseMetricLabelId(key);
      if (!source || !hasMetricTables(source) || !label) {
        return [];
      }
      const rows = frameRows<{ value: string }>(
        await runSql(variable, labelValuesSql(source, label, otherFiltersSql(variable, key, metricLabelExpression)))
      );
      return rows.map((row) => row.value);
    },
  });
  return buildAppScene('metrics', new MetricsExploration(), [filters], { from: 'now-1h', to: 'now' });
};
