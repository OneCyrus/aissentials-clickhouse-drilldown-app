import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { SceneComponentProps } from '@grafana/scenes';
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
  getMetricFunctions,
  metricFunctionLabels,
  usesGroupBy,
  usesSeriesAggregation,
} from 'clickhouse/metrics';
import { MetricFunction, MetricSeriesAggregation, MetricType } from 'clickhouse/types';
import { Control, copyCurrentUrl, LoadStatus, seriesSortOptions, Spacer, Toolbar, ToolbarGroup } from '../shared';
import { getMetricLabelId, metricPrefix } from './sql';
import { metricKindLabel } from './MetricsExplorationView';
import type { BreakdownLayout, HistogramBreakdownFn, MetricScene } from './MetricScene';

export const ALL = '$__all';

const quantileChoices = [0.5, 0.75, 0.9, 0.95, 0.99, 0.999];

export function MetricSceneRenderer({ model }: SceneComponentProps<MetricScene>) {
  const styles = useStyles2(getStyles);
  const state = model.useState();
  const { entry, query, main, body, actionView, groupBy, labels, labelsLoad, sort, search, layout, summaryQuantiles } =
    state;
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
      {actionView === 'breakdown' && (
        <LoadStatus
          state={labelsLoad}
          quietLoading
          loadingText="Loading labels…"
          errorTitle="Error while loading the metric's labels"
        />
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
