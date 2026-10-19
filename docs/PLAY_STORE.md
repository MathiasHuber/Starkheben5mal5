# Publishing Starkheben 5×5 on Google Play

Everything the store needs is in this repository:

| What | Where |
|---|---|
| App bundle to upload | `dist/starkheben-5x5.aab` (built by `android/build.sh`, signed with your upload key) |
| App icon 512×512 | `store/icon-512.png` |
| Feature graphic 1024×500 | `store/feature-graphic.png` |
| Phone screenshots 1080×1920 | `store/screenshots/` (6 images, example data) |
| Privacy policy | `https://mathiashuber.github.io/Starkheben5mal5/privacy.html` (needs GitHub Pages on) |

App details: package name `app.starkheben.fivebyfive` (permanent once published), version 1.0 (versionCode 5), targets Android 16 (API 36), runs on Android 5.0+.

## Keep these safe: the upload key

The bundle is signed with an **upload key** (`starkheben-upload.jks`, alias `upload`, plus its password). Google re-signs the app for users with its own app signing key, so the upload key only proves updates come from you.

- Store the `.jks` file and its password somewhere safe, such as a password manager. Don't put them in the repository.
- If you lose it, Play Console lets you request an upload key reset (Setup → App signing). That takes a few days but your app is not lost.
- To build signed updates yourself:
  `BUNDLETOOL=bundletool-all.jar UPLOAD_KEYSTORE=starkheben-upload.jks UPLOAD_STORE_PASS=… ./android/build.sh`
  Raise `android:versionCode` in `android/AndroidManifest.xml` for every upload.

## 1. Developer account (one time)

1. Go to [play.google.com/console](https://play.google.com/console) and sign up. A one-time fee of US$25 applies.
2. Choose a **personal** account and complete identity verification. This can take a few days.
3. Personal accounts created after November 2023 must run a **closed test with at least 12 testers for 14 days** before they can publish to everyone. See step 5.

## 2. Create the app

**Create app** → name `Starkheben 5×5`, default language English (or German), **App**, **Free** → accept the declarations → **Create app**.

## 3. Store listing (Grow → Store presence → Main store listing)

- **App name:** `Starkheben 5×5`
- **Short description** (80 characters max):
  `Simple 5×5 barbell training: workouts, rest timer, progress and calendar.`
- **Full description:**

  ```
  Starkheben 5×5 is a simple tracker for 5×5 barbell strength training.

  Two workouts, A and B: squat, bench press and barbell row; squat, overhead press and deadlift. Log your sets with a tap and the app works out your next weights.

  • Automatic progression: make all your reps and the weight goes up next time
  • Deload when you need it: after missed reps, one tap takes 10% off, rounded to plates you can load
  • Rest timer that beeps and vibrates when it's time for the next set
  • Plate calculator and warm-up sets for every lift
  • Weekly schedule: pick your training days, 2 or 3 per week, or fix a workout per weekday
  • Calendar: see done and planned workouts, move a single workout, add past workouts
  • Progress graphs for every lift
  • Strength standards: see how close you are to the next level for your bodyweight
  • Workout editor: reorder exercises, add assistance work, or use a top set with back-off sets
  • Week streak to keep you consistent
  • Light and dark mode

  Private by design: no account, no ads, no tracking and no internet access. Your data stays on your phone. Export it to a file whenever you like and import it again on another device.
  ```

- **App icon:** `store/icon-512.png`
- **Feature graphic:** `store/feature-graphic.png`
- **Phone screenshots:** all six from `store/screenshots/`, in order.
- **Category:** Health & Fitness. **Contact email:** your email (required, shown on the listing).

Don't mention other apps' names (such as StrongLifts) in the listing. "5×5" itself is a generic term for the training method.

## 4. App content (Policy → App content)

Answer each section:

- **Privacy policy:** `https://mathiashuber.github.io/Starkheben5mal5/privacy.html`
- **Ads:** No, the app doesn't contain ads.
- **App access:** All functionality is available without special access.
- **Content rating:** start the questionnaire, category **Utility, Productivity, Communication or Other** (or "Health & fitness" if offered), answer **No** to everything (violence, sexuality, gambling, user interaction, sharing location, purchases). Result: Everyone / PEGI 3.
- **Target audience:** 18 and over (or 13+ if you prefer). Not designed for children.
- **Data safety:**
  - Does your app collect or share any of the required user data types? **No**
  - (The app has no internet permission, so it can't send data anywhere.)
- **Health apps declaration** (if asked): the app is a fitness/activity tracker for strength training. It does not use Health Connect and makes no medical claims.
- **Government app / financial features / news:** No.

## 5. Testing, then production

1. **Testing → Closed testing → Create track** (e.g. "Friends").
2. **Testers:** add an email list with at least 12 people (Gmail addresses) who'll install it. They opt in via the link Play shows you.
3. **Create release** → upload `dist/starkheben-5x5.aab` → the first time, accept **Play App Signing** (Google manages the app signing key) → release name `1.0` → release notes, e.g. "First release." → **Review and roll out**.
4. Keep the test running for 14 days with at least 12 opted-in testers.
5. Then **Production → Create release**, add the same (or a newer) bundle and roll out. Google reviews new apps, which usually takes a few days.

## Moving your data to the Play version

The version from Play is signed by Google, so it can't install over the APK you sideloaded. Before switching:

1. In the old app, open **Settings → Export data** and save the file.
2. Uninstall the old app, install from Play.
3. In the new app, open **Settings → Import data** and pick the file.

The same export file also moves data between the web version and the Android app, in either direction.
