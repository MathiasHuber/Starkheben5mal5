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

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

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
  const views = { today: todayView, calendar: calendarView, progress: progressView, program: programView, settings: settingsView };
  app.innerHTML = views[view]();
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

function chartSvg(points, title) {
  if (points.length < 2) return `<p class="muted small">Log at least two sessions to see a graph.</p>`;
  const W = 340, H = 190, L = 40, R = 14, T = 14, B = 26;
  const ws = points.map((p) => p.weight);
  const ts = points.map((p) => new Date(p.date).getTime());
  const step = niceStep(Math.max(...ws) - Math.min(...ws) || 5);
  const lo = Math.floor(Math.min(...ws) / step) * step;
  const hi = Math.max(lo + step, Math.ceil(Math.max(...ws) / step) * step);
  const t0 = ts[0], t1 = ts.at(-1) === t0 ? t0 + 1 : ts.at(-1);
  const x = (t) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const y = (w) => T + (1 - (w - lo) / (hi - lo)) * (H - T - B);
  const grid = [];
  for (let v = lo; v <= hi + 1e-9; v += step) {
    grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  }
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(ts[i]).toFixed(1)},${y(p.weight).toFixed(1)}`).join(" ");
  const area = `${d} L${x(ts.at(-1)).toFixed(1)},${H - B} L${x(ts[0]).toFixed(1)},${H - B} Z`;
  const dots = points.map((p, i) => `<circle class="dot" cx="${x(ts[i]).toFixed(1)}" cy="${y(p.weight).toFixed(1)}" r="${i === points.length - 1 ? 4.5 : 2.5}"/>`).join("");
  const last = points.at(-1);
  const lx = Math.min(x(ts.at(-1)), W - R - 2);
  const short = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: ${kg(points[0].weight)} to ${kg(last.weight)} over ${points.length} sessions">
    ${grid.join("")}
    <path class="area" d="${area}"/><path class="line" d="${d}"/>${dots}
    <text class="value" x="${lx}" y="${y(last.weight) - 10}" text-anchor="end">${kg(last.weight)}</text>
    <text class="axis" x="${L}" y="${H - 6}">${esc(short(points[0].date))}</text>
    <text class="axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(short(last.date))}</text>
  </svg>`;
}

function progressView() {
  const assistNames = [...new Set(state.history.flatMap((h) => h.exercises.filter((e) => e.type === "assist" && e.weight > 0).map((e) => e.name)))];
  const keys = [...Object.keys(LIFTS), ...assistNames];
  if (!keys.includes(ui.progressKey)) ui.progressKey = "squat";
  const label = (k) => LIFTS[k]?.name ?? k;
  const chips = keys.map((k) => `<button class="chip" data-action="progress-key" data-key="${esc(k)}" aria-pressed="${k === ui.progressKey}">${esc(label(k))}</button>`).join("");
  const points = liftSeries(state.history, ui.progressKey);
  const stats = points.length
    ? `<div class="stats">
        <div><span class="small muted">Start</span><strong>${kg(points[0].weight)}</strong></div>
        <div><span class="small muted">Latest</span><strong>${kg(points.at(-1).weight)}</strong></div>
        <div><span class="small muted">Gained</span><strong>${points.at(-1).weight - points[0].weight >= 0 ? "+" : ""}${kg(points.at(-1).weight - points[0].weight)}</strong></div>
        <div><span class="small muted">Sessions</span><strong>${points.length}</strong></div>
      </div>` : "";
  return `<div class="row between head"><h2>Progress</h2>${streakBadge()}</div>
    <div class="chips" role="group" aria-label="Lift">${chips}</div>
    <div class="card">${chartSvg(points, label(ui.progressKey))}${stats}</div>
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
  const rows = Object.keys(LIFTS).map((id) => {
    const best = bestOneRepMax(state.history, id);
    const e1rm = best || estimateOneRepMax(state.lifts[id].weight, LIFTS[id].reps);
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
  return `<h2>Strength standards</h2>
    <div class="card">
      <p class="small muted">${kg(p.bodyweight)} · ${p.sex === "male" ? "men's" : "women's"} standards. Your estimated 1-rep max is compared with rough bodyweight multiples for Beginner → Novice → Intermediate → Advanced → Elite.</p>
      ${rows}
      ${Object.keys(LIFTS).some((id) => !bestOneRepMax(state.history, id)) ? `<p class="small muted">* Estimated from your working weight until you log a session.</p>` : ""}
      <details class="small"><summary>Edit bodyweight</summary>${profileFields()}</details>
    </div>`;
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

// ---------- settings ----------

function settingsView() {
  const s = state.settings;
  const step = loadStep(s);
  const field = (label, name, value, attrs = "") =>
    `<label class="field"><span>${esc(label)}</span><input type="number" inputmode="decimal" id="set-${esc(name)}" name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
  return `<h2>Settings</h2>
    <form class="card" id="settings">
      <h3>You</h3>
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

document.addEventListener("submit", (e) => e.preventDefault());

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
