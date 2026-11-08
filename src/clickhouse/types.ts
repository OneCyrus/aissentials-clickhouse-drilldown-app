/**
 * Types of the ClickHouse data source's OTel metrics queries and settings, as far as this app
 * uses them. They mirror grafana-clickhouse-datasource, so queries the app opens in Explore are
 * understood by the data source's query editor.
 */

/** The data source's query types. */
export enum QueryType {
  Table = 'table',
  Logs = 'logs',
  TimeSeries = 'timeseries',
  Traces = 'traces',
}

/** The signal a single-source ClickHouse data source holds. */
export type SignalType = 'logs' | 'traces' | 'metrics';

/** OTel metric table names, mirroring the exporter's `metrics_tables` option. */
export interface CHMetricsConfig {
  defaultDatabase?: string;
  gaugeTable?: string;
  sumTable?: string;
  histogramTable?: string;
  exponentialHistogramTable?: string;
  summaryTable?: string;
}

/** The parts of the ClickHouse data source settings (jsonData) the app reads. */
export interface CHConfig {
  defaultDatabase?: string;
  signalType?: SignalType;
  logs?: {
    defaultDatabase?: string;
    defaultTable?: string;
    /**
     * The column the exporter's partition key uses (DateTime), when the schema has one. Filtering on
     * it prunes partitions; filtering on the DateTime64 column does not.
     */
    filterTimeColumn?: string;
  };
  traces?: {
    defaultDatabase?: string;
    defaultTable?: string;
    /**
     * Suffix of the companion trace-id index table (`<traces table>_trace_id_ts`), which maps a
     * TraceId to its start and end. The data source defaults to `_trace_id_ts`.
     */
    traceTimestampTableSuffix?: string;
  };
  metrics?: CHMetricsConfig;
}

/** Operators of the data source's builder filters used for Explore links. */
export enum FilterOperator {
  Equals = '=',
  NotEquals = '!=',
  In = 'IN',
  NotIn = 'NOT IN',
}

/** A builder filter of the data source, for the metrics queries the app opens in Explore. */
export interface Filter {
  filterType: 'custom';
  key: string;
  mapKey?: string;
  type: string;
  condition: 'AND' | 'OR';
  operator: FilterOperator;
  value: string | string[];
}

/**
 * The OTel metric data point types, one per table written by the
 * opentelemetry-collector-contrib ClickHouse exporter.
 */
export enum MetricType {
  Gauge = 'gauge',
  Sum = 'sum',
  Histogram = 'histogram',
  ExponentialHistogram = 'exponential_histogram',
  Summary = 'summary',
}

/**
 * What is computed per series and time bucket.
 * - avg / min / max / last: the value of a gauge or non-monotonic sum.
 * - rate: per-second increase of a counter (a monotonic sum, or the Count of a histogram or summary).
 * - increase: increase of a counter per time bucket.
 * - sum_rate: per-second increase of the Sum of a histogram or summary.
 * - avg_value: Sum / Count of a histogram or summary, for example the mean latency.
 * - quantile: quantiles from histogram buckets or summary quantile values.
 * - heatmap: observations per histogram bucket and interval, for the Heatmap panel.
 */
export enum MetricFunction {
  Avg = 'avg',
  Min = 'min',
  Max = 'max',
  Last = 'last',
  Rate = 'rate',
  Increase = 'increase',
  SumRate = 'sum_rate',
  AvgValue = 'avg_value',
  Quantile = 'quantile',
  Heatmap = 'heatmap',
}

/** How the per-series values are combined into one value per group. */
export enum MetricSeriesAggregation {
  Sum = 'sum',
  Avg = 'avg',
  Min = 'min',
  Max = 'max',
  Count = 'count',
}

/**
 * Where a metric label comes from.
 * - attribute: the data point `Attributes` map.
 * - resource: the `ResourceAttributes` map (service.name, k8s.pod.name, ...).
 * - scope: the `ScopeAttributes` map.
 * - column: a top level column such as ServiceName or ScopeName.
 */
export type MetricLabelSource = 'attribute' | 'resource' | 'scope' | 'column';

export interface MetricLabel {
  source: MetricLabelSource;
  /** The attribute key, or the column name for the `column` source. */
  key: string;
}

export interface MetricQuery {
  /** MetricName. Empty until a metric is picked. */
  name: string;
  type: MetricType;
  unit?: string;
  /** IsMonotonic of a sum metric: monotonic sums are counters. */
  isMonotonic?: boolean;
  fn: MetricFunction;
  /** Quantiles between 0 and 1 for the quantile function. */
  quantiles?: number[];
  aggregation: MetricSeriesAggregation;
  groupBy: MetricLabel[];
  /** True when the attribute columns use the ClickHouse JSON type instead of Map. */
  jsonAttributes?: boolean;
  /**
   * Smallest time bucket in seconds, set to twice the metric's detected export interval. Buckets
   * shorter than the export interval would hold only some of the series' points, so sums across
   * series would jump depending on which instances happened to export in each bucket.
   */
  minStep?: number;
  /**
   * An extra SQL condition for the WHERE clause, for example `$filters` of the Drilldown app's
   * filter bar. The query editor doesn't set it.
   */
  condition?: string;
}
