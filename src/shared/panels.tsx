import React from 'react';
import { DataFrame, FieldType, PanelData } from '@grafana/data';
import { CustomTransformOperator, SceneDataTransformer, SceneQueryRunner } from '@grafana/scenes';
import { Button } from '@grafana/ui';
import { map } from 'rxjs';

/** A small header button like the Drilldown apps' "Select" and "Add to filters". */
export const headerButton = (label: string, onClick: () => void, icon?: 'plus' | 'arrow-right' | 'filter') => (
  <Button size="sm" variant="secondary" fill="outline" icon={icon} onClick={onClick}>
    {label}
  </Button>
);

export type SeriesSort =
  'outliers' | 'name' | 'name-desc' | 'max-desc' | 'min-asc' | 'avg-desc' | 'sum-desc' | 'stddev-desc';

export const seriesSortOptions: Array<{ label: string; value: SeriesSort; description: string }> = [
  {
    label: 'Outlying series',
    value: 'outliers',
    description: 'Prioritizes values that show distinct behavior from others within the same label',
  },
  { label: 'Name [A-Z]', value: 'name', description: 'Alphabetical order' },
  { label: 'Name [Z-A]', value: 'name-desc', description: 'Reversed alphabetical order' },
];

/** The sort options of Logs Drilldown's value breakdowns. */
export const valueSortOptions: Array<{ label: string; value: SeriesSort; description: string }> = [
  { label: 'Widest spread', value: 'stddev-desc', description: 'Standard deviation, highest first' },
  { label: 'Count', value: 'sum-desc', description: 'Total, highest first' },
  { label: 'Highest spike', value: 'max-desc', description: 'Highest maximum first' },
  { label: 'Lowest dip', value: 'min-asc', description: 'Lowest minimum first' },
  { label: 'Name', value: 'name', description: 'Alphabetical order' },
];

const numbers = (frame: DataFrame): number[] =>
  (frame.fields.find((field) => field.type === FieldType.number)?.values || []).filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );

const pointwiseMean = (frames: DataFrame[]): number[] => {
  const length = Math.max(0, ...frames.map((frame) => frame.length));
  return Array.from({ length }, (_, i) => {
    const values = frames
      .map((frame) => frame.fields.find((f) => f.type === FieldType.number)?.values[i])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
  });
};

/** A series' value for a sort: higher sorts first. */
const sortScore = (frame: DataFrame, sort: SeriesSort, mean: number[]): number => {
  const values = numbers(frame);
  if (!values.length) {
    return -Infinity;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  const avg = sum / values.length;
  switch (sort) {
    case 'max-desc':
      return Math.max(...values);
    case 'min-asc':
      return -Math.min(...values);
    case 'sum-desc':
      return sum;
    case 'stddev-desc':
      return Math.sqrt(values.reduce((total, value) => total + (value - avg) ** 2, 0) / values.length);
    case 'outliers': {
      // Grafana's apps run an outlier detector (DBSCAN in WebAssembly). This keeps the idea, unusual
      // series first, with a simple deterministic score: the squared distance from the mean series.
      const raw = (frame.fields.find((f) => f.type === FieldType.number)?.values || []) as Array<number | null>;
      return raw.reduce<number>(
        (total, value, i) =>
          total + (typeof value === 'number' && Number.isFinite(mean[i]) ? (value - mean[i]) ** 2 : 0),
        0
      );
    }
    case 'avg-desc':
    default:
      return avg;
  }
};

/** Sorts split series for a breakdown. */
export const sortSeries = (frames: DataFrame[], sort: SeriesSort): DataFrame[] => {
  if (sort === 'name' || sort === 'name-desc') {
    const sorted = [...frames].sort((a, b) => seriesName(a).localeCompare(seriesName(b)));
    return sort === 'name' ? sorted : sorted.reverse();
  }
  const mean = sort === 'outliers' ? pointwiseMean(frames) : [];
  const scores = new Map(frames.map((frame) => [frame, sortScore(frame, sort, mean)]));
  return [...frames].sort((a, b) => scores.get(b)! - scores.get(a)!);
};

/** Comma separated, case-insensitive regular expressions (invalid ones dropped); any may match. */
export const searchMatches = (text: string): ((value: string) => boolean) => {
  const patterns = text
    .split(',')
    .map((piece) => piece.trim())
    .filter(Boolean)
    .flatMap((piece) => {
      try {
        return [new RegExp(piece, 'i')];
      } catch {
        return [];
      }
    });
  return patterns.length ? (value) => patterns.some((pattern) => pattern.test(value)) : () => true;
};

/** The label value a split series stands for. */
export const seriesName = (frame: DataFrame): string => {
  const field = frame.fields.find((f) => f.type === FieldType.number);
  const labels = field?.labels ? Object.values(field.labels) : [];
  return labels.length ? labels.join(', ') : field?.config.displayNameFromDS || field?.name || frame.name || '';
};

/**
 * Splits wide time series frames into one frame per series, sorted and filtered, so a
 * SceneByFrameRepeater can show one panel per label value.
 */
export const splitSeries =
  (sort: () => SeriesSort, search: () => string, limit = 500): CustomTransformOperator =>
  () =>
  (source) =>
    source.pipe(
      map((frames: DataFrame[]) => {
        const series = frames.flatMap((frame) => {
          const time = frame.fields.find((field) => field.type === FieldType.time);
          if (!time) {
            return [];
          }
          return frame.fields
            .filter((field) => field.type === FieldType.number)
            .map((field): DataFrame => ({ ...frame, name: undefined, fields: [time, field], length: frame.length }));
        });
        const matches = searchMatches(search());
        return sortSeries(
          series.filter((frame) => matches(seriesName(frame))),
          sort()
        ).slice(0, limit);
      })
    );

export const splitSeriesData = (
  runner: SceneQueryRunner,
  sort: () => SeriesSort,
  search: () => string,
  limit?: number
) => new SceneDataTransformer({ $data: runner, transformations: [splitSeries(sort, search, limit)] });

/** Whether any series has data, for empty states. */
export const hasSeries = (data?: PanelData): boolean =>
  Boolean(data?.series.some((frame) => frame.length > 0 && frame.fields.some((f) => f.type === FieldType.number)));

/** Grafana units for OTel units (UCUM), per second for rates. */
export const grafanaUnit = (unit: string | undefined, perSecond = false): string | undefined => {
  const units: Record<string, [string, string]> = {
    s: ['s', 'none'],
    ms: ['ms', 'none'],
    us: ['µs', 'none'],
    ns: ['ns', 'none'],
    By: ['bytes', 'Bps'],
    KiBy: ['kbytes', 'KBs'],
    MiBy: ['mbytes', 'MBs'],
    '1': ['percentunit', 'none'],
    '%': ['percent', 'none'],
  };
  const match = unit ? units[unit] : undefined;
  if (perSecond) {
    // Seconds per second (CPU time) read as a share; other units have no per-second form here.
    return unit === 's' ? 'percentunit' : match?.[1] !== 'none' ? match?.[1] : undefined;
  }
  return match?.[0];
};

/** Log level colors of Logs Drilldown. */
export const levelColors: Record<string, string> = {
  critical: 'semi-dark-purple',
  fatal: 'semi-dark-purple',
  error: 'semi-dark-red',
  warn: 'semi-dark-orange',
  info: 'semi-dark-blue',
  debug: '#9e9e9e',
  trace: 'purple',
  unknown: '#8e8e8e',
};
