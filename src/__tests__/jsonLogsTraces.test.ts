/**
 * Logs and traces tables written with the exporter's `json: true` have JSON attribute columns. The
 * shape is detected once per data source and table, and every query reads the attributes in that
 * shape. These cover the detection (with runSql stubbed) and the SQL of both shapes; the SQL was
 * also run against Map and JSON copies of the same data, with the same results.
 */
import { SceneObject } from '@grafana/scenes';

const settings: Record<string, { uid: string; name: string; type: string; jsonData: object }> = {};
const runSql = jest.fn();

jest.mock('@grafana/runtime', () => ({
  ...jest.requireActual('@grafana/runtime'),
  getDataSourceSrv: () => ({
    getInstanceSettings: (uid: string) => settings[uid],
    getList: () => Object.values(settings),
  }),
}));

jest.mock('../shared/query', () => ({
  ...jest.requireActual('../shared/query'),
  runSql: (...args: unknown[]) => runSql(...args),
}));

// Imported after the mocks.
import { getSignalSource, loadSignalSource, SignalSource } from '../shared/datasource';
import { filtersVariable, refreshFilterExpression } from '../shared/scene';
import {
  attributeKeysOf,
  attributeMapOf,
  attributeValuesOf,
  attributeValueSql,
  filtersSql,
  hasJsonAttributes,
} from '../shared/sql';
import { detectedKeysSql, logLinesSql, logsExpression, logsKeyExpression, valueCountsSql } from '../logs-drilldown/sql';
import {
  attributeKeysSql,
  comparisonSql,
  exceptionsSql,
  primarySignalSql,
  spanListSql,
  traceExpression,
  traceSql,
} from '../traces-drilldown/sql';

const scene = {} as SceneObject;

const addDataSource = (uid: string, jsonData: object) => {
  settings[uid] = { uid, name: uid, type: 'grafana-clickhouse-datasource', jsonData };
};

const columns = (rows: Array<[string, string]>) => [
  {
    fields: [
      { name: 'name', values: rows.map((row) => row[0]) },
      { name: 'type', values: rows.map((row) => row[1]) },
    ],
    length: rows.length,
  },
];
const count = (n: number) => [{ fields: [{ name: 'count', values: [n] }], length: 1 }];

const source = (shape: Partial<SignalSource>, table = 'otel_logs') =>
  ({ uid: 'x', type: 't', name: 'x', database: 'otel', table, metricTables: {}, ...shape }) as SignalSource;
const MAP = source({ jsonAttributes: false });
const JSON_ALL = source({ jsonAttributes: true, jsonAllValues: true });
const JSON_TEXT = source({ jsonAttributes: true, jsonAllValues: false });
const traces = (s: SignalSource) => ({ ...s, table: 'otel_traces' });

describe('attribute shape detection', () => {
  beforeEach(() => runSql.mockReset());

  it('detects JSON columns and JSONAllValues once per data source', async () => {
    addDataSource('json-logs', { logs: { defaultDatabase: 'otel5', defaultTable: 'otel_logs' } });
    runSql
      .mockResolvedValueOnce(
        columns([
          ['Timestamp', 'DateTime64(9)'],
          ['ResourceAttributes', 'JSON'],
        ])
      )
      .mockResolvedValueOnce(count(1));
    expect(getSignalSource('json-logs', 'logs')?.attributeShapeKnown).toBe(false);
    const [first, second] = await Promise.all([
      loadSignalSource(scene, 'json-logs', 'logs'),
      loadSignalSource(scene, 'json-logs', 'logs'),
    ]);
    expect(runSql).toHaveBeenCalledTimes(2);
    expect(String(runSql.mock.calls[0][1])).toBe('DESC TABLE "otel5"."otel_logs"');
    expect(String(runSql.mock.calls[1][1])).toContain("system.functions WHERE name = 'JSONAllValues'");
    expect(first).toMatchObject({ jsonAttributes: true, jsonAllValues: true, attributeShapeKnown: true });
    expect(second).toMatchObject({ jsonAttributes: true });
    // Cached: no further query, and getSignalSource knows the shape.
    await loadSignalSource(scene, 'json-logs', 'logs');
    expect(runSql).toHaveBeenCalledTimes(2);
    expect(getSignalSource('json-logs', 'logs')?.jsonAttributes).toBe(true);
  });

  it('needs no function lookup for Map tables', async () => {
    addDataSource('map-traces', {});
    runSql.mockResolvedValueOnce(columns([['ResourceAttributes', 'Map(LowCardinality(String), String)']]));
    const result = await loadSignalSource(scene, 'map-traces', 'traces');
    expect(runSql).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ jsonAttributes: false, attributeShapeKnown: true, table: 'otel_traces' });
  });

  it('reads as Map after a failed detection and tries again next time', async () => {
    addDataSource('failing', {});
    runSql.mockRejectedValueOnce(new Error('no access'));
    const failed = await loadSignalSource(scene, 'failing', 'logs');
    expect(failed).toMatchObject({ attributeShapeKnown: false });
    expect(failed?.jsonAttributes).toBeUndefined();
    runSql.mockResolvedValueOnce(columns([['ResourceAttributes', 'JSON']])).mockResolvedValueOnce(count(0));
    const retried = await loadSignalSource(scene, 'failing', 'logs');
    expect(retried).toMatchObject({ jsonAttributes: true, jsonAllValues: false, attributeShapeKnown: true });
  });

  it('tells JSON from Map by ResourceAttributes', () => {
    expect(hasJsonAttributes([{ name: 'ResourceAttributes', type: 'JSON' }])).toBe(true);
    expect(hasJsonAttributes([{ name: 'ResourceAttributes', type: 'Map(String, String)' }])).toBe(false);
    expect(hasJsonAttributes([{ name: 'LogAttributes', type: 'JSON' }])).toBe(false);
  });
});

describe('attribute SQL by shape', () => {
  it('reads a missing key as an empty string in both shapes', () => {
    expect(attributeValueSql('LogAttributes', 'http.route')).toBe("LogAttributes['http.route']");
    expect(attributeValueSql('LogAttributes', 'http.route', true)).toBe(
      "ifNull(LogAttributes.`http`.`route`::Nullable(String), '')"
    );
  });

  it('lists keys and values in matching order', () => {
    expect(attributeKeysOf('A', MAP)).toBe('mapKeys(A)');
    expect(attributeValuesOf('A', MAP)).toBe('mapValues(A)');
    expect(attributeMapOf('A', MAP)).toBe('A');
    expect(attributeKeysOf('A', JSON_ALL)).toBe('JSONAllPaths(A)');
    expect(attributeValuesOf('A', JSON_ALL)).toBe('JSONAllValues(A)');
    expect(attributeMapOf('A', JSON_ALL)).toBe('mapFromArrays(JSONAllPaths(A), JSONAllValues(A))');
    // Without JSONAllValues each path is read out of the JSON text.
    const text = attributeValuesOf('A', JSON_TEXT);
    expect(text).toMatch(/^arrayMap\(p -> .*, JSONAllPaths\(A\)\)$/);
    expect(text).toContain('JSONExtractRaw(toJSONString(A), splitByChar');
    expect(text).not.toContain('JSONAllValues');
  });
});

describe('logs SQL', () => {
  const noMap = /mapKeys|mapValues|mapConcat\(map\('service\.name', ServiceName\), ResourceAttributes/;

  it('keeps the Map form for Map tables', () => {
    expect(logsExpression('resource.k8s.pod.name')).toBe("ResourceAttributes['k8s.pod.name']");
    expect(detectedKeysSql(MAP, 'fields', '1 = 1')).toContain(
      'arrayZip(mapKeys(LogAttributes), mapValues(LogAttributes))'
    );
    expect(logLinesSql(MAP, '1 = 1')).toContain(
      "mapConcat(map('service.name', ServiceName), ResourceAttributes, LogAttributes)"
    );
  });

  it.each([
    ['JSONAllValues', JSON_ALL],
    ['JSON text', JSON_TEXT],
  ])('uses JSON paths for JSON tables (%s)', (_, shape) => {
    expect(logsExpression('log.http.route', true)).toBe("ifNull(LogAttributes.`http`.`route`::Nullable(String), '')");
    for (const sql of [
      detectedKeysSql(shape, 'labels', '1 = 1'),
      detectedKeysSql(shape, 'fields', '1 = 1'),
      logLinesSql(shape, '1 = 1'),
    ]) {
      expect(sql).not.toMatch(noMap);
      expect(sql).toContain('JSONAllPaths(');
    }
    expect(valueCountsSql(shape, 'resource.k8s.pod.name', '1 = 1')).toContain(
      "toString(ifNull(ResourceAttributes.`k8s`.`pod`.`name`::Nullable(String), ''))"
    );
  });

  it('renders filter-bar conditions for the shape, a missing key reading as empty', () => {
    const filters = [{ key: 'resource.no.such', operator: '!=', value: 'x' }];
    expect(filtersSql(filters, logsKeyExpression(JSON_ALL))).toBe(
      "(ifNull(ResourceAttributes.`no`.`such`::Nullable(String), '') != 'x')"
    );
    expect(filtersSql(filters, logsKeyExpression(MAP))).toBe("(ResourceAttributes['no.such'] != 'x')");
  });
});

describe('traces SQL', () => {
  it('keeps the Map form for Map tables', () => {
    expect(primarySignalSql('database')).toBe(
      "(SpanAttributes['db.system'] != '' OR SpanAttributes['db.system.name'] != '')"
    );
    expect(traceSql(traces(MAP), 'abc')).toContain(
      "arrayMap(key -> map('key', key, 'value', SpanAttributes[key]), mapKeys(SpanAttributes)) AS tags"
    );
    expect(exceptionsSql(traces(MAP))).toContain("tupleElement(event, 2)['exception.type'] AS type");
  });

  it('uses JSON paths for JSON tables', () => {
    const json = traces(JSON_ALL);
    expect(primarySignalSql('database', json)).toBe(
      "(ifNull(SpanAttributes.`db`.`system`::Nullable(String), '') != '' OR " +
        "ifNull(SpanAttributes.`db`.`system`.`name`::Nullable(String), '') != '')"
    );
    expect(primarySignalSql('root', json)).toBe("ParentSpanId = ''");
    expect(traceExpression('span.http.route', true)).toBe(
      "ifNull(SpanAttributes.`http`.`route`::Nullable(String), '')"
    );
    for (const sql of [attributeKeysSql(json, '1 = 1'), comparisonSql(json, '1 = 1'), traceSql(json, 'abc')]) {
      expect(sql).not.toMatch(/mapKeys|mapValues/);
    }
    expect(traceSql(json, 'abc')).toContain(
      "arrayMap((key, value) -> map('key', key, 'value', value), JSONAllPaths(SpanAttributes), JSONAllValues(SpanAttributes)) AS tags"
    );
    expect(exceptionsSql(json)).toContain(
      "ifNull(getSubcolumn(tupleElement(event, 2), 'exception.type')::Nullable(String), '') AS type"
    );
    expect(spanListSql(json, '1 = 1', ['span.http.route'])).toContain(
      'toString(ifNull(SpanAttributes.`http`.`route`::Nullable(String), \'\')) AS "span.http.route"'
    );
  });

  it('lists attribute keys without reading values', () => {
    expect(attributeKeysSql(traces(MAP), '1 = 1')).toContain(
      "arrayMap(k -> concat('span.', k), mapKeys(SpanAttributes))"
    );
    expect(attributeKeysSql(traces(JSON_TEXT), '1 = 1')).not.toContain('toJSONString');
  });
});

describe('filter bar after detection', () => {
  it('renders filters set before the shape was known again for the shape', () => {
    let json = false;
    const variable = filtersVariable({
      placeholder: 'Filter',
      expressionOf: (key: string) => logsExpression(key, json),
      getKeys: async () => [],
      getValues: async () => [],
    });
    variable.setState({ filters: [{ key: 'resource.no.such', operator: '!=', value: 'x' }] });
    expect(variable.getValue()).toBe("(ResourceAttributes['no.such'] != 'x')");
    json = true;
    // AdHocFiltersVariable keeps the expression it rendered when the filters were set.
    expect(variable.getValue()).toBe("(ResourceAttributes['no.such'] != 'x')");
    refreshFilterExpression(variable);
    expect(variable.getValue()).toBe("(ifNull(ResourceAttributes.`no`.`such`::Nullable(String), '') != 'x')");
  });
});
