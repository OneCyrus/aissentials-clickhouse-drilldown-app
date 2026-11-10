# Changelog

Every change to `main` is released as a patch version; the release notes on GitHub list its commits. This file summarizes notable changes.

## 0.1.2 to 0.1.12

### Names

- The app is named **ClickHouse** and its pages **Metrics**, **Logs** and **Traces**.

### Data sources and tables

- Metric tables are resolved like the ClickHouse data source does: only existing tables are queried, the older `otel_metrics_exponential_histogram` table is found, and a database without metric tables says so instead of failing every query.
- Data sources of a ClickHouse plugin installed under a fork's plugin id are listed and usable.
- Metrics tables with JSON attribute columns (the exporter's `json: true`) work; before, every metrics query failed on them.

### Faster queries

- Logs: the time range is filtered on the table's partition column when the data source names one, so ClickHouse reads only the partitions in range.
- Logs: the landing page runs one query per kind for all tiles (3 queries instead of two per tile).
- Traces: the trace view is bounded with the exporter's trace-id index.

### Loading and errors

- Every load has its own loading and error state: no spinner stuck after clearing "Group by", no error left over after a successful reload, no "No data" under an error.
- A slow response for earlier filters, a previous tab or a previous grouping no longer overwrites the newer one.
- Screen readers announce loading and errors.

## 0.1.1

- The pages are named **Metrics (ClickHouse)**, **Logs (ClickHouse)** and **Traces (ClickHouse)**, and all three are listed in the menu.
- The pages can be shown directly in Grafana's Drilldown menu section with `[navigation.app_standalone_pages]`.

## 0.1.0

First release: Metrics, Logs and Traces Drilldown for OpenTelemetry data in ClickHouse.
