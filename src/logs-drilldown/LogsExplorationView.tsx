import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { AdHocFiltersVariable, SceneComponentProps } from '@grafana/scenes';
import {
  Alert,
  Button,
  Combobox,
  Icon,
  IconButton,
  Input,
  MultiCombobox,
  RadioButtonGroup,
  Stack,
  Tab,
  TabsBar,
  Tooltip,
  useStyles2,
} from '@grafana/ui';
import { VAR_FILTERS } from '../constants';
import {
  Control,
  copyCurrentUrl,
  frameRows,
  LoadStatus,
  runSql,
  Spacer,
  Toolbar,
  ToolbarGroup,
  valueSortOptions,
  errorMessage,
} from '../shared';
import { detectedKeysSql, FILTERS, keyDisplayName, levelOrder, LineFilter, SERVICE_KEY, VAR_FIELDS } from './sql';
import type { LogsExploration, Visualization } from './LogsExploration';

export const ALL = '$__all';

const PAGE_SIZES = [20, 40, 60];

export function ServiceSelection({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const { body, landingLoad, values, primaryLabel, tabs, search, pageSize, page } = model.useState();
  const [searchText, setSearchText] = useState(search);
  const [addingTab, setAddingTab] = useState(false);
  const [labelKeys, setLabelKeys] = useState<string[]>([]);
  const [labelKeysError, setLabelKeysError] = useState<string>();
  const filters = model.getVariable(VAR_FILTERS, AdHocFiltersVariable);
  const { filters: labelFilters } = filters?.useState() || { filters: [] };
  useEffect(() => {
    const timer = setTimeout(() => searchText !== search && model.setLanding({ search: searchText }), 300);
    return () => clearTimeout(timer);
  }, [searchText, search, model]);
  const total = model.landingValues().length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const labelName = keyDisplayName(primaryLabel);

  const openAddTab = async () => {
    setAddingTab(true);
    setLabelKeysError(undefined);
    const source = model.getSource();
    if (source) {
      try {
        const rows = frameRows<{ key: string }>(await runSql(model, detectedKeysSql(source, 'labels', FILTERS)));
        setLabelKeys(rows.map((row) => row.key).filter((key) => key !== 'level' && !tabs.includes(key)));
      } catch (error) {
        setLabelKeys([]);
        setLabelKeysError(errorMessage(error));
      }
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.tabsRow}>
        <TabsBar>
          {tabs.map((tab) => (
            <Tab
              key={tab}
              label={keyDisplayName(tab).length > 15 ? `${keyDisplayName(tab).slice(0, 15)}…` : keyDisplayName(tab)}
              active={tab === primaryLabel}
              onChangeTab={() => model.setLanding({ primaryLabel: tab })}
              suffix={
                tab !== SERVICE_KEY
                  ? () => (
                      <IconButton
                        name="times"
                        size="sm"
                        tooltip="Remove tab"
                        onClick={(e) => {
                          e.stopPropagation();
                          model.setLanding({ tabs: tabs.filter((t) => t !== tab), primaryLabel: SERVICE_KEY });
                        }}
                      />
                    )
                  : undefined
              }
            />
          ))}
          <Tooltip content="Add label tab">
            <IconButton name="plus" aria-label="Add label tab" onClick={openAddTab} />
          </Tooltip>
        </TabsBar>
        {addingTab && labelKeysError && (
          <Alert severity="error" title="Could not load labels">
            {labelKeysError}
          </Alert>
        )}
        {addingTab && !labelKeysError && (
          <Combobox
            aria-label="Search labels"
            placeholder="Search labels"
            width={30}
            options={labelKeys.map((key) => ({ label: keyDisplayName(key), value: key }))}
            value={null}
            onChange={(option) => {
              setAddingTab(false);
              if (option) {
                model.setLanding({ tabs: [...tabs, option.value], primaryLabel: option.value });
              }
            }}
          />
        )}
      </div>
      <Toolbar>
        <Input
          className={styles.search}
          prefix={<Icon name="filter" />}
          placeholder={`Search ${labelName}`}
          aria-label={`Search ${labelName}`}
          value={searchText}
          onChange={(e) => setSearchText(e.currentTarget.value)}
        />
        <Control label="Per page">
          <Combobox
            aria-label="Page size"
            width={8}
            options={PAGE_SIZES.map((size) => ({ label: String(size), value: size }))}
            value={pageSize}
            onChange={(option) => model.setLanding({ pageSize: option.value })}
          />
        </Control>
        <Tooltip content={`${values.length} ${labelName} values have logs for the selected time range.`}>
          <span className={styles.muted}>
            Showing {Math.min(total, pageSize * (page + 1)) - page * pageSize} of {total}
          </span>
        </Tooltip>
        <Spacer />
        <Button
          icon="arrow-right"
          disabled={!labelFilters.length}
          tooltip={labelFilters.length ? 'Show the logs of the label filters' : 'Add a label filter first'}
          onClick={() => model.showLogs(undefined)}
        >
          Show logs
        </Button>
      </Toolbar>
      <LoadStatus
        state={landingLoad}
        loadingText={`Loading ${labelName} values…`}
        errorTitle="Error while loading logs"
        quietLoading={values.length > 0}
      />
      {landingLoad.status === 'done' && !total && (
        <Alert
          severity="info"
          title={search ? `No ${labelName} matched your search.` : `No logs found in ${labelName}.`}
        >
          {search ? '' : 'Please adjust time range or select another label.'}
        </Alert>
      )}
      {body && (
        <div className={styles.fill}>
          <body.Component model={body} />
        </div>
      )}
      {pages > 1 && (
        <div className={styles.pager}>
          {Array.from({ length: pages }, (_, index) => (
            <Button
              key={index}
              size="sm"
              variant={index === page ? 'primary' : 'secondary'}
              onClick={() => model.setLanding({ page: index })}
            >
              {index + 1}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function LineFilters({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const { lineFilters } = model.useState();
  const [drafts, setDrafts] = useState(lineFilters.length ? lineFilters : [emptyLineFilter()]);
  useEffect(() => setDrafts(lineFilters.length ? lineFilters : [emptyLineFilter()]), [lineFilters]);
  // Applied 2 seconds after typing stops, or on Enter.
  useEffect(() => {
    const timer = setTimeout(() => apply(drafts), 2000);
    return () => clearTimeout(timer);
  }, [drafts]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (next: LineFilter[]) => {
    const applied = next.filter((filter) => filter.text);
    if (JSON.stringify(applied) !== JSON.stringify(lineFilters)) {
      model.setConditions({ lineFilters: applied });
    }
  };
  const update = (index: number, change: Partial<LineFilter>) =>
    setDrafts(drafts.map((filter, i) => (i === index ? { ...filter, ...change } : filter)));

  return (
    <Stack direction="column" gap={0.5}>
      {drafts.map((filter, index) => (
        <div key={index} className={styles.lineFilter}>
          <RadioButtonGroup
            options={[
              { label: 'Include', value: false },
              { label: 'Exclude', value: true },
            ]}
            value={filter.exclude}
            onChange={(exclude) => update(index, { exclude })}
          />
          <Input
            width={32}
            placeholder="Filter logs by string"
            value={filter.text}
            onChange={(e) => update(index, { text: e.currentTarget.value })}
            onKeyDown={(e) => e.key === 'Enter' && apply(drafts)}
            suffix={
              <>
                <IconButton
                  name="text-fields"
                  tooltip={filter.caseSensitive ? 'Case sensitive' : 'Case insensitive'}
                  variant={filter.caseSensitive ? 'primary' : 'secondary'}
                  onClick={() => update(index, { caseSensitive: !filter.caseSensitive })}
                />
                <IconButton
                  name="brackets-curly"
                  tooltip={filter.regex ? 'Regular expression' : 'Plain text'}
                  variant={filter.regex ? 'primary' : 'secondary'}
                  onClick={() => update(index, { regex: !filter.regex })}
                />
              </>
            }
          />
          {drafts.length > 1 && (
            <IconButton
              name="times"
              aria-label="Remove line filter"
              onClick={() => {
                const next = drafts.filter((_, i) => i !== index);
                setDrafts(next);
                apply(next);
              }}
            />
          )}
          {index === drafts.length - 1 && (
            <IconButton
              name="plus"
              aria-label="Add line filter"
              onClick={() => setDrafts([...drafts, emptyLineFilter()])}
            />
          )}
        </div>
      ))}
    </Stack>
  );
}

const emptyLineFilter = (): LineFilter => ({ exclude: false, text: '', caseSensitive: false, regex: false });

export function ServiceDetails({ model }: SceneComponentProps<LogsExploration>) {
  const styles = useStyles2(getStyles);
  const {
    view,
    body,
    levels,
    patterns,
    labels,
    fields,
    logsCount,
    labelsLoad,
    fieldsLoad,
    labelBy,
    fieldBy,
    visualization,
    sort,
    valueSearch,
    patternsCount,
  } = model.useState();
  const fieldsVariable = model.getVariable(VAR_FIELDS, AdHocFiltersVariable);
  const primary = model.getPrimaryFilter();
  const by = view === 'labels' ? labelBy : fieldBy;
  const keys = view === 'labels' ? labels : fields;
  const keysLoad = view === 'labels' ? labelsLoad : fieldsLoad;
  const primaryName = keyDisplayName(model.state.primaryLabel);

  return (
    <div className={styles.container}>
      <Toolbar>
        <Button variant="secondary" size="sm" icon="arrow-left" onClick={() => model.backToLanding()}>
          {primaryName === 'service' ? 'All services' : `All ${primaryName} values`}
        </Button>
        {primary && (
          <h4 className={styles.title}>
            <span className={styles.muted}>{keyDisplayName(primary.key)}</span> {primary.value}
          </h4>
        )}
        <Spacer />
        <Button variant="secondary" size="sm" icon="compass" onClick={() => model.openInExplore()}>
          Explore
        </Button>
        <Button variant="secondary" size="sm" icon="share-alt" tooltip="Copy URL" onClick={() => copyCurrentUrl()} />
      </Toolbar>
      <Toolbar className={styles.filters}>
        <Control
          label="Levels"
          tooltip="Keep only logs whose severity matches your selection. Leave empty to include all levels."
        >
          <MultiCombobox
            aria-label="Log level filters"
            placeholder="All levels"
            options={levelOrder.map((level) => ({ label: level, value: level }))}
            value={levels}
            onChange={(options) => model.setConditions({ levels: options.map((o) => o.value) })}
            width="auto"
            minWidth={14}
          />
        </Control>
        <Control label="Fields" tooltip="Filter by log record attributes, such as http.route or user.id.">
          <div className={styles.fieldsFilter}>
            {fieldsVariable && <fieldsVariable.Component model={fieldsVariable} />}
          </div>
        </Control>
        <Control
          label="Line filter"
          tooltip="Match or exclude text in the log line body: plain text or a regular expression, case sensitive or not. Applied after you stop typing or on Enter."
        >
          <LineFilters model={model} />
        </Control>
      </Toolbar>
      {patterns.length > 0 && (
        <div className={styles.row}>
          {(['include', 'exclude'] as const).map((type) => {
            const applied = patterns.filter((p) => p.type === type);
            return applied.length ? (
              <Stack key={type} direction="row" gap={0.5} alignItems="center" wrap="wrap">
                <span className={styles.muted}>
                  {type === 'include' ? 'Included pattern(s)' : 'Excluded pattern(s):'}
                </span>
                {applied.map((p) => (
                  <span key={p.pattern} className={styles.chip}>
                    {p.pattern}
                    <IconButton
                      name="times"
                      size="sm"
                      aria-label="Remove pattern"
                      onClick={() => model.setConditions({ patterns: patterns.filter((x) => x !== p) })}
                    />
                  </span>
                ))}
              </Stack>
            ) : null;
          })}
        </div>
      )}
      <div className={styles.tabsRow}>
        <TabsBar className={styles.tabs}>
          <Tab
            label="Logs"
            active={view === 'logs'}
            counter={logsCount}
            onChangeTab={() => model.setView({ view: 'logs' })}
          />
          <Tab
            label="Labels"
            active={view === 'labels'}
            counter={labels.length}
            onChangeTab={() => model.setView({ view: 'labels' })}
          />
          <Tab
            label="Fields"
            active={view === 'fields'}
            counter={fields.length}
            onChangeTab={() => model.setView({ view: 'fields' })}
          />
          <Tab
            label="Patterns"
            active={view === 'patterns'}
            counter={patternsCount}
            onChangeTab={() => model.setView({ view: 'patterns' })}
          />
        </TabsBar>
        {view === 'logs' && (
          <RadioButtonGroup
            aria-label="Visualization"
            options={[
              { label: 'Logs', value: 'logs' },
              { label: 'Table', value: 'table' },
            ]}
            value={visualization}
            onChange={(value) => model.setView({ visualization: value as Visualization })}
          />
        )}
      </div>
      {(view === 'labels' || view === 'fields') && (
        <Toolbar>
          <Control
            label={view === 'labels' ? 'Label' : 'Field'}
            tooltip={view === 'labels' ? 'Resource attributes and the level' : 'Log record attributes'}
          >
            <Combobox
              aria-label={view === 'labels' ? 'Label' : 'Field'}
              width={28}
              options={[
                { label: 'All', value: ALL },
                ...[...keys]
                  .sort((a, b) => (a.key === 'level' ? -1 : b.key === 'level' ? 1 : a.cardinality - b.cardinality))
                  .map((k) => ({ label: keyDisplayName(k.key), value: k.key, description: `${k.cardinality} values` })),
              ]}
              value={by}
              onChange={(option) =>
                model.setView(view === 'labels' ? { labelBy: option.value } : { fieldBy: option.value })
              }
            />
          </Control>
          {by !== ALL && (
            <ToolbarGroup>
              <Input
                prefix={<Icon name="search" />}
                placeholder="Search for value"
                aria-label="Search for value"
                value={valueSearch}
                onChange={(e) => model.setView({ valueSearch: e.currentTarget.value })}
                width={28}
              />
              <Control
                label="Sort by"
                tooltip="Calculate a derived quantity from the values in your time series and sort by this criteria. Defaults to standard deviation."
              >
                <Combobox
                  aria-label="Sort by"
                  placeholder="Choose criteria"
                  width={20}
                  options={valueSortOptions}
                  value={sort}
                  onChange={(option) => model.setView({ sort: option.value })}
                />
              </Control>
            </ToolbarGroup>
          )}
        </Toolbar>
      )}
      {(view === 'labels' || view === 'fields') && (
        <LoadStatus
          state={keysLoad}
          quietLoading
          loadingText={`Loading ${view}…`}
          errorTitle={`Error while loading ${view}`}
        />
      )}
      {view !== 'logs' && view !== 'patterns' && keysLoad.status === 'done' && !keys.length && (
        <Alert severity="info" title={`We did not find any ${view} for the given time range.`} />
      )}
      {body && (
        <div className={styles.fill}>
          <body.Component model={body} />
        </div>
      )}
    </div>
  );
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({ display: 'flex', flexDirection: 'column', gap: theme.spacing(1), width: '100%', flexGrow: 1 }),
  row: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1), flexWrap: 'wrap' }),
  fill: css({ width: '100%' }),
  filters: css({ alignItems: 'flex-start' }),
  fieldsFilter: css({ minWidth: 260 }),
  tabs: css({ flexGrow: 1 }),
  tabsRow: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(1) }),
  title: css({ margin: 0 }),
  search: css({ maxWidth: 500 }),
  spacer: css({ flexGrow: 1 }),
  muted: css({ color: theme.colors.text.secondary, fontSize: theme.typography.bodySmall.fontSize }),
  field: css({ marginBottom: 0 }),
  lineFilter: css({ display: 'flex', alignItems: 'center', gap: theme.spacing(0.5) }),
  chip: css({
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    padding: theme.spacing(0, 0.5, 0, 1),
    borderRadius: theme.shape.radius.pill,
    background: theme.colors.background.secondary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  pager: css({ display: 'flex', gap: theme.spacing(0.5), justifyContent: 'center', padding: theme.spacing(2) }),
});
