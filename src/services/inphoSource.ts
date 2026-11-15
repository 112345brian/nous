// The InPhO (Internet Philosophy Ontology) source: the adapter behind the core's GraphSource port.
//
// Data is fetched per client at runtime from inphoproject.org (not bundled), so there is no
// redistribution of the CC BY-NC-SA dataset: the same model as how SEP article content is fetched and
// cached on device. Dev builds can instead read index files injected into the simulator by
// scripts/inject-dev-seeds.sh. The use cases are in src/core/graph.ts.
import * as FileSystem from 'expo-file-system';
import { documentDirectory } from 'expo-file-system/legacy';
import type { GraphSource } from '../core/ports';

declare const __DEV__: boolean | undefined;

const INPHO_BASE = 'https://www.inphoproject.org';
const HEADERS = { 'User-Agent': 'Nous/0.3 (SEP reader; +https://github.com/112345brian/sep-reader)' };

export const inphoSource: GraphSource = {
  async fetchJson(path) {
    try {
      const res = await fetch(`${INPHO_BASE}${path}`, { headers: HEADERS });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },

  async readDevSeed() {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return null;
    const dir = documentDirectory + 'dev-seeds/';
    try {
      const [ideaText, thinkerText] = await Promise.all([
        FileSystem.readAsStringAsync(dir + 'inpho-idea.json'),
        FileSystem.readAsStringAsync(dir + 'inpho-thinker.json'),
      ]);
      return { ideas: JSON.parse(ideaText), thinkers: JSON.parse(thinkerText) };
    } catch {
      return null;
    }
  },
};
