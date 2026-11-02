# Fusion for foobar2000

A Groove-style interface for foobar2000 v2 (64-bit), built as a theme for the
[foo_ui_webview2](https://github.com/NereaFantasia/foo_ui_webview2) component.

Fusion 3 is a from-scratch rewrite of NadirP's
[Fusion](https://www.deviantart.com/nadirp) skin (v2.4.1.1, 2015), which needed
WSH Panel Mod and UI Hacks. Neither exists for 64-bit foobar2000. The layout,
colours and behaviour follow the original. The code, icons and artwork are all
new.

## Features

- **Albums, Artists, Genres and Songs** views of any playlist. The Collection
  autoplaylist shows the whole media library.
- **Expand in place**: click an album to open its track list under the row,
  over a blurred copy of the cover.
- Artists and Genres open into their albums. Search filters the current view.
- **Now playing** with large artwork and the playback queue (or what's up next).
- Player bar with seek, volume, playback order, and a menu that replaces the
  hidden foobar2000 menu bar (the full foobar2000 menu is still there).
- **Multi-disc albums**: a disc bar with each disc's own cover and DISCSUBTITLE,
  shown as separate sections or one disc at a time.
- **Like / dislike**: the heart on each song cycles nothing → Like it (heart) →
  Hate it (broken heart) → nothing, in the `MOOD` tag, the same as the original
  skin; the Favorites autoplaylist lists the liked ones.
- **Playlist manager** (Ctrl+M), standing in for foobar2000's Default UI panel:
  reorder by dragging, multi-select, rename, duplicate, delete, load and save,
  and create or edit autoplaylists.
- Drag albums or songs onto a playlist to add them.
- Track info panel, a pop-up bar for selected songs, light and dark themes, and
  21 accent colours.
- foobar2000's own context menu on tracks and albums (right-click).
- Keyboard shortcuts: Space, Enter, Delete, Ctrl+A/I/F/M/N/P/O, F5,
  Ctrl+Shift+F5 (reload the skin), F11, Alt+A and Esc.

### Performance

- Grouping runs inside foobar2000 (`playlist.getGroupRuns`), off the UI
  thread. The page never downloads the whole library.
- The grid and the song list are virtualised. Only rows near the viewport
  exist, and their nodes are reused while scrolling.
- Artwork loads through `fb2k://artwork/` URLs that the component scales on
  request, batched up to 100 per call and cached for the session.
- The seek bar repaints at most 4 times a second, and stops when nothing is
  playing.

## Requirements

- Windows 10 or 11 with the Microsoft Edge WebView2 Runtime (preinstalled on
  both)
- foobar2000 v2.0 or later; the 64-bit build is recommended
- foo_ui_webview2 v2.1 or later

## Install

1. Install foo_ui_webview2: **File → Preferences → Components → Install…**,
   pick the `.fb2k-component` file, then restart foobar2000.
2. Copy this repository's `index.html`, `css` and `js` into
   `<foobar2000 profile>\webview-ui\fusion\`.
   - Portable install: `<foobar2000 folder>\profile\webview-ui\fusion\`
   - Standard install: `%APPDATA%\foobar2000-v2\webview-ui\fusion\`
3. **Preferences → Display → Default User Interface**: choose **WebView2 UI**.
4. **Preferences → Display → WebView2 UI**: set the template to **fusion**
   and click **Apply**.

The first time Fusion opens it creates a **Collection** autoplaylist (the
whole library) if you don't have one. **Favorites** is created when you first
click it. It holds tracks tagged `MOOD` = `Like it`, the same as the original
skin.

## Updating

**foobar2000 updates do not touch Fusion.** The theme lives in your profile's
`webview-ui` folder, which neither foobar2000's installer nor the component's
installer writes to. Your settings are stored in the profile as well.

To update Fusion itself, replace the files in `webview-ui\fusion\`, then press
**Ctrl+Shift+F5** in Fusion or restart foobar2000. Each file reference in
`index.html` carries a content hash (written by `dev/tools/stamp.py`), so
WebView2 never mixes cached old files with new ones. To update
foo_ui_webview2, install the new `.fb2k-component` in the usual way.

## Troubleshooting

- Warnings and errors are written to `fusion.log` in the profile folder.
- For the browser dev tools: **Preferences → Display → WebView2 UI →
  Developer**.
- **Settings → Reset Fusion settings** restores the defaults. Playlists and the
  library are not affected.

## Development

No build step: plain ES modules, loaded directly by WebView2.

```
index.html
css/          base (tokens), sidebar, main, grid, lists, playerbar, panels
js/core/      bridge wrapper, settings store, icons, helpers, log
js/data/      player, playlists, view model (grouping/selection), artwork, TF patterns
js/ui/        one module per panel
dev/          browser mock of the foobar2000 bridge, with a generated library
```

To work on it in a browser, serve the folder (for example
`python -m http.server`) and open `index.html`. When `window.fb2k` is missing,
`dev/mock-bridge.js` provides a fake library. Like the real host, the mock
rejects undeclared parameters. The list comes from the component's docs:

```
python dev/tools/extract-api.py <foo_ui_webview2>/docs/vitepress/api > dev/api-params.json
```

For live reloading inside foobar2000, point the component's development-server
setting at your local server.

## Credits and licence

Original Fusion design by NadirP. This rewrite is released under the MIT
licence (see `LICENSE`). It contains none of the original skin's code or
images.
