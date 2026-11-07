import { SceneObject, sceneGraph } from '@grafana/scenes';
import { config, locationService } from '@grafana/runtime';
import { CLICKHOUSE_DS_TYPE, VAR_DATASOURCE } from '../constants';
import { interpolate } from './query';

/** An Explore URL that opens the queries with the scene's data source and time range. */
export const exploreUrl = (sceneObject: SceneObject, queries: object[]): string => {
  const uid = interpolate(sceneObject, `\${${VAR_DATASOURCE}}`);
  const range = sceneGraph.getTimeRange(sceneObject).state;
  const panes = {
    a: {
      datasource: uid,
      queries: queries.map((query, index) => ({
        refId: String.fromCharCode(65 + index),
        datasource: { type: CLICKHOUSE_DS_TYPE, uid },
        ...query,
      })),
      range: { from: range.from, to: range.to },
    },
  };
  return `${config.appSubUrl ?? ''}/explore?schemaVersion=1&orgId=${config.bootData?.user?.orgId ?? 1}&panes=${encodeURIComponent(
    JSON.stringify(panes)
  )}`;
};

export const openUrl = (url: string, newTab = false) => {
  if (newTab) {
    window.open(url, '_blank');
  } else {
    locationService.push(url.replace(config.appSubUrl ?? '', ''));
  }
};

export const copyCurrentUrl = async (): Promise<void> => {
  await navigator.clipboard?.writeText(window.location.href);
};
