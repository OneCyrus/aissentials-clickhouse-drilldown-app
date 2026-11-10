import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  PanelBuilders,
  SceneByFrameRepeater,
  SceneComponentProps,
  SceneCSSGridLayout,
  SceneDataNode,
  SceneObject,
  SceneObjectBase,
  SceneObjectState,
  SceneObjectUrlSyncConfig,
  SceneObjectUrlValues,
  VizPanel,
  sceneGraph,
} from '@grafana/scenes';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  Icon,
  Input,
  LinkButton,
  MultiCombobox,
  RadioButtonGroup,
  Stack,
  Tab,
  TabsBar,
  useStyles2,
} from '@grafana/ui';
import {
  formatQuantile,
  generateMetricsQuery,
  getMetricFunctions,
  getSummaryQuantilesSql,
  MetricCatalogEntry,
  metricFunctionLabels,
  usesGroupBy,
  usesSeriesAggregation,
} from 'clickhouse/metrics';
import { toMetricLabelFilter } from 'clickhouse/filters';
import {
  FilterOperator,
  MetricFunction,
  MetricLabel,
  MetricQuery,
  MetricSeriesAggregation,
  MetricType,
  QueryType,
} from 'clickhouse/types';
import { PLUGIN_BASE_URL, ROUTES } from '../constants';
import {
  Control,
  copyCurrentUrl,
  exploreUrl,
  filtersSql,
  FilterLike,
  Format,
  frameRows,
  interpolate,
  getClickHouseDataSources,
  getSignalSource,
  LatestRequest,
  metricTableOf,
  headerButton,
  SignalSource,
  panelQueryRunner,
  queryRunner,
  runSql,
  searchMatches,
  SeriesSort,
  seriesName,
  seriesSortOptions,
  splitSeriesData,
  Spacer,
  sqlQuery,
  store,
  Toolbar,
  ToolbarGroup,
  supportsSignal,
} from '../shared';
import { countSql, logLinesSql, logsExpression } from '../logs-drilldown/sql';
import {
  defaultMetricQuery,
  FILTERS,
  getMetricLabelId,
  labelKeysSql,
  metricPrefix,
  metricSql,
  nameDistance,
  parseMetricLabelId,
  toMetricLabels,
} from './sql';
import { colorAt, metricGridItem, metricPanel } from './panels';
import { metricKindLabel, MetricsExploration } from './MetricsExploration';

type ActionView = 'breakdown' | 'related' | 'logs';
type BreakdownLayout = 'single' | 'grid' | 'rows';
type HistogramBreakdownFn = 'sum' | 'p99' | 'p95' | 'p75' | 'p50';
const ALL = '$__all';
const quantileChoices = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999];
const SORT_KEY = 'breakdown.sortby';
const MAX_OVERVIEW_SERIES = 20;

interface MetricSceneState extends SceneObjectState {
  entry: MetricCatalogEntry;
  query: MetricQuery;
  actionView: ActionView;
  /** Label id to break down by, or `$__all` for the overview of all labels. */
  groupBy: string;
  histogramFn: HistogramBreakdownFn;
  sort: SeriesSort;
  search: string;
  layout: BreakdownLayout;
  labels: MetricLabel[];
  summaryQuantiles: number[];
  relatedPrefix: string;
  relatedSearch: string;
  logsUid?: string;
  logsCount?: number;
  main?: VizPanel;
  body?: SceneObject;
}

/** Logs filter keys for the metric filters that logs share: the service and resource attributes. */
const logsFilterKey = (key: string): string | undefined => {
  const label = parseMetricLabelId(key);
  if (!label) {
    return undefined;
  }
  if (label.source === 'column' && label.key === 'ServiceName') {
    return 'resource.service.name';
  }
  return label.source === 'resource' ? `resource.${label.key}` : undefined;
};

/** One metric: the main panel with its function, then the breakdown, related metrics or related logs. */
export class MetricScene extends SceneObjectBase<MetricSceneState> {
  protected _urlSync = new SceneObjectUrlSyncConfig(this, {
    keys: [
      'actionView',
      'var-groupby',
      'var-histogramBreakdownFn',
      'breakdownLayout',
      'breakdownSearchText',
      'fn',
      'agg',
      'q',
      'metricPrefix',
      'relatedSearchText',
      'logsDs',
    ],
  });

  constructor(state: Pick<MetricSceneState, 'entry'> & Partial<MetricSceneState>) {
    super({
      query: defaultMetricQuery(state.entry),
      actionView: 'breakdown',
      groupBy: ALL,
      histogramFn: 'sum',
      sort: store.get<SeriesSort>(SORT_KEY, 'outliers'),
      search: '',
      layout: 'grid',
      labels: [],
      summaryQuantiles: [],
      relatedPrefix: 'all',
      relatedSearch: '',
      ...state,
    });
    this.addActivationHandler(() => {
      this.build();
      this.loadLabels();
    });
  }

  getUrlState(): SceneObjectUrlValues {
    const { query, actionView, groupBy, histogramFn, layout, search, relatedPrefix, relatedSearch, logsUid } =
      this.state;
    return {
      actionView,
      'var-groupby': groupBy,
      'var-histogramBreakdownFn': this.state.entry.type === MetricType.Histogram ? histogramFn : undefined,
      breakdownLayout: layout,
      breakdownSearchText: search || undefined,
      fn: query.fn,
      agg: query.aggregation,
      q: query.quantiles?.map(String),
      metricPrefix: relatedPrefix === 'all' ? undefined : relatedPrefix,
      relatedSearchText: relatedSearch || undefined,
      logsDs: logsUid,
    };
  }

  updateFromUrl(values: SceneObjectUrlValues) {
    const update: Partial<MetricSceneState> = {};
    if (values.actionView === 'related' || values.actionView === 'breakdown' || values.actionView === 'logs') {
      update.actionView = values.actionView;
    }
    if (typeof values['var-groupby'] === 'string') {
      update.groupBy = values['var-groupby'] || ALL;
    }
    if (typeof values['var-histogramBreakdownFn'] === 'string') {
      update.histogramFn = values['var-histogramBreakdownFn'] as HistogramBreakdownFn;
    }
    if (values.breakdownLayout === 'single' || values.breakdownLayout === 'grid' || values.breakdownLayout === 'rows') {
      update.layout = values.breakdownLayout;
    }
    if ('breakdownSearchText' in values) {
      update.search = values.breakdownSearchText ? String(values.breakdownSearchText) : '';
    }
    const functions = getMetricFunctions(this.state.entry.type, this.state.entry.isMonotonic);
    let query = this.state.query;
    if (typeof values.fn === 'string' && functions.includes(values.fn as MetricFunction)) {
      query = { ...query, fn: values.fn as MetricFunction };
    }
    if (typeof values.agg === 'string') {
      query = { ...query, aggregation: values.agg as MetricSeriesAggregation };
    }
    if (values.q) {
      query = {
        ...query,
        quantiles: (Array.isArray(values.q) ? values.q : [values.q]).map(Number).filter(Number.isFinite),
      };
    }
    update.query = query;
    if ('metricPrefix' in values) {
      update.relatedPrefix = values.metricPrefix ? String(values.metricPrefix) : 'all';
    }
    if ('relatedSearchText' in values) {
      update.relatedSearch = values.relatedSearchText ? String(values.relatedSearchText) : '';
    }
    if (typeof values.logsDs === 'string') {
      update.logsUid = values.logsDs;
    }
    this.setState(update);
    if (this.isActive) {
      this.build();
    }
  }

  getExploration(): MetricsExploration {
    return sceneGraph.getAncestor(this, MetricsExploration);
  }

  /** The metric's labels and summary quantiles; a filter or range change supersedes the request. */
  private labelsRequest = new LatestRequest();
  /** The related logs count; switching the logs data source or the filters supersedes it. */
  private logsCountRequest = new LatestRequest();

  async loadLabels() {
    const isCurrent = this.labelsRequest.start();
    const source = await this.getExploration()
      .loadSource()
      .catch(() => undefined);
    if (!source) {
      return;
    }
    const { entry } = this.state;
    const [keys, quantiles] = await Promise.all([
      runSql(this, labelKeysSql(source, '1 = 1', entry)).catch(() => []),
      entry.type === MetricType.Summary
        ? runSql(this, getSummaryQuantilesSql(source.database, metricTableOf(source, entry.type), entry.name)).catch(
            () => []
          )
        : Promise.resolve([]),
    ]);
    if (!isCurrent()) {
      return;
    }
    const labels = toMetricLabels(frameRows<{ source: string; key: string }>(keys));
    const summaryQuantiles = frameRows<{ quantile: number }>(quantiles)
      .map((row) => Number(row.quantile))
      .filter((q) => q > 0 && q < 1);
    this.setState({ labels, summaryQuantiles });
    this.build();
  }

  setQuery(update: Partial<MetricQuery>) {
    let query = { ...this.state.query, ...update };
    if (update.fn && update.fn !== this.state.query.fn) {
      query = { ...defaultMetricQuery(this.state.entry, query), fn: update.fn };
      if (update.fn === MetricFunction.Quantile) {
        query.quantiles =
          this.state.entry.type === MetricType.Summary && this.state.summaryQuantiles.length
            ? this.state.summaryQuantiles.slice(-3)
            : [0.5, 0.9, 0.99];
      }
    }
    this.setState({ query });
    this.build();
  }

  setView(
    update: Partial<
      Pick<
        MetricSceneState,
        | 'groupBy'
        | 'sort'
        | 'search'
        | 'layout'
        | 'actionView'
        | 'histogramFn'
        | 'relatedPrefix'
        | 'relatedSearch'
        | 'logsUid'
      >
    >
  ) {
    if (update.sort) {
      store.set(SORT_KEY, update.sort);
    }
    this.setState(update);
    this.build();
  }

  /** Adds a label filter to the filter bar, like the "Add to filters" buttons of Metrics Drilldown. */
  addFilter(label: MetricLabel, value: string) {
    const variable = this.getExploration().getFiltersVariable();
    if (!variable) {
      return;
    }
    const key = getMetricLabelId(label);
    const others = variable.state.filters.filter((filter) => filter.key !== key);
    // Filters change the label values, so the breakdown starts over at All.
    this.setState({ groupBy: ALL });
    variable.updateFilters([...others, { key, operator: '=', value }]);
  }

  /** The query of the breakdown panels: histograms use the histogram breakdown function. */
  breakdownQuery(groupBy: MetricLabel[]): MetricQuery {
    const { query, entry, histogramFn } = this.state;
    if (entry.type === MetricType.Histogram) {
      return histogramFn === 'sum'
        ? {
            ...query,
            fn: MetricFunction.SumRate,
            groupBy,
            quantiles: undefined,
            aggregation: MetricSeriesAggregation.Sum,
          }
        : { ...query, fn: MetricFunction.Quantile, groupBy, quantiles: [Number(histogramFn.slice(1)) / 100] };
    }
    return { ...query, groupBy, quantiles: query.quantiles?.slice(0, 1) };
  }

  relatedMetrics(): MetricCatalogEntry[] {
    const { entry, relatedPrefix, relatedSearch } = this.state;
    const matches = searchMatches(relatedSearch);
    return this.getExploration()
      .state.catalog.filter(
        (other) => (relatedPrefix === 'all' || metricPrefix(other.name) === relatedPrefix) && matches(other.name)
      )
      .map((other) => ({ other, distance: nameDistance(other.name, entry.name) }))
      .sort((a, b) => a.distance - b.distance)
      .map(({ other }) => other);
  }

  /** The filter bar's filters that logs share, as logs filters. */
  relatedLogsFilters(): FilterLike[] {
    const variable = this.getExploration().getFiltersVariable();
    return ((variable?.state.filters || []) as FilterLike[]).flatMap((filter) => {
      const key = logsFilterKey(filter.key);
      return key ? [{ ...filter, key }] : [];
    });
  }

  logsSources() {
    return getClickHouseDataSources('logs').filter((settings) => supportsSignal(settings, 'logs'));
  }

  /** Builds the main panel and the body for the current state. */
  build() {
    const exploration = this.getExploration();
    const source = exploration.getSource();
    if (!source) {
      return;
    }
    const { entry, query, actionView, groupBy, labels, layout } = this.state;
    const multi = query.fn === MetricFunction.Quantile && (query.quantiles?.length || 0) > 1;
    const main = metricPanel(source, entry, { ...query, groupBy: [] }, { legend: multi, maxDataPoints: 500 })
      .setTitle(entry.name)
      .setDescription(
        `${entry.description}${entry.description ? ' ' : ''}(${metricKindLabel(entry)}${entry.unit ? `, ${entry.unit}` : ''})`
      )
      .build();

    let body: SceneObject | undefined;
    const columns = layout === 'rows' ? '1fr' : 'repeat(auto-fit, minmax(400px, 1fr))';
    if (actionView === 'related') {
      body = new SceneCSSGridLayout({
        templateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
        autoRows: '220px',
        isLazy: true,
        children: this.relatedMetrics()
          .slice(0, 120)
          .map((other, index) => metricGridItem(source, other, index, () => exploration.selectMetric(other))),
      });
    } else if (actionView === 'logs') {
      body = this.buildRelatedLogs();
    } else if (!usesGroupBy(query.fn) && groupBy === ALL && entry.type !== MetricType.Histogram) {
      body = undefined;
    } else if (groupBy === ALL) {
      // Overview: one panel per label, each the metric split by that label (first 20 series).
      body = new SceneCSSGridLayout({
        templateColumns: columns,
        autoRows: '220px',
        isLazy: true,
        children: labels.slice(0, 60).map((label) => {
          const runner = panelQueryRunner([sqlQuery('A', metricSql(source, this.breakdownQuery([label])))], 250);
          return metricPanel(source, entry, this.breakdownQuery([label]), { title: label.key, legend: false })
            .setData(
              splitSeriesData(
                runner,
                () => 'outliers',
                () => '',
                MAX_OVERVIEW_SERIES
              )
            )
            .setDescription(
              `${entry.name} by ${label.key} (${label.source}). Shows up to ${MAX_OVERVIEW_SERIES} series.`
            )
            .setHeaderActions(headerButton('Select', () => this.setView({ groupBy: getMetricLabelId(label) })))
            .build();
        }),
      });
    } else {
      const label = parseMetricLabelId(groupBy);
      if (label) {
        const breakdown = this.breakdownQuery([label]);
        const runner = queryRunner([sqlQuery('A', metricSql(source, breakdown))], 250);
        const data = splitSeriesData(
          runner,
          () => this.state.sort,
          () => this.state.search
        );
        if (layout === 'single') {
          body = metricPanel(source, entry, breakdown, { title: `${entry.name} by ${label.key}`, legend: true })
            .setData(
              splitSeriesData(
                runner,
                () => this.state.sort,
                () => this.state.search,
                MAX_OVERVIEW_SERIES
              )
            )
            .build();
        } else {
          body = new SceneByFrameRepeater({
            $data: data,
            body: new SceneCSSGridLayout({ templateColumns: columns, autoRows: '220px', isLazy: true, children: [] }),
            getLayoutChild: (panelData, frame, index) => {
              const value = seriesName(frame);
              const panel = metricPanel(source, entry, breakdown, {
                title: value || '<unspecified label>',
                color: colorAt(index),
              }).setData(new SceneDataNode({ data: { ...panelData, series: [frame] } }));
              if (value) {
                panel.setHeaderActions(headerButton('Add to filters', () => this.addFilter(label, value)));
              }
              return panel.build();
            },
          });
        }
      }
    }
    this.setState({ main, body });
    if (actionView !== 'logs') {
      this.countRelatedLogs();
    }
  }

  /** The logs source and condition of the related logs, when the metric's filters apply to logs. */
  private relatedLogsQuery(): { uid: string; logsSource: SignalSource; condition: string } | undefined {
    const filters = this.relatedLogsFilters();
    const uid = this.state.logsUid || this.logsSources()[0]?.uid;
    const logsSource = uid ? getSignalSource(uid, 'logs') : undefined;
    if (!uid || !filters.length || !logsSource) {
      return undefined;
    }
    return { uid, logsSource, condition: filtersSql(filters, logsExpression) };
  }

  private buildRelatedLogs(): SceneObject | undefined {
    const query = this.relatedLogsQuery();
    if (!query) {
      return undefined;
    }
    const { uid, logsSource, condition } = query;
    return PanelBuilders.logs()
      .setTitle('Logs')
      .setData(queryRunner([sqlQuery('A', logLinesSql(logsSource, condition, 100), Format.Logs, uid)]))
      .setOption('showTime', true)
      .setOption('enableLogDetails', true)
      .build();
  }

  /** Counts the related log lines in the background for the tab's badge. */
  async countRelatedLogs() {
    const isCurrent = this.logsCountRequest.start();
    const query = this.relatedLogsQuery();
    if (!query) {
      this.setState({ logsCount: undefined });
      return;
    }
    const { uid, logsSource, condition } = query;
    // The badge shows no count until the new one arrives, rather than the previous filters' count.
    this.setState({ logsCount: undefined });
    try {
      const rows = frameRows<{ count: number }>(await runSql(this, countSql(logsSource, condition), Format.Table, uid));
      if (isCurrent()) {
        this.setState({ logsCount: Number(rows[0]?.count || 0) });
      }
    } catch {
      if (isCurrent()) {
        this.setState({ logsCount: undefined });
      }
    }
  }

  logsDrilldownUrl(): string {
    const params = new URLSearchParams();
    const uid = this.state.logsUid || this.logsSources()[0]?.uid;
    if (uid) {
      params.set('var-ds', uid);
    }
    const range = sceneGraph.getTimeRange(this).state;
    params.set('from', range.from);
    params.set('to', range.to);
    this.relatedLogsFilters().forEach((filter) =>
      params.append('var-filters', `${filter.key}|${filter.operator}|${filter.value}`)
    );
    return `${PLUGIN_BASE_URL}/${ROUTES.Logs}?${params}`;
  }

  openInExplore() {
    const source = this.getExploration().getSource();
    if (!source) {
      return;
    }
    const filters = (this.getExploration().getFiltersVariable()?.state.filters || []) as FilterLike[];
    const operators: Record<string, FilterOperator> = {
      '=': FilterOperator.Equals,
      '!=': FilterOperator.NotEquals,
      '=|': FilterOperator.In,
      '!=|': FilterOperator.NotIn,
    };
    const builderFilters = filters.flatMap((filter) => {
      const label = parseMetricLabelId(filter.key);
      const operator = operators[filter.operator];
      if (!label || !operator) {
        return [];
      }
      const multi = operator === FilterOperator.In || operator === FilterOperator.NotIn;
      return [toMetricLabelFilter(label, operator, multi ? filter.values || [filter.value] : filter.value)];
    });
    const builderOptions = {
      database: source.database,
      table: metricTableOf(source, this.state.entry.type),
      queryType: QueryType.TimeSeries,
      metric: { ...this.state.query, groupBy: [] },
      filters: builderFilters,
    };
    // The SQL with the filter bar's condition; the data source's editor rebuilds it from the builder options.
    const rawSql = generateMetricsQuery({
      database: builderOptions.database,
      table: builderOptions.table,
      metric: { ...builderOptions.metric, condition: interpolate(this, FILTERS) },
    });
    window.open(exploreUrl(this, [{ editorType: 'builder', builderOptions, rawSql, format: 0 }]), '_blank');
  }

  static Component = MetricSceneRenderer;
}

function MetricSceneRenderer({ model }: SceneComponentProps<MetricScene>) {
  const styles = useStyles2(getStyles);
  const state = model.useState();
  const { entry, query, main, body, actionView, groupBy, labels, sort, search, layout, summaryQuantiles } = state;
  const { histogramFn, relatedPrefix, relatedSearch, logsCount, logsUid } = state;
  const exploration = model.getExploration();
  const { catalog } = exploration.useState();
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  useEffect(() => {
    if (searchText === search) {
      return;
    }
    const timer = setTimeout(() => model.setView({ search: searchText }), 250);
    return () => clearTimeout(timer);
  }, [searchText, search, model]);

  const functions = getMetricFunctions(entry.type, entry.isMonotonic);
  const quantileOptions = (
    entry.type === MetricType.Summary && summaryQuantiles.length ? summaryQuantiles : quantileChoices
  ).map((q) => ({ label: formatQuantile(q), value: String(q) }));
  const groupOptions = [
    { label: 'All', value: ALL },
    ...labels.map((label) => ({ label: label.key, value: getMetricLabelId(label), description: label.source })),
  ];
  const breakdownable = usesGroupBy(query.fn) || entry.type === MetricType.Histogram;
  const prefixes = Array.from(new Set(catalog.map((other) => metricPrefix(other.name)))).sort();
  const logsSources = model.logsSources();

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Stack direction="row" alignItems="center" gap={1} wrap="wrap">
          <h3 className={styles.title}>{entry.name}</h3>
          <Badge color="purple" text={metricKindLabel(entry)} />
          {entry.unit && <Badge color="blue" text={entry.unit} />}
        </Stack>
        <Stack direction="row" gap={1}>
          <Button
            variant="secondary"
            size="sm"
            icon="arrow-left"
            tooltip="Remove existing metric and choose a new metric"
            onClick={() => exploration.selectMetric(undefined)}
          >
            Select new metric
          </Button>
          <Button variant="secondary" size="sm" icon="compass" onClick={() => model.openInExplore()}>
            Explore
          </Button>
          <Button variant="secondary" size="sm" icon="share-alt" tooltip="Copy URL" onClick={() => copyCurrentUrl()} />
        </Stack>
      </div>

      <Toolbar>
        <Control label="Function" tooltip="What is computed per series, as a PromQL function would">
          <RadioButtonGroup
            options={functions.map((fn) => ({
              label: metricFunctionLabels[fn].label,
              value: fn,
              description: metricFunctionLabels[fn].description,
            }))}
            value={query.fn}
            onChange={(fn) => model.setQuery({ fn })}
          />
        </Control>
        {query.fn === MetricFunction.Quantile && (
          <Control label="Quantiles">
            <MultiCombobox
              aria-label="Quantiles"
              options={quantileOptions}
              value={(query.quantiles || []).map(String)}
              onChange={(options) =>
                model.setQuery({ quantiles: options.map((o) => Number(o.value)).sort((a, b) => a - b) })
              }
              width="auto"
              minWidth={16}
            />
          </Control>
        )}
        {usesSeriesAggregation(entry.type, query.fn) && (
          <Control label="Aggregate" tooltip="How the series are combined">
            <RadioButtonGroup
              options={['sum', 'avg', 'min', 'max'].map((agg) => ({
                label: agg,
                value: agg as MetricSeriesAggregation,
              }))}
              value={query.aggregation}
              onChange={(aggregation) => model.setQuery({ aggregation })}
            />
          </Control>
        )}
      </Toolbar>

      <div className={styles.mainPanel}>{main && <main.Component model={main} />}</div>

      <TabsBar>
        <Tab
          label="Breakdown"
          active={actionView === 'breakdown'}
          onChangeTab={() => model.setView({ actionView: 'breakdown' })}
        />
        <Tab
          label="Related metrics"
          active={actionView === 'related'}
          onChangeTab={() => model.setView({ actionView: 'related' })}
        />
        <Tab
          label="Related logs"
          counter={logsCount}
          active={actionView === 'logs'}
          onChangeTab={() => model.setView({ actionView: 'logs' })}
        />
      </TabsBar>

      {actionView === 'breakdown' && breakdownable && (
        <Toolbar>
          <Control label="Group by" tooltip="Break the metric down by the values of a label">
            {groupOptions.length <= 4 ? (
              <RadioButtonGroup
                options={groupOptions}
                value={groupBy}
                onChange={(value) => model.setView({ groupBy: value })}
              />
            ) : (
              <Combobox
                aria-label="Group by"
                placeholder="Select a label to group by"
                options={groupOptions}
                value={groupBy}
                onChange={(option) => model.setView({ groupBy: option?.value || ALL })}
                isClearable
                width={32}
              />
            )}
          </Control>
          {entry.type === MetricType.Histogram && (
            <Control
              label="Breakdown function"
              tooltip="Sum: observations per second; pNN: the quantile of each label value"
            >
              <RadioButtonGroup
                options={(['sum', 'p99', 'p95', 'p75', 'p50'] as HistogramBreakdownFn[]).map((fn) => ({
                  label: fn === 'sum' ? 'Sum' : fn,
                  value: fn,
                }))}
                value={histogramFn}
                onChange={(value) => model.setView({ histogramFn: value })}
              />
            </Control>
          )}
          <ToolbarGroup>
            {groupBy !== ALL && (
              <>
                <Input
                  prefix={<Icon name="search" />}
                  placeholder="Quick search label values"
                  aria-label="Quick search label values"
                  value={searchText}
                  onChange={(e) => setSearchText(e.currentTarget.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setSearchText('')}
                  width={30}
                />
                <Control label="Sort by" tooltip="Sorts values using standard or smart time series calculations.">
                  <Combobox
                    aria-label="Sort by"
                    placeholder="Choose criteria"
                    options={seriesSortOptions}
                    value={sort}
                    onChange={(option) => model.setView({ sort: option.value })}
                    width={20}
                  />
                </Control>
              </>
            )}
            <RadioButtonGroup
              aria-label="View"
              options={(groupBy === ALL ? ['grid', 'rows'] : ['single', 'grid', 'rows']).map((value) => ({
                value: value as BreakdownLayout,
                label: value[0].toUpperCase() + value.slice(1),
              }))}
              value={groupBy === ALL && layout === 'single' ? 'grid' : layout}
              onChange={(value) => model.setView({ layout: value })}
            />
          </ToolbarGroup>
        </Toolbar>
      )}
      {actionView === 'breakdown' && !breakdownable && (
        <p className={styles.note}>A heatmap shows all series together; pick another function to break it down.</p>
      )}
      {actionView === 'breakdown' && breakdownable && groupBy === ALL && !labels.length && (
        <Alert severity="info" title="No labels found for the current filters and time range." />
      )}

      {actionView === 'related' && (
        <Toolbar>
          <Control label="View by" tooltip="Metrics with this name prefix">
            <Combobox
              aria-label="View by prefix"
              options={[
                { label: 'All metric names', value: 'all' },
                ...prefixes.map((prefix) => ({ label: prefix, value: prefix })),
              ]}
              value={relatedPrefix}
              onChange={(option) => model.setView({ relatedPrefix: option.value })}
              width={24}
            />
          </Control>
          <Input
            prefix={<Icon name="search" />}
            placeholder="Search related metrics"
            aria-label="Search related metrics"
            value={relatedSearch}
            onChange={(e) => model.setView({ relatedSearch: e.currentTarget.value })}
            width={32}
          />
        </Toolbar>
      )}

      {actionView === 'logs' && (
        <>
          <Toolbar>
            <Control label="Logs data source" tooltip="ClickHouse data sources with OpenTelemetry logs">
              <Combobox
                aria-label="Logs data source"
                options={logsSources.map((settings) => ({ label: settings.name, value: settings.uid }))}
                value={logsUid || logsSources[0]?.uid || null}
                onChange={(option) => model.setView({ logsUid: option.value })}
                width={28}
              />
            </Control>
            <Spacer />
            <LinkButton
              variant="secondary"
              icon="external-link-alt"
              href={model.logsDrilldownUrl()}
              tooltip="Explore these logs on the Logs page"
            >
              Open in Logs
            </LinkButton>
          </Toolbar>
          {!body && (
            <Alert severity="info" title="No related logs found">
              Logs are matched to the metric by the filters they share: the service and resource attributes such as
              k8s.pod.name. Add such a filter, or check that a ClickHouse data source holds OpenTelemetry logs.
            </Alert>
          )}
        </>
      )}
      {body && (
        <div
          className={actionView === 'logs' || (layout === 'single' && groupBy !== ALL) ? styles.tallBody : undefined}
        >
          <body.Component model={body} />
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), width: '100%', flexGrow: 1 }),
  header: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.spacing(1),
    flexWrap: 'wrap',
  }),
  title: css({ margin: 0 }),
  mainPanel: css({ height: 'max(280px, 30vh)', flexShrink: 0 }),
  note: css({ color: theme.colors.text.secondary }),
  tallBody: css({ height: 'max(420px, calc(100vh - 560px))' }),
});
