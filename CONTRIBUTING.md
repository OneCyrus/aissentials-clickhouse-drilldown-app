# Contributing

## Setup

```bash
npm install
npm run dev          # build in watch mode into dist/
npm run typecheck && npm run lint && npm run test:ci && npm run build
```

`docker compose up` starts Grafana with the ClickHouse data source and `dist/` mounted as the app.

## Loading data: one state machine per load

Every asynchronous load (a list, a tab's data, a count) follows the same rules, from `src/shared/load.tsx`:

- **One `LoadState` per load**, never a shared `loading` flag or `error` string: `{ status: 'loading' } | { status: 'done' } | { status: 'error', message }`. Two loads on one page get two states, so one cannot end the other's spinner or show its error.
- **One `LatestRequest` per load**, so a slow earlier response never overwrites a newer one:

  ```ts
  private groupsRequest = new LatestRequest();

  async loadGroups() {
    const isCurrent = this.groupsRequest.start();
    this.setState({ groupsLoad: LOADING });
    try {
      const rows = await runSql(this, sql);
      if (!isCurrent()) {
        return;
      }
      this.setState({ groups: rows, groupsLoad: DONE });
    } catch (error) {
      if (isCurrent()) {
        this.setState({ groupsLoad: loadFailed(error) });
      }
    }
  }
  ```

  Start the request before the first `await`, and check `isCurrent()` after each one.

- **Render with `<LoadStatus>`**, and show empty-state messages only when the status is `done`, never after an error:

  ```tsx
  <>
    <LoadStatus state={groupsLoad} loadingText="Loading label values…" errorTitle="Error while loading label values" />
    {groupsLoad.status === 'done' && !groups.length && <Alert severity="info" title="No label values." />}
  </>
  ```

  Pass `quietLoading` to keep the previous content on screen while reloading.

`LoadStatus` marks its element with `role="status"`, `aria-busy` and `data-load-state`. Screen readers announce loading and errors. Tests, scripts and agents can wait for a page to settle without sleeping:

```js
await page.waitForFunction(() => !document.querySelector('[data-load-state="loading"]'));
```

The tests in `src/__tests__/*Load*.test.ts` run the real scene classes with `runSql` stubbed. Use them as a template when you add a load.
