import React from 'react';
import { AppRootProps } from '@grafana/data';
import { EmbeddedScene, SceneApp, SceneAppPage, useSceneApp } from '@grafana/scenes';
import { Alert } from '@grafana/ui';
import { Navigate, useLocation, useResolvedPath } from 'react-router-dom';
import { PLUGIN_BASE_URL, prefixRoute, ROUTES } from '../constants';
import { getClickHouseDataSources } from '../shared';
import { buildMetricsScene } from '../metrics-drilldown';
import { buildLogsScene } from '../logs-drilldown';
import { buildTracesScene } from '../traces-drilldown';

/**
 * A page without the large title and subtitle: like Grafana's Drilldown apps, the breadcrumb names
 * the page and the controls start at the top.
 */
const page = (mountPath: string, title: string, route: ROUTES, getScene: () => EmbeddedScene) =>
  new SceneAppPage({
    title,
    renderTitle: () => null,
    url: prefixRoute(route),
    // Grafana mounts the app at its root, or, for a page shown on its own in the menu
    // ([navigation.app_standalone_pages]), at that page's URL.
    routePath: mountPath === prefixRoute(route) ? '*' : `${route}/*`,
    getScene,
  });

/** One scene app per mount point; useSceneApp caches it by factory. */
const sceneAppFactories = new Map<string, () => SceneApp>();
const getSceneAppFactory = (mountPath: string) => {
  let factory = sceneAppFactories.get(mountPath);
  if (!factory) {
    factory = () =>
      new SceneApp({
        pages: [
          page(mountPath, 'Metrics (ClickHouse)', ROUTES.Metrics, buildMetricsScene),
          page(mountPath, 'Logs (ClickHouse)', ROUTES.Logs, buildLogsScene),
          page(mountPath, 'Traces (ClickHouse)', ROUTES.Traces, buildTracesScene),
        ],
        urlSyncOptions: { updateUrlOnInit: true, createBrowserHistorySteps: true },
      });
    sceneAppFactories.set(mountPath, factory);
  }
  return factory;
};

export const App = (_props: AppRootProps) => {
  // The route Grafana mounted the app at (not the basename prop, which is the menu entry's URL).
  const mountPath = useResolvedPath('.').pathname.replace(/\/$/, '');
  const scene = useSceneApp(getSceneAppFactory(mountPath));
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
