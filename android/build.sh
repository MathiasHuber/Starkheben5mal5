#!/usr/bin/env bash
# Builds a signed APK without Gradle, using Ubuntu's Android packages:
#   apt-get install android-sdk-platform-23 aapt dalvik-exchange zipalign apksigner
# Output: dist/starkheben-5x5.apk
set -euo pipefail
cd "$(dirname "$0")"

ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
KEYSTORE="${KEYSTORE:-debug.keystore}"
OUT=build
APK=../dist/starkheben-5x5.apk

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/assets" ../dist

# 1. Web app, bundled into a single page.
node ../scripts/build-single.mjs --standalone "$OUT/assets/index.html"

# 2. Resources + manifest (also generates R.java).
aapt package -f -m -J "$OUT/gen" -M AndroidManifest.xml -S res -A "$OUT/assets" \
  -I "$ANDROID_JAR" -F "$OUT/unaligned.apk"

# 3. Java → classes → dex.
javac -nowarn --release 8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')
dalvik-exchange --dex --output="$OUT/classes.dex" "$OUT/classes"
(cd "$OUT" && aapt add unaligned.apk classes.dex >/dev/null)

# 4. Align and sign. A local debug key is created on first build; keep it to install updates over this version.
zipalign -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -noprompt -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias starkheben -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Starkheben 5x5 Debug" 2>/dev/null
fi
apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --ks-key-alias starkheben --out "$APK" "$OUT/aligned.apk"
apksigner verify "$APK"
echo "Built $(cd ../dist && pwd)/starkheben-5x5.apk"
