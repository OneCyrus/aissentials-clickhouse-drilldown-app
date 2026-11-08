import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import {
  PanelBuilders,
  SceneComponentProps,
  SceneObjectBase,
  SceneObjectState,
  VizPanel,
  sceneGraph,
} from '@grafana/scenes';
import { Alert, Button, Icon, IconButton, Input, LoadingPlaceholder, useStyles2, useTheme2 } from '@grafana/ui';
import { errorMessage, Format, frameRows, levelColors, queryRunner, runSql, sqlQuery, tableStyle } from '../shared';
import { ALL_FILTERS, FILTERS, LEVELS, patternSamplesSql, patternsListSql, patternsVolumeSql } from './sql';
import { namedSeries, stackedBars } from './panels';
import { LogsExploration } from './LogsExploration';

interface PatternRow {
  pattern: string;
  total: number;
  levels: string[];
  series: Array<[number, number]>;
}

interface PatternsSceneState extends SceneObjectState {
  rows: PatternRow[];
  loading: boolean;
  error?: string;
  search: string;
  volume?: VizPanel;
  expanded?: string;
  samples?: VizPanel;
}

/**
 * Patterns are found by the labels and levels only, like Logs Drilldown (where Loki mines them
 * from the stream): line filters and fields don't apply to the pattern list.
 */
const PATTERN_CONDITION = `${FILTERS} AND ${LEVELS}`;

/** The Patterns tab: a chart of the most frequent patterns and the pattern table. */
export class PatternsScene extends SceneObjectBase<PatternsSceneState> {
  constructor(state: Partial<PatternsSceneState>) {
    super({ rows: [], loading: true, search: '', ...state });
    this.addActivationHandler(() => {
      this.load();
    });
  }

  getExploration() {
    return sceneGraph.getAncestor(this, LogsExploration);
  }

  async load() {
    const exploration = this.getExploration();
    const source = exploration.getSource();
    if (!source) {
      return;
    }
    const range = sceneGraph.getTimeRange(this).state.value;
    const bucket = Math.max(1, (range.to.valueOf() - range.from.valueOf()) / 1000 / 60);
    this.setState({
      loading: true,
      volume: stackedBars(
        namedSeries(queryRunner([sqlQuery('A', patternsVolumeSql(source, PATTERN_CONDITION))], 120)),
        'right'
      )
        .setTitle('Patterns')
        .setHoverHeader(true)
        .setOption('legend', {
          showLegend: true,
          displayMode: 'table' as never,
          placement: 'right',
          calcs: [],
          width: 200,
        })
        .build(),
    });
    try {
      const rows = frameRows<{ pattern: string; total: number; levels: string[]; series: Array<[number, number]> }>(
        await runSql(this, patternsListSql(source, PATTERN_CONDITION, bucket))
      ).map((row) => ({
        pattern: row.pattern,
        total: Number(row.total),
        levels: Array.from(row.levels || []),
        series: Array.from(row.series || []).map((point) => [Number(point[0]), Number(point[1])] as [number, number]),
      }));
      this.setState({ rows, loading: false });
      exploration.setState({ patternsCount: rows.length });
    } catch (error) {
      this.setState({ loading: false, error: errorMessage(error) });
    }
  }

  toggle(pattern: string, type: 'include' | 'exclude') {
    const exploration = this.getExploration();
    const patterns = exploration.state.patterns;
    const existing = patterns.find((p) => p.pattern === pattern);
    const others = patterns.filter((p) => p.pattern !== pattern);
    exploration.setConditions({ patterns: existing?.type === type ? others : [...others, { type, pattern }] });
  }

  expand(pattern?: string) {
    const source = this.getExploration().getSource();
    if (!source || !pattern || pattern === this.state.expanded) {
      this.setState({ expanded: undefined, samples: undefined });
      return;
    }
    this.setState({
      expanded: pattern,
      samples: PanelBuilders.logs()
        .setTitle('')
        .setHoverHeader(true)
        .setData(queryRunner([sqlQuery('A', patternSamplesSql(source, ALL_FILTERS, pattern), Format.Logs)]))
        .setOption('showTime', true)
        .setOption('enableLogDetails', true)
        .build(),
    });
  }

  static Component = PatternsSceneRenderer;
}

function PatternsSceneRenderer({ model }: SceneComponentProps<PatternsScene>) {
  const styles = useStyles2(getStyles);
  const { rows, loading, error, search, volume, expanded, samples } = model.useState();
  const { patterns } = model.getExploration().useState();
  const [sortBy, setSortBy] = useState<'count' | 'pattern'>('count');
  const total = rows.reduce((sum, row) => sum + row.total, 0) || 1;
  const shown = rows
    .filter((row) => row.pattern.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (sortBy === 'count' ? b.total - a.total : a.pattern.localeCompare(b.pattern)));

  return (
    <div className={styles.container}>
      <Input
        prefix={<Icon name="search" />}
        placeholder="Search patterns"
        value={search}
        onChange={(e) => model.setState({ search: e.currentTarget.value })}
        width={50}
      />
      <p className={styles.muted}>
        Patterns are selected by label and may be filtered by level. Fields and line filters are not supported for the
        pattern list. Numbers, ids, IP addresses and quoted values are replaced by &lt;_&gt;.
      </p>
      {volume && (
        <div className={styles.volume}>
          <volume.Component model={volume} />
        </div>
      )}
      {error && <Alert title="Could not load patterns">{error}</Alert>}
      {loading && <LoadingPlaceholder text="Loading patterns…" />}
      {!loading && !error && !rows.length && (
        <Alert severity="info" title="No patterns found in the current time range." />
      )}
      {!loading && rows.length > 0 && !shown.length && (
        <Alert severity="info" title="No patterns match these filters." />
      )}
      {shown.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th />
              <th className={styles.sortable} onClick={() => setSortBy('count')}>
                Count {sortBy === 'count' && <Icon name="arrow-down" size="sm" />}
              </th>
              <th>%</th>
              <th className={styles.sortable} onClick={() => setSortBy('pattern')}>
                Pattern {sortBy === 'pattern' && <Icon name="arrow-down" size="sm" />}
              </th>
              <th />
              <th>Levels</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 500).map((row) => {
              const applied = patterns.find((p) => p.pattern === row.pattern)?.type;
              return (
                <React.Fragment key={row.pattern}>
                  <tr>
                    <td>
                      <IconButton
                        name={expanded === row.pattern ? 'angle-down' : 'angle-right'}
                        aria-label="Show sample lines"
                        onClick={() => model.expand(row.pattern)}
                      />
                    </td>
                    <td>
                      <Sparkline points={row.series} />
                    </td>
                    <td className={styles.number}>{row.total.toLocaleString()}</td>
                    <td className={styles.number}>{Math.round((row.total / total) * 100)}%</td>
                    <td className={styles.pattern}>
                      {row.pattern.split('<_>').map((part, index) => (
                        <React.Fragment key={index}>
                          {index > 0 && <span className={styles.placeholder}>&lt;_&gt;</span>}
                          {part}
                        </React.Fragment>
                      ))}
                    </td>
                    <td className={styles.actions}>
                      <Button
                        size="sm"
                        variant={applied === 'include' ? 'primary' : 'secondary'}
                        fill={applied === 'include' ? 'solid' : 'outline'}
                        onClick={() => model.toggle(row.pattern, 'include')}
                      >
                        Include
                      </Button>
                      <Button
                        size="sm"
                        variant={applied === 'exclude' ? 'primary' : 'secondary'}
                        fill={applied === 'exclude' ? 'solid' : 'outline'}
                        onClick={() => model.toggle(row.pattern, 'exclude')}
                      >
                        Exclude
                      </Button>
                    </td>
                    <td>
                      {row.levels.map((level) => (
                        <LevelChip key={level} level={level} />
                      ))}
                    </td>
                  </tr>
                  {expanded === row.pattern && samples && (
                    <tr>
                      <td colSpan={7} className={styles.samples}>
                        <samples.Component model={samples} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Sparkline({ points }: { points: Array<[number, number]> }) {
  const theme = useTheme2();
  if (points.length < 2) {
    return null;
  }
  const xs = points.map((p) => p[0]);
  const max = Math.max(...points.map((p) => p[1]), 1);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const path = points
    .map(
      ([x, y], i) =>
        `${i ? 'L' : 'M'}${(((x - x0) / (x1 - x0 || 1)) * 96 + 2).toFixed(1)},${(22 - (y / max) * 20).toFixed(1)}`
    )
    .join(' ');
  return (
    <svg width={100} height={24} aria-hidden>
      <path d={path} fill="none" stroke={theme.visualization.getColorByName('blue')} strokeWidth={1.5} />
    </svg>
  );
}

function LevelChip({ level }: { level: string }) {
  const theme = useTheme2();
  const color = theme.visualization.getColorByName(levelColors[level] || 'gray');
  return (
    <span
      className={css({
        display: 'inline-block',
        marginRight: 4,
        padding: '0 6px',
        borderRadius: 4,
        fontSize: 12,
        color: theme.colors.getContrastText(color),
        background: color,
      })}
    >
      {level}
    </span>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  muted: css({ color: theme.colors.text.secondary, margin: 0 }),
  volume: css({ height: 200 }),
  table: tableStyle(theme),
  sortable: css({ cursor: 'pointer' }),
  number: css({ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
  pattern: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    wordBreak: 'break-all',
  }),
  placeholder: css({ color: theme.colors.primary.text, fontWeight: theme.typography.fontWeightBold }),
  actions: css({ whiteSpace: 'nowrap', 'button + button': { marginLeft: theme.spacing(0.5) } }),
  samples: css({ height: 300 }),
});
