#!/usr/bin/env bash
# Builds the Android app without Gradle, using Ubuntu's Android packages plus bundletool:
#   apt-get install android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
#   bundletool: https://github.com/google/bundletool/releases (set BUNDLETOOL=/path/to/bundletool-all.jar)
#
# Outputs (in dist/):
#   starkheben-5x5.apk  installable directly, signed with the local debug key (android/debug.keystore)
#   starkheben-5x5.aab  for Google Play, signed with the upload key when UPLOAD_KEYSTORE is set
#                       (UPLOAD_KEYSTORE, UPLOAD_KEY_ALIAS, UPLOAD_STORE_PASS)
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
AAPT2="${AAPT2:-/usr/lib/android-sdk/build-tools/debian/aapt2}"
KEYSTORE="${KEYSTORE:-debug.keystore}"
OUT=build
DIST=../dist
rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/assets" "$DIST"

# 1. Web app, bundled into a single page, without server settings (data stays on the device).
node ../scripts/build-single.mjs --standalone --offline "$OUT/assets/index.html"

# 2. Resources. Linked twice: binary for the APK, protobuf for the app bundle.
"$AAPT2" compile --dir res -o "$OUT/res.zip"
link() { "$AAPT2" link -I "$ANDROID_JAR" --manifest AndroidManifest.xml -A "$OUT/assets" --auto-add-overlay "$@" "$OUT/res.zip"; }
link -o "$OUT/binary.apk" --java "$OUT/gen"
link -o "$OUT/proto.apk" --proto-format

# 3. Java → classes → dex.
javac -nowarn --release 8 -classpath "$ANDROID_JAR" -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')
dalvik-exchange --dex --min-sdk-version=21 --output="$OUT/classes.dex" "$OUT/classes"

# 4. APK: add the dex, align, sign. A local debug key is created on first build.
cp "$OUT/binary.apk" "$OUT/unaligned.apk"
(cd "$OUT" && zip -q -j unaligned.apk classes.dex)
zipalign -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias starkheben -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Starkheben 5x5 Debug" 2>/dev/null
fi
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --ks-key-alias starkheben --out "$DIST/starkheben-5x5.apk" "$OUT/aligned.apk"
apksigner verify "$DIST/starkheben-5x5.apk"
rm -f "$DIST/starkheben-5x5.apk.idsig"

# 5. App bundle: rearrange the protobuf APK into a bundle module, then let bundletool build the .aab.
if [ -n "${BUNDLETOOL:-}" ]; then
  mkdir -p "$OUT/module/manifest" "$OUT/module/dex"
  (cd "$OUT/module" && unzip -q ../proto.apk)
  mv "$OUT/module/AndroidManifest.xml" "$OUT/module/manifest/"
  cp "$OUT/classes.dex" "$OUT/module/dex/"
  (cd "$OUT/module" && zip -q -r ../base.zip .)
  rm -f "$DIST/starkheben-5x5.aab"
  java -jar "$BUNDLETOOL" build-bundle --modules="$OUT/base.zip" --output="$DIST/starkheben-5x5.aab"
  if [ -n "${UPLOAD_KEYSTORE:-}" ]; then
    jarsigner -keystore "$UPLOAD_KEYSTORE" -storepass "$UPLOAD_STORE_PASS" -sigalg SHA256withRSA -digestalg SHA-256 \
      "$DIST/starkheben-5x5.aab" "${UPLOAD_KEY_ALIAS:-upload}" >/dev/null
    echo "Signed the bundle with the upload key."
  else
    echo "Bundle is unsigned: set UPLOAD_KEYSTORE to sign it for Google Play."
  fi
  echo "Built $(cd "$DIST" && pwd)/starkheben-5x5.aab"
else
  echo "Skipped the app bundle: set BUNDLETOOL to bundletool-all.jar to build it."
fi
echo "Built $(cd "$DIST" && pwd)/starkheben-5x5.apk"
