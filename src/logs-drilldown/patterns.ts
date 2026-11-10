import { DataFrame, FieldType, rangeUtil, TimeRange } from '@grafana/data';

/** The number of buckets of the Patterns chart, as its query runner had (maxDataPoints). */
export const PATTERNS_CHART_POINTS = 120;

/** The number of patterns the chart shows: the most frequent ones. */
export const PATTERNS_CHART_SERIES = 20;

/**
 * The bucket of the pattern list's counts, in seconds: the interval Grafana gives a panel of
 * PATTERNS_CHART_POINTS points, so the chart built from the list looks as it did with its own query.
 */
export const patternsBucketSeconds = (range: TimeRange): number =>
  Math.max(1, Math.round(rangeUtil.calculateInterval(range, PATTERNS_CHART_POINTS).intervalMs / 1000));

/** A pattern of the list: its counts per bucket, one entry per bucket and level. */
export interface PatternSeries {
  pattern: string;
  /** [unix seconds, count] */
  series: Array<[number, number]>;
}

/**
 * The chart's data from the pattern list (most frequent first): one frame with a time field and a
 * count field per pattern (labelled `pattern`, ordered by pattern), null where a pattern has no
 * lines. That is the frame the data source returned for the chart's own long-format query.
 */
export const patternsVolumeFrame = (rows: PatternSeries[], limit = PATTERNS_CHART_SERIES): DataFrame => {
  const top = rows.slice(0, limit).sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  const counts = top.map((row) => {
    const byTime = new Map<number, number>();
    // The list has one entry per bucket and level; the chart counts all levels.
    row.series.forEach(([time, count]) => byTime.set(time, (byTime.get(time) || 0) + count));
    return byTime;
  });
  const times = [...new Set(counts.flatMap((byTime) => [...byTime.keys()]))].sort((a, b) => a - b);
  return {
    length: times.length,
    fields: [
      { name: 'time', type: FieldType.time, config: {}, values: times.map((time) => time * 1000) },
      ...top.map((row, i) => ({
        name: 'count',
        type: FieldType.number,
        config: {},
        labels: { pattern: row.pattern },
        values: times.map((time) => counts[i].get(time) ?? null),
      })),
    ],
  };
};
