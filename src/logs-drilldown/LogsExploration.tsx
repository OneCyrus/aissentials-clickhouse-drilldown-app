import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
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
import {
  Alert,
  Button,
  Combobox,
  Field,
  Icon,
  IconButton,
  Input,
  LoadingPlaceholder,
  MultiCombobox,
  RadioButtonGroup,
  Stack,
  Tab,
  TabsBar,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { VAR_DATASOURCE, VAR_FILTERS } from '../constants';
import {
  copyCurrentUrl,
  exploreUrl,
  Format,
  frameRows,
  getSignalSource,
  interpolate,
  queryRunner,
  quoteString,
  runSql,
  SeriesSort,
  seriesName,
  SignalSource,
  splitSeriesData,
  sqlQuery,
  store,
  valueSortOptions,
} from '../shared';
import {
  ALL_FILTERS,
  AppliedPattern,
  countSql,
  detectedKeysSql,
  FILTERS,
  keyDisplayName,
  levelOrder,
  levelsSql,
  LineFilter,
  logsExpression,
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

type View = 'logs' | 'labels' | 'fields' | 'patterns';
type Visualization = 'logs' | 'table';
const ALL = '$__all';
const PAGE_SIZES = [20, 40, 60];

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
  loading: boolean;
  error?: string;
  // Details
  labels: DetectedKey[];
  fields: DetectedKey[];
  logsCount?: number;
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

  private token = 0;

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
      loading: true,
      labels: [],
      fields: [],
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
        return fallback;
      }
    };
    this.setState({
      view: (['logs', 'labels', 'fields', 'patterns'] as View[]).find((v) => v === values.actionView),
      primaryLabel: typeof values.primaryLabel === 'string' && values.primaryLabel ? values.primaryLabel : SERVICE_KEY,
      labelBy: typeof values['var-labelBy'] === 'string' && values['var-labelBy'] ? values['var-labelBy'] : ALL,
      fieldBy: typeof values['var-fieldBy'] === 'string' && values['var-fieldBy'] ? values['var-fieldBy'] : ALL,
      levels: typeof values.levels === 'string' && values.levels ? values.levels.split(',') : [],
      lineFilters: json<LineFilter[]>(values.lineFilters, []),
      patterns: json<AppliedPattern[]>(values.patterns, []),
      visualization: values.visualizationType === 'table' ? 'table' : 'logs',
      sort: (values.sortBy as SeriesSort) || 'stddev-desc',
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

  refresh() {
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
    const token = ++this.token;
    if (!source) {
      this.setState({ loading: false, error: 'Pick a ClickHouse data source with OpenTelemetry logs.' });
      return;
    }
    this.setState({ loading: true, error: undefined });
    try {
      const rows = frameRows<{ value: string; count: number }>(
        await runSql(this, valueCountsSql(source, this.state.primaryLabel, FILTERS))
      );
      if (token === this.token) {
        this.setState({ values: rows.map((row) => ({ value: row.value, count: Number(row.count) })), loading: false });
        this.buildLanding();
      }
    } catch (error) {
      if (token === this.token) {
        this.setState({ loading: false, error: error instanceof Error ? error.message : String(error) });
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
    const { primaryLabel, page, pageSize } = this.state;
    const favorites = this.favorites();
    const values = this.landingValues().slice(page * pageSize, (page + 1) * pageSize);
    const expression = (value: string) => `${logsExpression(primaryLabel) || 'ServiceName'} = ${quoteString(value)}`;
    const children = values.map((value) => {
      const condition = `${expression(value)} AND ${FILTERS}`;
      const volume = stackedBars(
        namedSeries(queryRunner([sqlQuery('A', volumeByLevelSql(source, condition))], 100), true),
        'right'
      )
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
        .setData(queryRunner([sqlQuery('A', logLinesSql(source, condition, 100), Format.Logs)]))
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
    const source = this.getSource();
    if (!source) {
      return;
    }
    const [count, labels, fields] = await Promise.all([
      runSql(this, countSql(source, ALL_FILTERS)).catch(() => []),
      runSql(this, detectedKeysSql(source, 'labels', ALL_FILTERS)).catch(() => []),
      runSql(this, detectedKeysSql(source, 'fields', ALL_FILTERS)).catch(() => []),
    ]);
    const keys = (frames: typeof labels) =>
      frameRows<{ key: string; cardinality: number }>(frames).map((row) => ({
        key: row.key,
        cardinality: Number(row.cardinality),
      }));
    this.setState({
      logsCount: Number(frameRows<{ count: number }>(count)[0]?.count ?? 0),
      labels: keys(labels),
      fields: keys(fields),
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
        new SceneFlexItem({ minHeight: 160, height: '22vh', body: volume }),
        new SceneFlexItem({ minHeight: 500, body: lines }),
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
              queryRunner([sqlQuery('A', volumeByValueSql(source, key, ALL_FILTERS, 20))], 80),
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
              color: { mode: 'fixed' as never, fixedColor: levelColorOf(value) },
            },
          });
        }
        return panel;
      },
    });
    return new SceneFlexLayout({
      direction: 'column',
      children: [new SceneFlexItem({ height: 220, body: summary }), new SceneFlexItem({ body: repeater })],
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

const levelColorOf = (level: string) =>
  ({
    critical: 'semi-dark-purple',
    fatal: 'semi-dark-purple',
    error: 'semi-dark-red',
    warn: 'semi-dark-orange',
    info: 'semi-dark-blue',
    debug: '#9e9e9e',
  })[level] || '#8e8e8e';

function ServiceSelection({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const { body, loading, error, values, primaryLabel, tabs, search, pageSize, page } = model.useState();
  const [searchText, setSearchText] = useState(search);
  const [addingTab, setAddingTab] = useState(false);
  const [labelKeys, setLabelKeys] = useState<string[]>([]);
  const filters = model.getVariable(VAR_FILTERS, AdHocFiltersVariable);
  const { filters: labelFilters } = filters?.useState() || { filters: [] };
  useEffect(() => {
    const timer = setTimeout(() => searchText !== search && model.setLanding({ search: searchText }), 300);
    return () => clearTimeout(timer);
  }, [searchText, search, model]);
  const total = model.landingValues().length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const labelName = keyDisplayName(primaryLabel);

  const openAddTab = async () => {
    setAddingTab(true);
    const source = model.getSource();
    if (source) {
      const rows = frameRows<{ key: string }>(
        await runSql(model, detectedKeysSql(source, 'labels', FILTERS)).catch(() => [])
      );
      setLabelKeys(rows.map((row) => row.key).filter((key) => key !== 'level' && !tabs.includes(key)));
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <Button icon="arrow-right" disabled={!labelFilters.length} onClick={() => model.showLogs(undefined)}>
          Show logs
        </Button>
      </div>
      <div className={styles.tabsRow}>
        <TabsBar>
          {tabs.map((tab) => (
            <Tab
              key={tab}
              label={keyDisplayName(tab).length > 15 ? `${keyDisplayName(tab).slice(0, 15)}…` : keyDisplayName(tab)}
              active={tab === primaryLabel}
              onChangeTab={() => model.setLanding({ primaryLabel: tab })}
              suffix={
                tab !== SERVICE_KEY
                  ? () => (
                      <IconButton
                        name="times"
                        size="sm"
                        tooltip="Remove tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          model.setLanding({ tabs: tabs.filter((t) => t !== tab), primaryLabel: SERVICE_KEY });
                        }}
                      />
                    )
                  : undefined
              }
            />
          ))}
          <Tooltip content="Add label tab">
            <IconButton name="plus" aria-label="Add label tab" onClick={openAddTab} />
          </Tooltip>
        </TabsBar>
        {addingTab && (
          <Combobox
            aria-label="Search labels"
            placeholder="Search labels"
            width={30}
            options={labelKeys.map((key) => ({ label: keyDisplayName(key), value: key }))}
            value={null}
            onChange={(option) => {
              setAddingTab(false);
              if (option) {
                model.setLanding({ tabs: [...tabs, option.value], primaryLabel: option.value });
              }
            }}
          />
        )}
      </div>
      <div className={styles.row}>
        <Input
          className={styles.search}
          prefix={<Icon name="filter" />}
          placeholder={`Search ${labelName}`}
          value={searchText}
          onChange={(e) => setSearchText(e.currentTarget.value)}
        />
        <Combobox
          aria-label="Page size"
          width={10}
          options={PAGE_SIZES.map((size) => ({ label: String(size), value: size }))}
          value={pageSize}
          onChange={(option) => model.setLanding({ pageSize: option.value })}
        />
        <Tooltip content={`${values.length} ${labelName} values have logs for the selected time range.`}>
          <Icon name="info-circle" />
        </Tooltip>
        <span className={styles.muted}>
          Showing {Math.min(total, pageSize * (page + 1)) - page * pageSize} of {total}
        </span>
      </div>
      {error && <Alert title="Error while loading logs">{error}</Alert>}
      {loading && !values.length && <LoadingPlaceholder text="Loading…" />}
      {!loading && !error && !total && (
        <Alert
          severity="info"
          title={search ? `No ${labelName} matched your search.` : `No logs found in ${labelName}.`}
        >
          {search ? '' : 'Please adjust time range or select another label.'}
        </Alert>
      )}
      {body && (
        <div className={styles.fill}>
          <body.Component model={body} />
        </div>
      )}
      {pages > 1 && (
        <div className={styles.pager}>
          {Array.from({ length: pages }, (_, index) => (
            <Button
              key={index}
              size="sm"
              variant={index === page ? 'primary' : 'secondary'}
              onClick={() => model.setLanding({ page: index })}
            >
              {index + 1}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function LineFilters({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const { lineFilters } = model.useState();
  const [drafts, setDrafts] = useState(lineFilters.length ? lineFilters : [emptyLineFilter()]);
  useEffect(() => setDrafts(lineFilters.length ? lineFilters : [emptyLineFilter()]), [lineFilters]);
  // Applied 2 seconds after typing stops, or on Enter.
  useEffect(() => {
    const timer = setTimeout(() => apply(drafts), 2000);
    return () => clearTimeout(timer);
  }, [drafts]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (next: LineFilter[]) => {
    const applied = next.filter((filter) => filter.text);
    if (JSON.stringify(applied) !== JSON.stringify(lineFilters)) {
      model.setConditions({ lineFilters: applied });
    }
  };
  const update = (index: number, change: Partial<LineFilter>) =>
    setDrafts(drafts.map((filter, i) => (i === index ? { ...filter, ...change } : filter)));

  return (
    <Stack direction="column" gap={0.5}>
      {drafts.map((filter, index) => (
        <div key={index} className={styles.lineFilter}>
          <RadioButtonGroup
            size="sm"
            options={[
              { label: 'Include', value: false },
              { label: 'Exclude', value: true },
            ]}
            value={filter.exclude}
            onChange={(exclude) => update(index, { exclude })}
          />
          <Input
            width={40}
            placeholder="Filter logs by string"
            value={filter.text}
            onChange={(e) => update(index, { text: e.currentTarget.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply(drafts)}
            suffix={
              <>
                <IconButton
                  name="text-fields"
                  tooltip={filter.caseSensitive ? 'Case sensitive' : 'Case insensitive'}
                  variant={filter.caseSensitive ? 'primary' : 'secondary'}
                  onClick={() => update(index, { caseSensitive: !filter.caseSensitive })}
                />
                <IconButton
                  name="brackets-curly"
                  tooltip={filter.regex ? 'Regular expression' : 'Plain text'}
                  variant={filter.regex ? 'primary' : 'secondary'}
                  onClick={() => update(index, { regex: !filter.regex })}
                />
              </>
            }
          />
          {drafts.length > 1 && (
            <IconButton
              name="times"
              aria-label="Remove line filter"
              onClick={() => {
                const next = drafts.filter((_, i) => i !== index);
                setDrafts(next);
                apply(next);
              }}
            />
          )}
          {index === drafts.length - 1 && (
            <IconButton
              name="plus"
              aria-label="Add line filter"
              onClick={() => setDrafts([...drafts, emptyLineFilter()])}
            />
          )}
        </div>
      ))}
    </Stack>
  );
}

const emptyLineFilter = (): LineFilter => ({ exclude: false, text: '', caseSensitive: false, regex: false });

function ServiceDetails({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const {
    view,
    body,
    levels,
    patterns,
    labels,
    fields,
    logsCount,
    labelBy,
    fieldBy,
    visualization,
    sort,
    valueSearch,
    patternsCount,
  } = model.useState();
  const fieldsVariable = model.getVariable(VAR_FIELDS, AdHocFiltersVariable);
  const primary = model.getPrimaryFilter();
  const by = view === 'labels' ? labelBy : fieldBy;
  const keys = view === 'labels' ? labels : fields;

  return (
    <div className={styles.container}>
      <div className={styles.row}>
        <Button variant="secondary" size="sm" icon="arrow-left" onClick={() => model.backToLanding()}>
          All {keyDisplayName(model.state.primaryLabel)}
        </Button>
        {primary && (
          <h4 className={styles.title}>
            {keyDisplayName(primary.key)} {primary.operator} {primary.value}
          </h4>
        )}
        <div className={styles.spacer} />
        <Button variant="secondary" size="sm" icon="compass" onClick={() => model.openInExplore()}>
          Explore
        </Button>
        <Button variant="secondary" size="sm" icon="share-alt" tooltip="Copy URL" onClick={() => copyCurrentUrl()} />
      </div>
      <div className={styles.filterRow}>
        <Field
          label="Log levels"
          description="Keep only logs whose severity matches your selection. Leave empty to include all levels."
          className={styles.field}
        >
          <MultiCombobox
            aria-label="Log level filters"
            placeholder="All levels"
            options={levelOrder.map((level) => ({ label: level, value: level }))}
            value={levels}
            onChange={(options) => model.setConditions({ levels: options.map((o) => o.value) })}
            width="auto"
            minWidth={20}
          />
        </Field>
        <Field
          label="Fields"
          description="Filter by log record attributes, such as http.route or user.id."
          className={styles.field}
        >
          <div>{fieldsVariable && <fieldsVariable.Component model={fieldsVariable} />}</div>
        </Field>
        <Field label="Line filter" description="Match or exclude text in the log line body." className={styles.field}>
          <LineFilters model={model} />
        </Field>
      </div>
      {patterns.length > 0 && (
        <div className={styles.row}>
          {(['include', 'exclude'] as const).map((type) => {
            const applied = patterns.filter((p) => p.type === type);
            return applied.length ? (
              <Stack key={type} direction="row" gap={0.5} alignItems="center" wrap="wrap">
                <span className={styles.muted}>
                  {type === 'include' ? 'Included pattern(s)' : 'Excluded pattern(s):'}
                </span>
                {applied.map((p) => (
                  <span key={p.pattern} className={styles.chip}>
                    {p.pattern}
                    <IconButton
                      name="times"
                      size="sm"
                      aria-label="Remove pattern"
                      onClick={() => model.setConditions({ patterns: patterns.filter((x) => x !== p) })}
                    />
                  </span>
                ))}
              </Stack>
            ) : null;
          })}
        </div>
      )}
      <TabsBar>
        <Tab
          label="Logs"
          active={view === 'logs'}
          counter={logsCount}
          onChangeTab={() => model.setView({ view: 'logs' })}
        />
        <Tab
          label="Labels"
          active={view === 'labels'}
          counter={labels.length}
          onChangeTab={() => model.setView({ view: 'labels' })}
        />
        <Tab
          label="Fields"
          active={view === 'fields'}
          counter={fields.length}
          onChangeTab={() => model.setView({ view: 'fields' })}
        />
        <Tab
          label="Patterns"
          active={view === 'patterns'}
          counter={patternsCount}
          onChangeTab={() => model.setView({ view: 'patterns' })}
        />
      </TabsBar>
      {view === 'logs' && (
        <div className={styles.row}>
          <div className={styles.spacer} />
          <RadioButtonGroup
            size="sm"
            options={[
              { label: 'Logs', value: 'logs' },
              { label: 'Table', value: 'table' },
            ]}
            value={visualization}
            onChange={(value) => model.setView({ visualization: value as Visualization })}
          />
        </div>
      )}
      {(view === 'labels' || view === 'fields') && (
        <div className={styles.row}>
          <Field label={view === 'labels' ? 'Label' : 'Field'} className={styles.field}>
            <Combobox
              aria-label={view === 'labels' ? 'Label' : 'Field'}
              width={30}
              options={[
                { label: 'All', value: ALL },
                ...[...keys]
                  .sort((a, b) => (a.key === 'level' ? -1 : b.key === 'level' ? 1 : a.cardinality - b.cardinality))
                  .map((k) => ({ label: keyDisplayName(k.key), value: k.key, description: `${k.cardinality} values` })),
              ]}
              value={by}
              onChange={(option) =>
                model.setView(view === 'labels' ? { labelBy: option.value } : { fieldBy: option.value })
              }
            />
          </Field>
          {by !== ALL && (
            <>
              <Field label="Search" className={styles.field}>
                <Input
                  placeholder="Search for value"
                  value={valueSearch}
                  onChange={(e) => model.setView({ valueSearch: e.currentTarget.value })}
                  width={30}
                />
              </Field>
              <Field
                label="Sort by"
                description="Calculate a derived quantity from the values in your time series and sort by this criteria. Defaults to standard deviation."
                className={styles.field}
              >
                <Combobox
                  aria-label="Sort by"
                  placeholder="Choose criteria"
                  width={22}
                  options={valueSortOptions}
                  value={sort}
                  onChange={(option) => model.setView({ sort: option.value })}
                />
              </Field>
            </>
          )}
        </div>
      )}
      {view !== 'logs' && view !== 'patterns' && !keys.length && (
        <Alert severity="info" title={`We did not find any ${view} for the given time range.`} />
      )}
      {body && (
        <div className={styles.fill}>
          <body.Component model={body} />
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), width: '100%', flexGrow: 1 }),
  row: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), flexWrap: 'wrap' }),
  fill: css({ width: '100%' }),
  filterRow: css({ display: 'flex', alignItems: 'flex-start', gap: theme.spacing(2), flexWrap: 'wrap' }),
  tabsRow: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1) }),
  title: css({ margin: 0 }),
  search: css({ maxWidth: 500 }),
  spacer: css({ flexGrow: 1 }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  field: css({ marginBottom: 0 }),
  lineFilter: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(0.5) }),
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0, 0.5, 0, 1),
    borderRadius: theme.shape.radius.pill,
    background: theme.colors.background.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  pager: css({ display: 'flex', gap: theme.spacing(0.5), justifyContent: 'center', padding: theme.spacing(2) }),
});
