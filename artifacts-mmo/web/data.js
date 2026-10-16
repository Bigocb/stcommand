// Loads the public game data and the characters feed.
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
};

export async function loadGameData(base = '/data') {
  const names = ['maps', 'monsters', 'resources', 'npcs', 'items', 'events'];
  const parts = await Promise.all(names.map((n) => get(`${base}/${n}.json`)));
  return Object.fromEntries(names.map((n, i) => [n, parts[i]]));
}

/** Characters come from window.ARTIFACTS_CHARACTERS when set, else the example file. Max 5. */
export async function loadCharacters(base = '/data') {
  if (Array.isArray(globalThis.ARTIFACTS_CHARACTERS)) return globalThis.ARTIFACTS_CHARACTERS.slice(0, 5);
  try { return (await get(`${base}/characters.example.json`)).slice(0, 5); } catch { return []; }
}

/** Current characters array; live wiring only has to reassign window.ARTIFACTS_CHARACTERS. */
export const currentCharacters = () => (Array.isArray(globalThis.ARTIFACTS_CHARACTERS) ? globalThis.ARTIFACTS_CHARACTERS.slice(0, 5) : null);
