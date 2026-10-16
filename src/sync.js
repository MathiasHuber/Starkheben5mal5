// Pure helpers for server sync: how app state maps to stored documents, and how two copies merge.
import { validateState, validateSession } from "./program.js";

const plain = (v) => JSON.parse(JSON.stringify(v)); // drops undefined, which the store doesn't accept

const newestFirst = (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id);

/** State is stored as one athlete document plus one document per finished session. */
export function splitState(state) {
  const { history, ...doc } = state;
  return { doc: plain(doc), sessions: history.map(plain) };
}

/** Rebuilds state from stored documents; invalid sessions are dropped, an invalid athlete doc gives null. */
export function assembleState(doc, sessions) {
  if (!doc || typeof doc !== "object") return null;
  const history = sessions.filter(validateSession).sort(newestFirst);
  const s = validateState({ ...doc, history });
  if (!s) return null;
  return { ...s, active: validateSession(doc.active) ? doc.active : null };
}

/**
 * First connection on a device: keep every session from both sides. Settings and weights come from the
 * server, unless the server copy has never logged a workout and this device has (an earlier local-only user).
 */
export function mergeOnConnect(local, remote) {
  if (!remote) return local;
  const byId = new Map(remote.history.map((h) => [h.id, h]));
  for (const h of local.history) if (!byId.has(h.id)) byId.set(h.id, h);
  const base = remote.history.length === 0 && local.history.length > 0 ? local : remote;
  return { ...base, history: [...byId.values()].sort(newestFirst) };
}

/** JSON with sorted keys, so the same data always compares equal regardless of key order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
