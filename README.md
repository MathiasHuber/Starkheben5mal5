# Starkheben 5×5

A small, offline-first web app for running a 5×5 barbell strength program. No build step, no dependencies, no account. Data stays in your browser.

## The program

Two workouts, A and B:

| Workout A | Workout B |
|---|---|
| Squat 5×5 | Squat 5×5 |
| Bench Press 5×5 | Overhead Press 5×5 |
| Barbell Row 5×5 | Deadlift 1×5 |

- **Made every rep:** the lift goes up next time (+2.5 kg, deadlift +5 kg).
- **Missed reps:** the weight stays the same. A **Deload** button appears, which takes 10% off and rounds down to a weight you can load on the bar. Use it or ignore it and try the weight again. After 3 misses in a row the app recommends deloading.
- An exercise with no sets logged counts as skipped and doesn't change.

All weights are in kg. All the numbers above can be changed in Settings.

## Features

- **Today:** today's planned workout with weights, or the next one if it's a rest day. You can also train any day, or do the other workout instead.
- **Logging:** tap a set circle to log full reps; tap again to lower the count. Plate calculator (tap the weight), warm-up sets, and − / + to adjust today's weight.
- **Rest timer:** counts up and beeps at 1:30 and 3:00 after a made set, or 5:00 after a miss.
- **Schedule (Program tab):** either pick training days and let A/B alternate across them, or set a fixed workout per weekday. Any number of days works, including 2 per week. A change applies from today; past weeks keep their old schedule.
- **Calendar:** a month view of done, planned, moved and missed workouts. Tap a day to move that one workout to another date; the weekly schedule stays the same. "Put back" undoes a move.
- **Streak:** the flame counts weeks in a row in which every scheduled workout was done. Moved workouts count in the week they land in. The current week counts once it's complete.
- **Workout templates:** reorder exercises in A and B, switch a main lift between straight 5×5 and top set + back-off (1×5 top, then 4×5 at −10% by default), and add assistance work. The dropdown has the standard 5×5 assistance exercises (pull-ups, chin-ups, dips, skullcrushers, curls, hanging knee raises, planks, Romanian deadlifts, hip thrusts), or type your own.
- **Progress:** a weight graph per lift (and per weighted assistance exercise).
- **Strength standards:** enter bodyweight and sex. For each lift, the app compares your estimated 1-rep max with bodyweight-multiple milestones (Beginner → Novice → Intermediate → Advanced → Elite) and shows the % reached toward the next one. These standards are rough guides.
- **Backup:** copy/paste JSON backup and restore. Data saved by older versions, including lb data, is upgraded automatically.

## Run it

Any static file server works. The service worker needs `http://localhost` or HTTPS.

```bash
npm start          # serves on http://localhost:8080
npm test           # program logic tests (Node 20+)
```

To use it on a phone, host the folder on any static host (for example GitHub Pages) and use "Add to Home Screen".

## Android app

`android/` wraps the app in a small native WebView shell. It loads the bundled page from inside the APK, needs no internet permission, and runs fully offline. It's built without Gradle, using Ubuntu's Android packages:

```bash
sudo apt-get install android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
./android/build.sh        # → dist/starkheben-5x5.apk
```

The first build creates a local signing key, `android/debug.keystore` (not committed). Keep it: Android only installs an update over an existing install when both are signed with the same key. With a new key, uninstall first, which deletes the app's data, so save a backup in Settings before that.

## Layout

- `src/program.js`: program logic (progression, deloads, set schemes, templates, plates, warm-ups, data migration and validation)
- `src/schedule.js`: schedules, calendar, rescheduling and streaks
- `src/standards.js`: strength standards and 1RM estimates
- `src/app.js`: UI, storage and rest timer
- `tests/`: unit tests for the logic modules
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline and install support
- `scripts/build-single.mjs`: bundles everything into one HTML file
- `android/`: native Android shell and its build script

This is an independent app built from the publicly known 5×5 method. It isn't affiliated with or derived from any commercial 5×5 app.
