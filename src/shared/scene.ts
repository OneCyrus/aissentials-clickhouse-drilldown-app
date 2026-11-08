import {
  AdHocFiltersVariable,
  DataSourceVariable,
  EmbeddedScene,
  SceneControlsSpacer,
  SceneObject,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
  SceneVariable,
  SceneVariableSet,
  VariableValueSelectors,
} from '@grafana/scenes';
import { VariableHide } from '@grafana/schema';
import { of } from 'rxjs';
import { SignalType } from 'clickhouse/types';
import { CLICKHOUSE_DS_TYPE, VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import { getDataSourceOptions, getDefaultDataSourceUid } from './datasource';
import { datasourceRef, FilterLike, filtersSql } from './index';

/**
 * The data source picker. DataSourceVariable lists one plugin id, so its options are replaced with
 * every accepted ClickHouse plugin id: a fork installed under its own id serves the same SQL and
 * must be selectable, and Grafana routes a query by uid regardless of the type declared with it.
 */
class ClickHouseDataSourceVariable extends DataSourceVariable {
  getValueOptions(args: Parameters<DataSourceVariable['getValueOptions']>[0]) {
    void args;
    return of(getDataSourceOptions());
  }
}

export const dataSourceVariable = (signal: SignalType): DataSourceVariable =>
  new ClickHouseDataSourceVariable({
    name: VAR_DATASOURCE,
    label: 'Data source',
    pluginId: CLICKHOUSE_DS_TYPE,
    value: getDefaultDataSourceUid(signal) || '',
  });

interface FiltersVariableOptions {
  /** The SQL expression of a filter key, undefined for unknown keys (which are ignored). */
  expressionOf: (key: string) => string | undefined;
  getKeys: (variable: AdHocFiltersVariable) => Promise<Array<{ text: string; value: string; group?: string }>>;
  getValues: (variable: AdHocFiltersVariable, key: string) => Promise<string[]>;
  placeholder: string;
  label?: string;
  name?: string;
}

/**
 * The filter bar. It interpolates to an SQL condition (all filters ANDed), so queries use it as
 * `WHERE ... AND ${filters}`.
 */
export const filtersVariable = (options: FiltersVariableOptions): AdHocFiltersVariable =>
  new AdHocFiltersVariable({
    name: options.name || VAR_FILTERS,
    label: options.label || 'Filters',
    datasource: datasourceRef,
    applyMode: 'manual',
    layout: 'combobox',
    allowCustomValue: true,
    supportsMultiValueOperators: true,
    hide: VariableHide.hideLabel,
    addFilterButtonText: options.placeholder,
    inputPlaceholder: options.placeholder,
    expressionBuilder: (filters) => filtersSql(filters as FilterLike[], options.expressionOf),
    getTagKeysProvider: async (variable) => ({ replace: true, values: await options.getKeys(variable) }),
    getTagValuesProvider: async (variable, filter) => ({
      replace: true,
      values: (await options.getValues(variable, filter.key)).map((value) => ({ text: value, value })),
    }),
  });

/** The SQL condition of all filters except those on one key, for value suggestions of that key. */
export const otherFiltersSql = (
  variable: AdHocFiltersVariable,
  key: string,
  expressionOf: (key: string) => string | undefined
): string =>
  filtersSql(
    (variable.state.filters as FilterLike[]).filter((filter) => filter.key !== key),
    expressionOf
  );

export const buildAppScene = (
  signal: SignalType,
  body: SceneObject,
  variables: SceneVariable[],
  defaultRange: { from: string; to: string }
): EmbeddedScene =>
  new EmbeddedScene({
    $timeRange: new SceneTimeRange(defaultRange),
    $variables: new SceneVariableSet({ variables: [dataSourceVariable(signal), ...variables] }),
    controls: [
      new VariableValueSelectors({}),
      new SceneControlsSpacer(),
      new SceneTimePicker({}),
      new SceneRefreshPicker({}),
    ],
    body,
  });
