---
name: Companion for YouTube
description: A flat, dark-first 400×600 popup with hairline borders and one purple accent, kept quiet so the videos are the loudest thing in it.
colors:
  accent: "#7c5cf0"
  accent-light: "#6d4ae8"
  accent-text: "#a58cff"
  accent-text-light: "#5534d6"
  on-accent: "#ffffff"
  bg: "#0f0f14"
  surface: "#17171f"
  surface-hover: "#1e1e28"
  text: "#f1f1f4"
  bg-light: "#ffffff"
  surface-light: "#f6f6f8"
  surface-hover-light: "#eeeef2"
  text-light: "#16161a"
  ok: "#22c55e"
  ok-light: "#15803d"
  live: "#e11d2e"
  live-light: "#d10f20"
  premiere: "#e6a317"
  premiere-light: "#c98911"
  on-premiere: "#1a1408"
  short-tag: "#3a3a48"
  short-tag-light: "#e6e6ee"
  thumb-badge: "rgb(0 0 0 / 0.8)"
typography:
  title:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.5
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.5
  heading:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  meta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
  tag:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "10px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.03em"
rounded:
  tag: "4px"
  thumb: "6px"
  control: "7px"
  menu-item: "6px"
  menu: "8px"
  md: "9px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "7px 13px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "7px 13px"
  chip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "5px 10px"
  chip-selected:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    padding: "5px 10px"
  feed-row:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "7px 10px"
  tag-new:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
  tag-live:
    backgroundColor: "{colors.live}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.tag}"
    padding: "1px 6px"
---

# Design System: Companion for YouTube

## Overview

**Creative North Star: "The Quiet Companion"**

The popup is a small, calm strip of a list that sits beside YouTube without competing with it. Surfaces are flat and sit one tonal step apart from the page. Edges are drawn with a single hairline, not with shadow. The only saturated colour in the whole interface is one purple, and it appears only where the person can act (the primary button, the selected chip, the active tab) or where something is new (the New tag). If the purple is everywhere, nothing is new.

The system is dark-first and follows the browser's colour scheme, with a Light and a Dark override in Settings. It is dense by design: 13px text, 54px thumbnails, 8–16px gaps, because the popup is 400×600 and is opened for a quick look. English and Arabic share one layout; every spacing and position is written with logical properties so right-to-left flips without a second stylesheet.

It is not YouTube. There is no red chrome; the only red is the `LIVE` tag, which is YouTube's own signal and means one thing.

**Key Characteristics:**
- Flat, tonal surfaces with a hairline border; shadows only on things that float.
- One purple accent, used for action and "new", never for decoration.
- System font, small sizes, tabular numbers on time and counts.
- Logical properties everywhere, so Arabic RTL is the same layout mirrored.
- Light and Dark are the same design with the same roles; badges on photos stay dark in both.

## Colors

A near-black violet-tinted ground, one step-lighter surfaces, a soft off-white text, and a single purple. Light theme is the same roles on white and cool grey.

### Primary
- **Quiet Violet** (#7c5cf0 dark, #6d4ae8 light): the only accent. Primary button fill, selected chip, active-tab underline, the `New` tag, focus rings, and the on-state of switches. Each value clears 4.5:1 against white text. It is the icon's purple, deliberately not YouTube red.
- **Violet Ink** (#a58cff dark, #5534d6 light): the accent when it is small text, such as error lines and the danger hover in a menu. The fill value is under 4.5:1 as text on a dark surface, so text uses this step instead.

### Neutral
- **Midnight Ground** (#0f0f14 dark, #ffffff light): page background and the bottom-sheet panel.
- **Dusk Surface** (#17171f dark, #f6f6f8 light): rows, inputs, buttons, chips, cards.
- **Raised Dusk** (#1e1e28 dark, #eeeef2 light): hover on any surface, switch track, thumbnail placeholder.
- **Soft White** (#f1f1f4 dark, #16161a light): body text.
- **Dim Text** (text at 55% dark, 64% light): meta lines, inactive tabs, placeholder copy.
- **Hairline** (white at 9% dark, black at 10% light): every border and divider.

### Status
- **Live Red** (#e11d2e dark, #d10f20 light): `LIVE` tag only.
- **Premiere Amber** (#e6a317 dark, #c98911 light), with dark ink (#1a1408): `PREMIERE` tag only.
- **Go Green** (#22c55e dark, #15803d light): success and the followed check.
- **Short Grey** (#3a3a48 dark, #e6e6ee light): the `SHORT` tag, deliberately dull.
- **Photo Badge** (black at 80%, white text): duration badge on thumbnails; does not flip with the theme because it sits on a photograph.

### Named Rules
**The One Voice Rule.** Purple means "you can act here" or "this is new." It is never a decoration, a heading colour or a background wash. If a screen needs a second accent, the screen is wrong.

**The No-Red Rule.** The interface itself never uses red or anything close to it. Red belongs to `LIVE` and to nothing else, so a red interface never reads as YouTube's own.

**The Token Rule.** Every colour is a custom property on `:root`, with the light values in both the `prefers-color-scheme` block and the `[data-theme='light']` block. A literal colour in a component is a bug.

## Typography

**Display Font:** none.
**Body Font:** `system-ui, -apple-system, 'Segoe UI', sans-serif`, the platform's own face, so Arabic falls through to the system's Arabic face with no web font to load or license.

**Character:** Plain and native. Hierarchy comes from weight and dimness, not from size jumps; most of the popup sits within 12 to 13px.

### Hierarchy
- **Title** (600, 15px, 1.5): the app name in the app bar. Sheet and section headings run 14 to 16px; the one 18px step is a single large glyph.
- **Body** (400, 13px, 1.5): everything by default; video titles are 500. Stat values are 14px, 600, tabular.
- **Label** (500, 12 to 12.5px): chips, menu items, secondary buttons, filters.
- **Meta** (400, 11.5px, dim): channel, time, view counts, with tabular figures.
- **Caption** (400, 11px, dim): stat labels and other small captions. This is the floor for running text.
- **Tag** (700, 10px, +0.03em, uppercase in Latin): `NEW`, `LIVE`, `PREMIERE`, `SHORT`. The thumbnail duration badge is 10.5px. Arabic has no case to change.

### Named Rules
**The Dim Instead Of Small Rule.** Reduce emphasis with the dim text colour before reducing size. Running text stays at 11px or more; only the bold tags and the duration badge go to 10 and 10.5px.

## Layout

A single 400px column, content height up to about 600px, then the popup scrolls natively. The page is never a scroll container (a Chrome popup-sizing constraint). Horizontal gutter is 12px for the app bar and tabs, 16px for panels. Vertical rhythm is 8px between related items and 10 to 14px between groups.

The structure is app bar, four equal-width tabs (Player, Feeds, Watchlist, Settings), then one panel. Feed rows are a flex row: a 96×54 thumbnail, a flexible text column, and an end column of small actions with the New tag on top. Chips scroll sideways in a single row with no visible scrollbar; the chip cut off at the edge is the cue. Sheets rise from the bottom over a dimmed backdrop.

Everything is positioned with logical properties (`padding-inline`, `inset-inline-end`, `border-start-start-radius`), so RTL is a mirror, not a rewrite.

## Elevation & Depth

Flat by default. Depth is tonal (Ground, then Surface, then Raised) plus a hairline border. Shadows exist only for things that float over the page, and they are heavy, short, and dark.

### Shadow Vocabulary
- **Menu** (`box-shadow: 0 8px 22px rgb(0 0 0 / 0.35)`): the ⋯ menu list.
- **Sheet** (`box-shadow: 0 -6px 24px rgb(0 0 0 / 0.35)`): the bottom sheet panel, over a `rgb(0 0 0 / 0.55)` scrim.
- **Focus ring** (`outline: 2px solid var(--accent)`): inputs and tabs; the ring is an outline, not a shadow.

### Named Rules
**The Floats-Only Rule.** A shadow means "this sits above the page and will go away." Rows, cards and buttons never get one.

## Shapes

Gently rounded and consistent. Rows, buttons, inputs and cards use 9px. Thumbnails and menu items use 6px, small controls 7px (and a few 5px inner pieces), the tags 4px, the menu list 8px. Filter chips and switch tracks are full pills (999px). Borders are always 1px hairline. Avatars are circles. There is no clipping, no cut corners and no decorative geometry.

## Components

### Buttons
- **Shape:** 9px corners, 1px hairline border, 7px 13px padding, weight 500.
- **Default:** Dusk Surface fill; hover steps to Raised Dusk.
- **Primary:** Quiet Violet fill, white text, no border; hover brightens by 8% rather than changing colour.
- **Icon buttons:** same shape, square, glyph at 16px (the ⋯ menu toggle).
- **Disabled:** at 55% opacity.

### Chips
- **Style:** pill, 1px hairline, Dusk Surface, dim 12px label.
- **State:** selected is filled Quiet Violet with white text (`aria-pressed`). Group chips and the "N failing" chip use the same shape.

### Feed rows
- **Shape:** 9px, hairline, Dusk Surface, 8px 10px padding; hover goes to Raised Dusk.
- **Body:** 96×54 thumbnail at 6px with its box pinned so a late image cannot shift the list; title at weight 500; meta line dim; tags inline.
- **Behaviour:** the whole row is one stretched open-video target, with the channel name and small buttons layered above it.

### Tags
- 10px bold, 4px corners, 1px 6px padding. `NEW` is violet, `LIVE` red, `PREMIERE` amber with dark ink, `SHORT` the dull grey.

### Inputs / Fields
- **Style:** Dusk Surface fill, hairline, 9px corners, 7px 10px padding; the clear ✕ sits inside the field at the inline end.
- **Focus:** a 2px violet outline, inset 1px. Disabled at 55%.

### Switches
- 36×20 pill track on Raised Dusk with a 14px text-coloured knob; on is Quiet Violet, and the knob slides along the inline axis so it flips in RTL.

### Navigation (tabs)
- Four equal flex tabs, dim 500-weight label, 2px bottom border; the active tab turns to full text colour with a violet underline. Focus is an inset 2px violet outline.

### Menus and sheets
- Menu: Dusk Surface, hairline, 8px corners, 4px padding, 12px items, flips above the toggle near the bottom. Sheet: full-width bottom panel, 86vh at most, Midnight Ground, rounded at the top only. Confirmation is an inline row, never a browser dialog.

### Player card (signature)
- A grid of a 56px cover and a text column, Dusk Surface, 9px corners. The title scrolls horizontally when too long, and stops under `prefers-reduced-motion`. Transport buttons are 32px; the play button is the same size and the only one that is not a text label.

## Do's and Don'ts

### Do:
- **Do** use the existing custom properties for every colour, and add a light value whenever you add a dark one.
- **Do** write spacing and position with logical properties so Arabic RTL works unchanged.
- **Do** keep violet for actions and "new" only, and keep it to a handful of elements per screen.
- **Do** show state with the dim text colour and weight first, size second.
- **Do** pin the box of anything that loads late (thumbnails, avatars) so the list does not jump.
- **Do** confirm destructive actions with an inline row.
- **Do** honour `prefers-reduced-motion`; motion is limited to a 120 to 150ms transform, a spinner and the scrolling title.

### Don't:
- **Don't** use red, or a red-leaning colour, anywhere in the interface except the `LIVE` tag.
- **Don't** add shadows to rows, cards, buttons or chips.
- **Don't** call it "YouTube Companion", or imitate YouTube's look, logo or red.
- **Don't** make the page a scroll container or set `overflow` on `html` or `body`; Chrome then falls back to an 800×600 popup.
- **Don't** use `confirm()`, `alert()` or `prompt()` in the popup.
- **Don't** load an image from a host that is not in the manifest's `img-src`.
- **Don't** add a web font, an icon font or any dependency.
- **Don't** style `::-webkit-scrollbar` on the page; it turns off overlay scrollbars and takes 8px of the 400.
