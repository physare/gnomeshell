# GnomeShell

GnomeShell builds 3D-printed mother-mold shells around latex mold scans. It runs on Windows with Blender 5.2: Blender does the geometry in the background, and the app opens in its own window.

## Install

**[Download GnomeShell-Setup.bat](https://github.com/physare/gnomeshell/releases/latest/download/GnomeShell-Setup.bat)** and double-click it. Setup does the following:

- installs the newest GnomeShell for your Windows user (no administrator rights needed)
- checks for Blender 5.2, and if it's missing, offers to download and set it up next to GnomeShell (about 400 MB)
- adds GnomeShell to the desktop and the Start menu, then opens it

Windows may warn that the file isn't commonly downloaded. Choose **Keep**, then **More info > Run anyway**.

To install by hand instead, click **Code > Download ZIP**, unzip it somewhere it can stay, and run `Make desktop shortcut.bat`. You also need [Blender 5.2](https://www.blender.org/download/). `READ ME.txt` covers everything the app does.

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
