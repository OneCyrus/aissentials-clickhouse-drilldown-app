import { MetricCatalogEntry } from 'clickhouse/metrics';
import { PanelBuilders, SceneDataTransformer, VizPanel } from '@grafana/scenes';
import { DataFrame } from '@grafana/data';
import { map } from 'rxjs';
import { toHeatmapFrame } from 'clickhouse/heatmap';
import { LegendDisplayMode, TooltipDisplayMode } from '@grafana/schema';
import { MetricFunction, MetricQuery, MetricType } from 'clickhouse/types';
import { grafanaUnit, headerButton, queryRunner, sqlQuery, SignalSource } from '../shared';
import { defaultMetricQuery, metricSql } from './sql';

/** Fixed colors per grid position, like the Drilldown grid: the first 8 colors of Grafana's classic palette. */
const palette = ['green', 'yellow', 'blue', 'orange', 'red', 'light-blue', 'purple', 'dark-green'];
export const colorAt = (index: number) => palette[index % palette.length];

const isRate = (query: MetricQuery) => query.fn === MetricFunction.Rate || query.fn === MetricFunction.SumRate;

/** The unit of a metric query's values. */
export const queryUnit = (entry: MetricCatalogEntry, query: MetricQuery): string | undefined => {
  if (query.fn === MetricFunction.Rate || query.fn === MetricFunction.Increase) {
    // Counting observations (histograms) or a counter of its own unit.
    return entry.type === MetricType.Sum ? grafanaUnit(entry.unit, isRate(query)) : isRate(query) ? 'reqps' : 'short';
  }
  if (query.fn === MetricFunction.SumRate) {
    // The per-second sum of observations: seconds per second, bytes per second.
    return entry.unit === 's' ? undefined : grafanaUnit(entry.unit, true);
  }
  return grafanaUnit(entry.unit);
};

type PanelOptions = { title?: string; color?: string; legend?: boolean; maxDataPoints?: number };

/** A heatmap of a histogram's buckets, drawn as is (Spectral, 32 steps), like Metrics Drilldown. */
const heatmapPanel = (source: SignalSource, entry: MetricCatalogEntry, query: MetricQuery, options: PanelOptions) =>
  PanelBuilders.heatmap()
    .setTitle(options.title ?? entry.name)
    .setData(
      new SceneDataTransformer({
        $data: queryRunner([sqlQuery('A', metricSql(source, query))], options.maxDataPoints ?? 300),
        // The bucket rows as heatmap rows, as the data source does for its own heatmap queries.
        transformations: [() => (frames) => frames.pipe(map((data: DataFrame[]) => data.map(toHeatmapFrame)))],
      })
    )
    .setOption('calculate', false)
    .setOption('color', {
      mode: 'scheme' as never,
      scheme: 'Spectral',
      steps: 32,
      exponent: 0.5,
      reverse: false,
      fill: 'dark-orange',
    } as never)
    .setOption('yAxis', { unit: grafanaUnit(entry.unit) } as never)
    .setOption('legend', { show: Boolean(options.legend) })
    .setOption('cellGap', 1);

/** A panel of a metric query: a heatmap for the heatmap function, else a time series. */
export const metricPanel = (
  source: SignalSource,
  entry: MetricCatalogEntry,
  query: MetricQuery,
  options: PanelOptions = {}
) =>
  query.fn === MetricFunction.Heatmap
    ? heatmapPanel(source, entry, query, options)
    : timeseriesPanel(source, entry, query, options);

const timeseriesPanel = (
  source: SignalSource,
  entry: MetricCatalogEntry,
  query: MetricQuery,
  options: PanelOptions
) => {
  const builder = PanelBuilders.timeseries()
    .setTitle(options.title ?? entry.name)
    .setData(queryRunner([sqlQuery('A', metricSql(source, query))], options.maxDataPoints ?? 300))
    .setOption('legend', {
      showLegend: Boolean(options.legend),
      displayMode: LegendDisplayMode.List,
      placement: 'bottom',
      calcs: [],
    })
    .setOption('tooltip', { mode: TooltipDisplayMode.Multi, sort: 'none' as never })
    .setCustomFieldConfig('fillOpacity', 9)
    .setCustomFieldConfig('lineWidth', 1)
    .setCustomFieldConfig('pointSize', 3);
  const unit = queryUnit(entry, query);
  if (unit) {
    builder.setUnit(unit);
  }
  if (options.color) {
    builder.setColor({ mode: 'fixed' as never, fixedColor: options.color });
  }
  return builder;
};

/** A metric in the grid: its default query as a sparkline-style panel with a Select button. */
export const metricGridItem = (
  source: SignalSource,
  entry: MetricCatalogEntry,
  index: number,
  onSelect: () => void
): VizPanel =>
  metricPanel(source, entry, defaultMetricQuery(entry), { color: colorAt(index), maxDataPoints: 120 })
    .setDescription(entry.description)
    .setHeaderActions(headerButton('Select', onSelect))
    .build();
