import { PLUGIN_ID } from '../constants';

/** Per-viewer preferences in localStorage, namespaced with the plugin id. Never throws. */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = window.localStorage.getItem(`${PLUGIN_ID}.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      // Storage unavailable or a corrupt entry: the default preference applies.
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      window.localStorage.setItem(`${PLUGIN_ID}.${key}`, JSON.stringify(value));
    } catch {
      // Storage can be unavailable (private mode, blocked site data); preferences are optional.
    }
  },
};
