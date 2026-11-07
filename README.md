# AIssentials ClickHouse Drilldown

A Grafana app plugin (`aissentials-clickhousedrilldown-app`) for browsing OpenTelemetry metrics, logs and traces stored in ClickHouse without writing queries. It follows Grafana's Metrics, Logs and Traces Drilldown apps view by view, but reads the tables of the [OpenTelemetry Collector ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter) through the ClickHouse data source.

## What it offers

| App     | Page                                             | Highlights                                                                                                                                                                                                                                                  |
| ------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metrics | `/a/aissentials-clickhousedrilldown-app/metrics` | Grid of all metrics with sidebar filters (prefix, suffix, metric type, group by labels), regex search and sorting. A metric with its function (rate, quantiles, heatmap and more), breakdown by label, related metrics by name similarity and related logs. |
| Logs    | `/a/aissentials-clickhousedrilldown-app/logs`    | Services (or any resource attribute) with volume by level and latest lines. A service with level, field and line filters and the Logs, Labels, Fields and Patterns tabs.                                                                                    |
| Traces  | `/a/aissentials-clickhousedrilldown-app/traces`  | Rate, errors and duration of a span set (root spans, all spans, server spans and more), Breakdown, Comparison of a selection with its baseline, Exceptions, the span list and a trace view.                                                                 |

Panels on dashboards and Explore queries of the ClickHouse data source get an **Open in AIssentials ClickHouse Drilldown** entry (panel menu and Explore toolbar). It opens the matching app in the panel's time range; a metrics query opens its metric.

## Requirements

- Grafana 11.6.11 or later, the same lower bound as Grafana's Drilldown apps. Tested with Grafana 13.3.
- The [ClickHouse data source](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/) with your OpenTelemetry data: a data source per signal (single-source mode), or one data source with the logs and traces defaults set. Database and table names come from the data source settings; the app expects the exporter's column layout (`otel_metrics_*`, `otel_logs`, `otel_traces`, with Map attributes).
- Metrics work with any ClickHouse data source; with a data source version that supports OTel metrics, the metric tables are configurable and **Explore** opens metrics in its metrics query editor. Without that, the exporter's default tables in the configured database (or `otel`) are used.

## Install

Build the plugin (see below) and copy or link `dist` into Grafana's plugin directory as `aissentials-clickhousedrilldown-app`. Until it is signed, allow it in `grafana.ini`:

```ini
[plugins]
allow_loading_unsigned_plugins = aissentials-clickhousedrilldown-app
```

To show the app in Grafana's **Drilldown** menu section next to Grafana's own apps:

```ini
[navigation.app_sections]
aissentials-clickhousedrilldown-app = drilldown
```

## Development

```bash
npm install
npm run dev          # build in watch mode into dist/
npm run build        # production build
npm run typecheck
npm run lint
npm run test:ci
```

`docker compose up` starts Grafana 13.3 with the ClickHouse data source installed and `dist/` mounted as the app; add a ClickHouse data source for your OpenTelemetry data there.

The build is the standard [create-plugin](https://grafana.com/developers/plugin-tools/) setup (`.config/`), extended in `webpack.config.ts` for the Scenes library: `react-router-dom` maps to Grafana's `react-router` module and `react/jsx-runtime` comes from Grafana.

## How it works

- Each app is a Grafana Scenes app. Queries are raw SQL queries of the ClickHouse data source, so the data source's connection, permissions, macros (`$__timeFilter`, `$__timeInterval`, `$__interval_s`) and result formats apply.
- The filter bars interpolate to SQL conditions (`${filters}`), built from attribute keys such as `resource.k8s.pod.name`, `span.http.route` or `log.user.id`.
- Metrics queries come from `src/clickhouse/metrics.ts`, derived from the ClickHouse data source's OTel metrics support (rates with counter resets and both temporalities, histogram quantiles and heatmaps), so they match its query editor.
- Log patterns are computed in SQL: numbers, ids, IP addresses and quoted values are replaced by `<_>`.

## Differences from Grafana's Drilldown apps

- The duration comparison selection defaults to the slowest quarter of the duration buckets, with a threshold list instead of dragging on the heatmap.
- "Outlying series" sorting ranks by distance from the mean series instead of a WebAssembly outlier detector.
- Not included: the Structure tabs of Traces Drilldown, bookmarks, saved searches, the JSON log view, Add to dashboard and Create alert, the time seeker and exemplars.
- Filter keys and URLs use OTel attribute names (`resource.service.name`) instead of Prometheus and Loki label names.

## License

Apache License 2.0. `src/clickhouse/` is derived from [grafana/clickhouse-datasource](https://github.com/grafana/clickhouse-datasource) (Apache License 2.0).
