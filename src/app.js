import {
  LIFTS, WORKOUTS, createState, startWorkout, finishWorkout, cycleSet, exerciseResult,
  platesPerSide, warmupSets, restTargets, switchUnit, validateState, loadStep,
} from "./program.js";

const STORAGE_KEY = "starkheben5x5";
const app = document.getElementById("app");
const timerEl = document.getElementById("timer");

let state = load();
let view = "workout";
let summary = null; // last finished session, shown once after finishing
const open = { plates: new Set(), warmups: new Set() };
let timer = null; // { start, targets, beeped }

// ---------- persistence ----------

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const valid = validateState(parsed);
      // Reuse the history check to validate an in-progress workout before restoring it.
      const activeOk = parsed.active && validateState({ ...parsed, history: [parsed.active] });
      if (valid) return { ...valid, active: activeOk ? parsed.active : null };
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  return createState();
}

function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

// ---------- helpers ----------

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (w) => `${Number(w.toFixed(2))}`;
const unit = () => state.settings.unit;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const dateLabel = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function platesText(weight) {
  const { plates, remainder } = platesPerSide(weight, state.settings);
  if (!plates.length) return `Empty bar (${fmt(state.settings.bar)} ${unit()})`;
  const extra = remainder > 0 ? ` · ${fmt(remainder)} ${unit()} per side can't be loaded` : "";
  return `Per side: ${plates.map(fmt).join(" + ")}${extra}`;
}

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

// ---------- views ----------

function render() {
  for (const b of document.querySelectorAll(".tabs button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  app.innerHTML = view === "history" ? historyView() : view === "settings" ? settingsView() : workoutView();
}

function workoutView() {
  if (state.active) return activeView(state.active);
  const type = state.nextWorkout;
  const rows = WORKOUTS[type].map((id) => {
    const l = LIFTS[id];
    const fails = state.lifts[id].failures;
    return `<div class="row between" style="padding:6px 0">
      <span>${esc(l.name)} <span class="muted small">${l.sets}×${l.reps}</span></span>
      <span><strong>${fmt(state.lifts[id].weight)}</strong> ${esc(unit())}${fails ? ` <span class="tag repeat">${fails}× missed</span>` : ""}</span>
    </div>`;
  }).join("");
  return `${summary ? summaryCard(summary) : ""}
    <h2>Next: Workout ${esc(type)}</h2>
    <div class="card">${rows}</div>
    <button class="btn primary block" data-action="start">Start workout ${esc(type)}</button>
    <p class="muted small">${state.history.length} workouts completed.</p>`;
}

function summaryCard(s) {
  const label = { increase: "+ next time", repeat: "repeat", deload: "deload", none: "skipped" };
  const rows = s.exercises.map((ex) => `
    <div class="row between" style="padding:4px 0">
      <span>${esc(LIFTS[ex.liftId].name)}</span>
      <span>${fmt(ex.weight)} → <strong>${fmt(ex.nextWeight)}</strong> ${esc(unit())} <span class="tag ${esc(ex.change)}">${esc(label[ex.change])}</span></span>
    </div>`).join("");
  return `<div class="card"><div class="row between"><strong>Workout ${esc(s.type)} done</strong>
    <button class="btn link" data-action="dismiss-summary">Close</button></div>${rows}</div>`;
}

function activeView(session) {
  const step = loadStep(state.settings);
  const cards = session.exercises.map((ex, i) => {
    const lift = LIFTS[ex.liftId];
    const sets = ex.sets.map((r, j) => {
      const cls = r === null ? "" : r >= lift.reps ? "done" : "miss";
      const aria = `${lift.name} set ${j + 1}: ${r === null ? "not done" : `${r} reps`}`;
      return `<button class="set ${cls}" data-action="set" data-ex="${i}" data-set="${j}" aria-label="${esc(aria)}">${r === null ? "" : r}</button>`;
    }).join("");
    const warm = open.warmups.has(i)
      ? `<ul class="warmups">${warmupSets(ex.liftId, ex.weight, state.settings).map((w) =>
          `<li>${w.reps} × ${fmt(w.weight)} ${esc(unit())}</li>`).join("") || "<li>No warm-up needed</li>"}</ul>`
      : "";
    return `<div class="card">
      <div class="row between">
        <div>
          <div class="lift-name">${esc(lift.name)} <span class="muted small">${lift.sets}×${lift.reps}</span></div>
          <button class="weight" data-action="plates" data-ex="${i}" aria-expanded="${open.plates.has(i)}">${fmt(ex.weight)} <small>${esc(unit())}</small></button>
        </div>
        <div class="row">
          <button class="btn icon" data-action="weight" data-ex="${i}" data-delta="${-step}" aria-label="Lower ${esc(lift.name)} weight">−</button>
          <button class="btn icon" data-action="weight" data-ex="${i}" data-delta="${step}" aria-label="Raise ${esc(lift.name)} weight">+</button>
        </div>
      </div>
      ${open.plates.has(i) ? `<div class="plates">${esc(platesText(ex.weight))}</div>` : ""}
      <div class="sets">${sets}</div>
      <div class="row between" style="margin-top:6px">
        <span class="set-label">Tap a set when done, tap again to lower reps</span>
        <button class="btn link small" data-action="warmups" data-ex="${i}">${open.warmups.has(i) ? "Hide" : "Warm-up"}</button>
      </div>
      ${warm}
    </div>`;
  }).join("");
  return `<h2>Workout ${esc(session.type)} <span class="muted small">${esc(dateLabel(session.date))}</span></h2>
    ${cards}
    <button class="btn primary block" data-action="finish">Finish workout</button>
    <div style="text-align:center"><button class="btn link" data-action="cancel">Discard workout</button></div>`;
}

function chart(id) {
  const points = state.history
    .flatMap((h) => h.exercises.filter((e) => e.liftId === id && e.result !== "skipped").map((e) => ({ t: h.date, w: e.weight })))
    .reverse();
  if (points.length < 2) return `<p class="muted small">Not enough data yet.</p>`;
  const ws = points.map((p) => p.w);
  const min = Math.min(...ws), max = Math.max(...ws), span = max - min || 1;
  const x = (i) => (i / (points.length - 1)) * 100;
  const y = (w) => 36 - ((w - min) / span) * 32;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p.w).toFixed(2)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 100 40" preserveAspectRatio="none" role="img"
      aria-label="${esc(LIFTS[id].name)} from ${fmt(points[0].w)} to ${fmt(ws.at(-1))} ${esc(unit())}"><path d="${d}"/></svg>
    <div class="row between small muted"><span>${fmt(points[0].w)}</span><span>${fmt(ws.at(-1))} ${esc(unit())}</span></div>`;
}

function historyView() {
  if (!state.history.length) return `<h2>History</h2><p class="muted">Finish a workout to see it here.</p>`;
  const charts = Object.keys(LIFTS).map((id) => `<div class="card"><div class="lift-name">${esc(LIFTS[id].name)}</div>${chart(id)}</div>`).join("");
  const entries = state.history.map((h) => `
    <div class="card">
      <div class="row between"><strong>Workout ${esc(h.type)}</strong><span class="muted small">${esc(dateLabel(h.date))}</span></div>
      ${h.exercises.map((ex) => `
        <div class="row between" style="padding:4px 0">
          <span>${esc(LIFTS[ex.liftId].name)} ${fmt(ex.weight)} ${esc(unit())}</span>
          <span class="history-sets">${ex.sets.map((r) => (r === null ? "–" : r)).join(" / ")}</span>
        </div>`).join("")}
    </div>`).join("");
  return `<h2>Progress</h2>${charts}<h2>Sessions</h2>${entries}`;
}

function settingsView() {
  const s = state.settings;
  const step = loadStep(s);
  const field = (label, name, value, attrs = "") =>
    `<label class="field"><span>${esc(label)}</span><input type="number" inputmode="decimal" name="${esc(name)}" value="${esc(value)}" ${attrs}></label>`;
  return `<h2>Settings</h2>
    <form class="card" id="settings">
      <label class="field"><span>Units</span>
        <select name="unit"><option value="kg" ${s.unit === "kg" ? "selected" : ""}>kg</option><option value="lb" ${s.unit === "lb" ? "selected" : ""}>lb</option></select>
      </label>
      ${field(`Bar weight (${s.unit})`, "bar", s.bar, `min="0" step="any"`)}
      ${field("Deload after misses in a row", "failuresBeforeDeload", s.failuresBeforeDeload, `min="1" step="1"`)}
      ${field("Deload by (%)", "deloadPercent", s.deloadPercent, `min="0" max="50" step="1"`)}
      ${field("Rest if easy (s)", "rest.easy", s.rest.easy, `min="0" step="15"`)}
      ${field("Rest if hard (s)", "rest.hard", s.rest.hard, `min="0" step="15"`)}
      ${field("Rest after miss (s)", "rest.failed", s.rest.failed, `min="0" step="15"`)}
      <h2>Working weights (${esc(s.unit)})</h2>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `weight.${id}`, state.lifts[id].weight, `min="0" step="${step}"`)).join("")}
      <h2>Increase per success (${esc(s.unit)})</h2>
      ${Object.keys(LIFTS).map((id) => field(LIFTS[id].name, `inc.${id}`, s.increments[id], `min="0" step="any"`)).join("")}
      <p class="muted small">Plates: ${s.plates.map(fmt).join(", ")} ${esc(s.unit)}</p>
    </form>
    <h2>Data</h2>
    <div class="card row wrap">
      <button class="btn" data-action="export">Export backup</button>
      <label class="btn">Import backup<input type="file" accept="application/json" id="import" hidden></label>
      <button class="btn" data-action="reset">Reset everything</button>
    </div>
    <p class="muted small">Your data stays in this browser. Export a backup before clearing site data.</p>`;
}

// ---------- events ----------

document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  view = b.dataset.view;
  render();
  window.scrollTo(0, 0);
});

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const i = Number(el.dataset.ex);
  const toggle = (set) => (set.has(i) ? set.delete(i) : set.add(i));
  switch (el.dataset.action) {
    case "start":
      state.active = startWorkout(state);
      summary = null;
      open.plates.clear();
      open.warmups.clear();
      break;
    case "set": {
      const ex = state.active.exercises[i];
      const target = LIFTS[ex.liftId].reps;
      const j = Number(el.dataset.set);
      ex.sets[j] = cycleSet(ex.sets[j], target);
      const isLastSetOfWorkout = i === state.active.exercises.length - 1 && j === ex.sets.length - 1;
      if (ex.sets[j] === null || isLastSetOfWorkout) stopTimer();
      else startTimer(ex.sets[j], target);
      break;
    }
    case "weight": {
      const ex = state.active.exercises[i];
      ex.weight = Math.max(0, Math.round((ex.weight + Number(el.dataset.delta)) * 100) / 100);
      break;
    }
    case "plates": toggle(open.plates); break;
    case "warmups": toggle(open.warmups); break;
    case "finish": {
      const unlogged = state.active.exercises.filter((ex) => exerciseResult(ex) !== "success" && ex.sets.some((r) => r === null));
      if (unlogged.length && !confirm("Some sets aren't logged. Unlogged sets count as missed. Finish anyway?")) return;
      state = finishWorkout(state, state.active);
      summary = state.history[0];
      stopTimer();
      break;
    }
    case "cancel":
      if (!confirm("Discard this workout? Nothing will be saved.")) return;
      state.active = null;
      stopTimer();
      break;
    case "dismiss-summary": summary = null; break;
    case "stop-timer": stopTimer(); return;
    case "export": exportData(); return;
    case "reset":
      if (!confirm("Delete all workouts and settings?")) return;
      state = createState(state.settings.unit);
      summary = null;
      stopTimer();
      break;
    default: return;
  }
  save();
  render();
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "import") return importData(e.target.files[0]);
  const form = e.target.closest("#settings");
  if (!form) return;
  const { name, value } = e.target;
  if (name === "unit") {
    state = switchUnit(state, value);
  } else {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return render();
    const [group, key] = name.split(".");
    if (group === "weight") state.lifts[key] = { ...state.lifts[key], weight: n };
    else if (group === "inc") state.settings.increments[key] = n;
    else if (group === "rest") state.settings.rest[key] = n;
    else if (name === "failuresBeforeDeload") state.settings.failuresBeforeDeload = Math.max(1, Math.round(n));
    else if (name in state.settings) state.settings[name] = n;
  }
  save();
  render();
});

function exportData() {
  const blob = new Blob([JSON.stringify({ ...state, active: null }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `starkheben-5x5-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  if (!file) return;
  try {
    const data = validateState(JSON.parse(await file.text()));
    if (!data) throw new Error("invalid");
    if (!confirm(`Replace current data with this backup (${data.history.length} workouts)?`)) return;
    state = data;
    summary = null;
    save();
    render();
  } catch {
    alert("That file isn't a valid backup.");
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

render();
