import React, { useEffect, useState } from 'react';
import { css, cx } from '@emotion/css';
import { DataFrame, FieldType, GrafanaTheme2 } from '@grafana/data';
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
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Drawer,
  Icon,
  IconButton,
  Input,
  LoadingPlaceholder,
  MultiCombobox,
  RadioButtonGroup,
  Tab,
  TabsBar,
  Tag,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { LegendDisplayMode, StackingMode, TooltipDisplayMode } from '@grafana/schema';
import { map } from 'rxjs';
import { toHeatmapFrame } from 'clickhouse/heatmap';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import {
  Control,
  copyCurrentUrl,
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
  Toolbar,
  ToolbarGroup,
  DONE,
  LatestRequest,
  loadError,
  LoadState,
  LoadStatus,
  loadFailed,
  LOADING,
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
  AttributesSidebar,
  ComparisonAttribute,
  ComparisonBars,
  ExceptionsTable,
  formatDuration,
  getFavorites,
  groupExceptions,
  SpanRow,
  SpanTable,
  toComparison,
  ComparisonRow,
} from './components';

type ActionView = 'breakdown' | 'comparison' | 'exceptions' | 'traceList';
type Layout = 'single' | 'grid' | 'rows';

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

const metricTitles: Record<MetricType, string> = {
  rate: 'Span rate',
  errors: 'Errors rate',
  duration: 'Histogram by duration',
};
const metricColors: Record<MetricType, string> = { rate: 'blue', errors: 'semi-dark-red', duration: '#FF9930' };

const tabLabels: Record<MetricType, Record<'traceList', string>> = {
  rate: { traceList: 'Traces' },
  errors: { traceList: 'Errored traces' },
  duration: { traceList: 'Slow traces' },
};

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
    if (typeof values['var-primarySignal'] === 'string') {
      update.primarySignal = values['var-primarySignal'];
    }
    if (values['var-metric'] === 'rate' || values['var-metric'] === 'errors' || values['var-metric'] === 'duration') {
      update.metric = values['var-metric'];
    }
    if (typeof values.actionView === 'string') {
      update.actionView = values.actionView as ActionView;
    }
    if (typeof values['var-groupBy'] === 'string') {
      update.groupBy = values['var-groupBy'];
    }
    if ('comparisonBy' in values) {
      update.comparisonBy = values.comparisonBy ? String(values.comparisonBy) : ALL;
    }
    if (values['var-durationPercentiles']) {
      update.percentiles = list(values['var-durationPercentiles']).map(Number).filter(Number.isFinite);
    }
    if ('layout' in values) {
      update.layout = (values.layout as Layout) || 'grid';
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
      const [keys, buckets] = await Promise.all([
        runSql(this, attributeKeysSql(source, `${PRIMARY} AND ${FILTERS}`), Format.Table, {
          requestId: this.attributesRequest.requestId('keys'),
        }).catch(() => []),
        runSql(this, durationBucketsSql(source), Format.Table, {
          requestId: this.attributesRequest.requestId('buckets'),
        }).catch(() => []),
      ]);
      if (!isCurrent()) {
        // A newer full refresh (span set or filters changed) owns the attributes and the body.
        return;
      }
      const attributes = frameRows<{ key: string }>(keys).map((row) => row.key);
      const auto = slowestQuarterThreshold(frameRows<{ bucket: number }>(buckets).map((row) => Number(row.bucket)));
      this.setState({ attributes, threshold: this.state.thresholdAuto ? auto : this.state.threshold });
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

const RedPanel = ({ panel }: { panel: VizPanel }) => <panel.Component model={panel} />;

function TracesView({ model }: SceneComponentProps<TracesExploration>) {
  const styles = useStyles2(getStyles);
  const state = model.useState();
  const {
    primarySignal,
    metric,
    actionView,
    ratePanel,
    errorsPanel,
    durationPanel,
    body,
    attributes,
    groupBy,
    comparisonBy,
    percentiles,
    layout,
  } = state;
  const {
    comparison,
    hideBaselineOnly,
    exceptions,
    spans,
    spanListColumns,
    bodyLoad,
    traceId,
    trace,
    threshold,
    search,
  } = state;
  const filtersVariable = model.getFiltersVariable();
  const { filters } = filtersVariable?.useState() || { filters: [] };
  const filteredKeys = filters.map((filter) => filter.key);
  const [traceInput, setTraceInput] = useState('');
  const range = sceneGraph.getTimeRange(model).useState().value;

  useEffect(() => {
    if (traceId && !trace) {
      model.openTrace(traceId);
    }
  }, [traceId, trace, model]);

  const primaryOptions = primarySignals.slice(0, 2);
  const extraSignal = primarySignals.slice(2).find((signal) => signal.value === primarySignal);
  const others = (['rate', 'errors', 'duration'] as MetricType[]).filter((m) => m !== metric);
  const panels =
    ratePanel && errorsPanel && durationPanel
      ? { rate: ratePanel, errors: errorsPanel, duration: durationPanel }
      : undefined;
  const selectionColor = metric === 'duration' ? '#FF9930' : 'semi-dark-red';
  const shownComparison = (comparisonBy === ALL ? comparison : comparison.filter((a) => a.key === comparisonBy)).filter(
    (attribute) => !hideBaselineOnly || attribute.values.some((v) => v.selection > 0)
  );

  return (
    <div className={styles.container}>
      <Toolbar>
        <span className={styles.label}>Filters</span>
        <RadioButtonGroup
          options={[...primaryOptions, ...(extraSignal ? [extraSignal] : [])].map((signal) => ({
            label: signal.label,
            value: signal.value,
            description: signal.description,
          }))}
          value={primarySignal}
          onChange={(value) => model.setExploration({ primarySignal: value })}
        />
        <Combobox
          aria-label="Primary signal"
          placeholder="Primary signal"
          width={18}
          options={primarySignals
            .slice(2)
            .map((signal) => ({ label: signal.label, value: signal.value, description: signal.description }))}
          value={extraSignal?.value ?? null}
          onChange={(option) => option && model.setExploration({ primarySignal: option.value })}
        />
        <div className={styles.filterBar}>
          {filtersVariable && <filtersVariable.Component model={filtersVariable} />}
        </div>
        <Control label="Trace ID" tooltip="Open a trace by its ID">
          <Input
            width={30}
            placeholder="Enter an ID and press Enter"
            value={traceInput}
            onChange={(e) => setTraceInput(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && traceInput.trim() && model.openTrace(traceInput.trim())}
            suffix={
              traceInput ? <IconButton name="times" aria-label="Clear" onClick={() => setTraceInput('')} /> : undefined
            }
          />
        </Control>
      </Toolbar>
      {/* The other tabs show their load state, errors included, in place. */}
      {actionView === 'breakdown' && loadError(bodyLoad) && <Alert title="Error">{loadError(bodyLoad)}</Alert>}

      <div className={styles.metricCaption}>
        Select metric type{' '}
        <Tooltip
          content={
            <div>
              <b>RED metrics for traces</b>
              <div>Rate - Spans per second that match your filter, useful to find unusual spikes in activity</div>
              <div>Errors - Spans that are failing, overall issues in tracing ecosystem</div>
              <div>Duration - Amount of time those spans take, represented as a heat map</div>
            </div>
          }
        >
          <Icon name="info-circle" size="sm" />
        </Tooltip>
      </div>
      {panels && (
        <div className={styles.red}>
          <div className={styles.redMain}>
            <RedPanel panel={panels[metric]} />
          </div>
          <div className={styles.redSide}>
            {others.map((other) => (
              <button
                key={other}
                className={styles.redSmall}
                aria-label={`Select ${metricTitles[other]}`}
                onClick={() =>
                  model.setExploration({
                    metric: other,
                    actionView: actionView === 'exceptions' ? 'breakdown' : actionView,
                  })
                }
              >
                <RedPanel panel={panels[other]} />
              </button>
            ))}
          </div>
        </div>
      )}
      {metric === 'duration' && (
        <Toolbar>
          <span className={styles.selectionChip} />
          <span>
            Comparison selection: spans slower than <b>{threshold ? formatDuration(threshold * 1000) : '…'}</b>
            {state.thresholdAuto ? ' (slowest traces)' : ''}
          </span>
          <Combobox
            aria-label="Comparison selection"
            width={20}
            options={[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10].map((s) => ({
              label: `≥ ${formatDuration(s * 1000)}`,
              value: s,
            }))}
            value={state.thresholdAuto ? null : (threshold ?? null)}
            placeholder="Custom threshold"
            onChange={(option) => option && model.setExploration({ threshold: option.value, thresholdAuto: false })}
          />
          <Button
            variant="secondary"
            disabled={state.thresholdAuto}
            onClick={() => {
              model.setState({ thresholdAuto: true });
              model.refresh(true);
            }}
          >
            {state.thresholdAuto ? 'Slowest traces selected' : 'Select slowest traces'}
          </Button>
        </Toolbar>
      )}

      <div className={styles.tabsRow}>
        <TabsBar className={styles.tabs}>
          <Tab
            label="Breakdown"
            active={actionView === 'breakdown'}
            onChangeTab={() => model.setExploration({ actionView: 'breakdown' })}
          />
          <Tab
            label="Comparison"
            active={actionView === 'comparison'}
            onChangeTab={() => model.setExploration({ actionView: 'comparison' })}
          />
          {metric === 'errors' && (
            <Tab
              label="Exceptions"
              counter={actionView === 'exceptions' ? exceptions.length : undefined}
              active={actionView === 'exceptions'}
              onChangeTab={() => model.setExploration({ actionView: 'exceptions' })}
            />
          )}
          <Tab
            label={tabLabels[metric].traceList}
            counter={actionView === 'traceList' ? spans.length : undefined}
            active={actionView === 'traceList'}
            onChangeTab={() => model.setExploration({ actionView: 'traceList' })}
          />
        </TabsBar>
        <Tooltip content="Copy url">
          <IconButton name="link" aria-label="Share exploration" onClick={() => copyCurrentUrl()} />
        </Tooltip>
      </div>

      {actionView === 'breakdown' && (
        <div className={styles.split}>
          <AttributesSidebar
            attributes={attributes}
            selected={[groupBy]}
            filtered={filteredKeys}
            onSelect={(attribute) => model.setExploration({ groupBy: attribute })}
          />
          <div className={styles.content}>
            <Toolbar>
              <span className={styles.muted}>
                {metric === 'duration'
                  ? 'Attributes are ordered by their average duration.'
                  : `Attributes are ordered by their rate of ${metric === 'errors' ? 'errors' : 'requests'} per second.`}
              </span>
              {metric !== 'duration' && (
                <Tag name={metric === 'errors' ? 'Error' : 'Rate'} colorIndex={metric === 'errors' ? 1 : 3} />
              )}
              <ToolbarGroup>
                <Input
                  prefix={<Icon name="search" />}
                  placeholder="Search values"
                  aria-label="Search values"
                  width={24}
                  value={search}
                  onChange={(e) => model.setExploration({ search: e.currentTarget.value })}
                />
                {metric === 'duration' && (
                  <Control label="Percentiles" tooltip="Default: p90">
                    <MultiCombobox
                      aria-label="Percentiles"
                      width="auto"
                      minWidth={14}
                      options={[0.5, 0.75, 0.9, 0.95, 0.99].map((p) => ({
                        label: `p${Math.round(p * 100)}`,
                        value: p,
                        description: p === 0.9 ? 'Default' : undefined,
                      }))}
                      value={percentiles}
                      onChange={(options) =>
                        model.setExploration({ percentiles: options.length ? options.map((o) => o.value) : [0.9] })
                      }
                    />
                  </Control>
                )}
                <RadioButtonGroup
                  aria-label="View"
                  options={(['single', 'grid', 'rows'] as Layout[]).map((value) => ({
                    value,
                    label: value[0].toUpperCase() + value.slice(1),
                  }))}
                  value={layout}
                  onChange={(value) => model.setExploration({ layout: value })}
                />
              </ToolbarGroup>
            </Toolbar>
            {body && (
              <div className={layout === 'single' ? styles.single : undefined}>
                <body.Component model={body} />
              </div>
            )}
          </div>
        </div>
      )}

      {actionView === 'comparison' && (
        <div className={styles.split}>
          <AttributesSidebar
            attributes={attributes}
            selected={[comparisonBy]}
            filtered={[]}
            allOption
            onSelect={(attribute) => model.setExploration({ comparisonBy: attribute })}
          />
          <div className={styles.content}>
            <Toolbar>
              <span className={styles.muted}>
                Attributes are ordered by the difference between the baseline and selection values for each value.
              </span>
              <span className={styles.legend}>
                <span className={styles.swatch} style={{ background: '#5794F299' }} /> Baseline
                <span
                  className={cx(styles.swatch)}
                  style={{ background: metric === 'duration' ? '#FF9930' : '#C4162A' }}
                />{' '}
                Selection
              </span>
              <div className={styles.spacer} />
              <Tooltip content="Hide panels that only have baseline percentage and no selection">
                <span>
                  <Checkbox
                    label="Hide baseline-only"
                    value={hideBaselineOnly}
                    onChange={() => model.setExploration({ hideBaselineOnly: !hideBaselineOnly })}
                  />
                </span>
              </Tooltip>
            </Toolbar>
            <p className={styles.muted}>
              Selection:{' '}
              {metric === 'duration'
                ? `spans slower than ${threshold ? formatDuration(threshold * 1000) : '…'}`
                : 'spans with status error'}
              ; baseline: all other spans in scope. Values are shares of each population.
            </p>
            <LoadStatus state={bodyLoad} loadingText="Comparing…" errorTitle="Could not compare" />
            {bodyLoad.status === 'done' && !shownComparison.length && (
              <Alert severity="info" title="No data for selected query" />
            )}
            <div className={comparisonBy === ALL ? styles.comparisonGrid : styles.comparisonSingle}>
              {shownComparison.slice(0, 60).map((attribute) => (
                <div key={attribute.key} className={styles.tile}>
                  <div className={styles.tileHeader}>
                    <b>{attribute.key}</b>
                    {comparisonBy === ALL && (
                      <Button
                        size="sm"
                        variant="secondary"
                        fill="outline"
                        onClick={() => model.setExploration({ comparisonBy: attribute.key })}
                      >
                        Inspect
                      </Button>
                    )}
                  </div>
                  <div className={styles.tileBody}>
                    <ComparisonBars
                      values={
                        comparisonBy === ALL
                          ? attribute.values
                          : [...attribute.values]
                              .sort((a, b) => b.selection - a.selection)
                              .filter((v) => v.selection || v.baseline)
                      }
                      selectionColor={selectionColor}
                    />
                  </div>
                  {attribute.maxDifferenceValue !== undefined && (
                    <div className={styles.tileFooter}>
                      <span className={styles.muted}>Highest difference</span>
                      <b>{Math.abs(attribute.maxDifference * 100).toFixed(2)}%</b>
                      <span className={styles.ellipsis}>{attribute.maxDifferenceValue}</span>
                      <div className={styles.spacer} />
                      {!filters.some((f) => f.key === attribute.key && f.value === attribute.maxDifferenceValue) && (
                        <>
                          <Button
                            size="sm"
                            variant="secondary"
                            fill="outline"
                            onClick={() => model.addFilter(attribute.key, attribute.maxDifferenceValue!)}
                          >
                            Include
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            fill="outline"
                            onClick={() => model.addFilter(attribute.key, attribute.maxDifferenceValue!, true)}
                          >
                            Exclude
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {actionView === 'exceptions' && (
        <>
          <p className={styles.muted}>View exception details from errored traces for the current set of filters.</p>
          <LoadStatus state={bodyLoad} loadingText="Loading exceptions…" errorTitle="Could not load exceptions" />
          {bodyLoad.status !== 'done' ? null : exceptions.length ? (
            <ExceptionsTable
              groups={exceptions}
              from={range.from.valueOf()}
              to={range.to.valueOf()}
              onOpenTrace={(id) => model.openTrace(id)}
            />
          ) : (
            <Alert severity="info" title="No exceptions found for the current filters." />
          )}
        </>
      )}

      {actionView === 'traceList' && (
        <div className={styles.split}>
          <AttributesSidebar
            attributes={attributes}
            selected={spanListColumns}
            filtered={[]}
            multi
            onSelect={(attribute) =>
              model.setExploration({
                spanListColumns: spanListColumns.includes(attribute)
                  ? spanListColumns.filter((c) => c !== attribute)
                  : [...spanListColumns, attribute],
              })
            }
          />
          <div className={styles.content}>
            <p className={styles.muted}>View a list of spans for the current set of filters, slowest first.</p>
            <LoadStatus state={bodyLoad} loadingText="Loading spans…" errorTitle="Could not load spans" />
            {bodyLoad.status !== 'done' ? null : spans.length ? (
              <SpanTable rows={spans} columns={spanListColumns} onOpen={(row) => model.openTrace(row['Trace ID'])} />
            ) : (
              <Alert severity="info" title="No data for selected query" />
            )}
          </div>
        </div>
      )}

      {traceId && (
        <Drawer title={`View trace ${traceId}`} size="lg" onClose={() => model.openTrace(undefined)}>
          <div className={styles.trace}>
            {trace ? <trace.Component model={trace} /> : <LoadingPlaceholder text="Loading trace…" />}
          </div>
        </Drawer>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), width: '100%', flexGrow: 1 }),
  label: css({ fontWeight: theme.typography.fontWeightMedium }),
  filterBar: css({ flexGrow: 1, minWidth: 300 }),
  metricCaption: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  red: css({
    display: 'flex',
    gap: theme.spacing(1),
    height: 240,
    [theme.breakpoints.down('md')]: { flexDirection: 'column', height: 'auto' },
  }),
  redMain: css({ flex: '0 0 60%', minWidth: 0, height: 240 }),
  redSide: css({ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  redSmall: css({
    height: 116,
    padding: 0,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    borderRadius: theme.shape.radius.default,
    '&:hover': { outline: `1px solid ${theme.colors.primary.border}` },
  }),
  selectionChip: css({ width: 12, height: 12, borderRadius: 2, background: '#FF993055', border: '1px solid #FF9930' }),
  tabsRow: css({ display: 'flex', alignItems: 'center' }),
  tabs: css({ flexGrow: 1 }),
  split: css({ display: 'flex', gap: theme.spacing(2), minHeight: 500 }),
  content: css({ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize, margin: 0 }),
  spacer: css({ flexGrow: 1 }),
  single: css({ height: 300 }),
  legend: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  swatch: css({ display: 'inline-block', width: 10, height: 10, borderRadius: 2, marginLeft: theme.spacing(1) }),
  comparisonGrid: css({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
    gap: theme.spacing(1),
  }),
  comparisonSingle: css({ display: 'grid', gridTemplateColumns: '1fr', gap: theme.spacing(1) }),
  tile: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    padding: theme.spacing(1),
    height: 320,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
  }),
  tileHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }),
  tileBody: css({ flexGrow: 1, minHeight: 0 }),
  tileFooter: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    borderTop: `1px solid ${theme.colors.border.weak}`,
    paddingTop: theme.spacing(1),
  }),
  ellipsis: css({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }),
  trace: css({ height: 'calc(100vh - 120px)' }),
});
