import {
  LIFTS, ASSISTANCE, VARIATIONS, MAIN_CHOICES, createState, startWorkout, finishWorkout, cycleSet, exerciseResult, targetsFor,
  warmupSets, migrate, validateSession, deloadLift, suggestDeload,
  moveItem, bestOneRepMax, liftSeries, manualDraft, addManualWorkout, deleteWorkout, makeBackup, readBackup,
  sessionLabel, addCustomWorkout, updateCustomWorkout, removeCustomWorkout, addToLibrary, removeFromLibrary, exerciseItem,
} from "./program.js";
import { PLATE_SIZES, MICRO_SIZE, barbellPlan, buddyPlan, nextLoadable } from "./plates.js";
import {
  WEEKDAY_NAMES, WEEK_ORDER, todayKey, toKey, fromKey, addDays, weekStart, occurrences, upcoming,
  streakWeeks, setSchedule, moveOccurrence, scheduleOn, daysPerWeek, historyKey,
} from "./schedule.js";
import { LEVELS, STANDARDS, estimateOneRepMax, strengthProgress } from "./standards.js";
import { splitState, assembleState, mergeOnConnect, stableStringify } from "./sync.js";
import { artifactBackend, crewRpc, crewBackend } from "./backends.js";
import { SUPABASE } from "./config.js";

const STORAGE_KEY = "starkheben5x5";
const app = document.getElementById("app");
const timerEl = document.getElementById("timer");

let state = load();
let view = "today";
const ui = {
  summary: null, // last finished session, shown once after finishing
  warmups: new Set(),
  chosenType: null, // overrides the planned workout on the Today screen
  calMonth: todayKey().slice(0, 7),
  calSelected: null,
  progressKey: "squat",
  editorType: "A",
  scheduleDraft: null,
  crewLift: "squat",
  loginMode: "signin",
  manual: null, // a past workout being filled in
  flash: "", // one-off message for the settings page
  crewOpen: null,
};
let timer = null; // { start }: the stopwatch since the last logged set

// ---------- persistence ----------

function load() {
  const today = todayKey();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const data = migrate(parsed, today);
      if (data) return { ...data, active: parsed.version === 2 && validateSession(parsed.active) ? parsed.active : null };
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return createState(today);
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

function save() {
  saveLocal();
  const { doc, sessions } = splitState(state);
  const changed = stableStringify(doc) !== sync.docJson || sessions.length !== sync.sessionIds.size;
  if (changed) sync.lastLocal = performance.now();
  pushCloud();
}

// ---------- server sync ----------
// The claude.ai page syncs through the artifact db. Everywhere else (GitHub Pages, the APK) the app
// syncs through Supabase once you sign in with a username and password; without an account, or
// with no server configured, data stays on the device.
// Each person has one athlete doc (everything but history) plus one doc per finished session.

let cloud = null; // a backend from backends.js once signed in
const rpc = crewRpc(SUPABASE); // null when no server is configured
const TOKEN_KEY = "starkheben5x5-token";
const crew = { athletes: {}, sessions: {}, profiles: {} };
const sync = { status: "local", writing: false, dirty: false, readOnly: false, docJson: null, sessionIds: new Set(), lastLocal: -Infinity, written: [] };
const LOCAL_ONLY_KEY = "starkheben5x5-local-only";

function setSync(status) {
  sync.status = status;
  const el = document.getElementById("sync");
  if (!el) return;
  const labels = { loading: "Connecting…", saving: "Saving…", synced: "Saved", error: "Not saved, retrying", readonly: "View only" };
  el.hidden = status === "local";
  el.textContent = labels[status] ?? "";
  el.dataset.status = status;
}

/** Writes changed documents, one write at a time; changes made meanwhile go out in the next pass. */
async function pushCloud() {
  if (!cloud || sync.readOnly) return;
  if (sync.writing) { sync.dirty = true; return; }
  sync.writing = true;
  setSync("saving");
  try {
    do {
      sync.dirty = false;
      const { doc, sessions } = splitState(state);
      const ids = new Set(sessions.map((h) => h.id));
      for (const h of sessions) {
        if (sync.sessionIds.has(h.id)) continue;
        await cloud.saveSession(h);
        sync.sessionIds.add(h.id);
      }
      for (const id of [...sync.sessionIds]) {
        if (ids.has(id)) continue;
        await cloud.deleteSession(id);
        sync.sessionIds.delete(id);
      }
      const json = stableStringify(doc);
      if (json !== sync.docJson) {
        await cloud.saveDoc(doc);
        sync.docJson = json;
        sync.written = [...sync.written.slice(-19), json]; // recognise late echoes of these writes
      }
    } while (sync.dirty);
    setSync("synced");
  } catch (e) {
    if (e?.code === "invalid_token") {
      signedOutElsewhere();
    } else if (cloud.isWriteRefusal(e)) {
      // Not allowed to write (e.g. shared as Viewer): keep working on this device.
      sync.readOnly = true;
      setSync("readonly");
    } else {
      setSync("error");
      setTimeout(pushCloud, 5000 + Math.random() * 3000);
    }
  } finally {
    sync.writing = false;
  }
}

async function startCloud() {
  cloud = await artifactBackend();
  if (!cloud) {
    if (!rpc || window.claude) return; // inside claude.ai only the artifact db is reachable
    const token = readToken();
    if (!token) {
      if (!localOnly()) showScreen("login");
      return;
    }
    try {
      cloud = await crewBackend(rpc, token);
    } catch (e) {
      if (e.code === "invalid_token") return signedOutElsewhere();
      setSync("error"); // offline: keep working on this device and try again shortly
      setTimeout(startCloud, 20000);
      return;
    }
  }
  document.querySelector('.tabs [data-view="crew"]').hidden = false;
  setSync("loading");
  try {
    const own = await cloud.loadOwn();
    const remote = own.doc ? assembleState(own.doc, own.sessions) : null;
    sync.sessionIds = new Set(own.sessions.map((h) => h?.id).filter((id) => typeof id === "string"));
    if (remote) sync.docJson = stableStringify(splitState(remote).doc);
    state = mergeOnConnect(state, remote);
    saveLocal();
    render();
    await pushCloud(); // uploads anything only this device had
  } catch {
    setSync("error");
  }
  cloud.watch({ onAthletes, onSessions, onSignedOut: signedOutElsewhere });
}

// Your own data coming back from the server. While you're editing (or just after), the newest copy is
// held and applied once you pause; copies matching something this device wrote are echoes and ignored.
const recentLocalChange = () => sync.writing || performance.now() - sync.lastLocal < 3000;
const pendingOwn = { doc: null, sessions: null, timer: null };

function deferOwn() {
  clearTimeout(pendingOwn.timer);
  pendingOwn.timer = setTimeout(() => {
    const { doc, sessions } = pendingOwn;
    pendingOwn.doc = pendingOwn.sessions = null;
    if (doc) applyOwnDoc(doc);
    if (sessions) applyOwnSessions(sessions);
  }, 3200);
}

function onAthletes(map) {
  crew.athletes = map;
  if (map[cloud.id] && applyOwnDoc(map[cloud.id])) return;
  if (view === "crew" && !isTyping()) render();
}

/** Returns true when it changed state (and rendered). */
function applyOwnDoc(doc) {
  const next = assembleState(doc, state.history);
  if (!next) return false;
  const json = stableStringify(splitState(next).doc);
  if (json === sync.docJson || sync.written.includes(json)) return false; // up to date, or an echo
  if (recentLocalChange()) {
    pendingOwn.doc = doc;
    deferOwn();
    return false;
  }
  sync.docJson = json;
  state = next;
  saveLocal();
  if (!isTyping()) render();
  return true;
}

function onSessions(uid, list) {
  if (uid !== cloud.id) {
    crew.sessions[uid] = list;
    if (view === "crew" && !isTyping()) render();
    return;
  }
  applyOwnSessions(list);
}

function applyOwnSessions(list) {
  const ids = new Set(list.map((h) => h?.id));
  if (ids.size === sync.sessionIds.size && [...ids].every((id) => sync.sessionIds.has(id))) return;
  if (recentLocalChange()) {
    pendingOwn.sessions = list;
    deferOwn();
    return;
  }
  const next = assembleState(splitState(state).doc, list);
  if (!next) return;
  sync.sessionIds = ids;
  state = next;
  saveLocal();
  if (!isTyping()) render();
}

function readToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/** The login stopped working (signed out on the server): ask to sign in again. */
function signedOutElsewhere() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
  cloud = null;
  setSync("local");
  showScreen("login");
}

function localOnly() {
  try { return localStorage.getItem(LOCAL_ONLY_KEY) === "1"; } catch { return false; }
}

/** Full-screen views without tabs: sign-in and the not-on-the-list notice. */
function showScreen(name) {
  view = name;
  render();
}

const isTyping = () => document.activeElement?.matches?.("input, textarea, select") ?? false;

// ---------- helpers ----------

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (w) => `${Number(w.toFixed(2))}`;
const kg = (w) => `${fmt(w)} kg`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const dayLabel = (key) => fromKey(key).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const isoDayLabel = (iso) => dayLabel(toKey(new Date(iso)));
const exName = (ex) => (ex.type === "main" ? LIFTS[ex.liftId].name : ex.name);
const newId = () => Math.random().toString(36).slice(2, 10);
const workouts = (n) => `${n} workout${n === 1 ? "" : "s"}`;

// ---------- plate drawing ----------
// Plates in their usual competition colours; height and thickness roughly to scale.
const PLATE_LOOK = {
  25: { h: 64, w: 15, fill: "#d6372b", text: "#ffffff" },
  20: { h: 64, w: 13, fill: "#2f6fdf", text: "#ffffff" },
  15: { h: 56, w: 12, fill: "#e8b100", text: "#1a1a1a" },
  10: { h: 48, w: 11, fill: "#1f8a4c", text: "#ffffff" },
  5: { h: 38, w: 10, fill: "#f2f2f2", text: "#1a1a1a" },
  2.5: { h: 30, w: 9, fill: "#d6372b", text: "#ffffff" },
  2: { h: 28, w: 9, fill: "#2f6fdf", text: "#ffffff" },
  1.25: { h: 26, w: 9, fill: "#b8bec9", text: "#1a1a1a" },
  1: { h: 24, w: 8, fill: "#b8bec9", text: "#1a1a1a" },
  0.5: { h: 20, w: 8, fill: "#7d8491", text: "#ffffff" },
};

/** The right half of a barbell with its plates, inner to outer. Plates from `swapFrom` on are drawn dashed. */
function barbellSvg(plates, swapFrom = plates.length) {
  const H = 72, mid = H / 2;
  let x = 44;
  const parts = plates.map((p, i) => {
    const look = PLATE_LOOK[p] ?? { h: 22, w: 8, fill: "#b8bec9", text: "#1a1a1a" };
    const cx = x + look.w / 2;
    const el = `<g class="plate${i >= swapFrom ? " swap" : ""}"><rect x="${x}" y="${mid - look.h / 2}" width="${look.w}" height="${look.h}" rx="2" style="fill:${look.fill}"/>`
      + `<text x="${cx}" y="${mid}" transform="rotate(-90 ${cx} ${mid})" style="fill:${look.text}">${fmt(p)}</text></g>`;
    x += look.w + 2;
    return el;
  }).join("");
  const end = Math.max(x + 16, 110);
  const label = plates.length ? `Per side: ${plates.map(fmt).join(", ")} kg` : "Empty bar";
  const scale = 1.4; // drawn larger than its grid so the plate labels stay readable
  return `<svg class="barbell" viewBox="0 0 ${end} ${H}" width="${end * scale}" height="${H * scale}" role="img" aria-label="${esc(label)}">
    <rect class="shaft" x="0" y="${mid - 3}" width="36" height="6" rx="2"/>
    <rect class="sleeve" x="40" y="${mid - 5}" width="${end - 42}" height="10" rx="3"/>
    <rect class="collar" x="34" y="${mid - 13}" width="8" height="26" rx="2"/>
    ${parts}
  </svg>`;
}

const plateList = (plates) => plates.map(fmt).join(" + ");

/** What to load for a weight; with a buddy, both loads with the plates that change at the outer end. */
function plateBlock(weight, buddyWeight = null) {
  const s = state.settings;
  if (buddyWeight === null) {
    const { plates, remainder } = barbellPlan(weight, s);
    const note = remainder > 0
      ? `<p class="small warn">${kg(weight)} can't be made with your plates. Loaded: ${kg(weight - remainder * 2)}.</p>`
      : plates.length ? "" : `<p class="small muted">Empty bar (${kg(s.bar)})</p>`;
    return `<div class="loading">${barbellSvg(plates)}${note}</div>`;
  }
  const p = buddyPlan(weight, buddyWeight, s);
  const row = (who, w, outer) => `<div class="load-row"><span class="small muted">${who} · ${kg(w)}</span>${barbellSvg([...p.shared, ...outer], p.shared.length)}</div>`;
  const steps = [p.mine.length ? `take off ${plateList(p.mine)}` : "", p.buddy.length ? `put on ${plateList(p.buddy)}` : ""].filter(Boolean);
  const how = steps.length
    ? `Switching from you to your buddy: ${steps.join(" and ")} per side (dashed). Back again: the reverse.`
    : "Same plates for both of you.";
  return `<div class="loading">${row("You", p.myWeight, p.mine)}${row("Buddy", p.buddyWeight, p.buddy)}<p class="small">${esc(how)}</p></div>`;
}

/** The weight of the next set still to do (the last set's weight once all are logged). */
function currentWeight(ex) {
  const targets = targetsFor(ex, state.settings);
  const j = ex.log.findIndex((r) => r === null);
  return targets[j === -1 ? targets.length - 1 : j]?.weight ?? ex.weight;
}

const isBarbell = (ex) => ex.type === "main" || ex.barbell === true;

function itemSummary(item) {
  if (item.type === "main") {
    const l = LIFTS[item.liftId];
    if (item.scheme === "topBackoff") {
      const b = state.settings.topBackoff;
      return `1×${l.reps} top + ${b.backoffSets}×${b.backoffReps} at −${b.backoffPercent}%`;
    }
    return `${l.sets}×${l.reps}`;
  }
  return `${item.sets}×${item.reps}${item.unit === "sec" ? " s" : ""}`;
}

const FLAME = `<svg class="flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.6 3.2-1.4 5-2.8 6.7C7.8 10.4 7 12 7 14a5 5 0 0 0 10 0c0-2.3-1-4-2-5.2.1 1.8-.6 3-1.8 3.6.6-3.6-.2-7.4-1.2-10.4z"/></svg>`;

// ---------- set stopwatch ----------
// Counts up from the last logged set. No alerts: you decide when to go again.

function startTimer() {
  timer = { start: Date.now() };
  tickTimer();
}

function stopTimer() {
  timer = null;
  timerEl.hidden = true;
}

function tickTimer() {
  if (!timer) return;
  timerEl.hidden = false;
  timerEl.innerHTML = `
    <div><div class="small">Since your last set</div><div class="clock">${mmss((Date.now() - timer.start) / 1000)}</div></div>
    <button class="btn" data-action="stop-timer">Hide</button>`;
}
setInterval(tickTimer, 1000);

// ---------- rendering ----------

function render() {
  for (const b of document.querySelectorAll(".tabs button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const views = { today: todayView, calendar: calendarView, progress: progressView, crew: crewView, program: programView, settings: settingsView,
    login: loginView, manual: manualView };
  document.querySelector(".tabs").hidden = view === "login";
  app.innerHTML = views[view]();
  if (view === "crew") {
    const members = crewMembers();
    document.querySelectorAll(".member-name").forEach((el, i) => { el.textContent = members[i] ? memberName(members[i]) : ""; });
  }
}

function streakBadge() {
  const weeks = streakWeeks(state, todayKey());
  const label = weeks ? `${weeks}-week streak` : "No streak yet";
  return `<span class="streak ${weeks ? "on" : ""}" title="Weeks in a row with every scheduled workout done">${FLAME}${esc(label)}</span>`;
}

/** Deload choice for a lift that missed reps last time. Keeping the weight needs no action. */
function deloadControl(liftId) {
  const lift = state.lifts[liftId];
  if (!lift.failures) return "";
  const target = deloadLift(lift, state.settings).weight;
  if (target >= lift.weight) return ""; // already at the empty bar: nothing to take off
  const suggest = suggestDeload(lift, state.settings);
  return `<div class="deload ${suggest ? "suggest" : ""}">
    <span class="small">Missed ${lift.failures}× in a row. ${suggest ? "A deload is recommended." : "Try the same weight again, or deload."}</span>
    <button class="btn small ${suggest ? "primary" : ""}" data-action="deload" data-lift="${esc(liftId)}">Deload to ${kg(target)}</button>
  </div>`;
}

function todayView() {
  if (state.active) return activeView(state.active);
  const today = todayKey();
  const plan = upcoming(state, today, addDays(today, 60));
  const plannedToday = plan[0]?.date === today ? plan[0] : null;
  const type = ui.chosenType ?? plan[0]?.type ?? state.nextWorkout;
  const other = type === "A" ? "B" : "A";
  const heading = plannedToday
    ? `Today: Workout ${type}`
    : ui.chosenType ? `Workout ${type}` : `Rest day`;
  const nextLine = !plannedToday && plan[0]
    ? `<p class="muted">Next: Workout ${esc(plan[0].type)} on ${esc(dayLabel(plan[0].date))}. You can train now anyway.</p>` : "";
  // A lift that just failed shows its deload choice in the summary card instead.
  const inSummary = new Set(ui.summary?.exercises.filter((e) => e.change === "repeat").map((e) => e.liftId) ?? []);
  const rows = state.templates[type].map((item) => {
    if (item.type === "assist") {
      return `<div class="line"><span>${esc(item.name)} <span class="muted small">${esc(itemSummary(item))}</span></span>
        <span class="muted">${item.weight ? kg(item.weight) : "bodyweight"}</span></div>`;
    }
    return `<div class="line"><span>${esc(LIFTS[item.liftId].name)} <span class="muted small">${esc(itemSummary(item))}</span></span>
      <strong>${kg(state.lifts[item.liftId].weight)}</strong></div>${inSummary.has(item.liftId) ? "" : deloadControl(item.liftId)}`;
  }).join("");
  return `<div class="row between head"><h2>${esc(dayLabel(today))}</h2>${streakBadge()}</div>
    ${ui.summary ? summaryCard(ui.summary) : ""}
    <h2>${esc(heading)}</h2>
    ${nextLine}
    <div class="card">${rows}</div>
    <button class="btn primary block" data-action="start" data-type="${type}">Start workout ${type}</button>
    <div class="center"><button class="btn link" data-action="choose" data-type="${other}">Do workout ${other} instead</button></div>
    ${state.workouts.length ? `<h2>Your workouts</h2><div class="card">${state.workouts.map((w) => `<div class="line">
      <span>${esc(w.name)} <span class="muted small">${w.items.length} exercise${w.items.length === 1 ? "" : "s"}</span></span>
      <button class="btn small" data-action="start" data-workout="${esc(w.id)}" ${w.items.length ? "" : "disabled"}>Start</button></div>`).join("")}</div>` : ""}`;
}

function summaryCard(s) {
  const label = { increase: "+ next time", repeat: "missed", none: "skipped" };
  const rows = s.exercises.filter((ex) => ex.type === "main").map((ex) => `
    <div class="line">
      <span>${esc(LIFTS[ex.liftId].name)}</span>
      <span>${fmt(ex.weight)} → <strong>${kg(state.lifts[ex.liftId].weight)}</strong> <span class="tag ${esc(ex.change)}">${esc(label[ex.change])}</span></span>
    </div>${ex.change === "repeat" ? deloadControl(ex.liftId) : ""}`).join("")
    + (s.custom ? s.exercises.map((ex) => `<div class="line"><span>${esc(ex.name)}</span>
      <span class="muted nowrap">${ex.weight ? kg(ex.weight) + " · " : ""}${ex.log.map((r) => (r === null ? "–" : r)).join("/")}</span></div>`).join("") : "");
  return `<div class="card"><div class="row between"><strong>${esc(sessionLabel(s))} done</strong>
    <button class="btn link" data-action="dismiss-summary">Close</button></div>${rows}</div>`;
}

function setCircles(ex, i, action = "set") {
  const targets = targetsFor(ex, state.settings);
  const unit = ex.type === "assist" ? ex.unit : "reps";
  const groups = [];
  targets.forEach((t, j) => {
    const r = ex.log[j];
    const cls = r === null ? "" : r >= t.reps ? "done" : "miss";
    const label = unit === "sec" ? (r === null ? "" : `${r}s`) : r === null ? "" : r;
    const aria = `${exName(ex)} set ${j + 1}${t.top ? " (top set)" : ""}: ${r === null ? "not done" : `${r} ${unit === "sec" ? "seconds" : "reps"}`}`;
    groups.push(`<button class="set ${cls} ${t.top ? "top" : ""}" data-action="${action}" data-ex="${i}" data-set="${j}" aria-label="${esc(aria)}">${esc(label)}</button>`);
  });
  if (ex.type === "main" && ex.scheme === "topBackoff") {
    const back = targets[1];
    return `<div class="sets"><div class="set-group"><span class="set-label">Top ${targets[0].reps} @ ${kg(targets[0].weight)}</span><div class="sets-row">${groups[0]}</div></div>
      ${back ? `<div class="set-group"><span class="set-label">Back-off ${targets.length - 1}×${back.reps} @ ${kg(back.weight)}</span><div class="sets-row">${groups.slice(1).join("")}</div></div>` : ""}</div>`;
  }
  return `<div class="sets"><div class="sets-row">${groups.join("")}</div></div>`;
}

function activeView(session) {
  const buddy = session.buddy?.on ? session.buddy : null;
  const buddyWeight = (ex, i) => (buddy && isBarbell(ex) ? buddy.weights?.[i] ?? currentWeight(ex) : null);
  const buddyField = (ex, i) => (buddy && isBarbell(ex)
    ? `<label class="inline small muted buddy-field">Buddy's weight
        <input type="number" inputmode="decimal" min="0" step="0.5" id="buddy-weight-${i}" data-input="buddy-weight" data-ex="${i}" value="${fmt(buddyWeight(ex, i))}"> kg</label>` : "");
  const cards = session.exercises.map((ex, i) => {
    if (ex.type === "assist") {
      return `<div class="card">
        <div class="row between wrap">
          <div class="lift-name">${esc(ex.name)} <span class="muted small">${esc(itemSummary(ex))}</span></div>
          <label class="inline small muted">Weight
            <input type="number" inputmode="decimal" min="0" step="0.5" id="assist-weight-${i}" data-input="assist-weight" data-ex="${i}" value="${fmt(ex.weight)}"> kg</label>
        </div>
        ${ex.barbell ? `${buddyField(ex, i)}${plateBlock(ex.weight, buddyWeight(ex, i))}` : ""}
        ${setCircles(ex, i)}
      </div>`;
    }
    const lift = LIFTS[ex.liftId];
    const warm = ui.warmups.has(i)
      ? `<ul class="warmups">${warmupSets(ex.liftId, ex.weight, state.settings).map((w) =>
          `<li>${w.reps} × ${kg(w.weight)} <span class="muted">· ${esc(plateList(barbellPlan(w.weight, state.settings).plates) || "bar only")}</span></li>`).join("") || "<li>No warm-up needed</li>"}</ul>`
      : "";
    return `<div class="card">
      <div class="row between">
        <div>
          <div class="lift-name">${esc(lift.name)} <span class="muted small">${esc(itemSummary(ex))}</span></div>
          <div class="weight">${fmt(ex.weight)} <small>kg</small></div>
        </div>
        <div class="row">
          <button class="btn icon" data-action="weight" data-ex="${i}" data-dir="-1" aria-label="Lower ${esc(lift.name)} weight">−</button>
          <button class="btn icon" data-action="weight" data-ex="${i}" data-dir="1" aria-label="Raise ${esc(lift.name)} weight">+</button>
        </div>
      </div>
      ${buddyField(ex, i)}
      ${plateBlock(currentWeight(ex), buddyWeight(ex, i))}
      ${setCircles(ex, i)}
      <div class="row between" style="margin-top:6px">
        <span class="set-label">Tap a set when done, tap again to lower reps</span>
        <button class="btn link small" data-action="warmups" data-ex="${i}">${ui.warmups.has(i) ? "Hide" : "Warm-up"}</button>
      </div>
      ${warm}
    </div>`;
  }).join("");
  const anyBarbell = session.exercises.some(isBarbell);
  return `<h2>${esc(sessionLabel(session))} <span class="muted small">${esc(isoDayLabel(session.date))}</span></h2>
    ${anyBarbell ? `<label class="card check buddy-toggle"><input type="checkbox" id="buddy-on" data-input="buddy-on" ${buddy ? "checked" : ""}>
      <span><strong>Training with a buddy</strong><br><span class="small muted">Enter their weights to load the bar with the fewest plate switches.</span></span></label>` : ""}
    ${cards}
    <button class="btn primary block" data-action="finish">Finish workout</button>
    <div class="center"><button class="btn link" data-action="cancel">Discard workout</button></div>`;
}

// ---------- adding a past workout ----------

function manualView() {
  const m = ui.manual;
  const day = toKey(new Date(m.date));
  const cards = m.exercises.map((ex, i) => `<div class="card">
    <div class="row between wrap">
      <div class="lift-name">${esc(exName(ex))} <span class="muted small">${esc(itemSummary(ex))}</span></div>
      <label class="inline small muted">Weight
        <input type="number" inputmode="decimal" min="0" step="0.5" id="manual-weight-${i}" data-input="manual-weight" data-ex="${i}" value="${fmt(ex.weight)}"> kg</label>
    </div>
    ${setCircles(ex, i, "manual-set")}
  </div>`).join("");
  return `<h2>Add a workout <span class="muted small">${esc(dayLabel(day))}</span></h2>
    <div class="chips" role="group" aria-label="Workout">
      <button class="chip" data-action="manual-type" data-type="A" aria-pressed="${!m.custom && m.type === "A"}">Workout A</button>
      <button class="chip" data-action="manual-type" data-type="B" aria-pressed="${!m.custom && m.type === "B"}">Workout B</button>
      ${state.workouts.filter((w) => w.items.length).map((w) => `<button class="chip" data-action="manual-type" data-workout="${esc(w.id)}" aria-pressed="${m.custom?.id === w.id}">${esc(w.name)}</button>`).join("")}
    </div>
    <p class="small muted">Sets start as done. Tap one to lower its reps, or tap through to clear it. Your current working weights stay as they are.</p>
    ${cards}
    <button class="btn primary block" data-action="manual-save">Save workout</button>
    <div class="center"><button class="btn link" data-action="manual-cancel">Cancel</button></div>`;
}

// ---------- calendar ----------

/** Calendar letter: A or B, or the first letter of your own workout's name. */
const markLetter = (h) => (h.custom ? h.custom.name.trim().charAt(0).toUpperCase() || "+" : h.type);

function calendarView() {
  const today = todayKey();
  const [y, m] = ui.calMonth.split("-").map(Number);
  const first = `${ui.calMonth}-01`;
  const gridStart = weekStart(first);
  const lastOfMonth = toKey(new Date(y, m, 0));
  const gridEnd = addDays(weekStart(lastOfMonth), 6);

  const planned = {};
  for (const o of occurrences(state, gridStart, gridEnd)) (planned[o.date] ??= []).push(o);
  const types = {};
  if (gridEnd >= today) for (const o of upcoming(state, today, gridEnd)) types[`${o.original}>${o.date}`] = o.type;
  const doneOn = {};
  for (const h of state.history) (doneOn[historyKey(h)] ??= []).push(h);

  const cells = [];
  for (let k = gridStart; k <= gridEnd; k = addDays(k, 1)) {
    const inMonth = k.startsWith(ui.calMonth);
    const done = doneOn[k] ?? [];
    const plans = planned[k] ?? [];
    let marks = done.map((h) => `<span class="mark done">${esc(markLetter(h))}</span>`).join("");
    const open = k < today ? plans.slice(done.length) : k === today ? plans.filter((o) => types[`${o.original}>${o.date}`]) : plans;
    marks += open.map((o) => {
      if (k < today) return `<span class="mark missed" title="Missed">×</span>`;
      const t = types[`${o.original}>${o.date}`] ?? "";
      return `<span class="mark planned ${o.moved ? "moved" : ""}">${esc(t)}</span>`;
    }).join("");
    const cls = ["day", inMonth ? "" : "out", k === today ? "today" : "", ui.calSelected === k ? "selected" : ""].join(" ");
    cells.push(`<button class="${cls}" data-action="cal-day" data-date="${k}" aria-label="${esc(dayLabel(k))}">
      <span class="num">${Number(k.slice(8))}</span><span class="marks">${marks}</span></button>`);
  }
  const monthName = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const heads = WEEK_ORDER.map((wd) => `<span class="dow">${WEEKDAY_NAMES[wd].slice(0, 2)}</span>`).join("");
  return `<div class="row between head"><h2>Calendar</h2>${streakBadge()}</div>
    <div class="card cal">
      <div class="row between">
        <button class="btn icon" data-action="cal-month" data-delta="-1" aria-label="Previous month">‹</button>
        <strong>${esc(monthName)}</strong>
        <button class="btn icon" data-action="cal-month" data-delta="1" aria-label="Next month">›</button>
      </div>
      <div class="grid">${heads}${cells.join("")}</div>
      <div class="legend small muted">
        <span><span class="mark done">A</span> done</span>
        <span><span class="mark planned">B</span> planned</span>
        <span><span class="mark planned moved">A</span> moved</span>
        <span><span class="mark missed">×</span> missed</span>
      </div>
    </div>
    ${ui.calSelected ? dayDetail(ui.calSelected, today, types, doneOn) : `<p class="muted small">Tap a day to see or move its workout.</p>`}`;
}

function dayDetail(k, today, types, doneOn) {
  const done = doneOn[k] ?? [];
  const plans = occurrences(state, k, k);
  const doneRows = done.map((h) => `<div class="plan">
    <div class="line"><span><span class="mark done">${esc(markLetter(h))}</span> ${esc(sessionLabel(h))}${h.manual ? ` <span class="tag none">added</span>` : ""}</span>
      <button class="btn small" data-action="delete-workout" data-id="${esc(h.id)}">Delete</button></div>
    ${h.exercises.map((e) => `<div class="line small"><span>${esc(exName(e))}</span>
      <span class="muted nowrap">${kg(e.weight)} · ${e.log.map((r) => (r === null ? "–" : r)).join("/")}</span></div>`).join("")}
  </div>`).join("");
  const planRows = plans.map((o) => {
    const t = types[`${o.original}>${o.date}`];
    // Past: only unmatched sessions are missed. Today/future: sessions without a type were already trained.
    if (k < today ? done.length : !t) return "";
    const status = k < today ? "Missed" : `Workout ${t}`;
    const moved = o.moved ? `<div class="small muted">Moved from ${esc(dayLabel(o.original))}</div>` : "";
    return `<div class="plan">
      <div><strong>${esc(status)}</strong>${moved}</div>
      <div class="row wrap">
        <label class="inline small">Move to <input type="date" id="move-${o.original}" data-original="${o.original}" min="${today}" value="${o.date < today ? today : o.date}"></label>
        <button class="btn small" data-action="move" data-original="${o.original}">Move</button>
        ${o.moved ? `<button class="btn small" data-action="unmove" data-original="${o.original}">Put back</button>` : ""}
      </div>
    </div>`;
  }).join("");
  const body = doneRows + planRows || `<p class="muted small">Nothing planned. Your weekly schedule is set in Program.</p>`;
  const add = k <= today
    ? `<button class="btn block add-past" data-action="manual-start" data-date="${k}">+ Add a workout on this day</button>` : "";
  return `<div class="card"><strong>${esc(dayLabel(k))}</strong>${body}${add}</div>`;
}

// ---------- progress ----------

function niceStep(range) {
  for (const s of [0.5, 1, 2.5, 5, 10, 20, 25, 50, 100]) if (range / s <= 5) return s;
  return 200;
}

/** Line chart of weight over time. `series`: [{ label, color, points: [{date, weight}] }]; one series gets an area fill and end label. */
function chartSvg(series, title) {
  const drawn = series.filter((sr) => sr.points.length);
  const all = drawn.flatMap((sr) => sr.points);
  if (!drawn.some((sr) => sr.points.length >= 2)) return `<p class="muted small">Log at least two sessions to see a graph.</p>`;
  const single = drawn.length === 1;
  const W = 340, H = 190, L = 40, R = 14, T = 14, B = 26;
  const ws = all.map((p) => p.weight);
  const ts = all.map((p) => new Date(p.date).getTime());
  const step = niceStep(Math.max(...ws) - Math.min(...ws) || 5);
  const lo = Math.floor(Math.min(...ws) / step) * step;
  const hi = Math.max(lo + step, Math.ceil(Math.max(...ws) / step) * step);
  const t0 = Math.min(...ts), tMax = Math.max(...ts), t1 = tMax === t0 ? t0 + 1 : tMax;
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (w) => T + (1 - (w - lo) / (hi - lo)) * (H - T - B);
  const grid = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const marks = drawn.map((sr) => {
    const pts = sr.points.map((p) => [x(new Date(p.date).getTime()), y(p.weight)]);
    const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
    const style = `style="--series:${sr.color}"`;
    const area = single ? `<path class="area" ${style} d="${d} L${pts.at(-1)[0].toFixed(1)},${H - B} L${pts[0][0].toFixed(1)},${H - B} Z"/>` : "";
    const dots = pts.map(([px, py], i) => `<circle class="dot" ${style} cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${i === pts.length - 1 ? 4.5 : 2.5}"/>`).join("");
    return `${area}<path class="line" ${style} d="${d}"/>${dots}`;
  }).join("");
  const short = (t) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  let endLabel = "";
  if (single) {
    const last = drawn[0].points.at(-1);
    endLabel = `<text class="value" x="${Math.min(x(new Date(last.date).getTime()), W - R - 2)}" y="${y(last.weight) - 10}" text-anchor="end">${kg(last.weight)}</text>`;
  }
  const summary = drawn.map((sr) => `${sr.label} ${kg(sr.points[0].weight)} to ${kg(sr.points.at(-1).weight)}`).join("; ");
  const legend = single ? "" : `<div class="legend small">${drawn.map((sr) =>
    `<span><span class="swatch" style="--series:${sr.color}"></span>${esc(sr.label)} · ${kg(sr.points.at(-1).weight)}</span>`).join("")}</div>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${esc(summary)}">
    ${grid.join("")}${marks}${endLabel}
    <text class="axis" x="${L}" y="${H - 6}">${esc(short(t0))}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(short(tMax))}</text>
  </svg>${legend}`;
}

function liftChips(keys, selected, action) {
  const label = (k) => LIFTS[k]?.name ?? (Object.values(LIFTS).some((l) => l.name === k) ? `${k} (own workouts)` : k);
  return keys.map((k) => `<button class="chip" data-action="${action}" data-key="${esc(k)}" aria-pressed="${k === selected}">${esc(label(k))}</button>`).join("");
}

function progressView() {
  const assistNames = [...new Set(state.history.flatMap((h) => h.exercises.filter((e) => e.type === "assist" && e.weight > 0).map((e) => e.name)))];
  const keys = [...Object.keys(LIFTS), ...assistNames];
  if (!keys.includes(ui.progressKey)) ui.progressKey = "squat";
  const label = LIFTS[ui.progressKey]?.name ?? ui.progressKey;
  const points = liftSeries(state.history, ui.progressKey);
  const stats = points.length
    ? `<div class="stats">
        <div><span class="small muted">Start</span><strong>${kg(points[0].weight)}</strong></div>
        <div><span class="small muted">Latest</span><strong>${kg(points.at(-1).weight)}</strong></div>
        <div><span class="small muted">Gained</span><strong>${points.at(-1).weight - points[0].weight >= 0 ? "+" : ""}${kg(points.at(-1).weight - points[0].weight)}</strong></div>
        <div><span class="small muted">Sessions</span><strong>${points.length}</strong></div>
      </div>` : "";
  return `<div class="row between head"><h2>Progress</h2>${streakBadge()}</div>
    <div class="chips" role="group" aria-label="Lift">${liftChips(keys, ui.progressKey, "progress-key")}</div>
    <div class="card">${chartSvg([{ label, color: "var(--accent)", points }], label)}${stats}</div>
    ${standardsSection()}`;
}

function standardsSection() {
  const p = state.profile;
  if (!p.bodyweight) {
    return `<h2>Strength standards</h2>
      <div class="card">
        <p class="small">Enter your bodyweight to see how close each lift is to the next strength milestone.</p>
        ${profileFields()}
      </div>`;
  }
  return `<h2>Strength standards</h2>
    <div class="card">
      <p class="small muted">${kg(p.bodyweight)} · ${p.sex === "male" ? "men's" : "women's"} standards. Your estimated 1-rep max is compared with rough bodyweight multiples for Beginner → Novice → Intermediate → Advanced → Elite.</p>
      ${standardsRows(state)}
      <details class="small"><summary>Edit bodyweight</summary>${profileFields()}</details>
    </div>`;
}

/** Strength-standard rows for anyone's state (needs a bodyweight). */
function standardsRows(s) {
  const p = s.profile;
  const rows = Object.keys(LIFTS).map((id) => {
    const best = bestOneRepMax(s.history, id);
    const e1rm = best || estimateOneRepMax(s.lifts[id].weight, LIFTS[id].reps);
    const sp = strengthProgress(e1rm, p.bodyweight, p.sex, id);
    const levels = STANDARDS[p.sex][id];
    const nextText = sp.next
      ? `${Math.floor(sp.percent)}% to ${esc(sp.next.name)} · ${kg(Math.round(sp.next.weight * 2) / 2)}`
      : "Elite reached";
    const ticks = levels.map((m, i) => `<span class="tick ${i <= sp.level ? "hit" : ""}" title="${esc(LEVELS[i])}: ${fmt(m)}× BW"></span>`).join("");
    return `<div class="std">
      <div class="line"><strong>${esc(LIFTS[id].name)}</strong><span class="small muted nowrap">e1RM ${kg(Math.round(e1rm * 2) / 2)}${best ? "" : "*"} · ${fmt(Math.round(sp.ratio * 100) / 100)}× BW</span></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(sp.percent)}" aria-label="${esc(LIFTS[id].name)} progress to next milestone"><span style="width:${sp.percent.toFixed(1)}%"></span></div>
      <div class="line small"><span class="level">${esc(sp.levelName ?? "Below Beginner")}</span><span class="muted nowrap">${nextText}</span></div>
      <div class="ticks">${ticks}</div>
    </div>`;
  }).join("");
  const note = Object.keys(LIFTS).some((id) => !bestOneRepMax(s.history, id))
    ? `<p class="small muted">* Estimated from the working weight until a session is logged.</p>` : "";
  return rows + note;
}

// ---------- crew (shared web version only) ----------

const CREW_COLORS = ["#2f6fdf", "#1f8a4c", "#9b51e0", "#d97706", "#0e9aa7"];
const safeColor = (c) => (typeof c === "string" && /^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\([\d\s.,%]+\))$/.test(c) ? c : null);

/** Everyone with a readable athlete document, you first. */
function crewMembers() {
  if (!cloud) return [];
  const members = [{ id: cloud.id, state, me: true }];
  for (const [aid, doc] of Object.entries(crew.athletes)) {
    if (aid === cloud.id) continue;
    const s = assembleState(doc, crew.sessions[aid] ?? []);
    if (s) members.push({ id: aid, state: s, me: false });
  }
  return members;
}

const memberName = (m) => m.state.profile.nickname || crew.profiles[m.id]?.name || (m.me ? "You" : "Lifter");
const memberColor = (m, i) => (m.me ? "var(--accent)" : safeColor(crew.profiles[m.id]?.color) ?? CREW_COLORS[i % CREW_COLORS.length]);

function crewView() {
  if (!cloud) {
    return `<h2>Crew</h2><div class="card"><p>Sign in to share your training with your crew. Right now your data stays on this device only.</p>
      ${rpc && !window.claude ? `<button class="btn primary" data-action="sign-in">Sign in</button>` : ""}</div>`;
  }
  const members = crewMembers();
  refreshProfiles(members.map((m) => m.id));
  if (!Object.keys(LIFTS).includes(ui.crewLift)) ui.crewLift = "squat";
  const series = members.map((m, i) => ({
    label: `${memberName(m)}${m.me ? " (you)" : ""}`,
    color: memberColor(m, i),
    points: liftSeries(m.state.history, ui.crewLift),
  }));
  const alone = members.length < 2
    ? `<div class="card"><p class="small">Nobody else has signed in yet. ${cloud.kind === "crew"
      ? "Send your training partner the link to this page. They create their own account on the sign-in screen."
      : "Share this page with your training partner as an <strong>Editor</strong> (Share menu → invite by email)."} Once they've opened it, they show up here.</p></div>` : "";
  return `<div class="row between head"><h2>Crew</h2></div>
    ${alone}
    <div class="chips" role="group" aria-label="Lift">${liftChips(Object.keys(LIFTS), ui.crewLift, "crew-lift")}</div>
    <div class="card">${chartSvg(series, `${LIFTS[ui.crewLift].name} working weight`)}</div>
    ${members.map((m, i) => memberCard(m, i)).join("")}`;
}

function memberCard(m, i) {
  const s = m.state;
  const today = todayKey();
  const weeks = streakWeeks(s, today);
  const last = s.history[0];
  const next = upcoming(s, today, addDays(today, 30))[0];
  const p = crew.profiles[m.id];
  const avatar = p?.avatarUrl ? `<img class="avatar" src="${esc(p.avatarUrl)}" alt="">` : `<span class="avatar" style="--series:${memberColor(m, i)}"></span>`;
  const weights = Object.keys(LIFTS).map((id) => `<div class="line">
      <span>${esc(LIFTS[id].name)}${s.lifts[id].failures ? ` <span class="tag repeat">${s.lifts[id].failures}× missed</span>` : ""}</span>
      <strong>${kg(s.lifts[id].weight)}</strong></div>`).join("");
  const open = ui.crewOpen === m.id;
  const details = open
    ? (s.profile.bodyweight
      ? `<h3>Strength standards · ${kg(s.profile.bodyweight)}</h3>${standardsRows(s)}`
      : `<p class="small muted">${m.me ? "Add your" : "No"} bodyweight${m.me ? " on the Progress tab" : " entered yet"}, so no strength standards.</p>`)
    : "";
  return `<div class="card member">
    <div class="row between">
      <div class="row">${avatar}<div><strong class="member-name"></strong>${m.me ? ` <span class="muted small">you</span>` : ""}
        <div class="small muted">${last ? `Last: ${esc(isoDayLabel(last.date))} · ${esc(sessionLabel(last))}` : "No workouts yet"}${next ? ` · Next: ${esc(dayLabel(next.date))}` : ""}</div></div></div>
      <span class="streak ${weeks ? "on" : ""}">${FLAME}${weeks}</span>
    </div>
    <h3>Working weights</h3>
    ${weights}
    <div class="row between small muted"><span>${s.history.length} workout${s.history.length === 1 ? "" : "s"} logged</span>
      <button class="btn link small" data-action="crew-open" data-member="${esc(m.id)}">${open ? "Hide standards" : "Strength standards"}</button></div>
    ${details}
  </div>`;
}

function refreshProfiles(ids) {
  if (!cloud) return;
  cloud.profiles(ids).then((ps) => {
    const before = JSON.stringify(crew.profiles);
    for (const id of ids) crew.profiles[id] = { name: ps[id]?.name || "", color: ps[id]?.color || "", avatarUrl: ps[id]?.avatarUrl || "" };
    if (JSON.stringify(crew.profiles) !== before && view === "crew") render();
  });
}

function profileFields() {
  const p = state.profile;
  return `<label class="field"><span>Bodyweight (kg)</span><input type="number" inputmode="decimal" min="20" max="400" step="0.1" id="profile-bodyweight" data-input="profile-bodyweight" value="${p.bodyweight ?? ""}" placeholder="e.g. 80"></label>
    <label class="field"><span>Standards for</span><select id="profile-sex" data-input="profile-sex">
      <option value="male" ${p.sex === "male" ? "selected" : ""}>Men</option>
      <option value="female" ${p.sex === "female" ? "selected" : ""}>Women</option></select></label>`;
}

// ---------- program: schedule + templates ----------

function programView() {
  const today = todayKey();
  const current = scheduleOn(state.schedules, today) ?? state.schedules.at(-1);
  const d = ui.scheduleDraft ?? (ui.scheduleDraft = JSON.parse(JSON.stringify({ mode: current.mode, days: current.days, fixed: current.fixed })));
  const perWeek = daysPerWeek(d);
  const changed = JSON.stringify([d.mode, [...d.days].sort(), d.fixed]) !== JSON.stringify([current.mode, [...current.days].sort(), current.fixed]);
  const dayButtons = WEEK_ORDER.map((wd) => `<button class="chip day-chip" data-action="toggle-day" data-wd="${wd}" aria-pressed="${d.days.includes(wd)}">${WEEKDAY_NAMES[wd]}</button>`).join("");
  const fixedRows = WEEK_ORDER.map((wd) => `<label class="field"><span>${WEEKDAY_NAMES[wd]}</span>
    <select id="fixed-${wd}" data-input="fixed-day" data-wd="${wd}">
      <option value="" ${!d.fixed[wd] ? "selected" : ""}>Rest</option>
      <option value="A" ${d.fixed[wd] === "A" ? "selected" : ""}>Workout A</option>
      <option value="B" ${d.fixed[wd] === "B" ? "selected" : ""}>Workout B</option>
    </select></label>`).join("");

  return `<h2>Weekly schedule</h2>
    <div class="card">
      <div class="seg" role="group" aria-label="Schedule type">
        <button data-action="schedule-mode" data-mode="alternate" aria-pressed="${d.mode === "alternate"}">Alternate A/B</button>
        <button data-action="schedule-mode" data-mode="fixed" aria-pressed="${d.mode === "fixed"}">Fixed per day</button>
      </div>
      <p class="small muted">${d.mode === "alternate"
        ? "Pick your training days. Workouts alternate A, B, A… across them, so a 3-day week starts with B the following week."
        : "Choose the workout for each weekday. It stays the same every week."}</p>
      ${d.mode === "alternate" ? `<div class="chips">${dayButtons}</div>` : fixedRows}
      <p class="small"><strong>${perWeek}</strong> workout${perWeek === 1 ? "" : "s"} per week</p>
      ${changed ? `<div class="row wrap">
        <button class="btn primary" data-action="save-schedule" ${perWeek ? "" : "disabled"}>Save schedule</button>
        <button class="btn" data-action="reset-schedule">Cancel</button>
        <span class="small muted">Applies from today. Past weeks and moved workouts stay as they are.</span></div>` : ""}
    </div>
    <h2>Workouts</h2>
    <div class="chips" role="group" aria-label="Workout to edit">
      <button class="chip" data-action="editor-type" data-type="A" aria-pressed="${ui.editorType === "A"}">Workout A</button>
      <button class="chip" data-action="editor-type" data-type="B" aria-pressed="${ui.editorType === "B"}">Workout B</button>
      ${state.workouts.map((w) => `<button class="chip" data-action="editor-type" data-type="${esc(w.id)}" aria-pressed="${ui.editorType === w.id}">${esc(w.name)}</button>`).join("")}
    </div>
    ${templateEditor(ui.editorType)}
    <div class="card">
      <strong>New workout</strong>
      <p class="small muted">Build your own workout from the main lifts, their variations, assistance work and your own exercises. A and B keep their 5×5 progression; your own workouts remember the weights you used.</p>
      <div class="row wrap">
        <input type="text" id="new-workout-name" class="text-input" maxlength="40" placeholder="e.g. Volume day" aria-label="Workout name">
        <button class="btn" data-action="workout-new">Create</button>
      </div>
    </div>
    ${libraryCard()}`;
}

const isOwnWorkout = () => ui.editorType !== "A" && ui.editorType !== "B";
const editorList = () => (isOwnWorkout() ? state.workouts.find((w) => w.id === ui.editorType)?.items ?? [] : state.templates[ui.editorType]);
function setEditorList(list) {
  if (isOwnWorkout()) state = updateCustomWorkout(state, ui.editorType, () => ({ items: list }));
  else state.templates[ui.editorType] = list;
}

function libraryCard() {
  if (!state.library.length) return "";
  return `<h2>Your exercise library</h2>
    <div class="card">
      <p class="small muted">Custom exercises you've added. They're offered again when you add an exercise.</p>
      ${state.library.map((e) => `<div class="line"><span>${esc(e.name)} <span class="muted small">${e.sets}×${e.reps}${e.unit === "sec" ? " s" : ""}${e.barbell ? " · barbell" : ""}</span></span>
        <button class="btn small" data-action="lib-remove" data-id="${esc(e.id)}">Remove</button></div>`).join("")}
    </div>`;
}

/** The "add exercise" picker. Your own workouts can use the main lifts and variations; A and B get assistance first. */
function addExerciseCard(own, label) {
  const opt = (prefix, list) => list.map((a, i) => `<option value="${prefix}:${prefix === "l" ? esc(a.id) : i}">${esc(a.name)} (${a.sets}×${a.reps}${a.unit === "sec" ? " s" : ""})</option>`).join("");
  const groups = [
    own ? `<optgroup label="Main lifts">${opt("m", MAIN_CHOICES)}</optgroup>` : "",
    own ? `<optgroup label="Variations">${opt("v", VARIATIONS)}</optgroup>` : "",
    `<optgroup label="Assistance">${opt("a", ASSISTANCE)}</optgroup>`,
    !own ? `<optgroup label="Variations">${opt("v", VARIATIONS)}</optgroup>` : "",
    state.library.length ? `<optgroup label="Your exercises">${opt("l", state.library)}</optgroup>` : "",
  ].join("");
  return `<div class="card">
      <strong>Add ${own ? "an exercise" : "assistance exercise"}</strong>
      <label class="field wide"><span>Exercise</span><select id="add-assist" data-input="add-assist">
        ${groups}<option value="custom">Custom exercise…</option></select></label>
      <div id="custom-assist" hidden>
        <label class="field wide"><span>Name</span><input type="text" id="custom-name" maxlength="60" placeholder="e.g. Face pulls"></label>
        <label class="field"><span>Sets</span><input type="number" id="custom-sets" min="1" max="10" value="3"></label>
        <label class="field"><span>Reps</span><input type="number" id="custom-reps" min="1" max="300" value="10"></label>
        <label class="field"><span>Counted in</span><select id="custom-unit"><option value="reps">Reps</option><option value="sec">Seconds</option></select></label>
        <label class="check"><input type="checkbox" id="custom-barbell"> Barbell exercise (show plates)</label>
        <p class="small muted">Saved to your exercise library for next time.</p>
      </div>
      <button class="btn primary" data-action="tpl-add">Add to ${esc(label)}</button>
      <p class="small muted" id="tpl-status" role="status"></p>
    </div>`;
}

function templateEditor(type) {
  const own = isOwnWorkout() ? state.workouts.find((w) => w.id === type) : null;
  if (isOwnWorkout() && !own) { ui.editorType = "A"; return templateEditor("A"); }
  const list = editorList();
  const items = list.map((item, i) => {
    const moveBtns = `<div class="row">
      <button class="btn icon" data-action="tpl-move" data-i="${i}" data-dir="-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
      <button class="btn icon" data-action="tpl-move" data-i="${i}" data-dir="1" ${i === list.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
    </div>`;
    if (item.type === "main") {
      return `<li class="card tpl">
        <div class="row between"><div><span class="lift-name">${esc(LIFTS[item.liftId].name)}</span> <span class="tag none">main lift</span></div>${moveBtns}</div>
        <label class="field wide"><span>Sets</span><select id="scheme-${type}-${i}" data-input="tpl-scheme" data-i="${i}">
          <option value="straight" ${item.scheme === "straight" ? "selected" : ""}>Straight ${LIFTS[item.liftId].sets}×${LIFTS[item.liftId].reps}</option>
          <option value="topBackoff" ${item.scheme === "topBackoff" ? "selected" : ""}>Top set + back-off</option>
        </select></label>
      </li>`;
    }
    return `<li class="card tpl">
      <div class="row between"><div><span class="lift-name">${esc(item.name)}</span> <span class="tag none">${own ? (item.barbell ? "barbell" : "exercise") : "assistance"}</span></div>${moveBtns}</div>
      <div class="row wrap">
        <label class="inline small">Sets <input type="number" min="1" max="10" step="1" id="tpl-sets-${item.id}" data-input="tpl-sets" data-i="${i}" value="${item.sets}"></label>
        <label class="inline small">${item.unit === "sec" ? "Seconds" : "Reps"} <input type="number" min="1" max="300" step="1" id="tpl-reps-${item.id}" data-input="tpl-reps" data-i="${i}" value="${item.reps}"></label>
        <button class="btn small" data-action="tpl-remove" data-i="${i}">Remove</button>
      </div>
    </li>`;
  }).join("");
  const head = own
    ? `<div class="card row wrap own-head">
        <label class="inline small">Name <input type="text" class="text-input" id="workout-name-${esc(own.id)}" data-input="workout-name" maxlength="40" value="${esc(own.name)}"></label>
        <button class="btn small" data-action="workout-delete">Delete workout</button>
      </div>`
    : "";
  const empty = own && !list.length ? `<p class="small muted">No exercises yet. Add the first one below.</p>` : "";
  return `${head}${empty}<ol class="tpl-list">${items}</ol>${addExerciseCard(Boolean(own), own ? own.name : `workout ${type}`)}`;
}

// ---------- sign-in ----------

function loginView() {
  const register = ui.loginMode === "register";
  return `<form class="login" id="login-form">
    <h2>${register ? "Create your account" : "Train 5×5 with your crew"}</h2>
    <p class="muted">${register ? "Pick a username your crew will see." : "Sign in to keep your workouts on every device and see your training partner's progress."}</p>
    <label class="field wide"><span>Username</span><input type="text" id="login-username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required></label>
    <label class="field wide"><span>Password</span><input type="password" id="login-password" autocomplete="${register ? "new-password" : "current-password"}" required></label>
    ${register ? `<p class="small muted">Don't reuse a password from anywhere else. This app keeps things simple, not secret.</p>` : ""}
    <button class="btn primary block" type="submit">${register ? "Create account" : "Sign in"}</button>
    <p class="small" id="login-status" role="status"></p>
    <button class="btn link" type="button" data-action="login-mode">${register ? "I already have an account" : "New here? Create an account"}</button>
    <button class="btn link small" type="button" data-action="local-only">Use without an account (this device only)</button>
  </form>`;
}

const LOGIN_ERRORS = {
  invalid_login: "Wrong username or password.",
  username_taken: "That username is taken. Pick another one.",
  invalid_username: "Usernames are 3–20 characters: letters, numbers, dots, dashes or underscores.",
  password_too_short: "Use a password with at least 4 characters.",
  crew_full: "This crew already has 20 accounts.",
  offline: "Can't reach the server. Check your connection and try again.",
  not_set_up: "The database isn't set up yet. Run supabase/schema.sql in the Supabase SQL Editor, then try again.",
};

async function submitLogin() {
  const status = document.getElementById("login-status");
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  status.textContent = ui.loginMode === "register" ? "Creating account…" : "Signing in…";
  try {
    const result = await rpc(ui.loginMode === "register" ? "crew_register" : "crew_login", { p_username: username, p_password: password });
    try {
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.removeItem(LOCAL_ONLY_KEY);
    } catch { /* storage blocked */ }
    location.reload();
  } catch (e) {
    status.textContent = LOGIN_ERRORS[e.code] ?? `Something went wrong (${e.code}). Try again.`;
  }
}

function accountCard() {
  if (cloud?.kind === "crew") {
    return `<div class="card row between wrap"><span class="small">Signed in as <strong>${esc(cloud.username)}</strong></span>
      <button class="btn" data-action="sign-out">Sign out</button></div>`;
  }
  if (cloud?.kind === "artifact") return `<div class="card small">Synced with your Claude account.</div>`;
  if (rpc && !window.claude) {
    return `<div class="card row between wrap"><span class="small">Not signed in. Your data stays on this device.</span>
      <button class="btn primary" data-action="sign-in">Sign in</button></div>`;
  }
  return "";
}

// ---------- settings ----------

function settingsView() {
  const s = state.settings;
  const field = (label, name, value, attrs = "") =>
    `<label class="field"><span>${esc(label)}</span><input type="number" inputmode="decimal" id="set-${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
  return `<h2>Settings</h2>
    ${accountCard()}
    <form class="card" id="settings">
      <h3>You</h3>
      ${rpc || window.claude ? `<label class="field wide"><span>Name for your crew</span><input type="text" id="profile-nickname" data-input="profile-nickname" maxlength="30" value="${esc(state.profile.nickname ?? "")}" placeholder="e.g. Mathias"></label>` : ""}
      ${profileFields()}
      <h3>Working weights (kg)</h3>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `weight.${id}`, state.lifts[id].weight, `min="0" step="0.5"`)).join("")}
      <h3>Increase per success (kg)</h3>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `inc.${id}`, s.increments[id], `min="0" step="0.5"`)).join("")}
      <h3>Deload</h3>
      ${field("Deload by (%)", "deloadPercent", s.deloadPercent, `min="1" max="50" step="1"`)}
      ${field("Recommend after misses in a row", "deloadSuggestAfter", s.deloadSuggestAfter, `min="1" step="1"`)}
      <h3>Top set + back-off</h3>
      ${field("Back-off sets", "topBackoff.backoffSets", s.topBackoff.backoffSets, `min="1" max="10" step="1"`)}
      ${field("Back-off reps", "topBackoff.backoffReps", s.topBackoff.backoffReps, `min="1" max="20" step="1"`)}
      ${field("Back-off weight (−%)", "topBackoff.backoffPercent", s.topBackoff.backoffPercent, `min="0" max="50" step="1"`)}
      <h3>Bar and plates</h3>
      ${field("Bar weight (kg)", "bar", s.bar, `min="0" step="0.5"`)}
      <p class="small">Plates in your gym</p>
      <div class="plate-checks">${PLATE_SIZES.map((p) => `<label class="check"><input type="checkbox" id="plate-${String(p).replace(".", "-")}" data-input="plate" data-size="${p}" ${s.plates.includes(p) ? "checked" : ""}> ${fmt(p)} kg</label>`).join("")}</div>
      <label class="check"><input type="checkbox" id="micro-on" data-input="micro-on" ${s.micro.enabled ? "checked" : ""}> Microplates (${fmt(MICRO_SIZE)} kg)</label>
      ${s.micro.enabled ? `<label class="field"><span>Pairs of ${fmt(MICRO_SIZE)} kg plates</span><input type="number" id="micro-pairs" data-input="micro-pairs" min="1" max="5" step="1" value="${s.micro.pairs}"></label>` : ""}
      <p class="muted small">New weights after a successful session, deloads, back-off and warm-up sets only use weights these plates can make. With one pair of 0.5 kg plates and 1 kg increases: 40 → 41 → 42.5 → 43.5 → 45 kg.</p>
    </form>
    <h2>Your data</h2>
    <div class="card data">
      <p class="small">Export saves all your workouts, weights and settings to a file. Import replaces everything ${cloud ? "in your account" : "in this app"} with a file's contents. Use them to move between the web app and the Android app.</p>
      <div class="row wrap">
        <button class="btn" data-action="export-file">Export data</button>
        <label class="btn">Import data<input type="file" accept="application/json,.json,text/plain" id="import" hidden></label>
      </div>
      <p class="small" id="backup-status" role="status">${esc(ui.flash)}</p>
      <details id="backup-paste">
        <summary class="small">Copy and paste instead</summary>
        <textarea id="backup" rows="5" spellcheck="false" aria-label="Exported data"></textarea>
        <div class="row wrap">
          <button class="btn small" data-action="copy-backup">Copy my data</button>
          <button class="btn small" data-action="import-text">Import pasted text</button>
        </div>
      </details>
    </div>
    <div class="card row between wrap">
      <span class="small muted">${cloud ? "Your data is saved to your account." : "Your data is saved on this device only. Export it now and then."}</span>
      <button class="btn small" data-action="reset">Reset everything</button>
    </div>`;
}

// ---------- events ----------

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  view = b.dataset.view;
  ui.scheduleDraft = null;
  ui.flash = "";
  render();
  window.scrollTo(0, 0);
});

const actions = {
  start(el) {
    state.active = startWorkout(state, el.dataset.type ?? "A", Date.now(), el.dataset.workout ?? null);
    state.active.id += `-${newId()}`; // unique across devices, since it's also the session's storage key
    ui.summary = null;
    ui.chosenType = null;
    ui.warmups.clear();
    stopTimer();
  },
  choose(el) { ui.chosenType = el.dataset.type; },
  set(el) {
    const i = Number(el.dataset.ex), j = Number(el.dataset.set);
    const ex = state.active.exercises[i];
    const target = targetsFor(ex, state.settings)[j].reps;
    const unit = ex.type === "assist" ? ex.unit : "reps";
    ex.log[j] = cycleSet(ex.log[j], target, unit);
    if (ex.log[j] !== null) startTimer(); // the stopwatch counts from the last logged set
  },
  weight(el) {
    const ex = state.active.exercises[Number(el.dataset.ex)];
    ex.weight = nextLoadable(ex.weight, state.settings, Number(el.dataset.dir));
  },
  warmups(el) { toggle(ui.warmups, Number(el.dataset.ex)); },
  async finish() {
    const incomplete = state.active.exercises.some((ex) => ex.log.some((r) => r === null) && exerciseResult(ex, state.settings) !== "success");
    if (incomplete && !(await ask("Some sets aren't logged. Unlogged sets count as missed. Finish anyway?", "Finish"))) return false;
    state = finishWorkout(state, state.active);
    ui.summary = state.history[0];
    stopTimer();
  },
  async cancel() {
    if (!(await ask("Discard this workout? Nothing will be saved.", "Discard"))) return false;
    state.active = null;
    stopTimer();
  },
  deload(el) {
    const id = el.dataset.lift;
    state.lifts[id] = deloadLift(state.lifts[id], state.settings);
  },
  "dismiss-summary"() { ui.summary = null; },
  "stop-timer"() { stopTimer(); return false; },
  "cal-month"(el) {
    const [y, m] = ui.calMonth.split("-").map(Number);
    ui.calMonth = toKey(new Date(y, m - 1 + Number(el.dataset.delta), 1)).slice(0, 7);
    ui.calSelected = null;
  },
  "cal-day"(el) { ui.calSelected = ui.calSelected === el.dataset.date ? null : el.dataset.date; },
  move(el) {
    const original = el.dataset.original;
    const to = document.getElementById(`move-${original}`)?.value;
    if (!to || to < todayKey()) return false;
    state.overrides = moveOccurrence(state.overrides, original, to);
    ui.calSelected = to;
    ui.calMonth = to.slice(0, 7);
  },
  unmove(el) {
    const original = el.dataset.original;
    state.overrides = moveOccurrence(state.overrides, original, original);
    ui.calSelected = original;
  },
  "progress-key"(el) { ui.progressKey = el.dataset.key; },
  "login-mode"() { ui.loginMode = ui.loginMode === "register" ? "signin" : "register"; },
  "local-only"() {
    try { localStorage.setItem(LOCAL_ONLY_KEY, "1"); } catch { /* storage blocked */ }
    view = "today";
  },
  "sign-in"() {
    try { localStorage.removeItem(LOCAL_ONLY_KEY); } catch { /* storage blocked */ }
    view = "login";
  },
  async "sign-out"() {
    if (cloud && !(await ask("Sign out? Your data stays saved on the server.", "Sign out"))) return false;
    await cloud?.logout?.();
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
    // Clear this device's copy so the next person to sign in here starts clean.
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
    location.reload();
    return false;
  },
  "crew-lift"(el) { ui.crewLift = el.dataset.key; },
  "crew-open"(el) { ui.crewOpen = ui.crewOpen === el.dataset.member ? null : el.dataset.member; },
  "schedule-mode"(el) { ui.scheduleDraft.mode = el.dataset.mode; },
  "toggle-day"(el) {
    const wd = Number(el.dataset.wd);
    const days = ui.scheduleDraft.days;
    ui.scheduleDraft.days = days.includes(wd) ? days.filter((d) => d !== wd) : [...days, wd].sort();
  },
  "save-schedule"() {
    const d = ui.scheduleDraft;
    if (!daysPerWeek(d)) return false;
    state.schedules = setSchedule(state.schedules, { mode: d.mode, days: d.days, fixed: d.fixed }, todayKey());
    ui.scheduleDraft = null;
  },
  "reset-schedule"() { ui.scheduleDraft = null; },
  "editor-type"(el) { ui.editorType = el.dataset.type; },
  "tpl-move"(el) {
    setEditorList(moveItem(editorList(), Number(el.dataset.i), Number(el.dataset.dir)));
  },
  async "tpl-remove"(el) {
    const i = Number(el.dataset.i);
    const item = editorList()[i];
    if (!(await ask(`Remove ${item.name}?`, "Remove"))) return false;
    setEditorList(editorList().filter((_, k) => k !== i));
  },
  "tpl-add"() {
    const choice = document.getElementById("add-assist").value;
    let picked;
    if (choice === "custom") {
      const name = document.getElementById("custom-name").value.trim().slice(0, 60);
      const sets = Math.round(Number(document.getElementById("custom-sets").value));
      const reps = Math.round(Number(document.getElementById("custom-reps").value));
      if (!name || !(sets >= 1 && sets <= 10) || !(reps >= 1 && reps <= 300)) {
        document.getElementById("tpl-status").textContent = "Enter a name, 1–10 sets and 1–300 reps or seconds.";
        return false;
      }
      picked = { name, sets, reps, unit: document.getElementById("custom-unit").value === "sec" ? "sec" : "reps",
        barbell: document.getElementById("custom-barbell").checked };
      state = addToLibrary(state, picked); // remembered for next time
    } else {
      const [kind, key] = choice.split(":");
      const lists = { m: MAIN_CHOICES, v: VARIATIONS, a: ASSISTANCE };
      picked = kind === "l" ? state.library.find((e) => e.id === key) : lists[kind]?.[Number(key)];
      if (!picked) return false;
    }
    setEditorList([...editorList(), exerciseItem(picked, newId())]);
  },
  "workout-new"() {
    const input = document.getElementById("new-workout-name");
    const name = input.value.trim();
    if (!name) { input.focus(); return false; }
    state = addCustomWorkout(state, name);
    ui.editorType = state.workouts.at(-1).id;
  },
  async "workout-delete"() {
    const w = state.workouts.find((x) => x.id === ui.editorType);
    if (!w || !(await ask(`Delete the workout "${w.name}"? Workouts you already logged with it stay in your history.`, "Delete"))) return false;
    state = removeCustomWorkout(state, w.id);
    ui.editorType = "A";
  },
  async "lib-remove"(el) {
    const e = state.library.find((x) => x.id === el.dataset.id);
    if (!e || !(await ask(`Remove ${e.name} from your exercise library? Workouts that use it keep it.`, "Remove"))) return false;
    state = removeFromLibrary(state, e.id);
  },
  "export-file"() { exportData(); return false; },
  "copy-backup"() { copyBackup(); return false; },
  "import-text"() { importText(document.getElementById("backup").value); return false; },
  "manual-start"(el) {
    const [y, mo, d] = el.dataset.date.split("-").map(Number);
    ui.manual = manualDraft(state, state.nextWorkout === "A" ? "B" : "A", new Date(y, mo - 1, d, 12).toISOString());
    view = "manual";
    window.scrollTo(0, 0);
  },
  "manual-type"(el) { ui.manual = manualDraft(state, el.dataset.type ?? "A", ui.manual.date, el.dataset.workout ?? null); },
  "manual-set"(el) {
    const ex = ui.manual.exercises[Number(el.dataset.ex)];
    const j = Number(el.dataset.set);
    ex.log[j] = cycleSet(ex.log[j], targetsFor(ex, state.settings)[j].reps, ex.type === "assist" ? ex.unit : "reps");
  },
  "manual-save"() {
    if (ui.manual.exercises.every((ex) => ex.log.every((r) => r === null))) return false;
    const day = toKey(new Date(ui.manual.date));
    state = addManualWorkout(state, ui.manual, `${Date.now()}-${newId()}`);
    ui.manual = null;
    ui.calSelected = day;
    ui.calMonth = day.slice(0, 7);
    view = "calendar";
  },
  "manual-cancel"() { ui.manual = null; view = "calendar"; },
  async "delete-workout"(el) {
    const h = state.history.find((x) => x.id === el.dataset.id);
    if (!h || !(await ask(`Delete ${sessionLabel(h)} from ${isoDayLabel(h.date)}? It disappears from your history and graphs.`, "Delete"))) return false;
    state = deleteWorkout(state, h.id);
  },
  async reset() {
    if (!(await ask("Delete all workouts and settings? This can't be undone.", "Delete everything"))) return false;
    state = createState(todayKey());
    ui.summary = null;
    stopTimer();
  },
};

function toggle(set, value) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  // An action returns false when nothing changed (cancelled, invalid, or handled itself).
  if ((await actions[el.dataset.action](el)) === false) return;
  save();
  render();
});

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (t.id === "import") {
    const file = t.files[0];
    t.value = ""; // so picking the same file again still triggers an import
    return file && importText(await file.text());
  }
  if (t.id === "add-assist") {
    document.getElementById("custom-assist").hidden = t.value !== "custom";
    return;
  }
  const input = t.dataset.input;
  if (input === "manual-weight") {
    const n = Number(t.value);
    if (Number.isFinite(n) && n >= 0 && n <= 1000) ui.manual.exercises[Number(t.dataset.ex)].weight = n;
    return render();
  }
  if (input === "assist-weight") {
    const n = Number(t.value);
    if (Number.isFinite(n) && n >= 0) state.active.exercises[Number(t.dataset.ex)].weight = n;
  } else if (input === "buddy-on") {
    state.active.buddy = { on: t.checked, weights: state.active.buddy?.weights ?? {} };
  } else if (input === "buddy-weight") {
    const n = Number(t.value);
    if (Number.isFinite(n) && n >= 0 && n <= 1000) state.active.buddy.weights[t.dataset.ex] = n;
  } else if (input === "plate") {
    const size = Number(t.dataset.size);
    const plates = t.checked ? [...state.settings.plates, size] : state.settings.plates.filter((p) => p !== size);
    if (!plates.length) return render(); // keep at least one plate size
    state.settings.plates = [...new Set(plates)].sort((a, b) => b - a);
  } else if (input === "micro-on") {
    state.settings.micro = { ...state.settings.micro, enabled: t.checked };
  } else if (input === "micro-pairs") {
    const n = Math.round(Number(t.value));
    if (n >= 1 && n <= 5) state.settings.micro = { ...state.settings.micro, pairs: n };
  } else if (input === "workout-name") {
    const name = t.value.trim().slice(0, 40);
    if (name) state = updateCustomWorkout(state, ui.editorType, () => ({ name }));
  } else if (input === "profile-bodyweight") {
    const n = Number(t.value);
    state.profile.bodyweight = t.value === "" ? null : n >= 20 && n <= 400 ? Math.round(n * 10) / 10 : state.profile.bodyweight;
  } else if (input === "profile-nickname") {
    state.profile.nickname = t.value.trim().slice(0, 30);
  } else if (input === "profile-sex") {
    state.profile.sex = t.value === "female" ? "female" : "male";
  } else if (input === "fixed-day") {
    ui.scheduleDraft.fixed = { ...ui.scheduleDraft.fixed, [t.dataset.wd]: t.value || null };
    return render();
  } else if (input === "tpl-scheme") {
    state.templates[ui.editorType][Number(t.dataset.i)].scheme = t.value === "topBackoff" ? "topBackoff" : "straight";
  } else if (input === "tpl-sets" || input === "tpl-reps") {
    const n = Math.round(Number(t.value));
    const [min, max] = input === "tpl-sets" ? [1, 10] : [1, 300];
    if (n >= min && n <= max) {
      setEditorList(editorList().map((item, k) => (k === Number(t.dataset.i) ? { ...item, [input === "tpl-sets" ? "sets" : "reps"]: n } : item)));
    }
  } else if (t.closest("#settings") && t.name) {
    const n = Number(t.value);
    if (!Number.isFinite(n) || n < 0) return render();
    const [group, key] = t.name.split(".");
    if (group === "weight") state.lifts[key] = { ...state.lifts[key], weight: n };
    else if (group === "inc") state.settings.increments[key] = n;
    else if (group === "topBackoff") state.settings.topBackoff[key] = key === "backoffPercent" ? Math.min(50, n) : Math.max(1, Math.round(n));
    else if (t.name === "deloadSuggestAfter") state.settings.deloadSuggestAfter = Math.max(1, Math.round(n));
    else if (t.name === "deloadPercent") state.settings.deloadPercent = Math.min(50, Math.max(1, n));
    else if (t.name === "bar") state.settings.bar = n;
  } else {
    return;
  }
  save();
  render();
});

document.addEventListener("submit", (e) => {
  e.preventDefault();
  if (e.target.id === "login-form") submitLogin();
});

// ---------- export / import ----------
// One file format everywhere. Exports download as a file on the web, go through Android's save dialog
// in the app, and fall back to copy/paste on the Claude page, where downloads are blocked.

function backupStatus(msg) {
  ui.flash = msg;
  const el = document.getElementById("backup-status");
  if (el) el.textContent = msg;
}

function exportData() {
  const text = JSON.stringify(makeBackup(state));
  const name = `starkheben-5x5-${todayKey()}.json`;
  const count = workouts(state.history.length);
  if (window.StarkhebenAndroid?.exportFile) {
    window.StarkhebenAndroid.exportFile(name, text);
    return backupStatus("Choose where to save the file.");
  }
  if (window.claude) {
    document.getElementById("backup-paste").open = true;
    document.getElementById("backup").value = text;
    return backupStatus(`Downloads aren't available here. Copy the text below (${count}) and keep it somewhere safe.`);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  backupStatus(`Exported ${count} to ${name}.`);
}

// Called by the Android app once the save dialog finishes.
window.onAndroidExport = (ok) => backupStatus(ok ? "Exported. The file is where you chose to save it." : "Export cancelled.");

async function copyBackup() {
  const box = document.getElementById("backup");
  if (!box.value) box.value = JSON.stringify(makeBackup(state));
  try {
    await navigator.clipboard.writeText(box.value);
    backupStatus("Copied.");
  } catch {
    box.focus();
    box.select();
    backupStatus("Selected. Use your device's Copy.");
  }
}

/** Import always replaces everything, so it asks first and says exactly what will be lost. */
async function importText(text) {
  const data = readBackup(text, todayKey());
  if (!data) return backupStatus("That isn't a Starkheben export. Nothing was changed.");
  const where = cloud ? "your account (on all your devices)" : "this app";
  const ok = await ask(
    `Replace ALL data in ${where}? Your ${workouts(state.history.length)}, working weights, schedule and settings will be overwritten by the file's ${workouts(data.history.length)}. This can't be undone. Export your current data first if you might need it.`,
    "Replace my data",
  );
  if (!ok) return backupStatus("Import cancelled. Nothing was changed.");
  state = data;
  ui.summary = null;
  ui.manual = null;
  stopTimer();
  ui.flash = `Imported ${workouts(data.history.length)}.`;
  save();
  render();
}

// In-page confirmation: native confirm() is unavailable in some embedded views.
function ask(message, okLabel) {
  const modal = document.getElementById("modal");
  const ok = document.getElementById("modal-ok");
  const cancel = document.getElementById("modal-cancel");
  document.getElementById("modal-text").textContent = message;
  ok.textContent = okLabel;
  modal.hidden = false;
  cancel.focus();
  return new Promise((resolve) => {
    const done = (value) => {
      modal.hidden = true;
      ok.onclick = cancel.onclick = modal.onkeydown = null;
      resolve(value);
    };
    ok.onclick = () => done(true);
    cancel.onclick = () => done(false);
    modal.onkeydown = (ev) => ev.key === "Escape" && done(false);
  });
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
startCloud();
