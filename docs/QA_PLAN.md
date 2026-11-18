# ROTO QA plan: Live preview blank / preview inconvenience

Owner complaint: "When I press preview it sometimes goes blank, doesn't show me, or causes other inconvenience."

Target: running server at http://127.0.0.1:8000 (not restarted by QA). Browser: headed Microsoft Edge (`channel: msedge`), profile under `F:/ROTO_tools/cache/qa-edge`, debug port 9345.
Runner: `frontend/scripts/qa-run.mjs`. Output: `runtime/qa/results.json`, screenshots in `runtime/qa/shots/`.

## Targets (owner)
Character live in <= 5 s on a warm cache (`WARM_MS`) and <= 10 s cold (`COLD_MS`) on this PC; never a blank box; reloads fast. "Live" means the app reports ready (`data-ready="1"` on the holobox, "Holobox idle" in the console status) AND the canvas is not blank. While loading, the holobox must show its loading indicator (`holobox-loading`): a poll that shows neither a picture nor the indicator counts as a real blank (`blankNoIndicator`) and fails the case.

## Pass / fail rules (apply to every case)
- **Blank canvas**: the Holobox WebGL canvas is screenshotted and sampled on a 64x64 grid. Blank = all sampled pixels one colour (stddev of luminance < 1.5). Blank is a FAIL unless the case says otherwise.
- **Console errors**: any `console.error`, `pageerror`, or failed request (HTTP >= 400 or aborted) in the console or holobox pages is recorded. A case with a page error FAILS.
- **Warnings** are recorded but do not fail a case, except WebGL context warnings (see X-01).
- A case is BLOCKED (not FAIL) if its precondition is missing (for example no character file). None were missing at run time.

## Console: Live preview tab

### C-01 Open the console on the Live preview tab
Steps:
1. Open http://127.0.0.1:8000/ with a fresh page (no hash).
2. Wait for `preview-frame` to be visible.
3. Wait up to 60 s for `preview-status` to contain "Holobox idle" (or "Holobox" with state).
4. Screenshot the console; sample the Holobox canvas inside the preview iframe.

Expected: status reaches "Holobox ..." within 60 s; canvas is not blank; no console errors.
Pass if all hold. Fail otherwise.

### C-02 Switch tabs away and back 10 times
Steps:
1. Start on Live preview and wait for C-01 ready state.
2. Repeat 10 times: click `tab-persona`, wait 1 s, click `tab-preview`.
3. After each return, wait up to 30 s for status "Holobox" and sample the canvas.
4. Record the time to ready and blank result for each return. Record heap size before the loop and after the 10th return (used by X-02).

Expected: every return shows a live, non-blank holobox within 30 s; no page errors.
Note: the preview iframe lives outside the tab sections and stays mounted on every tab (hidden, not removed, on Diagnostics), so a switch must not reload the character; returns are expected to be near-instant.

### C-03 Reload the console 5 times
Steps:
1. Reload http://127.0.0.1:8000/#preview five times, waiting for `preview-status` each time.
2. For each reload, wait up to 60 s for ready, then sample the canvas.

Expected: each reload reaches a live, non-blank preview within 60 s.

### C-04 Leave the Live preview idle for 2 minutes
Steps:
1. Load the console on Live preview and wait for ready.
2. Do nothing for 120 s (no input).
3. Sample the canvas, read `preview-status` and FPS (text "fps"), and check for errors.

Expected: still ready, still non-blank, FPS > 0, no errors.

### C-05 "Open Holobox (1080x1920)" button on the Character tab
Steps:
1. Go to `#character`.
2. Click the button (text "Open Holobox (1080×1920)").
3. Confirm one new popup opens and renders a non-blank canvas within 15 s.

## Holobox window buttons

### H-01 Click "Preview in Holobox" repeatedly
Steps:
1. On `#preview`, click `open-holobox` five times at 1 s intervals.
2. Count popups created in the browser context and open holobox pages.

Expected: the buttons reuse one named window (`roto-holobox`); total holobox pages stay at 1; no popup is blocked; the window renders non-blank within 15 s.

### H-02 Close and reopen the holobox window 5 times
Steps:
1. Open the holobox window. Wait for non-blank.
2. Close it. Click `open-holobox` again. Wait for a new non-blank window.
3. Repeat five times.

Expected: each reopen renders non-blank within 15 s; no error in the console page.

### H-03 Console preview and holobox window open at the same time
Steps:
1. Open the console on `#preview` (ready) and open the holobox window (ready).
2. Keep both open for 60 s.
3. Sample both canvases at 0 s, 30 s and 60 s.

Expected: both stay non-blank; each reports FPS > 0; no context-lost event; no page errors.

## Each console tab

### T-01 .. T-08 Each tab loads with no console errors
Tabs: `preview`, `persona`, `voice`, `languages`, `character`, `demo`, `devices`, `diagnostics`.
Steps: open `/#<tab>`, wait 5 s, record console errors and warnings, screenshot.
Expected: no `console.error`, no page error, no failed request.

### P-01 One setting change persists after reload
Steps:
1. Open `#persona`. Set the greeting to "QA persist check <timestamp>".
2. Wait for `save-state` "Saved".
3. Reload. Check the greeting field still holds the value.
4. Restore the original greeting.

Expected: value survives reload.

### P-02 Setting change reaches the open holobox
Steps:
1. Open the console on `#character` and the holobox window (ready, black booth).
2. Sample the holobox mean luminance.
3. Click `theme-white`. Wait up to 10 s.
4. Sample the holobox mean luminance again. Expected: it rises (white booth).
5. Click `theme-black` to restore.

Expected: the holobox window changes within 10 s, without a reload.

## Holobox route alone

### W-01 /holobox loads the character within 15 s, full body visible
Steps: open `/holobox` in its own page. Time until the canvas is non-blank. Screenshot. Visually check that the full body is in frame.
Expected: non-blank within 15 s.

### W-02 Resize the window
Steps: set viewport to 390x844, then 1600x900, then 1440x1000. At each size, sample the canvas and check `document.documentElement.scrollWidth <= clientWidth`.
Expected: non-blank at each size; no horizontal page scroll.

## Talk loop

### L-01 Typed question in the console preview produces a reply and audio
Steps:
1. Console on `#preview` and ready.
2. Type "What time does the expo open?" in `test-talk`, click `test-send`.
3. Wait up to 60 s for the reply (read from `window.__ROTO_HOLOBOX__.controller.snapshot.replyText` in the preview iframe: the holobox draws no captions, so `caption-reply` only exists in Developer mode) and for an audio play event (counted by an init script that observes `HTMLMediaElement.play` and `AudioBufferSourceNode.start`; observation only, nothing mocked).
Expected: reply text appears; audio play count > 0.
This is the only case that calls the real backend.

### L-02 Mouth moves while speaking
Steps: when L-01 reaches the `speaking` state, take 8 head-region crops (top 30 %, middle 40 % of the canvas, 96x96) 200 ms apart and read the live jaw/viseme morph influences from the model. Pass: head-crop mean abs difference > 0.3 AND the morph value ranges by > 0.05.
Expected: the mouth region changes. This is a proxy measure; visual confirmation in screenshots is also recorded.

### L-03 Stop works
Steps: during playback, click `console-stop`. Within 2 s, audio play count stops increasing and `live-state` does not show "speaking".
Expected: audio stops within 2 s.

## Diagnostics

### D-01 Diagnostics tab embeds /developer
Steps: click `tab-diagnostics`, wait for `diag-frame`, wait 30 s, check that `diag-live` is not empty and that the embedded developer page has a non-blank canvas if it has one.
Expected: frame loads; no errors.

## Cross-cutting

### X-01 WebGL context count
Steps: an init script wraps `HTMLCanvasElement.prototype.getContext` to count WebGL contexts created across all pages, and listens for `webglcontextlost`. Across the whole run, grep console messages for "Too many active WebGL contexts" and "CONTEXT_LOST".
Expected: no such message. Record the count of contexts created and how many canvases are attached to the DOM at the end of C-02 and H-03.

### X-02 JS heap after 10 tab switches
Steps: record `performance.memory.usedJSHeapSize` (Chromium) before C-02 and after the 10th return. Measure again after a 5 s idle.
Expected: growth below 50 MB and not climbing per switch. Record values regardless of result.

### X-03 Blank summary
Steps: aggregate every blank check from all cases. List each blank check with its screenshot path.
