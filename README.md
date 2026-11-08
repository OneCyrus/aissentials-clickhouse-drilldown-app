# AIssentials ClickHouse Drilldown

[![CI](https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/actions/workflows/ci.yml/badge.svg)](https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/OneCyrus/aissentials-clickhouse-drilldown-app?sort=semver)](https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/releases/latest)
[![Grafana](https://img.shields.io/badge/Grafana-%E2%89%A5%2011.6.11-orange?logo=grafana)](https://grafana.com/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**Explore OpenTelemetry metrics, logs and traces in ClickHouse without writing a single query.**

AIssentials ClickHouse Drilldown is a Grafana app for OpenTelemetry data stored in ClickHouse by the [OpenTelemetry Collector ClickHouse exporter](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter). Pick a metric, a service or a span set and narrow it down by clicking: every chart, breakdown and filter is a query that runs through the ClickHouse data source, with its connection and permissions.

![Metrics overview](src/img/screenshots/metrics-overview.png)

## Features

### Metrics

- A grid of every metric, with a sidebar to filter by prefix, suffix, metric type and label, regex search and sorting.
- One click to a metric with the right function for its type: rate and increase for counters, quantiles and heatmaps for histograms, sum, avg, min or max aggregation.
- Breakdown by any label, with "outlying series" sorting to find the series that behave differently.
- Related metrics by name similarity and related logs of the same services.

![A histogram metric with heatmap and breakdown](src/img/screenshots/metrics-heatmap.png)

### Logs

- All services (or any other resource attribute) with log volume by level and their latest lines.
- A service with level, field and line filters, and the **Logs**, **Labels**, **Fields** and **Patterns** tabs.
- Log patterns computed in ClickHouse: numbers, IDs, IP addresses and quoted values become `<_>`.
- A log list and a table view, with links to Explore.

![Logs by service](src/img/screenshots/logs-services.png)

![Logs of a service](src/img/screenshots/logs-service.png)

### Traces

- Rate, errors and duration (RED) of a span set: root spans, all spans, server spans, consumer spans and more.
- **Breakdown** by any resource or span attribute, with favorite attributes in a sidebar.
- **Comparison** of a selection, such as the slowest spans or the erroneous spans, with its baseline, to find the attributes that make the difference.
- **Exceptions**, the list of matching traces and a trace view.

![Traces overview](src/img/screenshots/traces-overview.png)

![Duration breakdown with a comparison selection](src/img/screenshots/traces-duration.png)

### Everywhere in Grafana

Panels on dashboards and Explore queries of the ClickHouse data source get an **Open in AIssentials ClickHouse Drilldown** entry, in the panel menu and the Explore toolbar. It opens the matching app with the same time range; a metrics query opens its metric.

## Requirements

- Grafana **11.6.11 or later**.
- The **[ClickHouse data source plugin](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/)** (`grafana-clickhouse-datasource`) 4.0 or later, with a data source connected to your ClickHouse server. The app reads all data through it.
- OpenTelemetry data in the table layout of the OpenTelemetry Collector ClickHouse exporter: `otel_metrics_*`, `otel_logs` and `otel_traces`.

## Installation

1. Install the ClickHouse data source plugin, if it is not installed yet:

   ```bash
   grafana cli plugins install grafana-clickhouse-datasource
   ```

2. Install the app from the [latest release](https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/releases/latest):

   ```bash
   grafana cli \
     --pluginUrl https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/releases/download/v0.1.0/aissentials-clickhousedrilldown-app-0.1.0.zip \
     plugins install aissentials-clickhousedrilldown-app
   ```

   Or download the ZIP and unzip it into Grafana's plugin directory.

3. The app is not signed yet. Allow it in `grafana.ini`:

   ```ini
   [plugins]
   allow_loading_unsigned_plugins = aissentials-clickhousedrilldown-app
   ```

4. Restart Grafana.
5. Add a ClickHouse data source under **Connections → Data sources** (see [Configuration](#configuration)), then open **Apps → AIssentials ClickHouse Drilldown**.

### Docker

With the Grafana Docker image (Grafana 12 or later), both plugins are installed at startup:

```bash
docker run -p 3000:3000 \
  -e GF_PLUGINS_PREINSTALL_SYNC="grafana-clickhouse-datasource,aissentials-clickhousedrilldown-app@0.1.0@https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/releases/download/v0.1.0/aissentials-clickhousedrilldown-app-0.1.0.zip" \
  -e GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=aissentials-clickhousedrilldown-app \
  grafana/grafana
```

### Show it under Drilldown

To list the app in Grafana's **Drilldown** menu section instead of **Apps**:

```ini
[navigation.app_sections]
aissentials-clickhousedrilldown-app = drilldown
```

### Preview builds

The [preview](https://github.com/OneCyrus/aissentials-clickhouse-drilldown-app/releases/tag/preview) pre-release holds the latest, not yet released state, with versions such as `0.1.1-preview.42`. Use official releases for production.

## Configuration

The app finds the tables through the ClickHouse data source settings:

- **Database:** the default database of the data source's logs or traces settings, else the data source's default database, else `otel`, the exporter's default.
- **Logs and traces tables:** the default tables of the data source's **Logs configuration** and **Traces configuration**, else the exporter's `otel_logs` and `otel_traces`.
- **Metrics tables:** the exporter's `otel_metrics_gauge`, `otel_metrics_sum`, `otel_metrics_histogram`, `otel_metrics_exp_histogram` (or the older `otel_metrics_exponential_histogram`) and `otel_metrics_summary`.

So a data source with the exporter's defaults works without further settings. Each page has a data source picker; the choice is kept in the URL, so links can be shared.

## License

Apache License 2.0. Parts of the query generation are derived from [grafana/clickhouse-datasource](https://github.com/grafana/clickhouse-datasource) (Apache License 2.0).
