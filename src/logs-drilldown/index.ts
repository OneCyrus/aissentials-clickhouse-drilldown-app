import { EmbeddedScene, TextBoxVariable } from '@grafana/scenes';
import { VariableHide } from '@grafana/schema';
import { buildAppScene, filtersVariable, otherFiltersSql } from '../shared/scene';
import { frameRows, getSignalSource, interpolate, runSql } from '../shared';
import { VAR_DATASOURCE } from '../constants';
import {
  ALL_FILTERS,
  detectedKeysSql,
  keyDisplayName,
  logsExpression,
  valueCountsSql,
  VAR_FIELDS,
  VAR_LEVELS,
  VAR_LINE_FILTERS,
  VAR_PATTERNS,
} from './sql';
import { LogsExploration } from './LogsExploration';

const conditionVariable = (name: string) =>
  new TextBoxVariable({ name, value: '1 = 1', hide: VariableHide.hideVariable, skipUrlSync: true });

export const buildLogsScene = (): EmbeddedScene => {
  const source = (variable: Parameters<typeof interpolate>[0]) =>
    getSignalSource(interpolate(variable, `\${${VAR_DATASOURCE}}`), 'logs');

  const keysOf = (kind: 'labels' | 'fields') => async (variable: Parameters<typeof interpolate>[0]) => {
    const logs = source(variable);
    if (!logs) {
      return [];
    }
    const rows = frameRows<{ key: string; cardinality: number }>(
      await runSql(variable, detectedKeysSql(logs, kind, ALL_FILTERS))
    );
    return rows.filter((row) => row.key !== 'level').map((row) => ({ text: keyDisplayName(row.key), value: row.key }));
  };

  const valuesOf = async (variable: Parameters<typeof otherFiltersSql>[0], key: string) => {
    const logs = source(variable);
    if (!logs) {
      return [];
    }
    const rows = frameRows<{ value: string }>(
      await runSql(variable, valueCountsSql(logs, key, otherFiltersSql(variable, key, logsExpression), 1000))
    );
    return rows.map((row) => row.value);
  };

  const labels = filtersVariable({
    label: 'Labels',
    placeholder: 'Filter by label values',
    expressionOf: logsExpression,
    getKeys: keysOf('labels'),
    getValues: valuesOf,
  });
  const fields = filtersVariable({
    name: VAR_FIELDS,
    label: 'Fields',
    placeholder: 'Filter by fields',
    expressionOf: logsExpression,
    getKeys: keysOf('fields'),
    getValues: valuesOf,
  });
  // Rendered by the service page itself, under the label filters, as in Logs Drilldown.
  fields.setState({ hide: VariableHide.hideVariable });

  return buildAppScene(
    'logs',
    new LogsExploration(),
    [
      labels,
      fields,
      conditionVariable(VAR_LEVELS),
      conditionVariable(VAR_LINE_FILTERS),
      conditionVariable(VAR_PATTERNS),
    ],
    { from: 'now-15m', to: 'now' }
  );
};
