import React from 'react';
import { AppRootProps } from '@grafana/data';
import { EmbeddedScene, SceneApp, SceneAppPage, useSceneApp } from '@grafana/scenes';
import { Alert } from '@grafana/ui';
import { prefixRoute, ROUTES } from '../constants';
import { getClickHouseDataSources } from '../shared';
import { buildMetricsScene } from '../metrics-drilldown';
import { buildLogsScene } from '../logs-drilldown';
import { buildTracesScene } from '../traces-drilldown';

/**
 * A page without the large title and subtitle: like Grafana's Drilldown apps, the breadcrumb names
 * the page and the controls start at the top.
 */
const page = (title: string, route: ROUTES, getScene: () => EmbeddedScene) =>
  new SceneAppPage({
    title,
    renderTitle: () => null,
    url: prefixRoute(route),
    routePath: `${route}/*`,
    getScene,
  });

const getSceneApp = () =>
  new SceneApp({
    pages: [
      page('Metrics', ROUTES.Metrics, buildMetricsScene),
      page('Logs', ROUTES.Logs, buildLogsScene),
      page('Traces', ROUTES.Traces, buildTracesScene),
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
