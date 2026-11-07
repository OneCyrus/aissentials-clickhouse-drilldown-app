# AIssentials ClickHouse Drilldown

Queryless browsing of OpenTelemetry metrics, logs and traces stored in ClickHouse by the OpenTelemetry Collector's ClickHouse exporter, modeled on Grafana's Metrics, Logs and Traces Drilldown apps.

- **Metrics**: a grid of all metrics with prefix, suffix, type and label grouping filters; a metric with its function (rate, quantiles, heatmap), breakdown by label, related metrics and related logs.
- **Logs**: services with log volume and latest lines; a service with level, field and line filters and the Logs, Labels, Fields and Patterns tabs.
- **Traces**: rate, errors and duration of a span set; breakdown by attribute, comparison of errors or slow spans with their baseline, exceptions and the span list with a trace view.

The app queries through the ClickHouse data source plugin (`grafana-clickhouse-datasource`), so set up a ClickHouse data source for your OpenTelemetry data first.
