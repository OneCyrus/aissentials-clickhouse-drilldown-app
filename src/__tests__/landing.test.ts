import { DataFrame, FieldType } from '@grafana/data';
import { tileLines, tileVolume } from '../logs-drilldown/landing';
import { LANDING_TILE, landingLinesSql, landingVolumeSql } from '../logs-drilldown/sql';
import { SignalSource } from '../shared/datasource';

const source: SignalSource = {
  uid: 'logs',
  type: 'grafana-clickhouse-datasource',
  name: 'logs',
  database: 'otel',
  table: 'otel_logs',
  metricTables: {},
};

const field = (name: string, type: FieldType, values: unknown[], labels?: Record<string, string>) => ({
  name,
  type,
  values,
  config: {},
  ...(labels ? { labels } : {}),
});

describe('landing page queries', () => {
  it('queries the volume of all tiles at once, keeping the tile value as a label', () => {
    const sql = landingVolumeSql(source, 'resource.service.name', ['cart', "it's"], '1 = 1');
    expect(sql).toContain(`toString(ServiceName) AS ${LANDING_TILE}`);
    expect(sql).toContain("ServiceName IN ('cart', 'it\\'s')");
    expect(sql).toContain(`GROUP BY time, ${LANDING_TILE}, level`);
  });

  it('queries the latest lines of all tiles at once, capped per tile', () => {
    const sql = landingLinesSql(source, 'resource.service.name', ['cart', 'payments'], '1 = 1', 100);
    expect(sql).toContain(`ORDER BY Timestamp DESC LIMIT 100 BY "${LANDING_TILE}"`);
    expect(sql).toContain("ServiceName IN ('cart', 'payments')");
  });

  it("splits the volume into a tile's series without the tile label", () => {
    const frames: DataFrame[] = [
      {
        length: 2,
        fields: [
          field('time', FieldType.time, [1, 2]),
          field('count', FieldType.number, [1, 2], { [LANDING_TILE]: 'cart', level: 'info' }),
          field('count', FieldType.number, [3, 4], { [LANDING_TILE]: 'payments', level: 'info' }),
          field('count', FieldType.number, [5, 6], { [LANDING_TILE]: 'payments', level: 'error' }),
        ],
      },
    ];
    const payments = tileVolume(frames, 'payments')[0];
    expect(payments.fields.map((f) => f.labels)).toEqual([undefined, { level: 'info' }, { level: 'error' }]);
    expect(payments.fields[2].values).toEqual([5, 6]);
    expect(tileVolume(frames, 'cart')[0].fields).toHaveLength(2);
  });

  it("splits the lines into a tile's rows without the tile column", () => {
    const frames: DataFrame[] = [
      {
        length: 3,
        meta: { preferredVisualisationType: 'logs' },
        fields: [
          field('timestamp', FieldType.time, [3, 2, 1]),
          field('body', FieldType.string, ['a', 'b', 'c']),
          field(LANDING_TILE, FieldType.string, ['cart', 'payments', 'cart']),
        ],
      },
    ];
    const cart = tileLines(frames, 'cart')[0];
    expect(cart.length).toBe(2);
    expect(cart.fields.map((f) => f.name)).toEqual(['timestamp', 'body']);
    expect(cart.fields[1].values).toEqual(['a', 'c']);
    expect(cart.meta?.preferredVisualisationType).toBe('logs');
    expect(tileLines(frames, 'none')[0].length).toBe(0);
  });
});
