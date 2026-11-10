import React from 'react';
import { render, screen } from '@testing-library/react';
import { DONE, isLoading, LatestRequest, loadError, loadFailed, LOADING, LoadStatus } from '../shared/load';

describe('LatestRequest', () => {
  it('lets only the newest request write', async () => {
    const request = new LatestRequest();
    const first = request.start();
    const second = request.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('supersedes requests in flight on cancel', () => {
    const request = new LatestRequest();
    const pending = request.start();
    request.cancel();
    expect(pending()).toBe(false);
  });

  it('keeps instances independent, so one load cannot cancel another', () => {
    const catalog = new LatestRequest();
    const groups = new LatestRequest();
    const isCatalogCurrent = catalog.start();
    groups.start();
    groups.cancel();
    expect(isCatalogCurrent()).toBe(true);
  });
});

describe('LoadState', () => {
  it('has exactly one status, so loading and an error cannot coexist', () => {
    expect(isLoading(LOADING)).toBe(true);
    expect(loadError(LOADING)).toBeUndefined();
    expect(isLoading(loadFailed(new Error('boom')))).toBe(false);
    expect(loadError(loadFailed(new Error('boom')))).toBe('boom');
    expect(loadError(loadFailed({ data: { message: 'bad SQL' } }))).toBe('bad SQL');
    expect(loadError(DONE)).toBeUndefined();
  });
});

describe('LoadStatus', () => {
  it('shows a busy status while loading', () => {
    render(<LoadStatus state={LOADING} loadingText="Loading metrics…" errorTitle="Failed" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(status.getAttribute('data-load-state')).toBe('loading');
    expect(screen.getByText('Loading metrics…')).toBeTruthy();
  });

  it('shows the error with its title', () => {
    render(<LoadStatus state={loadFailed(new Error('bad SQL'))} loadingText="Loading" errorTitle="Could not load" />);
    expect(screen.getByText('Could not load')).toBeTruthy();
    expect(screen.getByText('bad SQL')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('data-load-state')).toBe('error');
  });

  it('renders no placeholder when done or when reloading quietly, but keeps the machine-readable state', () => {
    const { container, rerender } = render(<LoadStatus state={DONE} loadingText="Loading" errorTitle="x" />);
    expect(container.querySelector('[data-load-state="done"]')).toBeTruthy();
    expect(screen.queryByText('Loading')).toBeNull();
    rerender(<LoadStatus state={LOADING} quietLoading loadingText="Loading" errorTitle="x" />);
    expect(container.querySelector('[data-load-state="loading"]')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('Loading')).toBeNull();
  });
});
