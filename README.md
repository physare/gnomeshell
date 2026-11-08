# GnomeShell

GnomeShell builds 3D-printed mother-mold shells around latex mold scans. It runs on Windows with Blender 5.2: Blender does the geometry in the background, and the app opens in its own window.

## Install

1. Download `GnomeShell.zip` from the [latest release](https://github.com/physare/gnomeshell/releases/latest).
2. Unzip it somewhere it can stay.
3. Double-click `Make desktop shortcut.bat` once, then start GnomeShell from the shortcut.

`READ ME.txt` covers everything the app does.

## Updates

When GnomeShell opens, it checks this repo's latest release. If a newer version is out, an **Update** button appears at the top right. Clicking it downloads the release's `GnomeShell.zip`, unpacks it over the app folder and restarts the app. Your scans and settings stay where they are, in `Documents\Mold Shells`.

## Publishing a release

Bump the version in three places so they match:

- `APP_VERSION` in `engine/server.py`
- `APP_VERSION` in `web/app.js`
- `"version"` in `engine/mold_shell.py`

Then create a release tagged `vX.Y.Z` and attach `GnomeShell.zip`. The zip holds this repo's files at its top level, with no enclosing folder.

Inter is bundled under the SIL Open Font License (`web/vendor/fonts/Inter-LICENSE.txt`).
