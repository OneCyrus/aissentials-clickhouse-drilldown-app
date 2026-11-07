import { DataFrame, dataFrameFromJSON, DataFrameJSON } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { SceneDataQuery, SceneObject, SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { lastValueFrom } from 'rxjs';
import { CLICKHOUSE_DS_TYPE, VAR_DATASOURCE } from '../constants';

/** The plugin backend's result formats (sqlds). */
export enum Format {
  TimeSeries = 0,
  Table = 1,
  Logs = 2,
  Trace = 3,
}

export const datasourceRef = { type: CLICKHOUSE_DS_TYPE, uid: `\${${VAR_DATASOURCE}}` };

/** A raw SQL query of the ClickHouse data source: the scene's, or another one by uid. */
export const sqlQuery = (
  refId: string,
  rawSql: string,
  format: Format = Format.TimeSeries,
  uid?: string
): SceneDataQuery => ({
  refId,
  datasource: uid ? { type: CLICKHOUSE_DS_TYPE, uid } : datasourceRef,
  editorType: 'sql',
  pluginVersion: '',
  rawSql,
  format,
});

export const queryRunner = (queries: SceneDataQuery[], maxDataPoints?: number): SceneQueryRunner =>
  new SceneQueryRunner({ datasource: queries[0]?.datasource || datasourceRef, queries, maxDataPoints });

/** Interpolates scene variables without quoting, as the data source does. */
export const interpolate = (sceneObject: SceneObject, text: string): string =>
  sceneGraph.interpolate(sceneObject, text, undefined, (value: unknown) =>
    Array.isArray(value) ? value.join(',') : String(value ?? '')
  );

/**
 * Runs SQL outside a panel, for lists such as label keys and values. Uses the scene's data
 * source and time range; the backend expands the time macros.
 */
export const runSql = async (
  sceneObject: SceneObject,
  sql: string,
  format: Format = Format.Table,
  datasourceUid?: string
): Promise<DataFrame[]> => {
  const uid = datasourceUid || interpolate(sceneObject, `\${${VAR_DATASOURCE}}`);
  const range = sceneGraph.getTimeRange(sceneObject).state.value;
  const response = await lastValueFrom(
    getBackendSrv().fetch<{
      results: Record<string, { frames?: DataFrameJSON[]; error?: string }>;
    }>({
      url: '/api/ds/query',
      method: 'POST',
      data: {
        from: String(range.from.valueOf()),
        to: String(range.to.valueOf()),
        queries: [
          {
            refId: 'A',
            datasource: { type: CLICKHOUSE_DS_TYPE, uid },
            editorType: 'sql',
            rawSql: interpolate(sceneObject, sql),
            format,
          },
        ],
      },
      showErrorAlert: false,
    })
  );
  const result = response.data.results?.A;
  if (result?.error) {
    throw new Error(result.error);
  }
  return (result?.frames || []).map((frame) => dataFrameFromJSON(frame));
};

/** The rows of a table frame as objects. */
export const frameRows = <T extends Record<string, unknown>>(frames: DataFrame[]): T[] => {
  const frame = frames[0];
  if (!frame) {
    return [];
  }
  return Array.from({ length: frame.length }, (_, index) =>
    Object.fromEntries(frame.fields.map((field) => [field.name, field.values[index]]))
  ) as T[];
};
