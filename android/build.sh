#!/usr/bin/env bash
# Builds GnomeShell Scan (the Android app) into build/GnomeShellScan.apk without
# Gradle or Android Studio. Needs: a JDK (javac), aapt, dalvik-exchange (dx),
# zipalign and apksigner (Ubuntu: apt install aapt dalvik-exchange zipalign
# apksigner), and an android.jar for API 34 (ANDROID_JAR, or it's downloaded).
#
# The app is signed with android/gnomeshell-scan.keystore so each new build
# installs over the last one. Keep that file: a build signed with another key
# has to be uninstalled first.
set -euo pipefail
cd "$(dirname "$0")"
OUT=build
JAR="${ANDROID_JAR:-$OUT/android-34.jar}"
mkdir -p "$OUT"
if [ ! -f "$JAR" ]; then
  echo "Downloading android.jar (API 34)"
  curl -sSL -o "$JAR" https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar
fi
DX=$(command -v dalvik-exchange || command -v dx)
rm -rf "$OUT/gen" "$OUT/classes" "$OUT/dex" "$OUT"/*.apk
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "Resources"
aapt package -f -m -J "$OUT/gen" -M AndroidManifest.xml -S res -I "$JAR" \
  --min-sdk-version 26 --target-sdk-version 34 -F "$OUT/unsigned.apk"

echo "Java"
javac -nowarn -Xlint:-options -source 8 -target 8 -encoding UTF-8 -bootclasspath "$JAR" \
  -d "$OUT/classes" $(find src "$OUT/gen" -name '*.java')

echo "Dex"
"$DX" --dex --min-sdk-version=26 --output="$OUT/dex/classes.dex" "$OUT/classes"
(cd "$OUT/dex" && zip -q -u ../unsigned.apk classes.dex)

echo "Sign"
KS=gnomeshell-scan.keystore
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass gnomeshell -keypass gnomeshell -alias scan \
    -keyalg RSA -keysize 2048 -validity 20000 -dname "CN=GnomeShell Scan" >/dev/null 2>&1
fi
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"
apksigner sign --ks "$KS" --ks-pass pass:gnomeshell --key-pass pass:gnomeshell --ks-key-alias scan \
  --min-sdk-version 26 --out "$OUT/GnomeShellScan.apk" "$OUT/aligned.apk"
apksigner verify "$OUT/GnomeShellScan.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk"
ls -la "$OUT/GnomeShellScan.apk"
