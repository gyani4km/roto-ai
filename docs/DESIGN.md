# ROTO AI: exhibition presence

## Public display: the studio portrait

The owner's light revision supersedes the dark-stage direction in the original frontend brief. A Rotomakers ident opens the experience, then gives the screen to the character. The reference is a person photographed on a softly lit studio cyclorama: warm white continues unbroken from the interface into the 3D scene. The character, backing, and legible invitation do the work; there is no glass, halo, frame around the image, or card grid.

Portrait puts the person above the invitation; landscape puts the visitor's prompt to the left and the person to the right. In both arrangements the character has a dedicated camera area. A close-up can fill that area without covering the invitation, language switch, or disclosure. The presentation note, camera control, and pause button sit immediately below the image they describe. Side margins and header align across the character, controls, and footer.


| Portrait | Landscape |
|---|---|
| Studio mark and language choice | Studio mark and language choice |
| Character across the available width | Invitation on the left; character on the right |
| Presentation note and camera controls | Presentation note and camera controls under the character |
| Centered invitation and actions | |
| AI disclosure | AI disclosure |

## Palette and typography

| Intent | Value |
|---|---|
| Warm studio white / 3D background | #F7F7F2 |
| Dialog and developer work surface | #FFFFFF |
| Selected or hovered control surface | #E9EBE4 |
| Ink / primary action | #20231F |
| Secondary copy | #515750 |
| Rule | #B9BEB4 |
| Focus and state accent, a dark olive echo of the lime studio mark | #455327 |

The landing invitation uses locally hosted Manrope with close spacing in English. Telugu and Hindi use locally hosted Noto Sans, natural letter spacing, and more line height for vowel marks. The selected language has an underline as well as a weight change. Primary actions use a solid ink surface; secondary actions remain text links. On native 4K portrait, text, icons and button targets scale with physical display size. The engineering workspace uses the same light reading surfaces with tabular metrics; the dark model viewport keeps its original material inspection conditions.

Reduced motion disables ambient motion. A pause control remains available for the 3D presentation; camera and input controls remain usable by keyboard. State transitions cancel immediately on Stop, navigation, error or reset. No randomized lip movement.

## Honest S1 interaction

Idle → visitor welcome → listening preview → processing preview → response preview → idle. These are an explicitly labeled local rehearsal, not speech recognition or live AI. No microphone/camera permission or cloud call occurs. Stop clears timers immediately. Network loss has a local-preview path; visual failures preserve the interface and offer recovery.

English, Telugu and Hindi cover public labels, statuses, sample subtitles, errors and disclosure. Language choice uses native names. Text entry is a preview interaction and does not promise an actual answer.

## Character policy

The character repository was inspected through v022, including its validation reports and full-body render. No approved clothed model was identified. Kiosk Mode must not request or render the unclothed GLB. It uses an original, faceless mannequin in a complete suit, explicitly labeled temporary. It is a display-form fallback, not a reconstruction of the official's face. No facial geometry, skeleton, texture, viseme or source asset is changed.

Developer Mode retains the SHA-frozen S1 asset and all 15 visemes, four expressions, runtime animation controller, camera presets, benchmarking and recovery. The fallback is a separate module, so integrating a later approved clothed GLB does not require changing the engineering pipeline.

## Operator access

The public screen exposes no Developer Mode button. Ctrl+Shift+D opens an intentional operator confirmation; the explicit `?mode=developer` URL is also supported. These are deliberate entry mechanisms, not an authentication boundary. A deployed event security policy is outside this S1 review.

## Skills applied

`frontend-design` is the aesthetic lead. `web-design-guidelines` is the audit checklist, applied to `frontend/src/` and browser interactions. Both were reviewed and installed for Codex from pinned upstream commits. Optional plugin87 support was evaluated but not activated, avoiding a second doctrine and bulk changes to project instructions.

## Review requirements

Capture both modes at 2160 × 3840, 1080 × 1920 and 1920 × 1080. Inspect the actual renders, run axe and keyboard/state/cancellation tests, preserve original engine regression tests, and record actual buffer sizes, FPS and frame-time p95 on the GTX 1050 Ti. An unclothed asset, a passed build or a pretty screenshot alone does not establish event readiness. Stop for owner review before S2.
