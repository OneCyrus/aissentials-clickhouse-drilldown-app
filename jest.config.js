// force timezone to UTC to allow tests to work regardless of local timezone
process.env.TZ = 'UTC';

const base = require('./.config/jest.config');
const [[pattern, swc]] = Object.entries(base.transform);

module.exports = {
  // Jest configuration provided by Grafana scaffolding
  ...base,
  // The Scenes library pulls in ES module builds (.mjs) of d3 packages, which need transforming too.
  transform: { [pattern]: swc, '^.+\\.mjs$': swc },
};
