import React from 'react';
import { AppRootProps } from '@grafana/data';
import { EmbeddedScene, SceneApp, SceneAppPage, useSceneApp } from '@grafana/scenes';
import { Alert } from '@grafana/ui';
import { Navigate, useLocation } from 'react-router-dom';
import { PLUGIN_BASE_URL, prefixRoute, ROUTES } from '../constants';
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
      page('Metrics (ClickHouse)', ROUTES.Metrics, buildMetricsScene),
      page('Logs (ClickHouse)', ROUTES.Logs, buildLogsScene),
      page('Traces (ClickHouse)', ROUTES.Traces, buildTracesScene),
    ],
    urlSyncOptions: { updateUrlOnInit: true, createBrowserHistorySteps: true },
  });

export const App = (_props: AppRootProps) => {
  const scene = useSceneApp(getSceneApp);
  const { pathname } = useLocation();
  // The app's menu entry opens the app root; every page has its own entry, so the root opens Metrics.
  if (pathname.replace(/\/$/, '') === PLUGIN_BASE_URL) {
    return <Navigate to={prefixRoute(ROUTES.Metrics)} replace />;
  }
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
