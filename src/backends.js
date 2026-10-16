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

/** Supabase client and the current sign-in, for the hosted web version. Null when not configured. */
export async function supabaseAuth(config) {
  if (!config.url || !config.key || typeof window.supabase?.createClient !== "function") return null;
  const client = window.supabase.createClient(config.url, config.key);
  const { data } = await client.auth.getSession();
  return { client, user: data.session?.user ?? null };
}

const check = ({ data, error }) => {
  if (error) throw error;
  return data;
};

/** Supabase tables (see supabase/schema.sql). `member` is false when the Google account isn't on the member list. */
export async function supabaseBackend({ client, user }) {
  const member = check(await client.rpc("is_member"));
  const id = user.id;
  const meta = user.user_metadata ?? {};
  const names = {};
  const backend = {
    id,
    kind: "supabase",
    member: member === true,
    email: user.email ?? "",
    async loadOwn() {
      const [a, s] = await Promise.all([
        client.from("athletes").select("doc").eq("user_id", id).maybeSingle(),
        client.from("sessions").select("data").eq("user_id", id),
      ]);
      return { doc: check(a)?.doc ?? null, sessions: check(s).map((r) => r.data) };
    },
    saveDoc: async (doc) => check(await client.from("athletes").upsert({
      user_id: id, doc, name: String(meta.full_name || meta.name || "").slice(0, 80),
      avatar_url: String(meta.avatar_url || meta.picture || "").slice(0, 500), updated_at: new Date().toISOString(),
    })),
    saveSession: async (session) => check(await client.from("sessions").upsert({ user_id: id, id: session.id, data: session })),
    deleteSession: async (sid) => check(await client.from("sessions").delete().eq("user_id", id).eq("id", sid)),
    watch({ onAthletes, onSessions }) {
      const loadAthletes = async () => {
        const rows = check(await client.from("athletes").select("user_id, doc, name, avatar_url"));
        const map = {};
        for (const r of rows) {
          map[r.user_id] = r.doc;
          names[r.user_id] = { name: r.name || "", avatarUrl: r.avatar_url || "" };
        }
        onAthletes(map);
      };
      const loadSessions = async (uid) => {
        const rows = check(await client.from("sessions").select("data").eq("user_id", uid));
        onSessions(uid, rows.map((r) => r.data));
      };
      const loadAllSessions = async () => {
        const rows = check(await client.from("sessions").select("user_id, data"));
        const byUser = {};
        for (const r of rows) (byUser[r.user_id] ??= []).push(r.data);
        for (const uid of Object.keys(names)) onSessions(uid, byUser[uid] ?? []);
      };
      // Coalesce bursts of change events into one reload per table/person.
      const timers = {};
      const later = (key, fn) => {
        clearTimeout(timers[key]);
        timers[key] = setTimeout(() => fn().catch(() => {}), 400);
      };
      client.channel("starkheben")
        .on("postgres_changes", { event: "*", schema: "public", table: "athletes" }, () => later("athletes", loadAthletes))
        .on("postgres_changes", { event: "*", schema: "public", table: "sessions" }, (p) => {
          const uid = p.new?.user_id ?? p.old?.user_id;
          if (uid) later(`s:${uid}`, () => loadSessions(uid));
        })
        .subscribe();
      loadAthletes().then(loadAllSessions).catch(() => {});
    },
    async profiles(ids) {
      return Object.fromEntries(ids.map((i) => [i, { name: names[i]?.name || "", avatarUrl: names[i]?.avatarUrl || "", color: "" }]));
    },
    // Postgres "insufficient privilege" (RLS refusal).
    isWriteRefusal: (e) => e?.code === "42501",
  };
  return backend;
}
