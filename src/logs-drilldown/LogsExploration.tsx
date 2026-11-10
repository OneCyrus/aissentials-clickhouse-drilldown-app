import React from 'react';
import { DataFrame, LoadingState } from '@grafana/data';
import {
  AdHocFiltersVariable,
  PanelBuilders,
  SceneByFrameRepeater,
  SceneComponentProps,
  SceneCSSGridLayout,
  SceneDataNode,
  SceneFlexItem,
  SceneFlexLayout,
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
import { Button, IconButton } from '@grafana/ui';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import { tileLines, tileVolume } from './landing';
import {
  exploreUrl,
  Format,
  frameRows,
  getSignalSource,
  loadSignalSource,
  DONE,
  interpolate,
  LatestRequest,
  levelColors,
  LoadState,
  loadFailed,
  LOADING,
  panelQueryRunner,
  queryRunner,
  runSql,
  SeriesSort,
  seriesName,
  SignalSource,
  splitSeriesData,
  sqlQuery,
  store,
  errorMessage,
  oneOf,
  seriesSortOptions,
} from '../shared';
import { refreshFilterExpression } from '../shared/scene';
import {
  ALL_FILTERS,
  AppliedPattern,
  countSql,
  landingLinesSql,
  landingVolumeSql,
  detectedKeysSql,
  FILTERS,
  keyDisplayName,
  levelsSql,
  LineFilter,
  validLineFilters,
  validPatterns,
  lineFiltersSql,
  logLinesSql,
  patternsSql,
  SERVICE_KEY,
  valueCountsSql,
  VAR_FIELDS,
  VAR_LEVELS,
  VAR_LINE_FILTERS,
  VAR_PATTERNS,
  volumeByLevelSql,
  volumeByValueSql,
} from './sql';
import { namedSeries, stackedBars } from './panels';
import { PatternsScene } from './PatternsScene';
import { ALL, ServiceDetails, ServiceSelection } from './LogsExplorationView';

type View = 'logs' | 'labels' | 'fields' | 'patterns';
export type Visualization = 'logs' | 'table';

interface DetectedKey {
  key: string;
  cardinality: number;
}

interface LogsExplorationState extends SceneObjectState {
  /** Landing page tab: the label whose values are listed. */
  primaryLabel: string;
  /** Details tab; undefined on the landing page. */
  view?: View;
  labelBy: string;
  fieldBy: string;
  levels: string[];
  lineFilters: LineFilter[];
  patterns: AppliedPattern[];
  visualization: Visualization;
  sort: SeriesSort;
  valueSearch: string;
  // Landing page
  search: string;
  pageSize: number;
  page: number;
  values: Array<{ value: string; count: number }>;
  tabs: string[];
  /** The landing page's value list (services or another label) for the filters and range. */
  landingLoad: LoadState;
  // Details
  labels: DetectedKey[];
  fields: DetectedKey[];
  logsCount?: number;
  /** The detected labels of the Labels tab. */
  labelsLoad: LoadState;
  /** The detected fields of the Fields tab. */
  fieldsLoad: LoadState;
  patternsCount?: number;
  body?: SceneObject;
}

const favoritesKey = (uid: string, label: string) => `services.favorite.${uid}.${label}`;

/**
 * Logs Drilldown for the OTel exporter's logs table: services (or any resource attribute) with
 * their volume and latest lines, then one service with Logs, Labels, Fields and Patterns tabs.
 */
export class LogsExploration extends SceneObjectBase<LogsExplorationState> {
  protected _urlSync = new SceneObjectUrlSyncConfig(this, {
    keys: [
      'actionView',
      'primaryLabel',
      'var-labelBy',
      'var-fieldBy',
      'levels',
      'lineFilters',
      'patterns',
      'visualizationType',
      'sortBy',
    ],
  });

  protected _variableDependency = new VariableDependencyConfig(this, {
    variableNames: [VAR_DATASOURCE, VAR_FILTERS, VAR_FIELDS],
    onReferencedVariableValueChanged: () => this.refresh(),
  });

  /** The table shape detection before a refresh; a newer refresh supersedes it. */
  private sourceRequest = new LatestRequest();
  private landingRequest = new LatestRequest();
  /** The tiles' data of the landing page shown; search, paging and refresh supersede it. */
  private tilesRequest = new LatestRequest();
  /** The details' counts and detected keys; a filter change while they load supersedes them. */
  private countsRequest = new LatestRequest();

  constructor(state: Partial<LogsExplorationState> = {}) {
    super({
      primaryLabel: SERVICE_KEY,
      labelBy: ALL,
      fieldBy: ALL,
      levels: [],
      lineFilters: [],
      patterns: [],
      visualization: 'logs',
      sort: 'stddev-desc',
      valueSearch: '',
      search: '',
      pageSize: store.get('serviceSelection.pageCount', 20),
      page: 0,
      values: [],
      tabs: [SERVICE_KEY],
      landingLoad: LOADING,
      labels: [],
      fields: [],
      labelsLoad: DONE,
      fieldsLoad: DONE,
      ...state,
    });
    this.addActivationHandler(() => {
      this.syncConditionVariables();
      this.refresh();
      const timeRange = sceneGraph.getTimeRange(this).subscribeToState(() => this.refresh());
      return () => timeRange.unsubscribe();
    });
  }

  getUrlState(): SceneObjectUrlValues {
    const { view, primaryLabel, labelBy, fieldBy, levels, lineFilters, patterns, visualization, sort } = this.state;
    return {
      actionView: view,
      primaryLabel: primaryLabel === SERVICE_KEY ? undefined : primaryLabel,
      'var-labelBy': view === 'labels' && labelBy !== ALL ? labelBy : undefined,
      'var-fieldBy': view === 'fields' && fieldBy !== ALL ? fieldBy : undefined,
      levels: levels.length ? levels.join(',') : undefined,
      lineFilters: lineFilters.length ? JSON.stringify(lineFilters) : undefined,
      patterns: patterns.length ? JSON.stringify(patterns) : undefined,
      visualizationType: visualization === 'logs' ? undefined : visualization,
      sortBy: sort === 'stddev-desc' ? undefined : sort,
    };
  }

  updateFromUrl(values: SceneObjectUrlValues) {
    const json = <T,>(value: unknown, fallback: T): T => {
      try {
        return typeof value === 'string' ? (JSON.parse(value) as T) : fallback;
      } catch {
        // A hand-edited or truncated URL: the filters are dropped, as if none were set.
        return fallback;
      }
    };
    this.setState({
      view: (['logs', 'labels', 'fields', 'patterns'] as View[]).find((v) => v === values.actionView),
      primaryLabel: typeof values.primaryLabel === 'string' && values.primaryLabel ? values.primaryLabel : SERVICE_KEY,
      labelBy: typeof values['var-labelBy'] === 'string' && values['var-labelBy'] ? values['var-labelBy'] : ALL,
      fieldBy: typeof values['var-fieldBy'] === 'string' && values['var-fieldBy'] ? values['var-fieldBy'] : ALL,
      levels: typeof values.levels === 'string' && values.levels ? values.levels.split(',') : [],
      // Line filters and patterns are quoted into SQL: only well-formed entries are taken.
      lineFilters: validLineFilters(json<unknown>(values.lineFilters, [])),
      patterns: validPatterns(json<unknown>(values.patterns, [])),
      visualization: values.visualizationType === 'table' ? 'table' : 'logs',
      sort:
        oneOf(
          values.sortBy,
          seriesSortOptions.map((option) => option.value)
        ) ?? 'stddev-desc',
    });
    this.syncConditionVariables();
    if (this.isActive) {
      this.refresh();
    }
  }

  getSource(): SignalSource | undefined {
    return getSignalSource(interpolate(this, `\${${VAR_DATASOURCE}}`), 'logs');
  }

  getVariable<T>(name: string, type: new (...args: never[]) => T): T | undefined {
    const variable = sceneGraph.lookupVariable(name, this);
    return variable instanceof type ? variable : undefined;
  }

  /** Writes the levels, line filters and patterns into the hidden variables the queries use. */
  syncConditionVariables() {
    const set = (name: string, value: string) => {
      const variable = this.getVariable(name, TextBoxVariable);
      if (variable && variable.getValue() !== value) {
        variable.setValue(value);
      }
    };
    set(VAR_LEVELS, levelsSql(this.state.levels));
    set(VAR_LINE_FILTERS, lineFiltersSql(this.state.lineFilters));
    set(VAR_PATTERNS, patternsSql(this.state.patterns));
  }

  setConditions(update: Partial<Pick<LogsExplorationState, 'levels' | 'lineFilters' | 'patterns'>>) {
    this.setState(update);
    this.syncConditionVariables();
    if (this.state.view) {
      this.loadCounts();
      if (this.state.view === 'patterns' || this.state.view === 'labels' || this.state.view === 'fields') {
        this.buildDetails();
      }
    }
  }

  /** The value the details page is about: the first `=` filter on the primary label. */
  getPrimaryFilter() {
    const filters = this.getVariable(VAR_FILTERS, AdHocFiltersVariable)?.state.filters || [];
    return filters.find((filter) => filter.key === this.state.primaryLabel && filter.operator === '=') || filters[0];
  }

  /** Detects the table's attribute shape (JSON or Map) once per data source; the queries depend on it. */
  async loadSource(): Promise<SignalSource | undefined> {
    const source = await loadSignalSource(this, interpolate(this, `\${${VAR_DATASOURCE}}`), 'logs');
    // The filter bars render their SQL when their filters change, e.g. from the URL before the
    // shape was known; render it again for this table's shape.
    refreshFilterExpression(this.getVariable(VAR_FILTERS, AdHocFiltersVariable));
    refreshFilterExpression(this.getVariable(VAR_FIELDS, AdHocFiltersVariable));
    return source;
  }

  async refresh() {
    const isCurrent = this.sourceRequest.start();
    await this.loadSource();
    if (!isCurrent()) {
      return;
    }
    if (this.state.view) {
      this.loadCounts();
      this.buildDetails();
    } else {
      this.loadLanding();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Landing page

  async loadLanding() {
    const source = this.getSource();
    const isCurrent = this.landingRequest.start();
    if (!source) {
      this.setState({ landingLoad: loadFailed('Pick a ClickHouse data source with OpenTelemetry logs.') });
      return;
    }
    this.setState({ landingLoad: LOADING });
    try {
      const rows = frameRows<{ value: string; count: number }>(
        await runSql(this, valueCountsSql(source, this.state.primaryLabel, FILTERS), Format.Table, {
          requestId: this.landingRequest.requestId(),
        })
      );
      if (isCurrent()) {
        this.setState({
          values: rows.map((row) => ({ value: row.value, count: Number(row.count) })),
          landingLoad: DONE,
        });
        this.buildLanding();
      }
    } catch (error) {
      if (isCurrent()) {
        this.setState({ landingLoad: loadFailed(error) });
      }
    }
  }

  favorites(): string[] {
    const uid = this.getSource()?.uid || '';
    return store.get<string[]>(favoritesKey(uid, this.state.primaryLabel), []);
  }

  toggleFavorite(value: string) {
    const uid = this.getSource()?.uid || '';
    const favorites = this.favorites();
    store.set(
      favoritesKey(uid, this.state.primaryLabel),
      favorites.includes(value) ? favorites.filter((f) => f !== value) : [value, ...favorites]
    );
    this.buildLanding();
  }

  /** Values in display order: favorites first, then by volume, matching the search. */
  landingValues(): string[] {
    const search = this.state.search.toLowerCase();
    const values = this.state.values.map((v) => v.value);
    const favorites = this.favorites().filter((value) => values.includes(value));
    return [...favorites, ...values.filter((value) => !favorites.includes(value))].filter((value) =>
      value.toLowerCase().includes(search)
    );
  }

  buildLanding() {
    const source = this.getSource();
    if (!source) {
      return;
    }
    const { page, pageSize } = this.state;
    const favorites = this.favorites();
    const values = this.landingValues().slice(page * pageSize, (page + 1) * pageSize);
    const timeRange = sceneGraph.getTimeRange(this).state.value;
    // Every tile shows its slice of two queries for the whole page (see loadLandingData).
    const volumes = new Map<string, SceneDataNode>();
    const lines = new Map<string, SceneDataNode>();
    const children = values.map((value) => {
      const volumeData = new SceneDataNode({ data: { state: LoadingState.Loading, series: [], timeRange } });
      const linesData = new SceneDataNode({ data: { state: LoadingState.Loading, series: [], timeRange } });
      volumes.set(value, volumeData);
      lines.set(value, linesData);
      const volume = stackedBars(namedSeries(volumeData, true), 'right')
        .setTitle(value)
        .setHeaderActions(
          <>
            <IconButton
              key="favorite"
              name={favorites.includes(value) ? 'favorite' : 'star'}
              tooltip={favorites.includes(value) ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => this.toggleFavorite(value)}
            />
            <Button
              key="include"
              size="sm"
              variant="secondary"
              fill="outline"
              tooltip={`Add ${value} to filters`}
              onClick={() => this.includeLabelValue(value)}
            >
              Include
            </Button>
            <Button
              key="show"
              size="sm"
              variant="primary"
              tooltip={`View logs for ${value}`}
              onClick={() => this.showLogs(value)}
            >
              Show logs
            </Button>
          </>
        )
        .build();
      const logs = PanelBuilders.logs()
        .setTitle('')
        .setHoverHeader(true)
        .setData(linesData)
        .setOption('showTime', true)
        .setOption('enableLogDetails', false)
        .build();
      return new SceneFlexLayout({
        direction: 'row',
        height: 200,
        children: [
          new SceneFlexItem({ width: '40%', minWidth: 350, body: volume }),
          new SceneFlexItem({ minWidth: 300, body: logs }),
        ],
      });
    });
    this.setState({
      body: new SceneCSSGridLayout({ templateColumns: '1fr', autoRows: '200px', isLazy: true, children }),
    });
    this.loadLandingData(source, values, volumes, lines);
  }

  /**
   * The volume and the latest lines of all tiles of the page: one query each, split per tile,
   * instead of two queries per tile. A newer page (search, paging, refresh) supersedes it.
   */
  async loadLandingData(
    source: SignalSource,
    values: string[],
    volumes: Map<string, SceneDataNode>,
    lines: Map<string, SceneDataNode>
  ) {
    const isCurrent = this.tilesRequest.start();
    if (!values.length) {
      return;
    }
    const { primaryLabel } = this.state;
    const timeRange = sceneGraph.getTimeRange(this).state.value;
    const fill = (nodes: Map<string, SceneDataNode>, split: (frames: DataFrame[], value: string) => DataFrame[]) => ({
      done: (frames: DataFrame[]) => {
        if (isCurrent()) {
          nodes.forEach((node, value) =>
            node.setState({ data: { state: LoadingState.Done, series: split(frames, value), timeRange } })
          );
        }
      },
      failed: (error: unknown) => {
        if (isCurrent()) {
          const errors = [{ message: errorMessage(error) }];
          nodes.forEach((node) =>
            node.setState({ data: { state: LoadingState.Error, series: [], timeRange, errors } })
          );
        }
      },
    });
    const volume = fill(volumes, tileVolume);
    const line = fill(lines, tileLines);
    await Promise.all([
      runSql(this, landingVolumeSql(source, primaryLabel, values, FILTERS), Format.TimeSeries, {
        maxDataPoints: 100,
        requestId: this.tilesRequest.requestId('volume'),
      }).then(volume.done, volume.failed),
      runSql(this, landingLinesSql(source, primaryLabel, values, FILTERS, 100), Format.Logs, {
        requestId: this.tilesRequest.requestId('lines'),
      }).then(line.done, line.failed),
    ]);
  }

  includeLabelValue(value: string) {
    const variable = this.getVariable(VAR_FILTERS, AdHocFiltersVariable);
    if (!variable) {
      return;
    }
    const key = this.state.primaryLabel;
    const exists = variable.state.filters.some((f) => f.key === key && f.value === value);
    variable.updateFilters(
      exists
        ? variable.state.filters.filter((f) => !(f.key === key && f.value === value))
        : [...variable.state.filters.filter((f) => f.key !== key), { key, operator: '=', value }]
    );
  }

  /** Opens the details page for a value of the primary label. */
  showLogs(value?: string) {
    const variable = this.getVariable(VAR_FILTERS, AdHocFiltersVariable);
    if (variable && value !== undefined) {
      const key = this.state.primaryLabel;
      variable.updateFilters([...variable.state.filters.filter((f) => f.key !== key), { key, operator: '=', value }]);
    }
    this.setState({ view: 'logs', body: undefined });
    this.refresh();
  }

  backToLanding() {
    const variable = this.getVariable(VAR_FILTERS, AdHocFiltersVariable);
    variable?.updateFilters(variable.state.filters.filter((f) => f.key !== this.state.primaryLabel));
    this.setState({ view: undefined, body: undefined, page: 0 });
    this.refresh();
  }

  setLanding(update: Partial<Pick<LogsExplorationState, 'search' | 'pageSize' | 'page' | 'primaryLabel' | 'tabs'>>) {
    if (update.pageSize) {
      store.set('serviceSelection.pageCount', update.pageSize);
    }
    const reload = update.primaryLabel !== undefined && update.primaryLabel !== this.state.primaryLabel;
    this.setState({ page: 0, ...update });
    if (reload) {
      this.loadLanding();
    } else {
      this.buildLanding();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Details

  async loadCounts() {
    const isCurrent = this.countsRequest.start();
    const source = this.getSource();
    if (!source) {
      return;
    }
    this.setState({ labelsLoad: LOADING, fieldsLoad: LOADING });
    const [count, labels, fields] = await Promise.allSettled([
      runSql(this, countSql(source, ALL_FILTERS), Format.Table, {
        requestId: this.countsRequest.requestId('count'),
      }),
      runSql(this, detectedKeysSql(source, 'labels', ALL_FILTERS), Format.Table, {
        requestId: this.countsRequest.requestId('labels'),
      }),
      runSql(this, detectedKeysSql(source, 'fields', ALL_FILTERS), Format.Table, {
        requestId: this.countsRequest.requestId('fields'),
      }),
    ]);
    if (!isCurrent()) {
      return;
    }
    const keys = (result: typeof labels) =>
      result.status === 'fulfilled'
        ? frameRows<{ key: string; cardinality: number }>(result.value).map((row) => ({
            key: row.key,
            cardinality: Number(row.cardinality),
          }))
        : [];
    const loadState = (result: typeof labels) => (result.status === 'rejected' ? loadFailed(result.reason) : DONE);
    this.setState({
      // The count is a badge on the Logs tab: without it the tab shows none, rather than 0.
      logsCount:
        count.status === 'fulfilled' ? Number(frameRows<{ count: number }>(count.value)[0]?.count ?? 0) : undefined,
      labels: keys(labels),
      fields: keys(fields),
      // The Labels and Fields tabs list these keys, so a failure shows on its tab.
      labelsLoad: loadState(labels),
      fieldsLoad: loadState(fields),
    });
    const view = this.state.view;
    if (view === 'labels' || view === 'fields') {
      // The overview lists the detected keys, which just changed.
      this.buildDetails();
    }
  }

  setView(
    update: Partial<
      Pick<LogsExplorationState, 'view' | 'labelBy' | 'fieldBy' | 'visualization' | 'sort' | 'valueSearch'>
    >
  ) {
    this.setState(update);
    this.buildDetails();
  }

  /** Filters a value of a label or field in or out (Include / Exclude), or clears that filter. */
  toggleValueFilter(key: string, value: string, exclude: boolean) {
    if (key === 'level') {
      const levels = this.state.levels.includes(value)
        ? this.state.levels.filter((l) => l !== value)
        : [...this.state.levels, value];
      this.setConditions({ levels });
      return;
    }
    const variable = this.getVariable(key.startsWith('log.') ? VAR_FIELDS : VAR_FILTERS, AdHocFiltersVariable);
    if (!variable) {
      return;
    }
    const operator = exclude ? '!=' : '=';
    const existing = variable.state.filters.find((f) => f.key === key && f.value === value);
    const others = variable.state.filters.filter((f) => !(f.key === key && f.value === value));
    variable.updateFilters(existing?.operator === operator ? others : [...others, { key, operator, value }]);
  }

  valueFilterState(key: string, value: string): 'include' | 'exclude' | undefined {
    if (key === 'level') {
      return this.state.levels.includes(value) ? 'include' : undefined;
    }
    const variable = this.getVariable(key.startsWith('log.') ? VAR_FIELDS : VAR_FILTERS, AdHocFiltersVariable);
    const filter = variable?.state.filters.find((f) => f.key === key && f.value === value);
    return filter ? (filter.operator === '!=' ? 'exclude' : 'include') : undefined;
  }

  buildDetails() {
    const source = this.getSource();
    const { view } = this.state;
    if (!source || !view) {
      return;
    }
    if (view === 'logs') {
      this.setState({ body: this.buildLogsTab(source) });
    } else if (view === 'patterns') {
      this.setState({ body: new PatternsScene({}) });
    } else {
      this.setState({ body: this.buildBreakdown(source, view) });
    }
  }

  private buildLogsTab(source: SignalSource): SceneObject {
    const volume = stackedBars(
      namedSeries(queryRunner([sqlQuery('A', volumeByLevelSql(source, ALL_FILTERS))], 150), true)
    )
      .setTitle('Log volume')
      .build();
    const lines =
      this.state.visualization === 'table'
        ? PanelBuilders.table()
            .setTitle('Logs')
            .setData(
              queryRunner([
                sqlQuery(
                  'A',
                  `SELECT timestamp AS "Time", level AS "level", body AS "Line", labels AS "Attributes" ` +
                    `FROM (${logLinesSql(source, ALL_FILTERS)}) ORDER BY "Time" DESC`,
                  Format.Table
                ),
              ])
            )
            .build()
        : PanelBuilders.logs()
            .setTitle('Logs')
            .setData(queryRunner([sqlQuery('A', logLinesSql(source, ALL_FILTERS), Format.Logs)]))
            .setOption('showTime', true)
            .setOption('wrapLogMessage', true)
            .setOption('enableLogDetails', true)
            .setOption('enableInfiniteScrolling', false)
            .setOption('sortOrder', 'Descending' as never)
            .build();
    return new SceneFlexLayout({
      direction: 'column',
      children: [
        // Fixed heights: the page scrolls, so a flex item without one would collapse to nothing.
        new SceneFlexItem({ minHeight: 160, height: '20vh', body: volume }),
        new SceneFlexItem({ minHeight: 420, height: 'calc(100vh - 400px)', body: lines }),
      ],
    });
  }

  private buildBreakdown(source: SignalSource, view: 'labels' | 'fields'): SceneObject {
    const by = view === 'labels' ? this.state.labelBy : this.state.fieldBy;
    const keys = (view === 'labels' ? this.state.labels : this.state.fields).filter(
      (k) => !(view === 'labels' && k.key === this.state.primaryLabel)
    );
    if (by === ALL) {
      // Overview: one stacked bar chart per key, the level first, then alphabetical.
      const ordered = [...keys].sort((a, b) =>
        a.key === 'level' ? -1 : b.key === 'level' ? 1 : a.key.localeCompare(b.key)
      );
      return new SceneCSSGridLayout({
        templateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        autoRows: '200px',
        isLazy: true,
        children: ordered.map(({ key, cardinality }) =>
          stackedBars(
            namedSeries(
              panelQueryRunner([sqlQuery('A', volumeByValueSql(source, key, ALL_FILTERS, 20))], 80),
              key === 'level'
            ),
            'hidden'
          )
            .setTitle(keyDisplayName(key))
            .setDescription(`${cardinality} distinct value${cardinality === 1 ? '' : 's'}`)
            .setHeaderActions(
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Select ${keyDisplayName(key)}`}
                tooltip={`View breakdown of values for ${keyDisplayName(key)}`}
                onClick={() => this.setView(view === 'labels' ? { labelBy: key } : { fieldBy: key })}
              >
                Select
              </Button>
            )
            .build()
        ),
      });
    }
    // One key: a summary of all values, then one panel per value with Include / Exclude.
    const runner = queryRunner([sqlQuery('A', volumeByValueSql(source, by, ALL_FILTERS, 0))], 80);
    const summary = stackedBars(
      namedSeries(queryRunner([sqlQuery('A', volumeByValueSql(source, by, ALL_FILTERS, 20))], 150), by === 'level'),
      'right'
    )
      .setTitle(keyDisplayName(by))
      .build();
    const repeater = new SceneByFrameRepeater({
      $data: splitSeriesData(
        runner,
        () => this.state.sort,
        () => this.state.valueSearch
      ),
      body: new SceneCSSGridLayout({
        templateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        autoRows: '200px',
        isLazy: true,
        children: [],
      }),
      getLayoutChild: (data, frame) => {
        const value = seriesName(frame);
        const state = this.valueFilterState(by, value);
        const panel: VizPanel = stackedBars(new SceneDataNode({ data: { ...data, series: [frame] } }), 'hidden')
          .setTitle(value)
          .setHeaderActions(
            <>
              <Button
                key="include"
                size="sm"
                variant={state === 'include' ? 'primary' : 'secondary'}
                fill={state === 'include' ? 'solid' : 'outline'}
                onClick={() => this.toggleValueFilter(by, value, false)}
              >
                {state === 'include' ? 'Remove' : 'Include'}
              </Button>
              {by !== 'level' && (
                <Button
                  key="exclude"
                  size="sm"
                  variant={state === 'exclude' ? 'primary' : 'secondary'}
                  fill={state === 'exclude' ? 'solid' : 'outline'}
                  onClick={() => this.toggleValueFilter(by, value, true)}
                >
                  {state === 'exclude' ? 'Remove' : 'Exclude'}
                </Button>
              )}
            </>
          )
          .build();
        if (by === 'level') {
          panel.onFieldConfigChange({
            ...panel.state.fieldConfig,
            defaults: {
              ...panel.state.fieldConfig.defaults,
              color: { mode: 'fixed' as never, fixedColor: levelColors[value] || levelColors.unknown },
            },
          });
        }
        return panel;
      },
    });
    return new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({ height: 220, body: summary }),
        new SceneFlexItem({ body: repeater, minHeight: 200 }),
      ],
    });
  }

  openInExplore() {
    const source = this.getSource();
    if (source) {
      window.open(
        exploreUrl(this, [
          { editorType: 'sql', rawSql: interpolate(this, logLinesSql(source, ALL_FILTERS)), format: Format.Logs },
        ]),
        '_blank'
      );
    }
  }

  static Component = ({ model }: SceneComponentProps<LogsExploration>) => {
    const { view } = model.useState();
    return view ? <ServiceDetails model={model} /> : <ServiceSelection model={model} />;
  };
}
