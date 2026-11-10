import React, { useEffect, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { SceneComponentProps } from '@grafana/scenes';
import {
  Alert,
  Button,
  Checkbox,
  Combobox,
  Icon,
  IconButton,
  Input,
  RadioButtonGroup,
  Stack,
  Tag,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { MetricCatalogEntry, metricTypeLabels } from 'clickhouse/metrics';
import { MetricType } from 'clickhouse/types';
import { Control, LoadStatus } from '../shared';
import { getMetricLabelId, metricPrefix, metricSuffix, parseMetricLabelId } from './sql';
import type { GridLayout, MetricsExploration, SidebarSection, SortBy } from './MetricsExploration';

const PAGE_STEP = 9;

const GROUPS_STEP = 10;

/** Kinds shown in the sidebar: sums split into counters and up-down counters. */
export const metricKind = (entry: MetricCatalogEntry): string =>
  entry.type === MetricType.Sum ? (entry.isMonotonic ? 'counter' : 'updowncounter') : entry.type;

const kindLabels: Record<string, string> = {
  ...metricTypeLabels,
  counter: 'Counter',
  updowncounter: 'Up-down counter',
};

export const metricKindLabel = (entry: MetricCatalogEntry): string => kindLabels[metricKind(entry)] || entry.type;

const sections: Array<{ id: SidebarSection; title: string; description: string; icon: React.ReactNode }> = [
  {
    id: 'filters-prefix',
    title: 'Prefix filters',
    description: 'Filter metrics based on their name prefix',
    icon: <span>A_</span>,
  },
  {
    id: 'filters-suffix',
    title: 'Suffix filters',
    description: 'Filter metrics based on their name suffix',
    icon: <span>_Z</span>,
  },
  {
    id: 'filters-type',
    title: 'Metric type filters',
    description: 'Filter metrics by their OpenTelemetry type',
    icon: <Icon name="graph-bar" />,
  },
  {
    id: 'labels',
    title: 'Group by labels',
    description: 'Group metrics by their label values',
    icon: <Icon name="layer-group" />,
  },
];

const countBy = (items: MetricCatalogEntry[], key: (entry: MetricCatalogEntry) => string) =>
  items.reduce<Record<string, number>>((counts, entry) => {
    const k = key(entry);
    counts[k] = (counts[k] || 0) + 1;
    return counts;
  }, {});

/** A checkbox list with counts, search, "Hide empty" and clear, as in the Drilldown sidebar. */
function FilterList({
  values,
  counts,
  selected,
  labelOf,
  onChange,
}: {
  values: string[];
  counts: Record<string, number>;
  selected: string[];
  labelOf?: (value: string) => string;
  onChange: (selected: string[]) => void;
}) {
  const styles = useStyles2(getStyles);
  const [search, setSearch] = useState('');
  const [hideEmpty, setHideEmpty] = useState(false);
  const shown = values
    .filter((value) => (labelOf ? labelOf(value) : value).toLowerCase().includes(search.toLowerCase()))
    .filter((value) => !hideEmpty || counts[value] || selected.includes(value))
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b));
  return (
    <>
      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        prefix={<Icon name="search" />}
      />
      <div className={styles.listHeader}>
        <Checkbox label="Hide empty" value={hideEmpty} onChange={() => setHideEmpty(!hideEmpty)} />
        {selected.length > 0 && (
          <span>
            {selected.length} selected{' '}
            <Button variant="secondary" fill="text" size="sm" onClick={() => onChange([])}>
              clear
            </Button>
          </span>
        )}
      </div>
      <div className={styles.scrollList}>
        {shown.length === 0 && <span className={styles.muted}>No results.</span>}
        {shown.map((value) => (
          <Checkbox
            key={value}
            className={styles.checkbox}
            label={`${labelOf ? labelOf(value) : value} (${counts[value] || 0})`}
            value={selected.includes(value)}
            onChange={() =>
              onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value])
            }
          />
        ))}
      </div>
    </>
  );
}

function LabelList({ model }: SceneComponentProps<MetricsExploration>) {
  const styles = useStyles2(getStyles);
  const { labels, labelsLoad, groupBy } = model.useState();
  const [search, setSearch] = useState('');
  const selected = groupBy ? parseMetricLabelId(groupBy) : undefined;
  return (
    <>
      <Input
        placeholder="Search..."
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
        prefix={<Icon name="search" />}
      />
      <div className={styles.listHeader}>
        {selected ? (
          <span>
            Selected: &quot;{selected.key}&quot;{' '}
            <Button variant="secondary" fill="text" size="sm" onClick={() => model.setGroupBy(undefined)}>
              clear
            </Button>
          </span>
        ) : (
          <span className={styles.muted}>No selection</span>
        )}
      </div>
      <LoadStatus
        state={labelsLoad}
        quietLoading={labels.length > 0}
        loadingText="Loading labels…"
        errorTitle="Error while loading labels"
      />
      <div className={styles.scrollList}>
        {labels
          .filter((label) => label.key.toLowerCase().includes(search.toLowerCase()))
          .map((label) => {
            const id = getMetricLabelId(label);
            return (
              <button
                key={id}
                className={cx(styles.labelItem, id === groupBy && styles.labelItemSelected)}
                onClick={() => model.setGroupBy(id === groupBy ? undefined : id)}
              >
                {label.key}
                <span className={styles.muted}> {label.source}</span>
              </button>
            );
          })}
      </div>
    </>
  );
}

/** The metric list: sidebar, list controls and the tile grid (or the grouped list). */
export function MetricsReducer({ model }: SceneComponentProps<MetricsExploration>) {
  const styles = useStyles2(getStyles);
  const state = model.useState();
  const { catalog, catalogLoad, grid, search, prefixes, suffixes, types, layout, shown, sortBy, sidebar } = state;
  const { groupBy, groups, groupsLoad, groupGrids, groupsShown } = state;
  const visible = model.getVisibleMetrics();
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  useEffect(() => {
    if (searchText === search) {
      return;
    }
    const timer = setTimeout(() => model.setListState({ search: searchText }), 250);
    return () => clearTimeout(timer);
  }, [searchText, search, model]);

  const prefixCounts = useMemo(
    () => countBy(model.filtered('prefix'), (e) => metricPrefix(e.name)),
    [model, catalog, search, suffixes, types] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const suffixCounts = useMemo(
    () => countBy(model.filtered('suffix'), (e) => metricSuffix(e.name)),
    [model, catalog, search, prefixes, types] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const typeCounts = useMemo(
    () => countBy(model.filtered('type'), metricKind),
    [model, catalog, search, prefixes, suffixes] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const active: Record<SidebarSection, boolean> = {
    'filters-prefix': prefixes.length > 0,
    'filters-suffix': suffixes.length > 0,
    'filters-type': types.length > 0,
    labels: Boolean(groupBy),
  };
  const openSection = sections.find((section) => section.id === sidebar);
  const groupLabel = groupBy ? parseMetricLabelId(groupBy) : undefined;

  return (
    <div className={styles.container}>
      <div className={styles.rail} data-testid="metrics-sidebar">
        {sections.map((section) => (
          <Tooltip key={section.id} content={section.description} placement="right">
            <button
              aria-label={section.title}
              className={cx(
                styles.railButton,
                sidebar === section.id && styles.railButtonOpen,
                active[section.id] && styles.railButtonActive
              )}
              onClick={() => model.setSidebar(sidebar === section.id ? undefined : section.id)}
            >
              {section.icon}
            </button>
          </Tooltip>
        ))}
      </div>
      {openSection && (
        <div className={styles.sidebar}>
          <div className={styles.sidebarHeader}>
            <h6 className={styles.sectionTitle}>{openSection.title}</h6>
            <IconButton name="times" aria-label="Close" onClick={() => model.setSidebar(undefined)} />
          </div>
          {openSection.id === 'filters-prefix' && (
            <FilterList
              values={Object.keys(countBy(catalog, (e) => metricPrefix(e.name)))}
              counts={prefixCounts}
              selected={prefixes}
              onChange={(next) => model.setListState({ prefixes: next })}
            />
          )}
          {openSection.id === 'filters-suffix' && (
            <FilterList
              values={Object.keys(countBy(catalog, (e) => metricSuffix(e.name)))}
              counts={suffixCounts}
              selected={suffixes}
              onChange={(next) => model.setListState({ suffixes: next })}
            />
          )}
          {openSection.id === 'filters-type' && (
            <FilterList
              values={Object.keys(countBy(catalog, metricKind))}
              counts={typeCounts}
              selected={types}
              labelOf={(kind) => kindLabels[kind] || kind}
              onChange={(next) => model.setListState({ types: next })}
            />
          )}
          {openSection.id === 'labels' && <LabelList model={model} />}
        </div>
      )}

      <div className={styles.main}>
        <div className={styles.listControls}>
          {!groupBy && (
            <div className={styles.search}>
              <Input
                prefix={<Icon name="search" />}
                placeholder="Search metrics"
                aria-label="Quick search metrics"
                value={searchText}
                onChange={(e) => setSearchText(e.currentTarget.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearchText('')}
                suffix={
                  <Tooltip content={`metric: ${visible.length} of ${catalog.length} in total`}>
                    <span>
                      <Tag
                        name={
                          visible.length === catalog.length
                            ? String(catalog.length)
                            : `${visible.length}/${catalog.length}`
                        }
                      />
                    </span>
                  </Tooltip>
                }
              />
            </div>
          )}
          {groupBy && (
            <div className={styles.groupTitle}>
              <Icon name="layer-group" /> Grouped by <b>{groupLabel?.key}</b>
            </div>
          )}
          <Stack direction="row" gap={2} alignItems="center">
            <Control label="Sort by" tooltip="Default: recently selected metrics first, then alphabetical">
              <Combobox
                aria-label="Sort by"
                width={24}
                value={sortBy}
                options={[
                  {
                    value: 'default',
                    label: 'Default',
                    description: 'Recently selected metrics first, then alphabetical',
                  },
                  { value: 'alphabetical', label: 'Alphabetical [A-Z]' },
                  { value: 'alphabetical-reversed', label: 'Alphabetical [Z-A]' },
                ]}
                onChange={(option) => model.setListState({ sortBy: option.value as SortBy })}
              />
            </Control>
            <RadioButtonGroup
              aria-label="Layout switcher"
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'rows', label: 'Rows' },
              ]}
              value={layout}
              onChange={(value) => model.setListState({ layout: value as GridLayout })}
            />
          </Stack>
        </div>
        <LoadStatus
          state={catalogLoad}
          loadingText="Loading metrics…"
          errorTitle="Error while loading metrics"
          quietLoading={catalog.length > 0}
        />
        {groupBy && (
          <LoadStatus
            state={groupsLoad}
            loadingText="Loading label values…"
            errorTitle="Error while loading label values"
            quietLoading={groups.length > 0}
          />
        )}
        {catalogLoad.status === 'done' && !groupBy && !visible.length && (
          <Alert severity="info" title="No metrics found for the current filters and time range." />
        )}
        {!groupBy && grid && <grid.Component model={grid} />}
        {!groupBy && visible.length > shown && (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => model.setListState({ shown: shown + PAGE_STEP })}>
              Show {Math.min(PAGE_STEP, visible.length - shown)} more ({shown}/{visible.length})
            </Button>
          </div>
        )}
        {groupBy && groupsLoad.status === 'done' && !groups.length && (
          <Alert severity="info" title={`No label values found for label "${groupLabel?.key}".`} />
        )}
        {groupBy &&
          groupGrids.map((groupGrid, index) => {
            const group = groups[index];
            return (
              <div key={group.value} className={styles.group}>
                <div className={styles.groupHeader}>
                  <Icon name="layer-group" />
                  <b>{group.value}</b>
                  {groups.length > 1 && (
                    <span className={styles.muted}>
                      ({index + 1}/{groups.length})
                    </span>
                  )}
                  <div className={styles.spacer} />
                  <Tooltip content={`See metrics with ${groupLabel?.key}=${group.value}`}>
                    <Button size="sm" variant="secondary" onClick={() => model.selectGroup(group.value)}>
                      Select
                    </Button>
                  </Tooltip>
                </div>
                <groupGrid.Component model={groupGrid} />
              </div>
            );
          })}
        {groupBy && groups.length > groupsShown && (
          <div className={styles.more}>
            <Button variant="secondary" onClick={() => model.setListState({ groupsShown: groupsShown + GROUPS_STEP })}>
              Show {Math.min(GROUPS_STEP, groups.length - groupsShown)} more ({groupsShown}/{groups.length})
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', gap: theme.spacing(1), minHeight: 0, width: '100%', flexGrow: 1 }),
  rail: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0.5),
    borderRight: `1px solid ${theme.colors.border.weak}`,
  }),
  railButton: css({
    width: 32,
    height: 32,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: 'none',
    borderRadius: theme.shape.radius.default,
    background: 'transparent',
    color: theme.colors.text.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    position: 'relative',
    '&:hover': { background: theme.colors.action.hover, color: theme.colors.text.primary },
  }),
  railButtonOpen: css({ background: theme.colors.action.selected, color: theme.colors.text.primary }),
  railButtonActive: css({
    '&::after': {
      content: '""',
      position: 'absolute',
      top: 4,
      right: 4,
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: theme.colors.primary.main,
    },
  }),
  sidebar: css({
    width: 260,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    paddingRight: theme.spacing(1),
    borderRight: `1px solid ${theme.colors.border.weak}`,
  }),
  sidebarHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }),
  sectionTitle: css({ margin: 0 }),
  listHeader: css({ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 24 }),
  scrollList: css({ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }),
  checkbox: css({ display: 'flex', marginBottom: theme.spacing(0.5) }),
  labelItem: css({
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: 'none',
    background: 'transparent',
    padding: theme.spacing(0.5, 1),
    borderRadius: theme.shape.radius.default,
    color: theme.colors.text.primary,
    '&:hover': { background: theme.colors.action.hover },
  }),
  labelItemSelected: css({ background: theme.colors.action.selected, fontWeight: theme.typography.fontWeightMedium }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  main: css({ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing(1) }),
  listControls: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    justifyContent: 'space-between',
    flexWrap: 'wrap',
  }),
  search: css({ flexGrow: 1, maxWidth: 640 }),
  groupTitle: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1) }),
  group: css({
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1),
  }),
  groupHeader: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), marginBottom: theme.spacing(1) }),
  spacer: css({ flexGrow: 1 }),
  more: css({ display: 'flex', justifyContent: 'center', padding: theme.spacing(2) }),
});
