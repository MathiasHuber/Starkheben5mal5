// Server backends for sync. Both expose the same interface to app.js:
//   id                       the signed-in person's id
//   loadOwn()                → { doc, sessions }  (doc is null on first use)
//   saveDoc(doc), saveSession(session), deleteSession(id)
//   watch({ onAthletes(map id → doc), onSessions(id, sessions) })   everyone's data, live
//   profiles(ids)            → { id: { name, avatarUrl, color } }
//   isWriteRefusal(error)    true when the server refused a write (no permission)

/** Claude artifact `db` (the claude.ai shared page). Null outside claude.ai or when signed out. */
export async function artifactBackend() {
  if (typeof window.claude?.use !== "function") return null;
  const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
  const id = db && user ? await user.id() : null;
  if (!id) return null;
  const athlete = (uid) => db.doc(`athletes/${uid}`);
  const sessions = (uid) => db.collection(`athletes/${uid}/sessions`);
  return {
    id,
    kind: "artifact",
    async loadOwn() {
      const [d, s] = await Promise.all([athlete(id).get(), sessions(id).get()]);
      return { doc: d.exists ? d.data() : null, sessions: s.docs.map((x) => x.data()) };
    },
    saveDoc: (doc) => athlete(id).set(doc),
    saveSession: (session) => sessions(id).doc(session.id).set(session),
    deleteSession: (sid) => sessions(id).doc(sid).delete(),
    watch({ onAthletes, onSessions }) {
      const watching = new Set();
      db.collection("athletes").onSnapshot((snap) => {
        const map = {};
        for (const d of snap.docs) map[d.id] = d.data();
        onAthletes(map);
        for (const uid of Object.keys(map)) {
          if (watching.has(uid)) continue;
          watching.add(uid);
          sessions(uid).onSnapshot((s) => {
            if (!s.metadata.hasPendingWrites) onSessions(uid, s.docs.map((x) => x.data()));
          }, () => {});
        }
      }, () => {});
    },
    async profiles(ids) {
      const ps = await user.profiles(ids);
      return Object.fromEntries(ids.map((i) => [i, { name: ps[i]?.name || "", avatarUrl: ps[i]?.avatarUrl || "", color: ps[i]?.color || "" }]));
    },
    isWriteRefusal: (e) => e?.code === "invalid_argument",
  };
}

/**
 * Calls one of the crew_* database functions on the Supabase project (see supabase/schema.sql).
 * Errors carry `code`: the function's error ("invalid_login", "invalid_token", ...) or "offline".
 */
export function crewRpc(config) {
  if (!config.url || !config.key) return null;
  return async (fn, args = {}) => {
    let res;
    try {
      res = await fetch(`${config.url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: config.key, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
    } catch {
      throw Object.assign(new Error("offline"), { code: "offline" });
    }
    const body = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const code = body?.message || `http_${res.status}`;
      throw Object.assign(new Error(code), { code });
    }
    return body;
  };
}

/** Username/password accounts on Supabase. Rejects with code "invalid_token" when the login has expired. */
export async function crewBackend(rpc, token) {
  const call = (fn, args) => rpc(fn, { p_token: token, ...args });
  const first = await call("crew_state");
  const id = first.me.id;
  const names = {};
  const cache = {}; // account id → Map(session id → session)

  /** Bodies for the given session ids, fetching only ones not seen before. */
  async function sessionsFor(account, ids) {
    const have = (cache[account] ??= new Map());
    for (const k of [...have.keys()]) if (!ids.includes(k)) have.delete(k);
    const missing = ids.filter((k) => !have.has(k));
    for (let i = 0; i < missing.length; i += 100) {
      const rows = await call("crew_get_sessions", { p_account: account, p_ids: missing.slice(i, i + 100) });
      for (const r of rows ?? []) if (r && typeof r.id === "string") have.set(r.id, r);
    }
    return [...have.values()];
  }
  const idsOf = (state, account) => (state.sessions.find((x) => x.account === account)?.ids ?? []).slice().sort();

  return {
    id,
    kind: "crew",
    username: first.me.username,
    async loadOwn() {
      const st = await call("crew_state");
      return { doc: st.athletes.find((a) => a.id === id)?.doc ?? null, sessions: await sessionsFor(id, idsOf(st, id)) };
    },
    saveDoc: (doc) => call("crew_save_doc", { p_doc: doc }),
    saveSession: (session) => call("crew_save_session", { p_session: session }),
    deleteSession: (sid) => call("crew_delete_session", { p_id: sid }),
    watch({ onAthletes, onSessions, onSignedOut }) {
      // Polling: plenty for a small crew, and it needs nothing beyond the database functions.
      const seen = {};
      let busy = false;
      const poll = async () => {
        if (busy) return;
        busy = true;
        try {
          const st = await call("crew_state");
          const map = {};
          for (const a of st.athletes) {
            names[a.id] = a.username;
            if (a.doc) map[a.id] = a.doc;
          }
          onAthletes(map);
          for (const a of st.athletes) {
            const ids = idsOf(st, a.id);
            const key = ids.join(",");
            if (seen[a.id] === key) continue;
            const list = await sessionsFor(a.id, ids);
            seen[a.id] = key;
            onSessions(a.id, list);
          }
        } catch (e) {
          if (e.code === "invalid_token") onSignedOut?.();
        } finally {
          busy = false;
        }
      };
      poll();
      setInterval(() => { if (document.visibilityState === "visible") poll(); }, 15000);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
    },
    async profiles(ids) {
      return Object.fromEntries(ids.map((i) => [i, { name: names[i] || "", avatarUrl: "", color: "" }]));
    },
    isWriteRefusal: (e) => e?.code === "invalid_token",
    logout: () => call("crew_logout").catch(() => {}),
  };
}
