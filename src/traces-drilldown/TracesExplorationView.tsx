import React, { useEffect, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { SceneComponentProps, VizPanel, sceneGraph } from '@grafana/scenes';
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
import { Control, copyCurrentUrl, Toolbar, ToolbarGroup, loadError, LoadStatus } from '../shared';
import { MetricType, primarySignals } from './sql';
import { ALL, AttributesSidebar, ComparisonBars, ExceptionsTable, formatDuration, SpanTable } from './components';
import type { Layout, TracesExploration } from './TracesExploration';

export const metricTitles: Record<MetricType, string> = {
  rate: 'Span rate',
  errors: 'Errors rate',
  duration: 'Histogram by duration',
};

const tabLabels: Record<MetricType, Record<'traceList', string>> = {
  rate: { traceList: 'Traces' },
  errors: { traceList: 'Errored traces' },
  duration: { traceList: 'Slow traces' },
};

const RedPanel = ({ panel }: { panel: VizPanel }) => <panel.Component model={panel} />;

export function TracesView({ model }: SceneComponentProps<TracesExploration>) {
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
    attributesLoad,
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
            load={attributesLoad}
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
            load={attributesLoad}
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
            load={attributesLoad}
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
