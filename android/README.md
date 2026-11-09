# GnomeShell Scan (Android)

The phone half of GnomeShell's photo scanning. It walks you round the object
taking photos, then sends them over Wi-Fi to GnomeShell on your PC, which
builds the 3D model (`engine/photoscan.py`) and opens it as a scan.

## Install on the phone

1. Get `GnomeShellScan.apk` onto the phone (email it to yourself, or copy it
   over USB, or download it from the GitHub release).
2. Tap it. Android asks to allow installs from that app (Files, Gmail or
   Chrome): allow it, go back and tap Install.
3. Samsung may show "Unsafe app blocked" or a Play Protect warning, because the
   app isn't from the Play Store. Choose **More details > Install anyway**.

Needs Android 8 or newer, a back camera and the motion sensors every phone has.

## Using it

See **PHONE SCANS** in `READ ME.txt`. In short: print the scan sheet from
GnomeShell, stand the object on it, press **New scan**, walk round until the
three rings on the dial are full, press **Done**, then **Send to GnomeShell**.

## How it talks to the PC

- The app broadcasts `GNOMESHELL_SCAN_FIND` on UDP port 8771. GnomeShell
  answers with its port (8770).
- Photos go up as `PUT /phone/scans/<id>/photos/<name>` over plain HTTP on the
  home network. Every request carries the 6-digit code shown in GnomeShell's
  Phone scans panel (`X-GnomeShell-Code`), so other devices on the Wi-Fi
  can't send to it. After 30 wrong codes in 10 minutes it stops taking any.
- Photos are saved in the sensor's own orientation (`JPEG_ORIENTATION` 0), so
  they all share one set of lens settings for the reconstruction.

## Building the APK

No Gradle or Android Studio needed. On Ubuntu:

```
sudo apt install openjdk-17-jdk-headless aapt dalvik-exchange zipalign apksigner
android/build.sh
```

The APK lands in `android/build/GnomeShellScan.apk`. `build.sh` downloads an
`android.jar` (API 34) if `ANDROID_JAR` doesn't point at one.

It signs with `android/gnomeshell-scan.keystore`, made on the first build and
kept out of git. Use the same keystore for every build so a new APK installs
over the old one; a build signed with a different key has to be uninstalled
from the phone first (which deletes scans still on the phone).
