import React from 'react';
import {
  AdHocFiltersVariable,
  SceneComponentProps,
  SceneCSSGridLayout,
  SceneObjectBase,
  SceneObjectState,
  SceneObjectUrlSyncConfig,
  SceneObjectUrlValues,
  VariableDependencyConfig,
  sceneGraph,
  sceneUtils,
} from '@grafana/scenes';
import { locationService } from '@grafana/runtime';
import { Alert, Button, LoadingPlaceholder } from '@grafana/ui';
import { MetricCatalogEntry } from 'clickhouse/metrics';
import { MetricLabel, MetricType } from 'clickhouse/types';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import {
  Format,
  frameRows,
  getSignalSource,
  DONE,
  hasMetricTables,
  interpolate,
  isLoading,
  LatestRequest,
  LoadState,
  loadFailed,
  LOADING,
  loadMetricsSource,
  runSql,
  searchMatches,
  SignalSource,
  store,
  oneOf,
} from '../shared';
import {
  catalogSql,
  FILTERS,
  getMetricLabelId,
  labelKeysSql,
  metricPrefix,
  metricsByLabelValueSql,
  metricSuffix,
  parseMetricLabelId,
  toMetricLabels,
} from './sql';
import { metricGridItem } from './panels';
import { MetricScene } from './MetricScene';
import { metricKind, MetricsReducer } from './MetricsExplorationView';

const FIRST_PAGE = 120;
const GROUPS_FIRST_PAGE = 20;
const RECENT_KEY = 'recent-metrics';

export type GridLayout = 'grid' | 'rows';
const sortOptions = ['default', 'alphabetical', 'alphabetical-reversed'] as const;
export type SortBy = (typeof sortOptions)[number];
export type SidebarSection = 'filters-prefix' | 'filters-suffix' | 'filters-type' | 'labels';

interface MetricGroup {
  value: string;
  names: string[];
}

interface MetricsExplorationState extends SceneObjectState {
  /** The selected metric name. */
  metric?: string;
  search: string;
  prefixes: string[];
  suffixes: string[];
  types: string[];
  sortBy: SortBy;
  layout: GridLayout;
  shown: number;
  /** Label id of the sidebar's "Group by labels" selection. */
  groupBy?: string;
  groups: MetricGroup[];
  groupsShown: number;
  sidebar?: SidebarSection;
  catalog: MetricCatalogEntry[];
  labels: MetricLabel[];
  /** The label names of the "Group by labels" section, loaded while it is open. */
  labelsLoad: LoadState;
  /** The metric list (catalog and label names) of the data source, filters and time range. */
  catalogLoad: LoadState;
  /** The "Group by labels" list; done when no label is selected. */
  groupsLoad: LoadState;
  grid?: SceneCSSGridLayout;
  groupGrids: SceneCSSGridLayout[];
  metricScene?: MetricScene;
}

interface RecentMetric {
  name: string;
  at: number;
}

const recentMetrics = (): string[] =>
  store
    .get<RecentMetric[]>(RECENT_KEY, [])
    .filter((recent) => Date.now() - recent.at < 30 * 24 * 3600 * 1000)
    .map((recent) => recent.name);

const rememberMetric = (name: string) =>
  store.set(
    RECENT_KEY,
    [{ name, at: Date.now() }, ...store.get<RecentMetric[]>(RECENT_KEY, []).filter((r) => r.name !== name)].slice(0, 6)
  );

/**
 * Metrics Drilldown for the OTel exporter's metric tables: a searchable grid of every metric, then
 * one metric with its breakdown by label, related metrics and related logs.
 */
export class MetricsExploration extends SceneObjectBase<MetricsExplorationState> {
  protected _urlSync = new SceneObjectUrlSyncConfig(this, {
    keys: [
      'metric',
      'search_txt',
      'filters-prefix',
      'filters-suffix',
      'filters-type',
      'var-labelsWingman',
      'layout',
      'sort',
    ],
  });

  protected _variableDependency = new VariableDependencyConfig(this, {
    variableNames: [VAR_DATASOURCE, VAR_FILTERS],
    onReferencedVariableValueChanged: () => this.load(),
  });

  private catalogRequest = new LatestRequest();
  private labelsRequest = new LatestRequest();
  /** What the label names in state were loaded for: data source, filters and time range. */
  private labelsKey?: string;
  /**
   * Switching labels (or clearing the grouping) while a query is in flight otherwise lets the
   * previous label's values land a moment later, with Select buttons filtering on a label that is
   * no longer selected.
   */
  private groupsRequest = new LatestRequest();

  constructor(state: Partial<MetricsExplorationState> = {}) {
    super({
      search: '',
      prefixes: [],
      suffixes: [],
      types: [],
      sortBy: 'default',
      layout: 'grid',
      shown: FIRST_PAGE,
      groups: [],
      groupsShown: GROUPS_FIRST_PAGE,
      catalog: [],
      labels: [],
      labelsLoad: DONE,
      catalogLoad: LOADING,
      groupsLoad: DONE,
      groupGrids: [],
      ...state,
    });
    this.addActivationHandler(() => {
      this.load();
      const timeRange = sceneGraph.getTimeRange(this).subscribeToState(() => this.load());
      return () => timeRange.unsubscribe();
    });
  }

  getUrlState(): SceneObjectUrlValues {
    const list = (values: string[]) => (values.length ? values.join(',') : undefined);
    return {
      metric: this.state.metric,
      search_txt: this.state.search || undefined,
      'filters-prefix': list(this.state.prefixes),
      'filters-suffix': list(this.state.suffixes),
      'filters-type': list(this.state.types),
      'var-labelsWingman': this.state.groupBy,
      layout: this.state.layout === 'grid' ? undefined : this.state.layout,
      sort: this.state.sortBy === 'default' ? undefined : this.state.sortBy,
    };
  }

  updateFromUrl(values: SceneObjectUrlValues) {
    const list = (value: unknown) => (typeof value === 'string' && value ? value.split(',') : []);
    const update: Partial<MetricsExplorationState> = {};
    if ('metric' in values) {
      update.metric = values.metric ? String(values.metric) : undefined;
    }
    if ('search_txt' in values) {
      update.search = values.search_txt ? String(values.search_txt) : '';
    }
    if ('filters-prefix' in values) {
      update.prefixes = list(values['filters-prefix']);
    }
    if ('filters-suffix' in values) {
      update.suffixes = list(values['filters-suffix']);
    }
    if ('filters-type' in values) {
      update.types = list(values['filters-type']);
    }
    if ('var-labelsWingman' in values) {
      update.groupBy = values['var-labelsWingman'] ? String(values['var-labelsWingman']) : undefined;
    }
    if ('layout' in values) {
      update.layout = values.layout === 'rows' ? 'rows' : 'grid';
    }
    if ('sort' in values) {
      update.sortBy = oneOf(values.sort, sortOptions) ?? 'default';
    }
    const groupByChanged = 'groupBy' in update && update.groupBy !== this.state.groupBy;
    this.setState(update);
    if (groupByChanged) {
      this.loadGroups();
    } else {
      this.refresh();
    }
  }

  getSource(): SignalSource | undefined {
    return getSignalSource(interpolate(this, `\${${VAR_DATASOURCE}}`), 'metrics');
  }

  /** The source with the metric tables that exist (looked up once per data source). */
  loadSource(): Promise<SignalSource | undefined> {
    return loadMetricsSource(this, interpolate(this, `\${${VAR_DATASOURCE}}`));
  }

  getFiltersVariable(): AdHocFiltersVariable | undefined {
    const variable = sceneGraph.lookupVariable(VAR_FILTERS, this);
    return variable instanceof AdHocFiltersVariable ? variable : undefined;
  }

  /** Loads the metric list and the label names for the current data source, filters and range. */
  async load() {
    const isCurrent = this.catalogRequest.start();
    if (!this.getSource()) {
      this.setState({ catalogLoad: loadFailed('Pick a ClickHouse data source with OpenTelemetry metrics.') });
      return;
    }
    this.setState({ catalogLoad: LOADING });
    try {
      const source = await this.loadSource();
      if (!isCurrent()) {
        return;
      }
      // Filters from the URL were turned into SQL before the table shape was known; rebuild them.
      // A changed condition reloads through the variable's change event.
      const variable = this.getFiltersVariable();
      if (variable && variable.state.filters.length) {
        const before = variable.state.filterExpression;
        variable.updateFilters([...variable.state.filters]);
        if (variable.state.filterExpression !== before) {
          return;
        }
      }
      if (!source || !hasMetricTables(source)) {
        this.setState({
          catalog: [],
          catalogLoad: loadFailed(
            `No OpenTelemetry metric tables found in database ${source?.database ?? ''}. Check the data source's metrics settings.`
          ),
        });
        return;
      }
      const rows = await runSql(this, catalogSql(source, FILTERS), Format.Table, {
        requestId: this.catalogRequest.requestId(),
      });
      if (!isCurrent()) {
        return;
      }
      const catalog = frameRows<{
        name: string;
        type: MetricType;
        unit: string;
        description: string;
        monotonic: number;
      }>(rows).map((row) => ({
        name: row.name,
        type: row.type,
        unit: row.unit,
        description: row.description,
        isMonotonic: Boolean(Number(row.monotonic)),
      }));
      this.setState({ catalog, catalogLoad: DONE });
      // The label names are only shown in the "Group by labels" section: loaded when it is open.
      this.loadLabels();
      if (this.state.groupBy) {
        this.loadGroups();
      } else {
        this.refresh();
      }
      // Filters change the label values and related logs of an open metric.
      if (this.state.metricScene?.isActive) {
        this.state.metricScene.setView({ groupBy: '$__all' });
      }
    } catch (error) {
      if (isCurrent()) {
        this.setState({ catalogLoad: loadFailed(error) });
      }
    }
  }

  /**
   * The label names of the "Group by labels" sidebar section. They take a scan of every metric
   * table, so they load only while the section is open, and again only when the data source,
   * filters or time range changed since (the filter bar suggests keys with a query of its own).
   */
  async loadLabels() {
    const source = this.getSource();
    // Before the catalog is loaded the tables are not resolved yet; its load calls this again.
    if (
      this.state.sidebar !== 'labels' ||
      this.state.catalogLoad.status !== 'done' ||
      !source ||
      !hasMetricTables(source)
    ) {
      return;
    }
    const range = sceneGraph.getTimeRange(this).state.value;
    const key = [source.uid, interpolate(this, FILTERS), range.from.valueOf(), range.to.valueOf()].join('|');
    if (key === this.labelsKey) {
      return;
    }
    const isCurrent = this.labelsRequest.start();
    this.setState({ labelsLoad: LOADING });
    try {
      const rows = await runSql(this, labelKeysSql(source, FILTERS), Format.Table, {
        requestId: this.labelsRequest.requestId(),
      });
      if (isCurrent()) {
        this.labelsKey = key;
        this.setState({ labels: toMetricLabels(frameRows<{ source: string; key: string }>(rows)), labelsLoad: DONE });
      }
    } catch (error) {
      if (isCurrent()) {
        this.setState({ labelsLoad: loadFailed(error) });
      }
    }
  }

  /** Opens a sidebar section (or closes it with undefined). */
  setSidebar(sidebar: SidebarSection | undefined) {
    this.setState({ sidebar });
    this.loadLabels();
  }

  async loadGroups() {
    const isCurrent = this.groupsRequest.start();
    const label = this.state.groupBy ? parseMetricLabelId(this.state.groupBy) : undefined;
    if (!label) {
      // No grouping: nothing to load, and nothing still loading.
      this.setState({ groups: [], groupsLoad: DONE });
      this.refresh();
      return;
    }
    this.setState({ groupsLoad: LOADING });
    try {
      const source = await this.loadSource();
      if (!isCurrent()) {
        return;
      }
      if (!source) {
        this.setState({ groups: [], groupsLoad: DONE });
      } else {
        const groups = frameRows<{ value: string; names: string[] }>(
          await runSql(this, metricsByLabelValueSql(source, label, FILTERS), Format.Table, {
            requestId: this.groupsRequest.requestId(),
          })
        ).map((row) => ({ value: row.value, names: Array.from(row.names || []) }));
        if (!isCurrent()) {
          return;
        }
        this.setState({ groups, groupsShown: GROUPS_FIRST_PAGE, groupsLoad: DONE });
      }
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      this.setState({ groups: [], groupsLoad: loadFailed(error) });
    }
    this.refresh();
  }

  /** The catalog filtered by search and sidebar selections, except the one named. */
  filtered(except?: 'prefix' | 'suffix' | 'type'): MetricCatalogEntry[] {
    const { catalog, search, prefixes, suffixes, types } = this.state;
    const matches = searchMatches(search);
    return catalog.filter(
      (entry) =>
        matches(entry.name) &&
        (except === 'prefix' || !prefixes.length || prefixes.includes(metricPrefix(entry.name))) &&
        (except === 'suffix' || !suffixes.length || suffixes.includes(metricSuffix(entry.name))) &&
        (except === 'type' || !types.length || types.includes(metricKind(entry)))
    );
  }

  /** The metrics shown, sorted: recently selected ones first by default, then alphabetically. */
  getVisibleMetrics(): MetricCatalogEntry[] {
    const metrics = [...this.filtered()];
    const byName = (a: MetricCatalogEntry, b: MetricCatalogEntry) => a.name.localeCompare(b.name);
    if (this.state.sortBy === 'alphabetical-reversed') {
      return metrics.sort((a, b) => byName(b, a));
    }
    metrics.sort(byName);
    if (this.state.sortBy === 'default') {
      const recent = recentMetrics();
      const rank = (entry: MetricCatalogEntry) => {
        const index = recent.indexOf(entry.name);
        return index === -1 ? recent.length : index;
      };
      metrics.sort((a, b) => rank(a) - rank(b));
    }
    return metrics;
  }

  getMetricEntry(name?: string): MetricCatalogEntry | undefined {
    return name ? this.state.catalog.find((entry) => entry.name === name) : undefined;
  }

  /** Builds the grid, the grouped list, or the selected metric's scene. */
  refresh() {
    const source = this.getSource();
    if (!source) {
      return;
    }
    if (this.state.metric) {
      const entry = this.getMetricEntry(this.state.metric);
      if (entry && this.state.metricScene?.state.entry.name !== entry.name) {
        const metricScene = new MetricScene({ entry });
        // The scene is created after the URL was read, so it takes its tab, group by etc. from the URL now.
        sceneUtils.syncStateFromSearchParams(metricScene, new URLSearchParams(locationService.getLocation().search));
        this.setState({ metricScene, grid: undefined, groupGrids: [] });
      }
      return;
    }
    const columns = this.state.layout === 'rows' ? '1fr' : 'repeat(auto-fit, minmax(400px, 1fr))';
    if (this.state.groupBy) {
      const visible = new Set(this.filtered().map((entry) => entry.name));
      const groupGrids = this.state.groups.slice(0, this.state.groupsShown).map(
        (group) =>
          new SceneCSSGridLayout({
            templateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
            autoRows: '220px',
            isLazy: true,
            children: group.names
              .filter((name) => visible.has(name))
              .slice(0, 3)
              .flatMap((name, index) => {
                const entry = this.getMetricEntry(name);
                return entry ? [metricGridItem(source, entry, index, () => this.selectMetric(entry))] : [];
              }),
          })
      );
      this.setState({ metricScene: undefined, grid: undefined, groupGrids });
      return;
    }
    const metrics = this.getVisibleMetrics().slice(0, this.state.shown);
    this.setState({
      metricScene: undefined,
      groupGrids: [],
      grid: new SceneCSSGridLayout({
        templateColumns: columns,
        autoRows: '220px',
        isLazy: true,
        children: metrics.map((entry, index) => metricGridItem(source, entry, index, () => this.selectMetric(entry))),
      }),
    });
  }

  selectMetric(entry?: MetricCatalogEntry) {
    if (entry) {
      rememberMetric(entry.name);
    }
    this.setState({ metric: entry?.name, metricScene: undefined });
    this.refresh();
  }

  setListState(
    update: Partial<
      Pick<
        MetricsExplorationState,
        'search' | 'prefixes' | 'suffixes' | 'types' | 'layout' | 'shown' | 'sortBy' | 'groupsShown'
      >
    >
  ) {
    this.setState({ shown: FIRST_PAGE, ...update });
    this.refresh();
  }

  setGroupBy(groupBy?: string) {
    this.setState({ groupBy });
    this.loadGroups();
  }

  /** Adds `label = value` to the filter bar and clears the grouping (the group's Select button). */
  selectGroup(value: string) {
    const label = this.state.groupBy ? parseMetricLabelId(this.state.groupBy) : undefined;
    const variable = this.getFiltersVariable();
    if (label && variable) {
      const key = getMetricLabelId(label);
      this.setState({ groupBy: undefined });
      variable.updateFilters([
        ...variable.state.filters.filter((filter) => filter.key !== key),
        { key, operator: '=', value },
      ]);
    }
  }

  static Component = ({ model }: SceneComponentProps<MetricsExploration>) => {
    const { metricScene, metric, catalog, catalogLoad } = model.useState();
    if (metric) {
      if (metricScene) {
        return <metricScene.Component model={metricScene} />;
      }
      return isLoading(catalogLoad) ? (
        <LoadingPlaceholder text="Loading metric…" />
      ) : (
        <Alert severity="info" title={`No data for ${metric}`}>
          {catalog.length ? 'The metric has no data matching the filters in this time range.' : ''}
          <div>
            <Button variant="secondary" size="sm" onClick={() => model.selectMetric(undefined)}>
              Select new metric
            </Button>
          </div>
        </Alert>
      );
    }
    return <MetricsReducer model={model} />;
  };
}
