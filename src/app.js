import {
  LIFTS, ASSISTANCE, createState, startWorkout, finishWorkout, cycleSet, exerciseResult, targetsFor,
  platesPerSide, warmupSets, restTargets, migrate, validateSession, loadStep, deloadLift, suggestDeload,
  moveItem, bestOneRepMax, liftSeries,
} from "./program.js";
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
  plates: new Set(),
  warmups: new Set(),
  chosenType: null, // overrides the planned workout on the Today screen
  calMonth: todayKey().slice(0, 7),
  calSelected: null,
  progressKey: "squat",
  editorType: "A",
  scheduleDraft: null,
  crewLift: "squat",
  loginMode: "signin",
  crewOpen: null,
};
let timer = null; // { start, targets, beeped, missed }

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

function platesText(weight) {
  const { plates, remainder } = platesPerSide(weight, state.settings);
  if (!plates.length) return `Empty bar (${kg(state.settings.bar)})`;
  const extra = remainder > 0 ? ` · ${kg(remainder)} per side can't be loaded` : "";
  return `Per side: ${plates.map(fmt).join(" + ")}${extra}`;
}

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

// ---------- rest timer ----------

function startTimer(reps, target) {
  timer = { start: Date.now(), targets: restTargets(reps, target, state.settings), beeped: 0, missed: reps < target };
  tickTimer();
}

function stopTimer() {
  timer = null;
  timerEl.hidden = true;
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
    osc.onended = () => ctx.close();
  } catch { /* audio not allowed */ }
  navigator.vibrate?.([200, 100, 200]);
}

function tickTimer() {
  if (!timer) return;
  const elapsed = (Date.now() - timer.start) / 1000;
  while (timer.beeped < timer.targets.length && elapsed >= timer.targets[timer.beeped]) {
    timer.beeped++;
    beep();
  }
  const hint = timer.missed
    ? `Missed reps: rest ${mmss(timer.targets[0])}`
    : `Rest ${mmss(timer.targets[0])} if easy, ${mmss(timer.targets[1])} if hard`;
  timerEl.hidden = false;
  timerEl.innerHTML = `
    <div><div class="clock">${mmss(elapsed)}</div><div class="small">${esc(hint)}</div></div>
    <button class="btn" data-action="stop-timer">Dismiss</button>`;
}
setInterval(tickTimer, 500);

// ---------- rendering ----------

function render() {
  for (const b of document.querySelectorAll(".tabs button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const views = { today: todayView, calendar: calendarView, progress: progressView, crew: crewView, program: programView, settings: settingsView,
    login: loginView };
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
    <div class="center"><button class="btn link" data-action="choose" data-type="${other}">Do workout ${other} instead</button></div>`;
}

function summaryCard(s) {
  const label = { increase: "+ next time", repeat: "missed", none: "skipped" };
  const rows = s.exercises.filter((ex) => ex.type === "main").map((ex) => `
    <div class="line">
      <span>${esc(LIFTS[ex.liftId].name)}</span>
      <span>${fmt(ex.weight)} → <strong>${kg(state.lifts[ex.liftId].weight)}</strong> <span class="tag ${esc(ex.change)}">${esc(label[ex.change])}</span></span>
    </div>${ex.change === "repeat" ? deloadControl(ex.liftId) : ""}`).join("");
  return `<div class="card"><div class="row between"><strong>Workout ${esc(s.type)} done</strong>
    <button class="btn link" data-action="dismiss-summary">Close</button></div>${rows}</div>`;
}

function setCircles(ex, i) {
  const targets = targetsFor(ex, state.settings);
  const unit = ex.type === "assist" ? ex.unit : "reps";
  const groups = [];
  targets.forEach((t, j) => {
    const r = ex.log[j];
    const cls = r === null ? "" : r >= t.reps ? "done" : "miss";
    const label = unit === "sec" ? (r === null ? "" : `${r}s`) : r === null ? "" : r;
    const aria = `${exName(ex)} set ${j + 1}${t.top ? " (top set)" : ""}: ${r === null ? "not done" : `${r} ${unit === "sec" ? "seconds" : "reps"}`}`;
    groups.push(`<button class="set ${cls} ${t.top ? "top" : ""}" data-action="set" data-ex="${i}" data-set="${j}" aria-label="${esc(aria)}">${esc(label)}</button>`);
  });
  if (ex.type === "main" && ex.scheme === "topBackoff") {
    const back = targets[1];
    return `<div class="sets"><div class="set-group"><span class="set-label">Top ${targets[0].reps} @ ${kg(targets[0].weight)}</span><div class="sets-row">${groups[0]}</div></div>
      ${back ? `<div class="set-group"><span class="set-label">Back-off ${targets.length - 1}×${back.reps} @ ${kg(back.weight)}</span><div class="sets-row">${groups.slice(1).join("")}</div></div>` : ""}</div>`;
  }
  return `<div class="sets"><div class="sets-row">${groups.join("")}</div></div>`;
}

function activeView(session) {
  const step = loadStep(state.settings);
  const cards = session.exercises.map((ex, i) => {
    if (ex.type === "assist") {
      return `<div class="card">
        <div class="row between wrap">
          <div class="lift-name">${esc(ex.name)} <span class="muted small">${esc(itemSummary(ex))}</span></div>
          <label class="inline small muted">Weight
            <input type="number" inputmode="decimal" min="0" step="0.5" id="assist-weight-${i}" data-input="assist-weight" data-ex="${i}" value="${fmt(ex.weight)}"> kg</label>
        </div>
        ${setCircles(ex, i)}
      </div>`;
    }
    const lift = LIFTS[ex.liftId];
    const warm = ui.warmups.has(i)
      ? `<ul class="warmups">${warmupSets(ex.liftId, ex.weight, state.settings).map((w) =>
          `<li>${w.reps} × ${kg(w.weight)}</li>`).join("") || "<li>No warm-up needed</li>"}</ul>`
      : "";
    return `<div class="card">
      <div class="row between">
        <div>
          <div class="lift-name">${esc(lift.name)} <span class="muted small">${esc(itemSummary(ex))}</span></div>
          <button class="weight" data-action="plates" data-ex="${i}" aria-expanded="${ui.plates.has(i)}">${fmt(ex.weight)} <small>kg</small></button>
        </div>
        <div class="row">
          <button class="btn icon" data-action="weight" data-ex="${i}" data-delta="${-step}" aria-label="Lower ${esc(lift.name)} weight">−</button>
          <button class="btn icon" data-action="weight" data-ex="${i}" data-delta="${step}" aria-label="Raise ${esc(lift.name)} weight">+</button>
        </div>
      </div>
      ${ui.plates.has(i) ? `<div class="plates">${esc(platesText(ex.weight))}</div>` : ""}
      ${setCircles(ex, i)}
      <div class="row between" style="margin-top:6px">
        <span class="set-label">Tap a set when done, tap again to lower reps</span>
        <button class="btn link small" data-action="warmups" data-ex="${i}">${ui.warmups.has(i) ? "Hide" : "Warm-up"}</button>
      </div>
      ${warm}
    </div>`;
  }).join("");
  return `<h2>Workout ${esc(session.type)} <span class="muted small">${esc(isoDayLabel(session.date))}</span></h2>
    ${cards}
    <button class="btn primary block" data-action="finish">Finish workout</button>
    <div class="center"><button class="btn link" data-action="cancel">Discard workout</button></div>`;
}

// ---------- calendar ----------

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
    let marks = done.map((h) => `<span class="mark done">${esc(h.type)}</span>`).join("");
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
  const doneRows = done.map((h) => `<div class="line"><span><span class="mark done">${esc(h.type)}</span> Workout ${esc(h.type)} done</span>
    <span class="muted small">${h.exercises.filter((e) => e.type === "main").map((e) => esc(LIFTS[e.liftId].name)).join(", ")}</span></div>`).join("");
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
  return `<div class="card"><strong>${esc(dayLabel(k))}</strong>${body}</div>`;
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
  return keys.map((k) => `<button class="chip" data-action="${action}" data-key="${esc(k)}" aria-pressed="${k === selected}">${esc(LIFTS[k]?.name ?? k)}</button>`).join("");
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
        <div class="small muted">${last ? `Last: ${esc(isoDayLabel(last.date))} · Workout ${esc(last.type)}` : "No workouts yet"}${next ? ` · Next: ${esc(dayLabel(next.date))}` : ""}</div></div></div>
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
    <h2>Workout templates</h2>
    <div class="seg" role="group" aria-label="Template">
      <button data-action="editor-type" data-type="A" aria-pressed="${ui.editorType === "A"}">Workout A</button>
      <button data-action="editor-type" data-type="B" aria-pressed="${ui.editorType === "B"}">Workout B</button>
    </div>
    ${templateEditor(ui.editorType)}`;
}

function templateEditor(type) {
  const list = state.templates[type];
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
      <div class="row between"><div><span class="lift-name">${esc(item.name)}</span> <span class="tag none">assistance</span></div>${moveBtns}</div>
      <div class="row wrap">
        <label class="inline small">Sets <input type="number" min="1" max="10" step="1" id="tpl-sets-${item.id}" data-input="tpl-sets" data-i="${i}" value="${item.sets}"></label>
        <label class="inline small">${item.unit === "sec" ? "Seconds" : "Reps"} <input type="number" min="1" max="300" step="1" id="tpl-reps-${item.id}" data-input="tpl-reps" data-i="${i}" value="${item.reps}"></label>
        <button class="btn small" data-action="tpl-remove" data-i="${i}">Remove</button>
      </div>
    </li>`;
  }).join("");
  const options = ASSISTANCE.map((a, i) => `<option value="${i}">${esc(a.name)} (${a.sets}×${a.reps}${a.unit === "sec" ? " s" : ""})</option>`).join("");
  return `<ol class="tpl-list">${items}</ol>
    <div class="card">
      <strong>Add assistance exercise</strong>
      <label class="field wide"><span>Exercise</span><select id="add-assist" data-input="add-assist">
        ${options}<option value="custom">Custom exercise…</option></select></label>
      <div id="custom-assist" hidden>
        <label class="field wide"><span>Name</span><input type="text" id="custom-name" maxlength="60" placeholder="e.g. Face pulls"></label>
        <label class="field"><span>Sets</span><input type="number" id="custom-sets" min="1" max="10" value="3"></label>
        <label class="field"><span>Reps</span><input type="number" id="custom-reps" min="1" max="300" value="10"></label>
        <label class="field"><span>Counted in</span><select id="custom-unit"><option value="reps">Reps</option><option value="sec">Seconds</option></select></label>
      </div>
      <button class="btn primary" data-action="tpl-add">Add to workout ${type}</button>
      <p class="small muted" id="tpl-status" role="status"></p>
    </div>`;
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
  const step = loadStep(s);
  const field = (label, name, value, attrs = "") =>
    `<label class="field"><span>${esc(label)}</span><input type="number" inputmode="decimal" id="set-${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
  return `<h2>Settings</h2>
    ${accountCard()}
    <form class="card" id="settings">
      <h3>You</h3>
      <label class="field wide"><span>Name for your crew</span><input type="text" id="profile-nickname" data-input="profile-nickname" maxlength="30" value="${esc(state.profile.nickname ?? "")}" placeholder="e.g. Mathias"></label>
      ${profileFields()}
      <h3>Working weights (kg)</h3>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `weight.${id}`, state.lifts[id].weight, `min="0" step="${step}"`)).join("")}
      <h3>Increase per success (kg)</h3>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `inc.${id}`, s.increments[id], `min="0" step="0.5"`)).join("")}
      <h3>Deload</h3>
      ${field("Deload by (%)", "deloadPercent", s.deloadPercent, `min="1" max="50" step="1"`)}
      ${field("Recommend after misses in a row", "deloadSuggestAfter", s.deloadSuggestAfter, `min="1" step="1"`)}
      <h3>Top set + back-off</h3>
      ${field("Back-off sets", "topBackoff.backoffSets", s.topBackoff.backoffSets, `min="1" max="10" step="1"`)}
      ${field("Back-off reps", "topBackoff.backoffReps", s.topBackoff.backoffReps, `min="1" max="20" step="1"`)}
      ${field("Back-off weight (−%)", "topBackoff.backoffPercent", s.topBackoff.backoffPercent, `min="0" max="50" step="1"`)}
      <h3>Rest timer (seconds)</h3>
      ${field("If easy", "rest.easy", s.rest.easy, `min="0" step="15"`)}
      ${field("If hard", "rest.hard", s.rest.hard, `min="0" step="15"`)}
      ${field("After a miss", "rest.failed", s.rest.failed, `min="0" step="15"`)}
      <h3>Bar and plates</h3>
      ${field("Bar weight (kg)", "bar", s.bar, `min="0" step="0.5"`)}
      <p class="muted small">Plates: ${s.plates.map(fmt).join(", ")} kg. Deloads and back-off sets round down to ${kg(step)} steps.</p>
    </form>
    <h2>Data</h2>
    <div class="card row wrap">
      <button class="btn" data-action="export">Show backup</button>
      <button class="btn" data-action="reset">Reset everything</button>
    </div>
    <div class="card" id="backup-panel" hidden>
      <label for="backup" class="small muted">Backup text. Copy it somewhere safe, or paste a backup here and restore it.</label>
      <textarea id="backup" rows="6" spellcheck="false"></textarea>
      <div class="row wrap">
        <button class="btn" data-action="copy-backup">Copy</button>
        <label class="btn">Load file<input type="file" accept="application/json,.json,.txt" id="import" hidden></label>
        <button class="btn primary" data-action="restore">Restore</button>
      </div>
      <p class="small muted" id="backup-status" role="status"></p>
    </div>
    <p class="muted small">Your data stays on this device. Save a backup before clearing app data.</p>`;
}

// ---------- events ----------

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  view = b.dataset.view;
  ui.scheduleDraft = null;
  render();
  window.scrollTo(0, 0);
});

const actions = {
  start(el) {
    state.active = startWorkout(state, el.dataset.type);
    state.active.id += `-${newId()}`; // unique across devices, since it's also the session's storage key
    ui.summary = null;
    ui.chosenType = null;
    ui.plates.clear();
    ui.warmups.clear();
  },
  choose(el) { ui.chosenType = el.dataset.type; },
  set(el) {
    const i = Number(el.dataset.ex), j = Number(el.dataset.set);
    const ex = state.active.exercises[i];
    const target = targetsFor(ex, state.settings)[j].reps;
    const unit = ex.type === "assist" ? ex.unit : "reps";
    ex.log[j] = cycleSet(ex.log[j], target, unit);
    const isLast = i === state.active.exercises.length - 1 && j === ex.log.length - 1;
    if (ex.log[j] === null || isLast) stopTimer();
    else startTimer(ex.log[j], target);
  },
  weight(el) {
    const ex = state.active.exercises[Number(el.dataset.ex)];
    ex.weight = Math.max(0, Math.round((ex.weight + Number(el.dataset.delta)) * 100) / 100);
  },
  plates(el) { toggle(ui.plates, Number(el.dataset.ex)); },
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
    const t = ui.editorType;
    state.templates[t] = moveItem(state.templates[t], Number(el.dataset.i), Number(el.dataset.dir));
  },
  async "tpl-remove"(el) {
    const t = ui.editorType;
    const item = state.templates[t][Number(el.dataset.i)];
    if (!(await ask(`Remove ${item.name} from workout ${t}?`, "Remove"))) return false;
    state.templates[t] = state.templates[t].filter((_, i) => i !== Number(el.dataset.i));
  },
  "tpl-add"() {
    const t = ui.editorType;
    const choice = document.getElementById("add-assist").value;
    let item;
    if (choice === "custom") {
      const name = document.getElementById("custom-name").value.trim().slice(0, 60);
      const sets = Math.round(Number(document.getElementById("custom-sets").value));
      const reps = Math.round(Number(document.getElementById("custom-reps").value));
      if (!name || !(sets >= 1 && sets <= 10) || !(reps >= 1 && reps <= 300)) {
        document.getElementById("tpl-status").textContent = "Enter a name, 1–10 sets and 1–300 reps or seconds.";
        return false;
      }
      item = { name, sets, reps, unit: document.getElementById("custom-unit").value === "sec" ? "sec" : "reps" };
    } else {
      item = ASSISTANCE[Number(choice)];
    }
    state.templates[t] = [...state.templates[t], { type: "assist", id: newId(), ...item, weight: 0 }];
  },
  export() { showBackup(); return false; },
  "copy-backup"() { copyBackup(); return false; },
  restore() { restoreBackup(); return false; },
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
  if (t.id === "import") return loadBackupFile(t.files[0]);
  if (t.id === "add-assist") {
    document.getElementById("custom-assist").hidden = t.value !== "custom";
    return;
  }
  const input = t.dataset.input;
  if (input === "assist-weight") {
    const n = Number(t.value);
    if (Number.isFinite(n) && n >= 0) state.active.exercises[Number(t.dataset.ex)].weight = n;
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
    if (n >= min && n <= max) state.templates[ui.editorType][Number(t.dataset.i)][input === "tpl-sets" ? "sets" : "reps"] = n;
  } else if (t.closest("#settings") && t.name) {
    const n = Number(t.value);
    if (!Number.isFinite(n) || n < 0) return render();
    const [group, key] = t.name.split(".");
    if (group === "weight") state.lifts[key] = { ...state.lifts[key], weight: n };
    else if (group === "inc") state.settings.increments[key] = n;
    else if (group === "rest") state.settings.rest[key] = n;
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

// Backups go through a text box: downloads and file saves are blocked in some embedded views.
function backupStatus(msg) {
  const el = document.getElementById("backup-status");
  if (el) el.textContent = msg;
}

function showBackup() {
  document.getElementById("backup-panel").hidden = false;
  document.getElementById("backup").value = JSON.stringify({ ...state, active: null });
  backupStatus(`Backup of ${state.history.length} workouts.`);
}

async function copyBackup() {
  const box = document.getElementById("backup");
  try {
    await navigator.clipboard.writeText(box.value);
    backupStatus("Copied.");
  } catch {
    box.focus();
    box.select();
    backupStatus("Selected. Use your device's Copy.");
  }
}

async function loadBackupFile(file) {
  if (!file) return;
  document.getElementById("backup").value = await file.text();
  backupStatus("File loaded. Tap Restore to use it.");
}

async function restoreBackup() {
  let data = null;
  try { data = migrate(JSON.parse(document.getElementById("backup").value), todayKey()); } catch { /* handled below */ }
  if (!data) return backupStatus("That isn't a valid backup. Paste the full text from Show backup.");
  if (!(await ask(`Replace current data with this backup (${data.history.length} workouts)?`, "Replace"))) return;
  state = data;
  ui.summary = null;
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
