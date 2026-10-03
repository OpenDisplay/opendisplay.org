# opendisplay.org style guide

One pattern per kind of page. Every page belongs to exactly one category below and follows
it; a page that doesn't fit means the guide needs a decision, not a one-off design.
Components and tokens are listed in `/_ui/`; rules for writing code are in `AGENTS.md`.

## Everywhere

- **Chrome:** `SiteBar` on top, `SiteFooter` below the fold. Same on every page.
- **Column:** one content column, 900px max, centered. Phone gutter 16px, desktop 32px.
- **Type:** page title `--fs-5`; section heading `--fs-4`; subsection `--fs-3`; body `--fs-3`;
  small print and table text `--fs-2`; labels `--fs-1`. Nothing else.
- **Color:** text on cream. Blue only for links, the primary action and focus. Status colors
  only for status (ok, warn, error). Never decoration.
- **Spacing between blocks:** `--sp-4` inside a section, `--sp-6` between sections.
- **Never:** one-sided accent bars, toasts or pop-ups, boxes inside boxes, inline styles,
  one-off colors or sizes.
- **Checked at** 390px (phone), 820px (tablet) and 1440px (desktop): no sideways page scroll.

## Home

The only page with its own layout: a hero (title, one-line pitch, primary and secondary
action), then a few full-width bands (what it is, how to start, community).
- Keeps today's home design; only its colors, sizes, spacing and buttons move onto the
  shared tokens and components. No other page reuses its bands.

## Hub (a section's entry page: Protocol, Firmware, Flex tools)

Helps people pick where to go next; it is not reading material.
- Title + lead, then one `Card` per destination: heading, one or two sentences, one
  secondary `Button` to go there. Cards here make each choice a clear target and set hubs
  apart from reading pages.
- No contents list.

## Docs (protocol and firmware guides, references, hardware pages)

Reading and reference material.
- Written in Markdown (`+page.md`); frontmatter `title`, `lead`.
- Title + lead, "On this page" list (sidebar on wide screens, collapsible on phones).
- Sections are `h2` with a hairline divider between them; subsections `h3`. No cards.
- A note, warning or tip is a `Callout`, never a bold "Note:" paragraph.
- Tables for anything with columns (fields, packets, pixel examples, message sequences);
  first column names the row. Code in fenced blocks. Notes are `Callout`. Labels in tables
  are `Badge`. Display inks are `Swatch`.
- Reference data that exists elsewhere (schema fields, encoder output, palettes) is
  generated from that source, not typed in.
- Pictures only when a table can't say it, as a self-contained SVG without page CSS.

## Legal (Impressum, privacy)

Docs rules, plus: German body marked `lang: de`; contents list only with 3+ sections.

## Tool (Toolbox, BLE tester, battery, device landing `/l/`, QR generator, nRF tools)

Getting something done with a device.
- Title + one-line lead; then the steps or panels of the task, each a `Card` (cards are for
  tools: they group one task's inputs and actions).
- One primary `Button` per step (the next thing to do); others secondary. Progress and
  results on the button and in a status line; problems as a `Callout` next to the step or
  one at the top for page-level problems.
- Forms use `Field`, `Switch`, `SegmentedControl`. Advanced options in a `Fold`.
- Connection state in one device bar at the top of the tool.
- Same 900px column as every other page; a short field may be narrower inside it.
- No contents list.
