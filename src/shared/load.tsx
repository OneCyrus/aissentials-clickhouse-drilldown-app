import React from 'react';
import { Alert, LoadingPlaceholder } from '@grafana/ui';
import { errorMessage } from './query';

/**
 * Every asynchronous load in the apps (a metric list, a tab's data, a count) is the same small
 * state machine:
 *
 *   loading ──ok──> done
 *      │  ▲            │
 *    fail └─ reload ───┘ (and from error)
 *      ▼
 *    error
 *
 * One value per load, instead of a `loading` flag and an `error` string per page, makes the
 * impossible combinations unrepresentable (loading with a stale error, two loads sharing one
 * flag), and gives the UI one place to read what to show.
 */
export type LoadState = { status: 'loading' } | { status: 'done' } | { status: 'error'; message: string };

export const LOADING: LoadState = { status: 'loading' };
export const DONE: LoadState = { status: 'done' };
export const loadFailed = (error: unknown): LoadState => ({ status: 'error', message: errorMessage(error) });

export const isLoading = (state: LoadState): boolean => state.status === 'loading';
export const loadError = (state: LoadState): string | undefined =>
  state.status === 'error' ? state.message : undefined;

/**
 * "Latest wins" for one kind of request: a new request supersedes the ones still in flight, so a
 * slow earlier response can never overwrite a newer one (switching labels, tabs or metrics while a
 * query runs). Each load owns its own instance.
 *
 *   const isCurrent = this.groupsRequest.start();
 *   const rows = await runSql(...);
 *   if (!isCurrent()) return;
 */
let nextRequestKind = 0;

export class LatestRequest {
  private latest = 0;
  private readonly kind = `clickhouse-app-${++nextRequestKind}`;

  /**
   * The requestId (runSql's option) of this kind of request: Grafana cancels the request in flight
   * when a newer one with the same id starts, so a superseded query stops instead of running on.
   * `name` tells apart the queries of one load that run side by side, which must not cancel each
   * other.
   */
  requestId(name = 'query'): string {
    return `${this.kind}-${name}`;
  }

  /** Starts a request; the returned check tells whether it is still the newest one. */
  start(): () => boolean {
    const id = ++this.latest;
    return () => id === this.latest;
  }

  /** Supersedes the requests in flight without starting a new one, e.g. when a selection is cleared. */
  cancel() {
    this.latest++;
  }
}

/**
 * What a load shows while it is not done: a loading placeholder, or the error. Marked up with
 * `role="status"`, `aria-busy` and `data-load-state`, so screen readers announce it and tests and
 * agents can wait for `[data-load-state="loading"]` to disappear instead of sleeping.
 */
export function LoadStatus({
  state,
  loadingText,
  errorTitle,
  quietLoading = false,
}: {
  state: LoadState;
  loadingText: string;
  errorTitle: string;
  /** Keep showing the previous content while reloading, without a placeholder. */
  quietLoading?: boolean;
}) {
  if (state.status === 'done' || (state.status === 'loading' && quietLoading)) {
    return <span hidden role="status" aria-busy={state.status === 'loading'} data-load-state={state.status} />;
  }
  return (
    <div role="status" aria-live="polite" aria-busy={state.status === 'loading'} data-load-state={state.status}>
      {state.status === 'loading' ? (
        <LoadingPlaceholder text={loadingText} />
      ) : (
        <Alert severity="error" title={errorTitle}>
          {state.message}
        </Alert>
      )}
    </div>
  );
}
