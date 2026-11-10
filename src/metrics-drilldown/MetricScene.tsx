import React from 'react';
import {
  PanelBuilders,
  SceneByFrameRepeater,
  SceneCSSGridLayout,
  SceneDataNode,
  SceneObject,
  SceneObjectBase,
  SceneObjectState,
  SceneObjectUrlSyncConfig,
  SceneObjectUrlValues,
  VizPanel,
  sceneGraph,
  SceneReactObject,
} from '@grafana/scenes';
import {
  generateMetricsQuery,
  getMetricFunctions,
  getSummaryQuantilesSql,
  MetricCatalogEntry,
  usesGroupBy,
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
  exploreUrl,
  filtersSql,
  FilterLike,
  Format,
  frameRows,
  interpolate,
  getClickHouseDataSources,
  getSignalSource,
  loadSignalSource,
  LatestRequest,
  LOADING,
  LoadStatus,
  metricTableOf,
  headerButton,
  SignalSource,
  panelQueryRunner,
  queryRunner,
  runSql,
  searchMatches,
  SeriesSort,
  seriesName,
  splitSeriesData,
  sqlQuery,
  store,
  supportsSignal,
  oneOf,
  probabilities,
  LoadState,
  DONE,
  loadFailed,
} from '../shared';
import { countSql, logLinesSql, logsKeyExpression } from '../logs-drilldown/sql';
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
import { MetricsExploration } from './MetricsExploration';
import { metricKindLabel } from './MetricsExplorationView';
import { ALL, MetricSceneRenderer } from './MetricSceneView';

type ActionView = 'breakdown' | 'related' | 'logs';
export type BreakdownLayout = 'single' | 'grid' | 'rows';
const histogramFns = ['sum', 'p99', 'p95', 'p75', 'p50'] as const;
export type HistogramBreakdownFn = (typeof histogramFns)[number];
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
  /** The metric's label names for the breakdown. */
  labelsLoad: LoadState;
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
      labelsLoad: DONE,
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
    const histogramFn = oneOf(values['var-histogramBreakdownFn'], histogramFns);
    if (histogramFn) {
      update.histogramFn = histogramFn;
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
    // The aggregation is an SQL function name and the quantiles go into quantile(), so only the
    // values the app offers are taken.
    const aggregation = oneOf(values.agg, Object.values(MetricSeriesAggregation));
    if (aggregation) {
      query = { ...query, aggregation };
    }
    if (values.q) {
      const quantiles = probabilities(Array.isArray(values.q) ? values.q : [values.q]);
      if (quantiles.length) {
        query = { ...query, quantiles };
      }
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
  private logsSourceRequest = new LatestRequest();
  /** Logs data sources whose shape detection the logs tab has started, so it waits for it once. */
  private logsShapeTried = new Set<string>();

  async loadLabels() {
    const isCurrent = this.labelsRequest.start();
    const source = await this.getExploration()
      .loadSource()
      // The metric list shows a failed source lookup as its own error; the labels have nothing to add.
      .catch(() => undefined);
    if (!source) {
      return;
    }
    const { entry } = this.state;
    this.setState({ labelsLoad: LOADING });
    const [keys, quantiles] = await Promise.all([
      runSql(this, labelKeysSql(source, '1 = 1', entry), Format.Table, {
        requestId: this.labelsRequest.requestId('labels'),
      }).then(
        (frames) => ({ frames, error: undefined }),
        (error: unknown) => ({ frames: [], error })
      ),
      entry.type === MetricType.Summary
        ? runSql(
            this,
            getSummaryQuantilesSql(source.database, metricTableOf(source, entry.type), entry.name),
            Format.Table,
            {
              requestId: this.labelsRequest.requestId('quantiles'),
            }
          )
            // The quantiles a summary reports only refine the quantile choices; the defaults stay.
            .catch(() => [])
        : Promise.resolve([]),
    ]);
    if (!isCurrent()) {
      return;
    }
    // Without the attribute keys the breakdown still has the column labels; the error shows above it.
    const labels = toMetricLabels(frameRows<{ source: string; key: string }>(keys.frames));
    const summaryQuantiles = frameRows<{ quantile: number }>(quantiles)
      .map((row) => Number(row.quantile))
      .filter((q) => q > 0 && q < 1);
    this.setState({ labels, summaryQuantiles, labelsLoad: keys.error ? loadFailed(keys.error) : DONE });
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
    return { uid, logsSource, condition: filtersSql(filters, logsKeyExpression(logsSource)) };
  }

  /**
   * Detects the logs table's attribute shape (JSON or Map) before the related logs query it, and
   * rebuilds the logs tab once it is known.
   */
  private async loadRelatedLogsSource(uid: string) {
    const isCurrent = this.logsSourceRequest.start();
    await loadSignalSource(this, uid, 'logs');
    if (isCurrent() && this.state.actionView === 'logs') {
      this.build();
    }
  }

  private buildRelatedLogs(): SceneObject | undefined {
    const query = this.relatedLogsQuery();
    if (!query) {
      return undefined;
    }
    const { uid, logsSource, condition } = query;
    if (!logsSource.attributeShapeKnown && !this.logsShapeTried.has(uid)) {
      // The query depends on the shape; the tab is built again once it is known (or, if the
      // detection fails, with the Map form).
      this.logsShapeTried.add(uid);
      this.loadRelatedLogsSource(uid);
      return new SceneReactObject({
        reactNode: <LoadStatus state={LOADING} loadingText="Loading logs…" errorTitle="Error while loading logs" />,
      });
    }
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
    const logsUid = this.state.logsUid || this.logsSources()[0]?.uid;
    if (logsUid) {
      // The count's condition depends on the logs table's attribute shape.
      await loadSignalSource(this, logsUid, 'logs');
      if (!isCurrent()) {
        return;
      }
    }
    const query = this.relatedLogsQuery();
    if (!query) {
      this.setState({ logsCount: undefined });
      return;
    }
    const { uid, logsSource, condition } = query;
    // The badge shows no count until the new one arrives, rather than the previous filters' count.
    this.setState({ logsCount: undefined });
    try {
      const rows = frameRows<{ count: number }>(
        await runSql(this, countSql(logsSource, condition), Format.Table, {
          datasourceUid: uid,
          requestId: this.logsCountRequest.requestId(),
        })
      );
      if (isCurrent()) {
        this.setState({ logsCount: Number(rows[0]?.count || 0) });
      }
    } catch {
      // The count is a badge on the Related logs tab: without it the tab shows none.
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
