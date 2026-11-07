import { MetricFunction, MetricLabel, MetricQuery, MetricSeriesAggregation, MetricType } from './types';
import {
  buildMetricQuery,
  generateMetricsQuery,
  getConfiguredMetricTables,
  getDefaultSeriesAggregation,
  getMetricFunctions,
  getMetricTableFeatures,
  getMetricLabelAliases,
  getMetricLabelExpression,
  getMetricValueAliases,
  getSummaryQuantilesSql,
  histogramQuantileExpression,
  MetricQueryOptions,
  quoteString,
  resolveMetricTables,
  usesGroupBy,
  usesSeriesAggregation,
} from './metrics';

const metric = (overrides: Partial<MetricQuery> = {}): MetricQuery => ({
  name: 'http.server.request.duration',
  type: MetricType.Gauge,
  fn: MetricFunction.Avg,
  aggregation: MetricSeriesAggregation.Avg,
  groupBy: [],
  ...overrides,
});

const options = (m: MetricQuery, overrides: Partial<MetricQueryOptions> = {}): MetricQueryOptions => ({
  database: 'otel',
  table: 'otel_metrics_gauge',
  metric: m,
  ...overrides,
});

const route: MetricLabel = { source: 'attribute', key: 'http.route' };
const service: MetricLabel = { source: 'column', key: 'ServiceName' };

describe('metric tables', () => {
  it('falls back to the exporter defaults', () => {
    expect(getConfiguredMetricTables(undefined)).toEqual({
      gauge: 'otel_metrics_gauge',
      sum: 'otel_metrics_sum',
      histogram: 'otel_metrics_histogram',
      exponential_histogram: 'otel_metrics_exp_histogram',
      summary: 'otel_metrics_summary',
    });
    expect(getConfiguredMetricTables({ gaugeTable: ' my_gauge ', sumTable: '' }).gauge).toBe('my_gauge');
    expect(getConfiguredMetricTables({ sumTable: '' }).sum).toBe('otel_metrics_sum');
  });

  it('keeps only existing tables', () => {
    const resolved = resolveMetricTables(getConfiguredMetricTables(), ['otel_metrics_gauge', 'otel_metrics_sum']);
    expect(resolved).toEqual({ gauge: 'otel_metrics_gauge', sum: 'otel_metrics_sum' });
  });

  it('finds the exponential histogram table of older exporters', () => {
    const resolved = resolveMetricTables(getConfiguredMetricTables(), ['otel_metrics_exponential_histogram']);
    expect(resolved).toEqual({ exponential_histogram: 'otel_metrics_exponential_histogram' });
  });

  it('does not replace a custom exponential histogram table with the legacy one', () => {
    const configured = getConfiguredMetricTables({ exponentialHistogramTable: 'custom' });
    expect(resolveMetricTables(configured, ['otel_metrics_exponential_histogram'])).toEqual({});
  });
});

describe('metric labels', () => {
  it('reads map attributes, JSON attributes and columns', () => {
    expect(getMetricLabelExpression(route)).toBe("Attributes['http.route']");
    expect(getMetricLabelExpression({ source: 'resource', key: "it's" })).toBe("ResourceAttributes['it\\'s']");
    expect(getMetricLabelExpression({ source: 'scope', key: 'a' })).toBe("ScopeAttributes['a']");
    expect(getMetricLabelExpression(route, true)).toBe("ifNull(Attributes.`http`.`route`::Nullable(String), '')");
    expect(getMetricLabelExpression(service)).toBe('"ServiceName"');
  });

  it('names labels by key and resolves clashes', () => {
    expect(
      getMetricLabelAliases([
        route,
        { source: 'resource', key: 'http.route' },
        { source: 'attribute', key: 'time' },
        service,
      ])
    ).toEqual(['http.route', 'resource.http.route', 'attribute.time', 'ServiceName']);
  });
});

describe('metric functions', () => {
  it('offers functions by type', () => {
    expect(getMetricFunctions(MetricType.Gauge)[0]).toBe(MetricFunction.Avg);
    expect(getMetricFunctions(MetricType.Sum, true)).toEqual([MetricFunction.Rate, MetricFunction.Increase]);
    expect(getMetricFunctions(MetricType.Sum, false)[0]).toBe(MetricFunction.Last);
    expect(getMetricFunctions(MetricType.Histogram)[0]).toBe(MetricFunction.Quantile);
    expect(getMetricFunctions(MetricType.ExponentialHistogram)).not.toContain(MetricFunction.Quantile);
    expect(getMetricFunctions(MetricType.Summary)[0]).toBe(MetricFunction.Quantile);
  });

  it('picks the cross-series aggregation', () => {
    expect(getDefaultSeriesAggregation(MetricType.Sum, MetricFunction.Rate)).toBe(MetricSeriesAggregation.Sum);
    expect(getDefaultSeriesAggregation(MetricType.Sum, MetricFunction.Last)).toBe(MetricSeriesAggregation.Sum);
    expect(getDefaultSeriesAggregation(MetricType.Gauge, MetricFunction.Last)).toBe(MetricSeriesAggregation.Avg);
    expect(usesSeriesAggregation(MetricType.Histogram, MetricFunction.Quantile)).toBe(false);
    expect(usesSeriesAggregation(MetricType.Summary, MetricFunction.Quantile)).toBe(true);
    expect(usesSeriesAggregation(MetricType.Histogram, MetricFunction.AvgValue)).toBe(false);
  });

  it('builds a query for a picked metric', () => {
    expect(buildMetricQuery({ name: 'requests', type: MetricType.Sum, isMonotonic: true, unit: '1' })).toEqual({
      name: 'requests',
      type: MetricType.Sum,
      unit: '1',
      isMonotonic: true,
      fn: MetricFunction.Rate,
      quantiles: undefined,
      aggregation: MetricSeriesAggregation.Sum,
      groupBy: [],
      jsonAttributes: undefined,
    });
  });

  it('keeps the group by and a fitting function of the previous metric', () => {
    const previous = metric({
      type: MetricType.Histogram,
      fn: MetricFunction.Quantile,
      quantiles: [0.99],
      groupBy: [route],
    });
    const next = buildMetricQuery({ name: 'other', type: MetricType.Histogram }, previous);
    expect(next.fn).toBe(MetricFunction.Quantile);
    expect(next.quantiles).toEqual([0.99]);
    expect(next.groupBy).toEqual([route]);

    const counter = buildMetricQuery({ name: 'c', type: MetricType.Sum, isMonotonic: true }, previous);
    expect(counter.fn).toBe(MetricFunction.Rate);
    expect(counter.aggregation).toBe(MetricSeriesAggregation.Sum);

    // A different kind of metric gets its own default function, even one the previous used.
    const rateOfCounter = metric({ type: MetricType.Sum, isMonotonic: true, fn: MetricFunction.Rate });
    expect(buildMetricQuery({ name: 'h', type: MetricType.Histogram }, rateOfCounter).fn).toBe(MetricFunction.Quantile);
    const histogramRate = metric({ type: MetricType.Histogram, fn: MetricFunction.Rate });
    expect(buildMetricQuery({ name: 'h2', type: MetricType.Histogram }, histogramRate).fn).toBe(MetricFunction.Rate);
  });

  it('names value columns', () => {
    expect(getMetricValueAliases(metric())).toEqual(['http.server.request.duration']);
    expect(getMetricValueAliases(metric({ fn: MetricFunction.Quantile, quantiles: [0.95] }))).toEqual([
      'http.server.request.duration p95',
    ]);
    expect(getMetricValueAliases(metric({ fn: MetricFunction.Quantile, quantiles: [0.5, 0.999] }))).toEqual([
      'p50',
      'p99.9',
    ]);
  });
});

describe('generateMetricsQuery', () => {
  it('generates nothing until a metric is picked', () => {
    expect(generateMetricsQuery(options(metric({ name: '' })))).toBe('');
    expect(generateMetricsQuery(options(metric(), { table: '' }))).toBe('');
    expect(generateMetricsQuery(options(metric({ name: '' })))).toBe('');
  });

  it('aggregates gauges per series, then across series', () => {
    const sql = generateMetricsQuery(options(metric({ groupBy: [route, service] })));
    expect(sql).toBe(
      'SELECT __time AS time, __label_0 AS "http.route", __label_1 AS "ServiceName", avg(__value) AS "http.server.request.duration" ' +
        'FROM (SELECT $__timeInterval(TimeUnix) AS __time, Attributes[\'http.route\'] AS __label_0, "ServiceName" AS __label_1, ' +
        'cityHash64(ResourceAttributes, ScopeName, ScopeAttributes, Attributes) AS __series, avg(Value) AS __value ' +
        'FROM "otel"."otel_metrics_gauge" WHERE MetricName = \'http.server.request.duration\' AND TimeUnix >= $__fromTime AND TimeUnix <= $__toTime ' +
        'GROUP BY __time, __label_0, __label_1, __series) GROUP BY __time, __label_0, __label_1 ORDER BY time ASC'
    );
  });

  it.each([
    [MetricFunction.Min, 'min(Value) AS __value'],
    [MetricFunction.Max, 'max(Value) AS __value'],
    [MetricFunction.Last, 'argMax(Value, TimeUnix) AS __value'],
  ])('reduces gauge series with %s', (fn, expected) => {
    expect(generateMetricsQuery(options(metric({ fn })))).toContain(expected);
  });

  it.each([
    [MetricSeriesAggregation.Sum, 'sum(__value)'],
    [MetricSeriesAggregation.Min, 'min(__value)'],
    [MetricSeriesAggregation.Max, 'max(__value)'],
    [MetricSeriesAggregation.Count, 'count(__value)'],
  ])('aggregates across series with %s', (aggregation, expected) => {
    expect(generateMetricsQuery(options(metric({ aggregation })))).toContain(
      `${expected} AS "http.server.request.duration"`
    );
  });

  it('never buckets finer than the minimum step', () => {
    const sql = generateMetricsQuery(options(metric({ minStep: 20 })));
    expect(sql).toContain(
      'toStartOfInterval(toDateTime(TimeUnix), INTERVAL greatest($__interval_s, 20) second) AS __time'
    );
    expect(sql).not.toContain('$__timeInterval');
  });

  it('escapes the metric name', () => {
    expect(generateMetricsQuery(options(metric({ name: "a'b" })))).toContain("MetricName = 'a\\'b'");
  });

  it('treats non-monotonic sums as values', () => {
    const sql = generateMetricsQuery(
      options(metric({ type: MetricType.Sum, isMonotonic: false, fn: MetricFunction.Last }), {
        table: 'otel_metrics_sum',
      })
    );
    expect(sql).toContain('argMax(Value, TimeUnix) AS __value');
    expect(sql).not.toContain('lagInFrame');
  });

  describe('counters', () => {
    const counter = metric({
      name: 'http.server.requests',
      type: MetricType.Sum,
      isMonotonic: true,
      fn: MetricFunction.Rate,
      aggregation: MetricSeriesAggregation.Sum,
      groupBy: [route],
    });

    it('computes per-second rates per run and bucket, handling resets and delta temporality', () => {
      const sql = generateMetricsQuery(options(counter, { table: 'otel_metrics_sum' }));
      expect(sql).toBe(
        'SELECT __time AS time, __label_0 AS "http.route", sum(__d0 / nullIf(__seconds, 0)) AS "http.server.requests"' +
          '' +
          '' +
          " FROM (SELECT __time, __label_0, __series, sum(__in0 + if(NOT __is_delta AND __prev0 IS NOT NULL, if(__first0 >= __prev0, __first0 - __prev0, __first0), 0)) AS __d0, sum(__secs + if(NOT __is_delta AND __prev0 IS NOT NULL, dateDiff('millisecond', __prev_t, __first_t) / 1000, 0)) AS __seconds FROM (SELECT *, lagInFrame(toNullable(__last0)) OVER w AS __prev0, lagInFrame(toNullable(__last_t)) OVER w AS __prev_t FROM (SELECT $__timeInterval(TimeUnix) AS __time, Attributes['http.route'] AS __label_0, cityHash64(ResourceAttributes, ScopeName, ScopeAttributes, Attributes) AS __series, if(AggregationTemporality = 1, toDateTime(0), StartTimeUnix) AS __run, any(AggregationTemporality = 1) AS __is_delta, if(__is_delta, sum(toFloat64(Value)), deltaSumTimestamp(toFloat64(Value), toUnixTimestamp64Nano(toDateTime64(TimeUnix, 9)))) AS __in0, argMin(toFloat64(Value), TimeUnix) AS __first0, argMax(toFloat64(Value), TimeUnix) AS __last0, min(TimeUnix) AS __first_t, max(TimeUnix) AS __last_t, if(__is_delta, sum(if(StartTimeUnix > toDateTime(0) AND StartTimeUnix < TimeUnix, dateDiff('millisecond', StartTimeUnix, TimeUnix), 0) / 1000), dateDiff('millisecond', __first_t, __last_t) / 1000) AS __secs" +
          ' FROM "otel"."otel_metrics_sum" WHERE MetricName = \'http.server.requests\' AND TimeUnix >= subtractSeconds($__fromTime, greatest($__interval_s, 600)) AND TimeUnix <= $__toTime GROUP BY __time, __label_0, __series, __run)' +
          ' WINDOW w AS (PARTITION BY __series ORDER BY __first_t ASC ROWS BETWEEN 1 PRECEDING AND CURRENT ROW))' +
          ' WHERE __time >= $__timeInterval($__fromTime) GROUP BY __time, __label_0, __series' +
          ') GROUP BY __time, __label_0 ORDER BY time ASC'
      );
    });

    it('computes increases', () => {
      const sql = generateMetricsQuery(
        options({ ...counter, fn: MetricFunction.Increase }, { table: 'otel_metrics_sum' })
      );
      expect(sql).toContain('sum(__d0) AS "http.server.requests"');
      expect(sql).not.toContain('__seconds, 0)');
    });

    it('rates the observation count of histograms', () => {
      const sql = generateMetricsQuery(
        options({ ...counter, type: MetricType.Histogram, isMonotonic: undefined }, { table: 'otel_metrics_histogram' })
      );
      expect(sql).toContain(
        'deltaSumTimestamp(toFloat64(Count), toUnixTimestamp64Nano(toDateTime64(TimeUnix, 9)))) AS __in0'
      );
      expect(sql).not.toContain('__first1');
    });

    it('rates the sum of histograms with resets detected on the count', () => {
      const sql = generateMetricsQuery(
        options({ ...counter, type: MetricType.Histogram, fn: MetricFunction.SumRate }, { table: 'h' })
      );
      expect(sql).toContain(
        'deltaSumTimestamp(toFloat64(Sum), toUnixTimestamp64Nano(toDateTime64(TimeUnix, 9)))) AS __in0'
      );
      // Resets are detected on the count, tracked as the second value.
      expect(sql).toContain('argMin(toFloat64(Count), TimeUnix) AS __first1');
      expect(sql).toContain('if(__first1 >= __prev1, __first0 - __prev0, __first0)');
    });

    it('divides summed sums by summed counts for the average value', () => {
      const sql = generateMetricsQuery(
        options({ ...counter, type: MetricType.ExponentialHistogram, fn: MetricFunction.AvgValue }, { table: 'e' })
      );
      expect(sql).toContain(
        'deltaSumTimestamp(toFloat64(Sum), toUnixTimestamp64Nano(toDateTime64(TimeUnix, 9)))) AS __in0'
      );
      expect(sql).toContain(
        'deltaSumTimestamp(toFloat64(Count), toUnixTimestamp64Nano(toDateTime64(TimeUnix, 9)))) AS __in1'
      );
      expect(sql).toContain('sum(__d0) / nullIf(sum(__d1), 0) AS "http.server.requests"');
    });

    it('treats summaries as cumulative', () => {
      const sql = generateMetricsQuery(options({ ...counter, type: MetricType.Summary }, { table: 's' }));
      expect(sql).toContain('any(0) AS __is_delta');
      expect(sql).toContain('if(0, toDateTime(0), StartTimeUnix) AS __run');
      expect(sql).not.toContain('AggregationTemporality');
    });
  });

  it('computes histogram quantiles from merged bucket increases', () => {
    const sql = generateMetricsQuery(
      options(
        metric({ type: MetricType.Histogram, fn: MetricFunction.Quantile, quantiles: [0.5, 0.99], groupBy: [service] }),
        { table: 'otel_metrics_histogram' }
      )
    );
    expect(sql).toContain("argMax(CAST(BucketCounts, 'Array(Float64)'), TimeUnix) AS __last_b");
    expect(sql).toContain('lagInFrame(__last_b) OVER w AS __prev_b');
    // Buckets merge by upper bound, so series with different bounds add up correctly.
    expect(sql).toContain(
      'sumMap(arrayPushBack(__point_bounds, inf), arrayResize(arrayMap((x, i) -> x + (if(__is_delta OR'
    );
    expect(sql).toContain('arrayMap(x -> 1., arrayPushBack(__point_bounds, inf))) AS __merged');
    expect(sql).toContain('tupleElement(__merged, 2) AS __counts');
    expect(sql).toContain('arrayPopBack(tupleElement(__merged, 1)) AS __bounds');
    expect(sql).toContain('GROUP BY __time, __label_0, __series, __run');
    expect(sql).toContain('arrayFirstIndex(c -> c >= 0.5 * __total, __cum) AS __i0');
    expect(sql).toContain('arrayFirstIndex(c -> c >= 0.99 * __total, __cum) AS __i1');
    expect(sql).toContain(`${histogramQuantileExpression(0.5, '__i0')} AS "p50"`);
    expect(sql).toContain(`${histogramQuantileExpression(0.99, '__i1')} AS "p99"`);
    expect(sql).toContain('__label_0 AS "ServiceName"');
    expect(sql.endsWith('ORDER BY time ASC')).toBe(true);
  });

  it('builds histogram heatmaps with one row per bucket bound', () => {
    const sql = generateMetricsQuery(
      options(metric({ type: MetricType.Histogram, fn: MetricFunction.Heatmap, groupBy: [service] }), {
        table: 'otel_metrics_histogram',
      })
    );
    // The group by does not apply: a heatmap shows one histogram of all series.
    expect(sql).not.toContain('__label_0');
    expect(sql).toContain("if(__i <= length(__bounds), toString(__bounds[__i]), '+Inf') AS le");
    expect(sql).toContain('__count AS "http.server.request.duration"');
    expect(sql).toContain('ARRAY JOIN __counts AS __count, arrayEnumerate(__counts) AS __i');
    expect(sql.endsWith('ORDER BY time ASC, __i ASC')).toBe(true);
  });

  it('offers heatmaps for histograms only', () => {
    expect(getMetricFunctions(MetricType.Histogram)).toContain(MetricFunction.Heatmap);
    expect(getMetricFunctions(MetricType.ExponentialHistogram)).not.toContain(MetricFunction.Heatmap);
    expect(usesSeriesAggregation(MetricType.Histogram, MetricFunction.Heatmap)).toBe(false);
    expect(usesGroupBy(MetricFunction.Heatmap)).toBe(false);
    expect(usesGroupBy(MetricFunction.Quantile)).toBe(true);
    expect(
      generateMetricsQuery(
        options(metric({ type: MetricType.ExponentialHistogram, fn: MetricFunction.Heatmap }), {
          table: 'otel_metrics_exp_histogram',
        })
      )
    ).toBe('');
  });

  it('reads summary quantiles per series', () => {
    const sql = generateMetricsQuery(
      options(
        metric({
          type: MetricType.Summary,
          fn: MetricFunction.Quantile,
          quantiles: [0.9],
          aggregation: MetricSeriesAggregation.Max,
        }),
        { table: 'otel_metrics_summary' }
      )
    );
    expect(sql).toContain(
      'avg(if(indexOf(ValueAtQuantiles.Quantile, 0.9) = 0 OR isNaN(ValueAtQuantiles.Value[indexOf(ValueAtQuantiles.Quantile, 0.9)]), NULL, ValueAtQuantiles.Value[indexOf(ValueAtQuantiles.Quantile, 0.9)])) AS __q0'
    );
    expect(sql).toContain('max(__q0) AS "http.server.request.duration p90"');
  });

  it('detects JSON attribute columns', () => {
    expect(getMetricTableFeatures([{ name: 'Attributes', type: 'JSON' }])).toEqual({ jsonAttributes: true });
    expect(getMetricTableFeatures([{ name: 'Attributes', type: 'Map(LowCardinality(String), String)' }])).toEqual({
      jsonAttributes: false,
    });
  });

  it('hashes JSON attribute columns as strings', () => {
    const sql = generateMetricsQuery(options(metric({ jsonAttributes: true, groupBy: [route] })));
    expect(sql).toContain(
      'cityHash64(toString(ResourceAttributes), ScopeName, toString(ScopeAttributes), toString(Attributes))'
    );
    expect(sql).toContain("ifNull(Attributes.`http`.`route`::Nullable(String), '') AS __label_0");
  });
});

describe('discovery queries', () => {
  it('lists summary quantiles', () => {
    expect(getSummaryQuantilesSql('otel', 's', 'rpc')).toContain('arrayJoin(ValueAtQuantiles.Quantile)');
  });

  it('quotes strings', () => {
    expect(quoteString("a\\'b")).toBe("'a\\\\\\'b'");
  });
});
