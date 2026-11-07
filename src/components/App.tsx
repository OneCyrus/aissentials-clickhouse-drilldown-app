import React from 'react';
import { AppRootProps } from '@grafana/data';
import { EmbeddedScene, SceneApp, SceneAppPage, useSceneApp } from '@grafana/scenes';
import { Alert } from '@grafana/ui';
import { prefixRoute, ROUTES } from '../constants';
import { getClickHouseDataSources } from '../shared';
import { buildMetricsScene } from '../metrics-drilldown';
import { buildLogsScene } from '../logs-drilldown';
import { buildTracesScene } from '../traces-drilldown';

const page = (title: string, subTitle: string, route: ROUTES, getScene: () => EmbeddedScene) =>
  new SceneAppPage({
    title,
    subTitle,
    url: prefixRoute(route),
    routePath: `${route}/*`,
    getScene,
  });

const getSceneApp = () =>
  new SceneApp({
    pages: [
      page('Metrics', 'Browse OpenTelemetry metrics without writing queries', ROUTES.Metrics, buildMetricsScene),
      page('Logs', 'Browse OpenTelemetry logs by service, labels, fields and patterns', ROUTES.Logs, buildLogsScene),
      page('Traces', 'Find what makes requests slow or fail, without writing queries', ROUTES.Traces, buildTracesScene),
    ],
    urlSyncOptions: { updateUrlOnInit: true, createBrowserHistorySteps: true },
  });

export const App = (_props: AppRootProps) => {
  const scene = useSceneApp(getSceneApp);
  if (!getClickHouseDataSources().length) {
    return (
      <Alert title="No ClickHouse data source" severity="info">
        AIssentials ClickHouse Drilldown reads OpenTelemetry data through the ClickHouse data source. Add one under
        Connections, Data sources.
      </Alert>
    );
  }
  return <scene.Component model={scene} />;
};
