import React from 'react';
import { DataFrame, FieldType } from '@grafana/data';
import {
  AdHocFiltersVariable,
  PanelBuilders,
  SceneByFrameRepeater,
  SceneComponentProps,
  SceneCSSGridLayout,
  SceneDataNode,
  SceneDataTransformer,
  SceneObject,
  SceneObjectBase,
  SceneObjectState,
  SceneObjectUrlSyncConfig,
  SceneObjectUrlValues,
  TextBoxVariable,
  VariableDependencyConfig,
  VizPanel,
  sceneGraph,
} from '@grafana/scenes';
import { Button } from '@grafana/ui';
import { LegendDisplayMode, StackingMode, TooltipDisplayMode } from '@grafana/schema';
import { map } from 'rxjs';
import { toHeatmapFrame } from 'clickhouse/heatmap';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import {
  Format,
  frameRows,
  getSignalSource,
  loadSignalSource,
  loadTraceIndex,
  interpolate,
  queryRunner,
  runSql,
  searchMatches,
  SignalSource,
  sqlQuery,
  DONE,
  LatestRequest,
  LoadState,
  loadFailed,
  LOADING,
  oneOf,
  probabilities,
} from '../shared';
import { refreshFilterExpression } from '../shared/scene';
import {
  attributeKeysSql,
  breakdownSql,
  comparisonSql,
  durationBucketsSql,
  durationHeatmapSql,
  ERROR_CONDITION,
  exceptionsSql,
  FILTERS,
  MetricType,
  PRIMARY,
  primarySignals,
  primarySignalSql,
  rateSql,
  selectionSql,
  SERVICE_KEY,
  slowestQuarterThreshold,
  spanListSql,
  traceSql,
  VAR_PRIMARY,
} from './sql';
import {
  ALL,
  ComparisonAttribute,
  getFavorites,
  groupExceptions,
  SpanRow,
  toComparison,
  ComparisonRow,
} from './components';
import { metricTitles, TracesView } from './TracesExplorationView';

const actionViews = ['breakdown', 'comparison', 'exceptions', 'traceList'] as const;
type ActionView = (typeof actionViews)[number];
const layouts = ['single', 'grid', 'rows'] as const;
export type Layout = (typeof layouts)[number];

interface TracesExplorationState extends SceneObjectState {
  primarySignal: string;
  metric: MetricType;
  actionView: ActionView;
  groupBy: string;
  comparisonBy: string;
  percentiles: number[];
  layout: Layout;
  search: string;
  hideBaselineOnly: boolean;
  spanListColumns: string[];
  /** Duration comparison selection: spans at least this slow, in seconds. Auto = slowest quarter. */
  threshold?: number;
  thresholdAuto: boolean;
  traceId?: string;
  attributes: string[];
  /** The attribute list of the sidebars. */
  attributesLoad: LoadState;
  comparison: ComparisonAttribute[];
  exceptions: ReturnType<typeof groupExceptions>;
  spans: SpanRow[];
  /** The current tab's data (comparison, exceptions, span list); the page's error without a data source. */
  bodyLoad: LoadState;
  ratePanel?: VizPanel;
  errorsPanel?: VizPanel;
  durationPanel?: VizPanel;
  body?: SceneObject;
  trace?: VizPanel;
}

const metricColors: Record<MetricType, string> = { rate: 'blue', errors: 'semi-dark-red', duration: '#FF9930' };

/**
 * Traces Drilldown for the OTel exporter's traces table: RED metrics of a span set (primary signal
 * and filters), then Breakdown, Comparison (selection vs baseline), Exceptions and the trace list.
 */
export class TracesExploration extends SceneObjectBase<TracesExplorationState> {
  protected _urlSync = new SceneObjectUrlSyncConfig(this, {
    keys: [
      'var-primarySignal',
      'var-metric',
      'actionView',
      'var-groupBy',
      'comparisonBy',
      'var-durationPercentiles',
      'layout',
      'var-spanListColumns',
      'selection',
      'traceId',
    ],
  });

  protected _variableDependency = new VariableDependencyConfig(this, {
    variableNames: [VAR_DATASOURCE, VAR_FILTERS],
    onReferencedVariableValueChanged: () => this.refresh(true),
  });

  constructor(state: Partial<TracesExplorationState> = {}) {
    super({
      primarySignal: 'root',
      metric: 'rate',
      actionView: 'breakdown',
      groupBy: getFavorites()[0] || SERVICE_KEY,
      comparisonBy: ALL,
      percentiles: [0.9],
      layout: 'grid',
      search: '',
      hideBaselineOnly: false,
      spanListColumns: [],
      thresholdAuto: true,
      attributes: [],
      attributesLoad: DONE,
      comparison: [],
      exceptions: [],
      spans: [],
      bodyLoad: DONE,
      ...state,
    });
    this.addActivationHandler(() => {
      this.syncPrimary();
      this.refresh(true);
      const timeRange = sceneGraph.getTimeRange(this).subscribeToState(() => this.refresh(true));
      return () => timeRange.unsubscribe();
    });
  }

  getUrlState(): SceneObjectUrlValues {
    const s = this.state;
    return {
      'var-primarySignal': s.primarySignal,
      'var-metric': s.metric,
      actionView: s.actionView,
      'var-groupBy': s.groupBy,
      comparisonBy: s.comparisonBy === ALL ? undefined : s.comparisonBy,
      'var-durationPercentiles': s.metric === 'duration' ? s.percentiles.map(String) : undefined,
      layout: s.layout === 'grid' ? undefined : s.layout,
      'var-spanListColumns': s.spanListColumns.length ? s.spanListColumns : undefined,
      selection: s.metric === 'duration' && !s.thresholdAuto && s.threshold ? String(s.threshold) : undefined,
      traceId: s.traceId,
    };
  }

  updateFromUrl(values: SceneObjectUrlValues) {
    const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : value ? [String(value)] : []);
    const update: Partial<TracesExplorationState> = {};
    const primarySignal = oneOf(
      values['var-primarySignal'],
      primarySignals.map((signal) => signal.value)
    );
    if (primarySignal) {
      update.primarySignal = primarySignal;
    }
    if (values['var-metric'] === 'rate' || values['var-metric'] === 'errors' || values['var-metric'] === 'duration') {
      update.metric = values['var-metric'];
    }
    if (typeof values.actionView === 'string') {
      // An unknown tab falls back to the default one.
      update.actionView = oneOf(values.actionView, actionViews) ?? 'breakdown';
    }
    if (typeof values['var-groupBy'] === 'string') {
      update.groupBy = values['var-groupBy'];
    }
    if ('comparisonBy' in values) {
      update.comparisonBy = values.comparisonBy ? String(values.comparisonBy) : ALL;
    }
    if (values['var-durationPercentiles']) {
      // Percentiles reach quantilesTDigest, which takes only levels between 0 and 1.
      const percentiles = probabilities(list(values['var-durationPercentiles']));
      if (percentiles.length) {
        update.percentiles = percentiles;
      }
    }
    if ('layout' in values) {
      update.layout = oneOf(values.layout, layouts) ?? 'grid';
    }
    if ('var-spanListColumns' in values) {
      update.spanListColumns = list(values['var-spanListColumns']);
    }
    if ('selection' in values) {
      const threshold = Number(values.selection);
      update.thresholdAuto = !values.selection || !Number.isFinite(threshold);
      update.threshold = update.thresholdAuto ? this.state.threshold : threshold;
    }
    if ('traceId' in values) {
      update.traceId = values.traceId ? String(values.traceId) : undefined;
    }
    this.setState(update);
    this.syncPrimary();
    if (this.isActive) {
      this.refresh(true);
    }
  }

  getSource(): SignalSource | undefined {
    return getSignalSource(interpolate(this, `\${${VAR_DATASOURCE}}`), 'traces');
  }

  getFiltersVariable() {
    const variable = sceneGraph.lookupVariable(VAR_FILTERS, this);
    return variable instanceof AdHocFiltersVariable ? variable : undefined;
  }

  /** Detects the table's attribute shape (JSON or Map) once per data source; the queries depend on it. */
  async loadSource(): Promise<SignalSource | undefined> {
    const source = await loadSignalSource(this, interpolate(this, `\${${VAR_DATASOURCE}}`), 'traces');
    // The filter bar renders its SQL when its filters change, e.g. from the URL before the shape
    // was known; render it again for this table's shape.
    refreshFilterExpression(this.getFiltersVariable());
    return source;
  }

  syncPrimary() {
    const variable = sceneGraph.lookupVariable(VAR_PRIMARY, this);
    const sql = primarySignalSql(this.state.primarySignal, this.getSource());
    if (variable instanceof TextBoxVariable && variable.getValue() !== sql) {
      variable.setValue(sql);
    }
  }

  /** Rebuilds what depends on the span set; `all` also reloads attributes and the duration selection. */
  async refresh(all = false) {
    const isSourceCurrent = this.sourceRequest.start();
    const source = await this.loadSource();
    if (!isSourceCurrent()) {
      return;
    }
    if (!source) {
      this.setState({ bodyLoad: loadFailed('Pick a ClickHouse data source with OpenTelemetry traces.') });
      return;
    }
    // The database signal reads an attribute, so its condition follows the table shape.
    this.syncPrimary();
    this.buildPanels(source);
    if (all) {
      const isCurrent = this.attributesRequest.start();
      this.setState({ attributesLoad: LOADING });
      const [keys, buckets] = await Promise.all([
        runSql(this, attributeKeysSql(source, `${PRIMARY} AND ${FILTERS}`), Format.Table, {
          requestId: this.attributesRequest.requestId('keys'),
        }).then(
          (frames) => ({ frames, error: undefined }),
          (error: unknown) => ({ frames: [], error })
        ),
        runSql(this, durationBucketsSql(source), Format.Table, {
          requestId: this.attributesRequest.requestId('buckets'),
        })
          // The buckets only place the default duration selection; without them it keeps its threshold.
          .catch(() => []),
      ]);
      if (!isCurrent()) {
        // A newer full refresh (span set or filters changed) owns the attributes and the body.
        return;
      }
      const attributes = frameRows<{ key: string }>(keys.frames).map((row) => row.key);
      const auto = slowestQuarterThreshold(frameRows<{ bucket: number }>(buckets).map((row) => Number(row.bucket)));
      this.setState({
        attributes,
        attributesLoad: keys.error ? loadFailed(keys.error) : DONE,
        threshold: this.state.thresholdAuto ? auto : this.state.threshold,
      });
    }
    this.buildBody(source);
  }

  setExploration(update: Partial<TracesExplorationState>) {
    this.setState(update);
    if ('primarySignal' in update) {
      this.syncPrimary();
      this.refresh(true);
      return;
    }
    const source = this.getSource();
    if (source) {
      if ('metric' in update) {
        this.buildPanels(source);
      }
      this.buildBody(source);
    }
  }

  /** Include adds `key = value`, Exclude `key != value`, replacing other filters on that key. */
  addFilter(key: string, value: string, exclude = false) {
    const variable = this.getFiltersVariable();
    variable?.updateFilters([
      ...variable.state.filters.filter((filter) => filter.key !== key),
      { key, operator: exclude ? '!=' : '=', value },
    ]);
  }

  buildPanels(source: SignalSource) {
    const rate = (errors: boolean) =>
      PanelBuilders.timeseries()
        .setTitle(errors ? metricTitles.errors : metricTitles.rate)
        // No error spans is a good result, not missing data.
        .setNoValue(errors ? 'No errors in this range' : 'No data')
        .setData(queryRunner([sqlQuery('A', rateSql(source, errors))], 64))
        .setCustomFieldConfig('drawStyle', 'bars' as never)
        .setCustomFieldConfig('fillOpacity', 75)
        .setCustomFieldConfig('lineWidth', 0)
        .setCustomFieldConfig('axisLabel', errors ? 'error/s' : 'span/s')
        .setCustomFieldConfig('axisSoftMin', 0)
        .setCustomFieldConfig('stacking', { mode: StackingMode.Normal, group: 'A' })
        .setColor({ mode: 'fixed' as never, fixedColor: errors ? metricColors.errors : metricColors.rate })
        .setOption('legend', { showLegend: false, displayMode: LegendDisplayMode.List, placement: 'bottom', calcs: [] })
        .setOption('tooltip', { mode: TooltipDisplayMode.Multi, sort: 'none' as never })
        .build();
    const duration = PanelBuilders.heatmap()
      .setTitle(metricTitles.duration)
      .setData(
        new SceneDataTransformer({
          $data: queryRunner([sqlQuery('A', durationHeatmapSql(source))], 24),
          transformations: [() => (frames) => frames.pipe(map((data: DataFrame[]) => data.map(toHeatmapFrame)))],
        })
      )
      .setOption('calculate', false)
      .setOption('color', { mode: 'scheme' as never, scheme: 'Blues', steps: 16 } as never)
      .setOption('yAxis', { unit: 's', axisLabel: 'duration' } as never)
      .setOption('legend', { show: false })
      .setOption('cellGap', 0)
      .build();
    this.setState({ ratePanel: rate(false), errorsPanel: rate(true), durationPanel: duration });
  }

  selectionCondition(): string {
    return selectionSql(this.state.metric, this.state.threshold);
  }

  /** Switching tabs or metrics while a tab's data loads supersedes that request. */
  private bodyRequest = new LatestRequest();
  /** The table shape detection before a refresh; a newer refresh supersedes it. */
  private sourceRequest = new LatestRequest();
  /** The attribute list and duration selection of the span set. */
  private attributesRequest = new LatestRequest();

  /** The tab content for the current state. */
  async buildBody(source: SignalSource) {
    const { actionView, metric } = this.state;
    const isCurrent = this.bodyRequest.start();
    if (actionView === 'exceptions' && metric !== 'errors') {
      this.setState({ actionView: 'breakdown' });
    }
    switch (this.state.actionView) {
      case 'comparison':
        this.setState({ body: undefined, bodyLoad: LOADING });
        try {
          const rows = frameRows<ComparisonRow>(
            await runSql(this, comparisonSql(source, this.selectionCondition()), Format.Table, {
              requestId: this.bodyRequest.requestId(),
            })
          );
          if (!isCurrent()) {
            return;
          }
          // The attributes that define the selection differ by definition; they are not findings.
          const defining = this.state.metric === 'duration' ? [] : ['status'];
          this.setState({
            comparison: toComparison(rows, this.state.primarySignal === 'root').filter(
              (a) => !defining.includes(a.key)
            ),
            bodyLoad: DONE,
          });
        } catch (error) {
          if (isCurrent()) {
            this.setState({ bodyLoad: loadFailed(error) });
          }
        }
        return;
      case 'exceptions':
        this.setState({ body: undefined, bodyLoad: LOADING });
        try {
          const rows = frameRows<{ time: number; service: string; type: string; message: string; traceId: string }>(
            await runSql(this, exceptionsSql(source), Format.Table, { requestId: this.bodyRequest.requestId() })
          );
          if (isCurrent()) {
            this.setState({ exceptions: groupExceptions(rows), bodyLoad: DONE });
          }
        } catch (error) {
          if (isCurrent()) {
            this.setState({ bodyLoad: loadFailed(error) });
          }
        }
        return;
      case 'traceList': {
        this.setState({ body: undefined, bodyLoad: LOADING });
        const condition =
          metric === 'errors' ? ERROR_CONDITION : metric === 'duration' ? this.selectionCondition() : '1 = 1';
        try {
          const rows = frameRows<SpanRow>(
            await runSql(this, spanListSql(source, condition, this.state.spanListColumns), Format.Table, {
              requestId: this.bodyRequest.requestId(),
            })
          );
          if (isCurrent()) {
            this.setState({ spans: rows, bodyLoad: DONE });
          }
        } catch (error) {
          if (isCurrent()) {
            this.setState({ bodyLoad: loadFailed(error) });
          }
        }
        return;
      }
      default:
        this.setState({ body: this.buildBreakdown(source), bodyLoad: DONE });
    }
  }

  private buildBreakdown(source: SignalSource): SceneObject {
    const { metric, groupBy, percentiles, layout } = this.state;
    const runner = queryRunner([sqlQuery('A', breakdownSql(source, metric, groupBy, percentiles))], 64);
    // One frame per attribute value (with a field per percentile for duration), highest maximum first.
    const byValue = new SceneDataTransformer({
      $data: runner,
      transformations: [
        () => (frames) =>
          frames.pipe(
            map((data: DataFrame[]) => {
              const groups = new Map<string, DataFrame>();
              data.forEach((frame) => {
                const time = frame.fields.find((f) => f.type === FieldType.time);
                frame.fields
                  .filter((f) => f.type === FieldType.number && time)
                  .forEach((field) => {
                    const value = field.labels?.value ?? '';
                    const existing = groups.get(value);
                    const named = {
                      ...field,
                      labels: undefined,
                      config: { ...field.config, displayNameFromDS: field.name },
                    };
                    groups.set(
                      value,
                      existing
                        ? { ...existing, fields: [...existing.fields, named] }
                        : { ...frame, name: value, fields: [time!, named], length: frame.length }
                    );
                  });
              });
              const max = (frame: DataFrame) =>
                Math.max(
                  ...frame.fields
                    .filter((f) => f.type === FieldType.number)
                    .flatMap((f) => f.values.filter(Number.isFinite)),
                  -Infinity
                );
              const matches = searchMatches(this.state.search);
              return Array.from(groups.values())
                .filter((frame) => matches(frame.name || ''))
                .sort((a, b) => max(b) - max(a));
            })
          ),
      ],
    });
    const panel = (title: string) => {
      const builder = PanelBuilders.timeseries()
        .setTitle(title)
        .setOption('legend', {
          showLegend: metric === 'duration' && percentiles.length > 1,
          displayMode: LegendDisplayMode.List,
          placement: 'bottom',
          calcs: [],
        })
        .setOption('tooltip', { mode: TooltipDisplayMode.Multi, sort: 'desc' as never });
      if (metric === 'duration') {
        builder.setUnit('s').setCustomFieldConfig('fillOpacity', 0);
      } else {
        builder
          .setUnit(metric === 'errors' ? 'error/s' : 'span/s')
          .setCustomFieldConfig('drawStyle', 'bars' as never)
          .setCustomFieldConfig('fillOpacity', 75)
          .setCustomFieldConfig('lineWidth', 0)
          .setColor({ mode: 'fixed' as never, fixedColor: metricColors[metric] });
      }
      return builder;
    };
    if (layout === 'single') {
      return panel(`${groupBy}`)
        .setData(
          new SceneDataTransformer({
            $data: byValue,
            transformations: [
              () => (frames) =>
                frames.pipe(
                  map((data: DataFrame[]) =>
                    data.slice(0, 20).map((frame) => ({
                      ...frame,
                      fields: frame.fields.map((f) =>
                        f.type === FieldType.number
                          ? { ...f, config: { ...f.config, displayNameFromDS: `${frame.name} ${f.name}` } }
                          : f
                      ),
                    }))
                  )
                ),
            ],
          })
        )
        .setOption('legend', { showLegend: true, displayMode: LegendDisplayMode.List, placement: 'bottom', calcs: [] })
        .setColor({ mode: 'palette-classic' as never })
        .setCustomFieldConfig('drawStyle', 'line' as never)
        .build();
    }
    return new SceneByFrameRepeater({
      $data: byValue,
      body: new SceneCSSGridLayout({
        templateColumns: layout === 'rows' ? '1fr' : 'repeat(auto-fit, minmax(400px, 1fr))',
        autoRows: '200px',
        isLazy: true,
        children: [],
      }),
      getLayoutChild: (data, frame) => {
        const value = frame.name || '';
        return panel(value)
          .setData(new SceneDataNode({ data: { ...data, series: [frame] } }))
          .setHeaderActions(
            <>
              <Button size="sm" variant="secondary" fill="outline" onClick={() => this.addFilter(groupBy, value)}>
                Include
              </Button>
              <Button size="sm" variant="secondary" fill="outline" onClick={() => this.addFilter(groupBy, value, true)}>
                Exclude
              </Button>
            </>
          )
          .build();
      },
    });
  }

  async openTrace(traceId?: string) {
    this.setState({ traceId, trace: undefined });
    if (!traceId) {
      return;
    }
    // The trace-id index bounds the lookup when the deployment has one, and the tags follow the
    // table's attribute shape (both looked up once).
    const uid = interpolate(this, `\${${VAR_DATASOURCE}}`);
    await this.loadSource();
    const source = await loadTraceIndex(this, uid);
    if (!source || this.state.traceId !== traceId) {
      return;
    }
    this.setState({
      trace: PanelBuilders.traces()
        .setTitle('')
        .setData(queryRunner([sqlQuery('A', traceSql(source, traceId), Format.Trace)]))
        .build(),
    });
  }

  static Component = ({ model }: SceneComponentProps<TracesExploration>) => <TracesView model={model} />;
}
