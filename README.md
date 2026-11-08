# GnomeShell

GnomeShell builds 3D-printed mother-mold shells around latex mold scans. It runs on Windows with Blender 5.2: Blender does the geometry in the background, and the app opens in its own window.

## Install

1. Click **Code > Download ZIP** on this page, or use the `GnomeShell.zip` you were sent.
2. Unzip it somewhere it can stay.
3. Double-click `Make desktop shortcut.bat` once, then start GnomeShell from the shortcut.

`READ ME.txt` covers everything the app does.

## Updates

When GnomeShell opens, it reads `version.json` from this repo's `main` branch. If that version is newer than the one running, an **Update** button appears at the top right. Clicking it downloads `main` as a zip, unpacks it over the app folder and restarts the app. Your scans and settings stay where they are, in `Documents\Mold Shells`.

## Publishing a version

1. Bump the version in four places so they match:
   - `APP_VERSION` in `engine/server.py`
   - `APP_VERSION` in `web/app.js`
   - `"version"` in `engine/mold_shell.py`
   - `version.json`, along with its short `notes`
2. Push to `main`. Every copy of the app offers the update the next time it opens.

Inter is bundled under the SIL Open Font License (`web/vendor/fonts/Inter-LICENSE.txt`).
