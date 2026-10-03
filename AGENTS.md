# opendisplay.org

The OpenDisplay website: docs, the protocol reference, and browser tools that talk to
e-paper displays over Bluetooth, USB serial and WebUSB. `CLAUDE.md` is a symlink to this
file; edit `AGENTS.md`.

## Shape of the project

- **SvelteKit (Svelte 5 runes), static export only.** `@sveltejs/adapter-static`, every
  route prerendered (`src/routes/+layout.js`). There is no server runtime: anything
  dynamic runs in the browser, or in `httpdocs/firmware/fwproxy.php`.
- **`httpdocs/` is the static folder _and_ the Netcup web root.** SvelteKit copies it into
  `build/` unchanged; the deploy uploads `build/` to the remote `httpdocs`. Never move or
  rename it. New pages go in `src/routes/`, never as HTML files in `httpdocs/`.
- **The port is in progress** (branch `svelte-port`). Unported pages are still plain files
  in `httpdocs/`. Porting a page = delete its file from `httpdocs/` and add the route in
  the same commit.
- SvelteKit 3: configuration lives in `vite.config.js` (the `sveltekit()` plugin); there is
  no `svelte.config.js`.

## Commands

```bash
npm run dev        # dev server; unported httpdocs pages are served at their usual URLs
npm run build      # static site in build/
npm test           # Vitest: protocol, encoding and component tests
npm run lint       # Stylelint: design-token rules for src/
npm run test:e2e   # Playwright (Chromium): builds, previews, checks every URL
```

Before committing: `npm test`, `npm run lint` and `npm run test:e2e` pass.

## Components and styling

- **Every page follows its category in `STYLE.md`** (home, hub, docs, legal, tool). A page
  that fits none, or a layout question the guide doesn't answer, is a decision for the
  maintainer: ask, then record the answer in `STYLE.md`. Don't design one page at a time.

- **Reuse before you create.** Look in `src/lib/ui/` (and the hidden `/_ui/` page) first.
  Imports use the `#lib/…` subpath alias with the file extension (SvelteKit 3 has no `$lib`).
- A new shared component needs **3 real uses**. Until then the markup stays in its page.
- Don't add a variant when a prop or snippet does it. No one-off button classes.
- **One `Button`.** Variants are primary / secondary / danger only. Busy, progress, done
  and failed are behavior (async `onclick`, `progress`, `state`), not variants. Choices
  and toggles use `SegmentedControl`.
- Every new component or variant goes into `/_ui/` in the same commit.
- **Design tokens only** (`src/lib/ui/tokens.css`): no raw hex, no px font sizes, spacing or
  radii. Exceptions: `1px` borders, `0`, `50%`. A new token needs a reason in the commit
  message and more than one use.
- **The only brand color is the logo blue `#00BFFF` (`--blue`).** Tints and readable blue
  text are `color-mix` recipes inside components, never new blue tokens.
- Corners are squircles where supported (`corner-shape`, set in `base.css`); pills and
  circles set `corner-shape: round`.
- **No one-sided accent bars** (a thick colored `border-left` on notes, steps or sections).
  Sections are headings and spacing (a full-width hairline divider at most); notes are a
  `Callout`: tinted box, thin border all round, bold label.
- Light theme only. No inline `style=""` in routes. No component libraries, utility-CSS
  frameworks or CSS-in-JS.
- **No toasts or pop-ups** (`alert()`, transient messages). Feedback stays where it happened:
  the `Button` failed state plus a `Callout` next to the action, a `Field` error for bad
  input, or one `Callout` at the top of a tool for page-level problems. Prefer making an
  error impossible (disable or busy the action until it can run) over reporting it.
- **Porting a page: as little styling as possible.** A ported page has no `<style>` block
  by default; plain HTML inside `Prose`, `Card`, `Badge`, `Swatch` carries it. Check each
  old style: does it carry meaning or layout the components can't express? If not (custom
  colors, one-off sizes and margins, accent links, hover effects), drop it instead of
  translating it. What survives goes into a component (3+ pages) or a short scoped style
  with a comment saying why. List what was dropped in the commit message.
- If a change seems to need a new component, variant or token: say so and stop. Don't add
  one quietly.

## Protocol code and libraries

- `src/lib/opendisplay/` mirrors py-opendisplay's layout and has **no DOM or Svelte
  imports**. `src/lib/flash/` (nRF flashers) likewise.
- **The firmware is the ground truth.** py-opendisplay is a second implementation, checked
  by `tests/legacy/py-agreement.test.js` against `tests/fixtures/py-opendisplay.json`. A
  disagreement is settled against the firmware source and recorded in
  `tests/fixtures/divergences.md`; never change code just to match py-opendisplay.
  Regenerate the fixtures with `tests/fixtures/gen.py` (pinned in `requirements.txt`);
  CI fails if they are stale.
- Dithering comes only from `@opendisplay/epaper-dithering`. Don't reimplement it or
  nearest-color matching.
- **Never use `@opendisplay/opendisplay`** (outdated).
- No vendored third-party code: `npm i` it, pinned. Local fixes go through
  `patch-package` with a link to the upstream PR.
- Web Bluetooth, Web Serial and WebUSB only inside `onMount` or event handlers:
  prerendering runs in Node.

## URLs

- Pages use folder URLs with a trailing slash (`/impressum/`). Build internal links with
  `#lib/paths.js`, never as hand-written strings, so the slash style can still change.
- Every URL ever published keeps working. `tests/e2e/legacy-urls.json` and the redirect
  map only grow; removing or renaming a page means adding a redirect.
- `/l/?<payload>` is printed as a QR code by the firmware. It must keep working forever.

## Don't touch

- `httpdocs/designer/` and what it loads (`/common.css`, `/js/ble-common.js`,
  `/js/pako.js`, `/js/js-yaml.min.js`): out of scope for the port.
- `httpdocs/firmware/toolbox/{bin,firmware}`: written by the firmware sync workflows.
- `httpdocs/firmware/fwproxy.php`: server-side PHP on the host. Under `npm run dev` it is
  proxied to the live site.

## Tests

- Protocol, encoding and flasher logic need unit tests. Tool flow changes need the
  fake-device Playwright tests updated.
- Don't write tests for the dithering algorithms (the library owns them) or for plain
  presentational markup.

## Commits and releases

- Conventional Commits (`feat(toolbox): …`, `fix(ble): …`): release-please builds the
  changelog and version from them. Small commits.
- No AI co-author trailers.
- Deploys happen on release (release-please → `deploy-ftp.yml`), never by hand.

## Known quirks

- ESP Web Tools erases the device config unless the manifest says not to, and fires no
  "finished" event (the toolbox polls `_installState`).
- Firefox and Safari have no Web Bluetooth; iOS needs the Bluefy browser.
