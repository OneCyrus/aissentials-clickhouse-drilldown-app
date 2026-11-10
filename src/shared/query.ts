import { DataFrame, dataFrameFromJSON, DataFrameJSON, rangeUtil } from '@grafana/data';
import { getBackendSrv } from '@grafana/runtime';
import { SceneDataQuery, SceneObject, SceneQueryRunner, sceneGraph } from '@grafana/scenes';
import { EmptyError, lastValueFrom } from 'rxjs';
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

/**
 * A query runner that is not a panel's own data, e.g. one shared by a SceneByFrameRepeater. It
 * runs as soon as it is activated.
 */
export const queryRunner = (queries: SceneDataQuery[], maxDataPoints?: number): SceneQueryRunner =>
  new SceneQueryRunner({ datasource: queries[0]?.datasource || datasourceRef, queries, maxDataPoints });

/**
 * The query runner of one panel: the panel's data directly or through SceneDataTransformers (they
 * pass the in-view state on). It runs once the panel is rendered and in view, so the panels of a
 * lazy grid query only when they are scrolled into view.
 *
 * A runner starts out "in view" and runs when it is activated, which happens before its panel's
 * renderer reports whether the panel is visible, so every panel of a lazy grid would query at once.
 * This one starts out of view; the renderer reports the real state when it mounts (true outside a
 * lazy grid), and the runner runs then. maxDataPoints stays fixed, so the resolution is unchanged.
 */
export const panelQueryRunner = (queries: SceneDataQuery[], maxDataPoints?: number): SceneQueryRunner => {
  const runner = queryRunner(queries, maxDataPoints);
  runner.isInViewChanged(false);
  return runner;
};

/** Interpolates scene variables without quoting, as the data source does. */
export const interpolate = (sceneObject: SceneObject, text: string): string =>
  sceneGraph.interpolate(sceneObject, text, undefined, (value: unknown) =>
    Array.isArray(value) ? value.join(',') : String(value ?? '')
  );

export interface RunSqlOptions {
  /** Another data source than the scene's. */
  datasourceUid?: string;
  /** For time series: the number of buckets $__timeInterval and $__interval_s aim at, like a panel's. */
  maxDataPoints?: number;
  /**
   * Grafana cancels a request still in flight when another one with the same id starts, so a
   * superseded load stops its query instead of letting it run to the end. Use one id per kind of
   * request (see LatestRequest.requestId), never one shared by requests that run side by side.
   */
  requestId?: string;
}

/** A request that a newer one with the same requestId cancelled. Its load is superseded. */
export class RequestCancelledError extends Error {
  constructor() {
    super('The request was cancelled by a newer one.');
    this.name = 'RequestCancelledError';
  }
}

/** Whether an error is a cancellation by a newer request, which is not a failure to show. */
export const isRequestCancelled = (error: unknown): boolean => error instanceof RequestCancelledError;

/**
 * Runs SQL outside a panel, for lists such as label keys and values. Uses the scene's data
 * source and time range; the backend expands the time macros. A request cancelled through its
 * requestId rejects with RequestCancelledError.
 */
export const runSql = async (
  sceneObject: SceneObject,
  sql: string,
  format: Format = Format.Table,
  { datasourceUid, maxDataPoints, requestId }: RunSqlOptions = {}
): Promise<DataFrame[]> => {
  const uid = datasourceUid || interpolate(sceneObject, `\${${VAR_DATASOURCE}}`);
  const range = sceneGraph.getTimeRange(sceneObject).state.value;
  const interval = maxDataPoints ? rangeUtil.calculateInterval(range, maxDataPoints) : undefined;
  const request = getBackendSrv().fetch<{
    results: Record<string, { frames?: DataFrameJSON[]; error?: string }>;
  }>({
    url: '/api/ds/query',
    method: 'POST',
    ...(requestId ? { requestId } : {}),
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
          ...(interval ? { intervalMs: interval.intervalMs, maxDataPoints } : {}),
        },
      ],
    },
    showErrorAlert: false,
  });
  let response;
  try {
    response = await lastValueFrom(request);
  } catch (error) {
    // A newer request with the same id completes this one without a response (EmptyError), or
    // Grafana reports the aborted fetch as cancelled.
    if (
      error instanceof EmptyError ||
      (error instanceof Error && error.name === 'EmptyError') ||
      (typeof error === 'object' && error && 'cancelled' in error && error.cancelled)
    ) {
      throw new RequestCancelledError();
    }
    throw error;
  }
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

/**
 * A readable message of a failed query: Error objects, Grafana's fetch errors ({ data: { message } },
 * { statusText }) and plain strings.
 */
export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'object' && error) {
    const e = error as {
      data?: { message?: string; error?: string; results?: Record<string, { error?: string }> };
      message?: string;
      statusText?: string;
    };
    // A failed /api/ds/query answers 400 with the database's message in the query's result.
    const queryError = Object.values(e.data?.results || {}).find((result) => result?.error)?.error;
    return queryError || e.data?.message || e.data?.error || e.message || e.statusText || JSON.stringify(error);
  }
  return String(error);
};
