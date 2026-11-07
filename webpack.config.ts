import type { Configuration } from 'webpack';
import grafanaConfig, { Env } from './.config/webpack/webpack.config';

/**
 * The create-plugin build, with two changes for the Scenes library:
 * - it imports routing from react-router-dom, which Grafana provides as version 5, while the v6
 *   API it needs (Routes, useParams, matchPath) comes with Grafana's react-router module;
 * - its JSX runtime must come from Grafana, which runs a newer React than the one in node_modules.
 */
const config = async (env: Env): Promise<Configuration> => {
  const base = await grafanaConfig(env);
  const externals = Array.isArray(base.externals) ? base.externals : [];
  return {
    ...base,
    externals: [
      { 'react-router-dom': 'react-router' },
      ...externals.filter((external) => external !== 'react-router-dom'),
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
    ],
  };
};

export default config;
