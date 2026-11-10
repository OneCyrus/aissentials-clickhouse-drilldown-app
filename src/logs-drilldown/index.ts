import { EmbeddedScene, TextBoxVariable } from '@grafana/scenes';
import { VariableHide } from '@grafana/schema';
import { buildAppScene, filtersVariable, otherFiltersSql } from '../shared/scene';
import { frameRows, getSignalSource, interpolate, loadSignalSource, runSql } from '../shared';
import { VAR_DATASOURCE } from '../constants';
import {
  ALL_FILTERS,
  detectedKeysSql,
  keyDisplayName,
  logsKeyExpression,
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
  const uidOf = (variable: Parameters<typeof interpolate>[0]) => interpolate(variable, `\${${VAR_DATASOURCE}}`);
  // The filter expressions follow the selected data source's table shape (JSON or Map attributes),
  // which the page detects before it queries; the key and value lists make sure of it themselves.
  const expressionOf = (key: string, variable: Parameters<typeof interpolate>[0]) =>
    logsKeyExpression(getSignalSource(uidOf(variable), 'logs'))(key);
  const source = (variable: Parameters<typeof interpolate>[0]) => loadSignalSource(variable, uidOf(variable), 'logs');

  const keysOf = (kind: 'labels' | 'fields') => async (variable: Parameters<typeof interpolate>[0]) => {
    const logs = await source(variable);
    if (!logs) {
      return [];
    }
    const rows = frameRows<{ key: string; cardinality: number }>(
      await runSql(variable, detectedKeysSql(logs, kind, ALL_FILTERS))
    );
    return rows.filter((row) => row.key !== 'level').map((row) => ({ text: keyDisplayName(row.key), value: row.key }));
  };

  const valuesOf = async (variable: Parameters<typeof otherFiltersSql>[0], key: string) => {
    const logs = await source(variable);
    if (!logs) {
      return [];
    }
    const rows = frameRows<{ value: string }>(
      await runSql(variable, valueCountsSql(logs, key, otherFiltersSql(variable, key, logsKeyExpression(logs)), 1000))
    );
    return rows.map((row) => row.value);
  };

  const labels = filtersVariable({
    label: 'Labels',
    placeholder: 'Filter by label values',
    expressionOf,
    getKeys: keysOf('labels'),
    getValues: valuesOf,
  });
  const fields = filtersVariable({
    name: VAR_FIELDS,
    label: 'Fields',
    placeholder: 'Filter by fields',
    expressionOf,
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
