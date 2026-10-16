# Starkheben 5×5

A small, offline-first web app for running a 5×5 barbell strength program. No build step, no dependencies, no account. Data stays in your browser.

## The program

Two workouts, alternated every session (three sessions a week, with a rest day between):

| Workout A | Workout B |
|---|---|
| Squat 5×5 | Squat 5×5 |
| Bench Press 5×5 | Overhead Press 5×5 |
| Barbell Row 5×5 | Deadlift 1×5 |

- **Made every rep:** the lift goes up next time (+2.5 kg, deadlift +5 kg; +5 / +10 lb).
- **Missed reps:** repeat the same weight next time.
- **Missed three sessions in a row:** deload by 10% (rounded down to a loadable weight, never below the bar).
- An exercise with no sets logged counts as skipped and doesn't change.

All of these numbers are adjustable in Settings.

## Features

- Tap a set circle to log 5 reps; tap again to lower the count (5 → 4 → … → 0 → empty).
- Rest timer after each set: counts up and beeps (and vibrates) at 1:30 and 3:00 after a made set, or at 5:00 after a missed one.
- Plate calculator (tap the weight) and warm-up sets for each lift.
- Adjust today's weight with − / +.
- History with per-lift progress charts.
- kg or lb, with conversion of your current weights.
- Export and import a JSON backup.
- Installable as an app on your phone and works offline (service worker).

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

- `src/program.js`: pure program logic (progression, deloads, plates, warm-ups, unit conversion, import validation)
- `src/app.js`: UI, storage and rest timer
- `tests/program.test.js`: unit tests for the logic
- `sw.js`, `manifest.webmanifest`, `icon.svg`: offline and install support
- `scripts/build-single.mjs`: bundles everything into one HTML file
- `android/`: native Android shell and its build script

This is an independent app built from the publicly known 5×5 method. It isn't affiliated with or derived from any commercial 5×5 app.
