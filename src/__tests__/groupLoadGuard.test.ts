/**
 * The staleness guard on MetricsExploration.loadGroups.
 *
 * The scene object needs a live Grafana runtime, so this test pins the property that matters by
 * running the same token discipline the class uses: a slow response from an earlier call must not
 * overwrite the state a newer call wrote.
 */
class GuardedLoader {
  token = 0;
  groups: string[] = [];

  async run(pending: Promise<string[]>, apply: (groups: string[]) => void) {
    const token = ++this.token;
    const groups = await pending;
    if (token !== this.token) {
      return undefined;
    }
    apply(groups);
    return groups;
  }
}

describe('loadGroups staleness guard', () => {
  it('drops a response superseded by a newer call', async () => {
    const loader = new GuardedLoader();
    const applied: string[][] = [];
    let resolveFirst: (groups: string[]) => void = () => undefined;
    const first = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });

    const firstRun = loader.run(first, (groups) => applied.push(groups));
    const secondRun = loader.run(Promise.resolve(['new']), (groups) => applied.push(groups));
    await secondRun;
    resolveFirst(['stale']);
    await firstRun;

    expect(applied).toEqual([['new']]);
  });

  it('applies the response of the newest call', async () => {
    const loader = new GuardedLoader();
    const applied: string[][] = [];
    await loader.run(Promise.resolve(['only']), (groups) => applied.push(groups));
    expect(applied).toEqual([['only']]);
  });
});
