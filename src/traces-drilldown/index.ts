import { EmbeddedScene, TextBoxVariable } from '@grafana/scenes';
import { VariableHide } from '@grafana/schema';
import { buildAppScene, filtersVariable, otherFiltersSql } from '../shared/scene';
import { frameRows, getSignalSource, interpolate, loadSignalSource, runSql } from '../shared';
import { VAR_DATASOURCE } from '../constants';
import { attributeKeysSql, attributeValuesSql, PRIMARY, traceKeyExpression, VAR_PRIMARY } from './sql';
import { TracesExploration } from './TracesExploration';

export const buildTracesScene = (): EmbeddedScene => {
  const uidOf = (variable: Parameters<typeof interpolate>[0]) => interpolate(variable, `\${${VAR_DATASOURCE}}`);
  const source = (variable: Parameters<typeof interpolate>[0]) => loadSignalSource(variable, uidOf(variable), 'traces');

  const filters = filtersVariable({
    placeholder: 'Add filter',
    // The selected data source's table shape (JSON or Map attributes), detected before the page queries.
    expressionOf: (key, variable) => traceKeyExpression(getSignalSource(uidOf(variable), 'traces'))(key),
    getKeys: async (variable) => {
      const traces = await source(variable);
      if (!traces) {
        return [];
      }
      const rows = frameRows<{ key: string }>(await runSql(variable, attributeKeysSql(traces, PRIMARY)));
      return [...rows.map((row) => row.key), 'duration'].map((key) => ({ text: key, value: key }));
    },
    getValues: async (variable, key) => {
      const traces = await source(variable);
      if (!traces || key === 'duration') {
        return [];
      }
      const condition = `${PRIMARY} AND ${otherFiltersSql(variable, key, traceKeyExpression(traces))}`;
      return frameRows<{ value: string }>(await runSql(variable, attributeValuesSql(traces, key, condition))).map(
        (row) => row.value
      );
    },
  });
  // The filter bar sits in the Filters row next to the primary signal, as in Traces Drilldown.
  filters.setState({ hide: VariableHide.hideVariable });

  return buildAppScene(
    'traces',
    new TracesExploration(),
    [
      filters,
      new TextBoxVariable({
        name: VAR_PRIMARY,
        value: "ParentSpanId = ''",
        hide: VariableHide.hideVariable,
        skipUrlSync: true,
      }),
    ],
    { from: 'now-30m', to: 'now' }
  );
};
