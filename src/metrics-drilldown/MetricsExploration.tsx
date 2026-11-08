import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
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
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Icon,
  IconButton,
  Input,
  LoadingPlaceholder,
  RadioButtonGroup,
  Stack,
  Tag,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { MetricCatalogEntry, metricTypeLabels } from 'clickhouse/metrics';
import { MetricLabel, MetricType } from 'clickhouse/types';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import {
  Control,
  frameRows,
  getSignalSource,
  hasMetricTables,
  interpolate,
  loadMetricsSource,
  runSql,
  searchMatches,
  SignalSource,
  store,
  errorMessage,
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

const FIRST_PAGE = 120;
const PAGE_STEP = 9;
const GROUPS_FIRST_PAGE = 20;
const GROUPS_STEP = 10;
const RECENT_KEY = 'recent-metrics';

type GridLayout = 'grid' | 'rows';
type SortBy = 'default' | 'alphabetical' | 'alphabetical-reversed';
type SidebarSection = 'filters-prefix' | 'filters-suffix' | 'filters-type' | 'labels';

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
  loading: boolean;
  error?: string;
  grid?: SceneCSSGridLayout;
  groupGrids: SceneCSSGridLayout[];
  metricScene?: MetricScene;
}

/** Kinds shown in the sidebar: sums split into counters and up-down counters. */
const metricKind = (entry: MetricCatalogEntry): string =>
  entry.type === MetricType.Sum ? (entry.isMonotonic ? 'counter' : 'updowncounter') : entry.type;

const kindLabels: Record<string, string> = {
  ...metricTypeLabels,
  counter: 'Counter',
  updowncounter: 'Up-down counter',
};

export const metricKindLabel = (entry: MetricCatalogEntry): string => kindLabels[metricKind(entry)] || entry.type;

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

  private loadToken = 0;
  private groupsToken = 0;

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
      loading: true,
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
      update.sortBy = (values.sort as SortBy) || 'default';
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
    const token = ++this.loadToken;
    if (!this.getSource()) {
      this.setState({ loading: false, error: 'Pick a ClickHouse data source with OpenTelemetry metrics.' });
      return;
    }
    this.setState({ loading: true, error: undefined });
    try {
      const source = await this.loadSource();
      if (token !== this.loadToken) {
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
          loading: false,
          error: `No OpenTelemetry metric tables found in database ${source?.database ?? ''}. Check the data source's metrics settings.`,
        });
        return;
      }
      const [rows, keys] = await Promise.all([
        runSql(this, catalogSql(source, FILTERS)),
        runSql(this, labelKeysSql(source, FILTERS)).catch(() => []),
      ]);
      if (token !== this.loadToken) {
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
      this.setState({
        catalog,
        labels: toMetricLabels(frameRows<{ source: string; key: string }>(keys)),
        loading: false,
      });
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
      if (token === this.loadToken) {
        this.setState({ loading: false, error: errorMessage(error) });
      }
    }
  }

  async loadGroups() {
    const source = await this.loadSource().catch(() => undefined);
    const label = this.state.groupBy ? parseMetricLabelId(this.state.groupBy) : undefined;
    // Every call takes a token; only the newest may write. Switching labels (or clearing the
    // grouping) while a query is in flight otherwise lets the previous label's values land a
    // moment later, so the list shows groups the user has already left and its Select buttons
    // filter on a label that is no longer selected.
    const token = ++this.groupsToken;
    if (!source || !label) {
      this.setState({ groups: [] });
      this.refresh();
      return;
    }
    this.setState({ loading: true });
    try {
      const groups = frameRows<{ value: string; names: string[] }>(
        await runSql(this, metricsByLabelValueSql(source, label, FILTERS))
      ).map((row) => ({ value: row.value, names: Array.from(row.names || []) }));
      if (token !== this.groupsToken) {
        return;
      }
      this.setState({ groups, groupsShown: GROUPS_FIRST_PAGE, loading: false });
    } catch (error) {
      if (token !== this.groupsToken) {
        return;
      }
      this.setState({ groups: [], loading: false, error: errorMessage(error) });
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
    const { metricScene, metric, catalog, loading } = model.useState();
    if (metric) {
      if (metricScene) {
        return <metricScene.Component model={metricScene} />;
      }
      return loading ? (
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

const sections: Array<{ id: SidebarSection; title: string; description: string; icon: React.ReactNode }> = [
  {
    id: 'filters-prefix',
    title: 'Prefix filters',
    description: 'Filter metrics based on their name prefix',
    icon: <span>A_</span>,
  },
  {
    id: 'filters-suffix',
    title: 'Suffix filters',
    description: 'Filter metrics based on their name suffix',
    icon: <span>_Z</span>,
  },
  {
    id: 'filters-type',
    title: 'Metric type filters',
    description: 'Filter metrics by their OpenTelemetry type',
    icon: <Icon name="graph-bar" />,
  },
  {
    id: 'labels',
    title: 'Group by labels',
    description: 'Group metrics by their label values',
    icon: <Icon name="layer-group" />,
  },
];

const countBy = (items: MetricCatalogEntry[], key: (entry: MetricCatalogEntry) => string) =>
  items.reduce<Record<string, number>>((counts, entry) => {
    const k = key(entry);
    counts[k] = (counts[k] || 0) + 1;
    return counts;
  }, {});

/** A checkbox list with counts, search, "Hide empty" and clear, as in the Drilldown sidebar. */
function FilterList({
  values,
  counts,
  selected,
  labelOf,
  onChange,
}: {
  values: string[];
  counts: Record<string, number>;
  selected: string[];
  labelOf?: (value: string) => string;
  onChange: (selected: string[]) => void;
}) {
  const styles = useStyles2(getStyles);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const shown = values
    .filter((value) => (labelOf ? labelOf(value) : value).toLowerCase().includes(search.toLowerCase()))
    .filter((value) => !hideEmpty || counts[value] || selected.includes(value))
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  return (
    <>
      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        prefix={<Icon name="search" />}
      />
      <div className={styles.listHeader}>
        <Checkbox label="Hide empty" value={hideEmpty} onChange={() => setHideEmpty(!hideEmpty)} />
        {selected.length > 0 && (
          <span>
            {selected.length} selected{' '}
            <Button variant="secondary" fill="text" size="sm" onClick={() => onChange([])}>
              clear
            </Button>
          </span>
        )}
      </div>
      <div className={styles.scrollList}>
        {shown.length === 0 && <span className={styles.muted}>No results.</span>}
        {shown.map((value) => (
          <Checkbox
            key={value}
            className={styles.checkbox}
            label={`${labelOf ? labelOf(value) : value} (${counts[value] || 0})`}
            value={selected.includes(value)}
            onChange={() =>
              onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
            }
          />
        ))}
      </div>
    </>
  );
}

function LabelList({ model }: SceneComponentProps<MetricsExploration>) {
  const styles = useStyles2(getStyles);
  const { labels, groupBy } = model.useState();
  const [search, setSearch] = useState('');
  const selected = groupBy ? parseMetricLabelId(groupBy) : undefined;
  return (
    <>
      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        prefix={<Icon name="search" />}
      />
      <div className={styles.listHeader}>
        {selected ? (
          <span>
            Selected: &quot;{selected.key}&quot;{' '}
            <Button variant="secondary" fill="text" size="sm" onClick={() => model.setGroupBy(undefined)}>
              clear
            </Button>
          </span>
        ) : (
          <span className={styles.muted}>No selection</span>
        )}
      </div>
      <div className={styles.scrollList}>
        {labels
          .filter((label) => label.key.toLowerCase().includes(search.toLowerCase()))
          .map((label) => {
            const id = getMetricLabelId(label);
            return (
              <button
                key={id}
                className={cx(styles.labelItem, id === groupBy && styles.labelItemSelected)}
                onClick={() => model.setGroupBy(id === groupBy ? undefined : id)}
              >
                {label.key}
                <span className={styles.muted}> {label.source}</span>
              </button>
            );
          })}
      </div>
    </>
  );
}

/** The metric list: sidebar, list controls and the tile grid (or the grouped list). */
function MetricsReducer({ model }: SceneComponentProps<MetricsExploration>) {
  const styles = useStyles2(getStyles);
  const state = model.useState();
  const { catalog, loading, error, grid, search, prefixes, suffixes, types, layout, shown, sortBy, sidebar } = state;
  const { groupBy, groups, groupGrids, groupsShown } = state;
  const visible = model.getVisibleMetrics();
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  useEffect(() => {
    if (searchText === search) {
      return;
    }
    const timer = setTimeout(() => model.setListState({ search: searchText }), 250);
    return () => clearTimeout(timer);
  }, [searchText, search, model]);

  const prefixCounts = useMemo(
    () => countBy(model.filtered('prefix'), (e) => metricPrefix(e.name)),
    [model, catalog, search, suffixes, types] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const suffixCounts = useMemo(
    () => countBy(model.filtered('suffix'), (e) => metricSuffix(e.name)),
    [model, catalog, search, prefixes, types] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const typeCounts = useMemo(
    () => countBy(model.filtered('type'), metricKind),
    [model, catalog, search, prefixes, suffixes] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const active: Record<SidebarSection, boolean> = {
    'filters-prefix': prefixes.length > 0,
    'filters-suffix': suffixes.length > 0,
    'filters-type': types.length > 0,
    labels: Boolean(groupBy),
  };
  const openSection = sections.find((section) => section.id === sidebar);
  const groupLabel = groupBy ? parseMetricLabelId(groupBy) : undefined;

  return (
    <div className={styles.container}>
      <div className={styles.rail} data-testid="metrics-sidebar">
        {sections.map((section) => (
          <Tooltip key={section.id} content={section.description} placement="right">
            <button
              aria-label={section.title}
              className={cx(
                styles.railButton,
                sidebar === section.id && styles.railButtonOpen,
                active[section.id] && styles.railButtonActive
              )}
              onClick={() => model.setState({ sidebar: sidebar === section.id ? undefined : section.id })}
            >
              {section.icon}
            </button>
          </Tooltip>
        ))}
      </div>
      {openSection && (
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h6 className={styles.sectionTitle}>{openSection.title}</h6>
            <IconButton name="times" aria-label="Close" onClick={() => model.setState({ sidebar: undefined })} />
          </div>
          {openSection.id === 'filters-prefix' && (
            <FilterList
              values={Object.keys(countBy(catalog, (e) => metricPrefix(e.name)))}
              counts={prefixCounts}
              selected={prefixes}
              onChange={(next) => model.setListState({ prefixes: next })}
            />
          )}
          {openSection.id === 'filters-suffix' && (
            <FilterList
              values={Object.keys(countBy(catalog, (e) => metricSuffix(e.name)))}
              counts={suffixCounts}
              selected={suffixes}
              onChange={(next) => model.setListState({ suffixes: next })}
            />
          )}
          {openSection.id === 'filters-type' && (
            <FilterList
              values={Object.keys(countBy(catalog, metricKind))}
              counts={typeCounts}
              selected={types}
              labelOf={(kind) => kindLabels[kind] || kind}
              onChange={(next) => model.setListState({ types: next })}
            />
          )}
          {openSection.id === 'labels' && <LabelList model={model} />}
        </div>
      )}

      <div className={styles.main}>
        <div className={styles.listControls}>
          {!groupBy && (
            <div className={styles.search}>
              <Input
                prefix={<Icon name="search" />}
                placeholder="Search metrics"
                aria-label="Quick search metrics"
                value={searchText}
                onChange={(e) => setSearchText(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearchText('')}
                suffix={
                  <Tooltip content={`metric: ${visible.length} of ${catalog.length} in total`}>
                    <span>
                      <Tag
                        name={
                          visible.length === catalog.length
                            ? String(catalog.length)
                            : `${visible.length}/${catalog.length}`
                        }
                      />
                    </span>
                  </Tooltip>
                }
              />
            </div>
          )}
          {groupBy && (
            <div className={styles.groupTitle}>
              <Icon name="layer-group" /> Grouped by <b>{groupLabel?.key}</b>
            </div>
          )}
          <Stack direction="row" gap={2} alignItems="center">
            <Control label="Sort by" tooltip="Default: recently selected metrics first, then alphabetical">
              <Combobox
                aria-label="Sort by"
                width={24}
                value={sortBy}
                options={[
                  {
                    value: 'default',
                    label: 'Default',
                    description: 'Recently selected metrics first, then alphabetical',
                  },
                  { value: 'alphabetical', label: 'Alphabetical [A-Z]' },
                  { value: 'alphabetical-reversed', label: 'Alphabetical [Z-A]' },
                ]}
                onChange={(option) => model.setListState({ sortBy: option.value as SortBy })}
              />
            </Control>
            <RadioButtonGroup
              aria-label="Layout switcher"
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'rows', label: 'Rows' },
              ]}
              value={layout}
              onChange={(value) => model.setListState({ layout: value as GridLayout })}
            />
          </Stack>
        </div>
        {error && <Alert title="Error while loading metrics!">{error}</Alert>}
        {loading && !catalog.length && <LoadingPlaceholder text="Loading metrics…" />}
        {!loading && !error && !groupBy && !visible.length && (
          <Alert severity="info" title="No metrics found for the current filters and time range." />
        )}
        {!groupBy && grid && <grid.Component model={grid} />}
        {!groupBy && visible.length > shown && (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => model.setListState({ shown: shown + PAGE_STEP })}>
              Show {Math.min(PAGE_STEP, visible.length - shown)} more ({shown}/{visible.length})
            </Button>
          </div>
        )}
        {groupBy && !loading && !groups.length && (
          <Alert severity="info" title={`No label values found for label "${groupLabel?.key}".`} />
        )}
        {groupBy &&
          groupGrids.map((groupGrid, index) => {
            const group = groups[index];
            return (
              <div key={group.value} className={styles.group}>
                <div className={styles.groupHeader}>
                  <Icon name="layer-group" />
                  <b>{group.value}</b>
                  {groups.length > 1 && (
                    <span className={styles.muted}>
                      ({index + 1}/{groups.length})
                    </span>
                  )}
                  <div className={styles.spacer} />
                  <Tooltip content={`See metrics with ${groupLabel?.key}=${group.value}`}>
                    <Button size="sm" variant="secondary" onClick={() => model.selectGroup(group.value)}>
                      Select
                    </Button>
                  </Tooltip>
                </div>
                <groupGrid.Component model={groupGrid} />
              </div>
            );
          })}
        {groupBy && groups.length > groupsShown && (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => model.setListState({ groupsShown: groupsShown + GROUPS_STEP })}>
              Show {Math.min(GROUPS_STEP, groups.length - groupsShown)} more ({groupsShown}/{groups.length})
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', gap: theme.spacing(1), minHeight: 0, width: '100%', flexGrow: 1 }),
  rail: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.5),
    borderRight: `1px solid ${theme.colors.border.weak}`,
  }),
  railButton: css({
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    position: 'relative',
    '&:hover': { background: theme.colors.action.hover, color: theme.colors.text.primary },
  }),
  railButtonOpen: css({ background: theme.colors.action.selected, color: theme.colors.text.primary }),
  railButtonActive: css({
    '&::after': {
      content: '""',
      position: 'absolute',
      top: 4,
      right: 4,
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: theme.colors.primary.main,
    },
  }),
  sidebar: css({
    width: 260,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    paddingRight: theme.spacing(1),
    borderRight: `1px solid ${theme.colors.border.weak}`,
  }),
  sidebarHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }),
  sectionTitle: css({ margin: 0 }),
  listHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 24 }),
  scrollList: css({ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }),
  checkbox: css({ display: 'flex', marginBottom: theme.spacing(0.5) }),
  labelItem: css({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: theme.spacing(0.5, 1),
    borderRadius: theme.shape.radius.default,
    color: theme.colors.text.primary,
    '&:hover': { background: theme.colors.action.hover },
  }),
  labelItemSelected: css({ background: theme.colors.action.selected, fontWeight: theme.typography.fontWeightMedium }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  main: css({ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  listControls: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  }),
  search: css({ flexGrow: 1, maxWidth: 640 }),
  groupTitle: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1) }),
  group: css({
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1),
  }),
  groupHeader: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), marginBottom: theme.spacing(1) }),
  spacer: css({ flexGrow: 1 }),
  more: css({ display: 'flex', justifyContent: 'center', padding: theme.spacing(2) }),
});
