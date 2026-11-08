import { filterConditionSql, filtersSql } from '../shared/sql';
import {
  getMetricLabelId,
  metricPrefix,
  metricSuffix,
  nameDistance,
  parseMetricLabelId,
  searchMatcher,
} from '../metrics-drilldown/sql';
import {
  levelsSql,
  lineFilterSql,
  lineFiltersSql,
  logsExpression,
  patternExpression,
  patternsSql,
  SERVICE_KEY as LOGS_SERVICE,
} from '../logs-drilldown/sql';
import {
  normalizeMessage,
  selectionSql,
  slowestQuarterThreshold,
  spanListSql,
  traceExpression,
} from '../traces-drilldown/sql';

describe('filter conditions', () => {
  it('covers the filter bar operators', () => {
    const e = 'ServiceName';
    expect(filterConditionSql(e, { key: 'k', operator: '=', value: "o'k" })).toBe("ServiceName = 'o\\'k'");
    expect(filterConditionSql(e, { key: 'k', operator: '!=', value: 'a' })).toBe("ServiceName != 'a'");
    expect(filterConditionSql(e, { key: 'k', operator: '=~', value: '^a' })).toBe("match(ServiceName, '^a')");
    expect(filterConditionSql(e, { key: 'k', operator: '!~', value: '^a' })).toBe("NOT match(ServiceName, '^a')");
    expect(filterConditionSql(e, { key: 'k', operator: '=|', value: 'a', values: ['a', 'b'] })).toBe(
      "ServiceName IN ('a', 'b')"
    );
    expect(filterConditionSql(e, { key: 'k', operator: '!=|', value: 'a', values: ['a'] })).toBe(
      "ServiceName NOT IN ('a')"
    );
    expect(filterConditionSql(e, { key: 'k', operator: '>', value: '200' })).toBe(
      'toFloat64OrNull(toString(ServiceName)) > 200'
    );
    expect(filterConditionSql(e, { key: 'k', operator: '<', value: 'x' })).toBe(
      'toFloat64OrNull(toString(ServiceName)) < NULL'
    );
  });

  it('ANDs filters and ignores unknown keys', () => {
    const expressionOf = (key: string) => (key === 'a' ? 'A' : undefined);
    expect(filtersSql([], expressionOf)).toBe('1 = 1');
    expect(
      filtersSql(
        [
          { key: 'a', operator: '=', value: '1' },
          { key: 'b', operator: '=', value: '2' },
          { key: 'a', operator: '!=', value: '3' },
        ],
        expressionOf
      )
    ).toBe("(A = '1') AND (A != '3')");
  });
});

describe('metrics', () => {
  it('uses readable label ids', () => {
    expect(getMetricLabelId({ source: 'column', key: 'ServiceName' })).toBe('ServiceName');
    expect(getMetricLabelId({ source: 'resource', key: 'k8s.pod.name' })).toBe('resource.k8s.pod.name');
    expect(parseMetricLabelId('attribute.http.route')).toEqual({ source: 'attribute', key: 'http.route' });
    expect(parseMetricLabelId('ScopeName')).toEqual({ source: 'column', key: 'ScopeName' });
    expect(parseMetricLabelId('unknown')).toBeUndefined();
  });

  it('splits names into prefix and suffix', () => {
    expect(metricPrefix('http.server.request.duration')).toBe('http');
    expect(metricPrefix('go_gc_duration_seconds')).toBe('go');
    expect(metricSuffix('go_gc_duration_seconds')).toBe('seconds');
    expect(metricSuffix('up')).toBe('up');
  });

  it('searches with comma separated regular expressions', () => {
    const match = searchMatcher('^http, cpu');
    expect(match('http.server.duration')).toBe(true);
    expect(match('system.cpu.time')).toBe(true);
    expect(match('go_gc')).toBe(false);
    expect(searchMatcher('(')('anything')).toBe(true);
  });

  it('ranks related metrics by name similarity', () => {
    const target = 'http.server.request.duration';
    const ranked = ['go_gc_duration_seconds', 'http.server.request.count', target, 'http.client.request.duration'].sort(
      (a, b) => nameDistance(a, target) - nameDistance(b, target)
    );
    expect(ranked[0]).toBe(target);
    expect(ranked[ranked.length - 1]).toBe('go_gc_duration_seconds');
  });
});

describe('logs', () => {
  it('maps keys to columns', () => {
    expect(logsExpression(LOGS_SERVICE)).toBe('ServiceName');
    expect(logsExpression('resource.k8s.pod.name')).toBe("ResourceAttributes['k8s.pod.name']");
    expect(logsExpression('log.user.id')).toBe("LogAttributes['user.id']");
    expect(logsExpression('level')).toContain('SeverityText');
    expect(logsExpression('pattern')).toBe(patternExpression);
    expect(logsExpression('other')).toBeUndefined();
  });

  it('builds line filters', () => {
    expect(lineFilterSql({ exclude: false, text: 'err', caseSensitive: false, regex: false })).toBe(
      "positionCaseInsensitiveUTF8(Body, 'err') > 0"
    );
    expect(lineFilterSql({ exclude: true, text: 'err', caseSensitive: true, regex: false })).toBe(
      "NOT position(Body, 'err') > 0"
    );
    expect(lineFilterSql({ exclude: false, text: 'a.b', caseSensitive: false, regex: true })).toBe(
      "match(Body, '(?i)a.b')"
    );
    expect(lineFiltersSql([{ exclude: false, text: '', caseSensitive: false, regex: false }])).toBe('1 = 1');
  });

  it('builds level and pattern conditions', () => {
    expect(levelsSql([])).toBe('1 = 1');
    expect(levelsSql(['error', 'warn'])).toMatch(/IN \('error', 'warn'\)$/);
    expect(patternsSql([])).toBe('1 = 1');
    const sql = patternsSql([
      { type: 'include', pattern: 'a <_>' },
      { type: 'include', pattern: 'b <_>' },
      { type: 'exclude', pattern: 'c' },
    ]);
    expect(sql).toContain(`${patternExpression} IN ('a <_>', 'b <_>')`);
    expect(sql).toContain(`${patternExpression} NOT IN ('c')`);
  });

  it('normalizes variable parts of log lines into patterns', () => {
    // The regexes are escaped once for the SQL string literal.
    expect(patternExpression.startsWith('replaceRegexpAll(replaceRegexpAll(')).toBe(true);
    expect(patternExpression).toContain("'\\\\b(\\\\d{1,3}\\\\.){3}\\\\d{1,3}\\\\b'");
    expect(patternExpression).toContain(`'\\'[^\\']*\\''`);
  });
});

describe('traces', () => {
  it('maps TraceQL style keys to columns', () => {
    expect(traceExpression('resource.service.name')).toBe('ServiceName');
    expect(traceExpression('resource.k8s.pod.name')).toBe("ResourceAttributes['k8s.pod.name']");
    expect(traceExpression('span.http.route')).toBe("SpanAttributes['http.route']");
    expect(traceExpression('status')).toBe('StatusCode');
    expect(traceExpression('duration')).toBe('Duration / 1000000');
    expect(traceExpression('other')).toBeUndefined();
  });

  it('selects the slowest quarter of the duration buckets', () => {
    expect(slowestQuarterThreshold([])).toBeUndefined();
    // 8 buckets: the top 2 are selected, so spans slower than the bucket below them.
    expect(slowestQuarterThreshold([0.5, 0.25, 1, 2, 0.125, 4, 8, 0.0625])).toBe(2);
    expect(slowestQuarterThreshold([0.5])).toBe(0.25);
    expect(selectionSql('duration', 0.25)).toBe('Duration >= 250000000 AND Duration < 1000000000000000');
    expect(selectionSql('errors')).toContain("StatusCode IN ('Error'");
  });

  it('keeps aliases from shadowing the duration column', () => {
    const sql = spanListSql(
      {
        uid: '',
        type: 'grafana-clickhouse-datasource',
        name: '',
        database: 'otel',
        table: 'otel_traces',
        metricTables: {} as never,
      },
      'Duration >= 1',
      []
    );
    expect(sql).toContain('AS "Duration (ms)"');
    expect(sql).not.toContain('AS "Duration",');
  });

  it('normalizes exception messages', () => {
    expect(normalizeMessage('timeout after 837ms calling 10.0.0.12 for orderId=ord-42')).toBe(
      'timeout after <num>ms calling <ip> for orderId=<id>'
    );
  });
});
