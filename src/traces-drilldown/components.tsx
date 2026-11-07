import React, { useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { dateTimeFormat, GrafanaTheme2 } from '@grafana/data';
import {
  Button,
  Checkbox,
  Icon,
  IconButton,
  Input,
  RadioButtonGroup,
  Tooltip,
  useStyles2,
  useTheme2,
} from '@grafana/ui';
import { store } from '../shared';
import { defaultFavorites, normalizeMessage, SERVICE_KEY } from './sql';

const FAVORITES_KEY = 'traces.favorites.attributes';
export const ALL = 'All';

export const getFavorites = (): string[] => store.get<string[]>(FAVORITES_KEY, defaultFavorites);

type Scope = 'favorites' | 'all' | 'resource' | 'span';

/**
 * The Attributes sidebar of Traces Drilldown: search, Favorites / All / Resource / Span tabs and
 * favorite stars. Single selection (Breakdown, Comparison with an All option) or multiple
 * (columns of the trace list).
 */
export function AttributesSidebar({
  attributes,
  selected,
  onSelect,
  multi,
  allOption,
  filtered,
}: {
  attributes: string[];
  selected: string[];
  onSelect: (attribute: string) => void;
  multi?: boolean;
  allOption?: boolean;
  filtered: string[];
}) {
  const styles = useStyles2(getStyles);
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useState(getFavorites);
  const [scope, setScope] = useState<Scope>(multi ? 'all' : 'favorites');
  const matches = useMemo(() => {
    try {
      const regex = new RegExp(search, 'i');
      return (value: string) => regex.test(value);
    } catch {
      return (value: string) => value.toLowerCase().includes(search.toLowerCase());
    }
  }, [search]);
  const inScope = (attribute: string) =>
    scope === 'favorites'
      ? favorites.includes(attribute)
      : scope === 'resource'
        ? attribute.startsWith('resource.')
        : scope === 'span'
          ? !attribute.startsWith('resource.')
          : true;
  const shown = attributes
    .filter((attribute) => inScope(attribute) && matches(attribute))
    .sort((a, b) =>
      scope === 'favorites'
        ? favorites.indexOf(a) - favorites.indexOf(b)
        : Number(favorites.includes(b)) - Number(favorites.includes(a)) || a.localeCompare(b)
    );
  const toggleFavorite = (attribute: string) => {
    const next = favorites.includes(attribute) ? favorites.filter((f) => f !== attribute) : [...favorites, attribute];
    store.set(FAVORITES_KEY, next);
    setFavorites(next);
  };

  return (
    <div className={styles.sidebar}>
      <Input
        prefix={<Icon name="search" />}
        placeholder="Search attributes..."
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
      />
      <div className={styles.scopes}>
        <RadioButtonGroup
          size="sm"
          options={(['favorites', 'all', 'resource', 'span'] as Scope[])
            .filter((s) => !multi || s !== 'favorites')
            .map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: s }))}
          value={scope}
          onChange={setScope}
        />
      </div>
      {multi && selected.length > 0 && <span className={styles.muted}>Selected ({selected.length}):</span>}
      <div className={styles.list}>
        {allOption && (
          <button className={cx(styles.item, selected.includes(ALL) && styles.selected)} onClick={() => onSelect(ALL)}>
            All
          </button>
        )}
        {shown.length === 0 && <span className={styles.muted}>No attributes match your criteria</span>}
        {shown.map((attribute) => (
          <div key={attribute} className={cx(styles.item, selected.includes(attribute) && styles.selected)}>
            {multi ? (
              <Checkbox value={selected.includes(attribute)} onChange={() => onSelect(attribute)} label={attribute} />
            ) : (
              <button
                className={styles.itemButton}
                disabled={filtered.includes(attribute)}
                onClick={() => onSelect(attribute)}
              >
                {attribute}
              </button>
            )}
            {filtered.includes(attribute) && (
              <Tooltip content="Already in the filters">
                <Icon name="filter" size="sm" />
              </Tooltip>
            )}
            <IconButton
              name={favorites.includes(attribute) ? 'favorite' : 'star'}
              size="sm"
              tooltip={favorites.includes(attribute) ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => toggleFavorite(attribute)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ComparisonValue {
  value: string;
  baseline: number;
  selection: number;
}

export interface ComparisonAttribute {
  key: string;
  values: ComparisonValue[];
  maxDifference: number;
  maxDifferenceValue?: string;
}

/**
 * Turns selection/baseline counts into shares of each population and ranks attributes by their
 * largest difference, as Traces Drilldown does with Tempo's compare().
 */
export const toComparison = (
  rows: Array<{
    key: string;
    value: string;
    selection: number;
    baseline: number;
    selection_total: number;
    baseline_total: number;
  }>,
  rootSpansOnly: boolean
): ComparisonAttribute[] => {
  const byKey = new Map<string, typeof rows>();
  rows.forEach((row) => byKey.set(row.key, [...(byKey.get(row.key) || []), row]));
  return Array.from(byKey.entries())
    .filter(([key]) => !(rootSpansOnly && (key === 'rootName' || key === 'rootServiceName')))
    .map(([key, entries]) => {
      const sum = (pick: (row: (typeof entries)[0]) => number) => entries.reduce((total, row) => total + pick(row), 0);
      const total = (declared: number, shown: number) => (declared && declared >= shown ? declared : shown) || 1;
      const baselineTotal = total(
        Number(entries[0].baseline_total),
        sum((r) => Number(r.baseline))
      );
      const selectionTotal = total(
        Number(entries[0].selection_total),
        sum((r) => Number(r.selection))
      );
      const values = entries.map((row) => ({
        value: row.value,
        baseline: Number(row.baseline) / baselineTotal,
        selection: Number(row.selection) / selectionTotal,
      }));
      let maxDifference = 0;
      let maxDifferenceValue: string | undefined;
      values.forEach((v) => {
        const difference = v.selection - v.baseline;
        if (Math.abs(difference) > Math.abs(maxDifference)) {
          maxDifference = difference;
          maxDifferenceValue = v.value;
        }
      });
      return { key, values, maxDifference, maxDifferenceValue };
    })
    .sort((a, b) => Math.abs(b.maxDifference) - Math.abs(a.maxDifference));
};

/** Two bars per value (baseline and selection share), drawn without a panel. */
export function ComparisonBars({ values, selectionColor }: { values: ComparisonValue[]; selectionColor: string }) {
  const theme = useTheme2();
  const styles = useStyles2(getStyles);
  const baseline = '#5794F299';
  return (
    <div className={styles.bars}>
      {values.map((v) => (
        <div key={v.value} className={styles.barRow}>
          <Tooltip
            content={`${v.value}: baseline ${(v.baseline * 100).toFixed(1)}%, selection ${(v.selection * 100).toFixed(1)}%`}
          >
            <span className={styles.barLabel}>{v.value}</span>
          </Tooltip>
          <div className={styles.barTrack}>
            <div className={styles.bar} style={{ width: `${v.baseline * 100}%`, background: baseline }} />
            <div
              className={styles.bar}
              style={{ width: `${v.selection * 100}%`, background: theme.visualization.getColorByName(selectionColor) }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ExceptionRow {
  time: number;
  service: string;
  type: string;
  message: string;
  traceId: string;
}

interface ExceptionGroup {
  key: string;
  message: string;
  type: string;
  service: string;
  count: number;
  lastSeen: number;
  times: number[];
  variants: string[];
  traceId: string;
}

export const groupExceptions = (rows: ExceptionRow[]): ExceptionGroup[] => {
  const groups = new Map<string, ExceptionGroup>();
  rows.forEach((row) => {
    const normalized = normalizeMessage(row.message || row.type);
    const key = `${row.type}|${normalized.length > 60 ? `${normalized.slice(0, 20)}…${normalized.slice(-20)}` : normalized}`;
    const group = groups.get(key) || {
      key,
      message: row.message,
      type: row.type,
      service: row.service,
      count: 0,
      lastSeen: 0,
      times: [],
      variants: [],
      traceId: row.traceId,
    };
    group.count += 1;
    group.times.push(row.time);
    if (row.time > group.lastSeen) {
      group.lastSeen = row.time;
      group.service = row.service;
      group.traceId = row.traceId;
    }
    if (!group.variants.includes(row.message) && group.variants.length < 5) {
      group.variants.push(row.message);
    }
    groups.set(key, group);
  });
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
};

export function ExceptionsTable({
  groups,
  from,
  to,
  onOpenTrace,
}: {
  groups: ExceptionGroup[];
  from: number;
  to: number;
  onOpenTrace: (traceId: string) => void;
}) {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();
  const [expanded, setExpanded] = useState<string>();
  const buckets = 50;
  const sparkline = (times: number[]) => {
    const counts = new Array(buckets).fill(0);
    times.forEach((time) => {
      const index = Math.min(buckets - 1, Math.max(0, Math.floor(((time - from) / (to - from || 1)) * buckets)));
      counts[index] += 1;
    });
    const max = Math.max(...counts, 1);
    return counts
      .map((count, i) => `${i ? 'L' : 'M'}${(i / (buckets - 1)) * 200},${28 - (count / max) * 26}`)
      .join(' ');
  };
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>
            Exception Details{' '}
            <Tooltip content="Exception type, message, service, and last seen timestamp.">
              <Icon name="info-circle" size="sm" />
            </Tooltip>
          </th>
          <th>Occurrences</th>
          <th>Frequency</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <React.Fragment key={group.key}>
            <tr>
              <td>
                <div className={styles.exceptionType}>
                  <IconButton
                    name={expanded === group.key ? 'angle-down' : 'angle-right'}
                    aria-label="Show grouped exception messages"
                    onClick={() => setExpanded(expanded === group.key ? undefined : group.key)}
                  />
                  <b>{group.type}</b>
                </div>
                <div className={styles.exceptionMessage}>{group.message}</div>
                <div className={styles.muted}>
                  {group.service} · last seen {dateTimeFormat(group.lastSeen)} ·{' '}
                  <Button size="sm" fill="text" onClick={() => onOpenTrace(group.traceId)}>
                    View trace
                  </Button>
                </div>
              </td>
              <td className={styles.number}>{group.count.toLocaleString()}</td>
              <td>
                <svg width={200} height={30} aria-hidden>
                  <path
                    d={sparkline(group.times)}
                    fill="none"
                    stroke={theme.visualization.getColorByName('semi-dark-red')}
                  />
                </svg>
              </td>
            </tr>
            {expanded === group.key && (
              <tr>
                <td colSpan={3}>
                  <div className={styles.muted}>Grouped messages</div>
                  {group.variants.map((variant) => (
                    <div key={variant} className={styles.exceptionMessage}>
                      {variant}
                    </div>
                  ))}
                </td>
              </tr>
            )}
          </React.Fragment>
        ))}
      </tbody>
    </table>
  );
}

export interface SpanRow {
  'Start time': number;
  status: string;
  Service: string;
  Name: string;
  'Duration (ms)': number;
  'Trace ID': string;
  'Span ID': string;
  [column: string]: unknown;
}

export function SpanTable({
  rows,
  columns,
  onOpen,
}: {
  rows: SpanRow[];
  columns: string[];
  onOpen: (row: SpanRow) => void;
}) {
  const styles = useStyles2(getStyles);
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Start time</th>
          <th>status</th>
          <th>Service</th>
          <th>Name</th>
          <th>
            Duration <Icon name="arrow-down" size="sm" />
          </th>
          {columns.map((column) => (
            <th key={column}>{column}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row['Trace ID']}-${row['Span ID']}`}>
            <td className={styles.number}>{dateTimeFormat(row['Start time'])}</td>
            <td className={row.status === 'Error' ? styles.error : undefined}>{row.status}</td>
            <td>{row.Service}</td>
            <td>
              <Button size="sm" fill="text" onClick={() => onOpen(row)}>
                {row.Name || '<name not yet available>'}
              </Button>
            </td>
            <td className={styles.number}>{formatDuration(Number(row['Duration (ms)']))}</td>
            {columns.map((column) => (
              <td key={column}>{String(row[column] ?? '')}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const formatDuration = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(0)} µs`;

export const isFavoriteDefault = (attribute: string) => attribute === SERVICE_KEY;

const getStyles = (theme: GrafanaTheme2) => ({
  sidebar: css({
    width: 280,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    borderRight: `1px solid ${theme.colors.border.weak}`,
    paddingRight: theme.spacing(1),
  }),
  scopes: css({ flexShrink: 0 }),
  list: css({ overflowY: 'auto', maxHeight: 600 }),
  item: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.25, 0.5),
    borderRadius: theme.shape.radius.default,
    width: '100%',
    border: 'none',
    background: 'transparent',
    color: theme.colors.text.primary,
    textAlign: 'left',
    '&:hover': { background: theme.colors.action.hover },
  }),
  itemButton: css({
    flexGrow: 1,
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '&:disabled': { color: theme.colors.text.disabled },
  }),
  selected: css({ background: theme.colors.action.selected, fontWeight: theme.typography.fontWeightMedium }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  bars: css({ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', height: '100%' }),
  barRow: css({ display: 'grid', gridTemplateColumns: 'minmax(80px, 35%) 1fr', alignItems: 'center', gap: 8 }),
  barLabel: css({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  barTrack: css({ display: 'flex', flexDirection: 'column', gap: 1 }),
  bar: css({ height: 7, minWidth: 1, borderRadius: 1 }),
  table: css({
    width: '100%',
    borderCollapse: 'collapse',
    'th, td': {
      padding: theme.spacing(0.5, 1),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      textAlign: 'left',
      verticalAlign: 'top',
    },
    th: {
      fontWeight: theme.typography.fontWeightMedium,
      position: 'sticky',
      top: 0,
      background: theme.colors.background.primary,
    },
  }),
  number: css({ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
  error: css({ color: theme.colors.error.text }),
  exceptionType: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(0.5) }),
  exceptionMessage: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
});
