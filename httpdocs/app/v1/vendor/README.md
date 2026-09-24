# Vendored: @opendisplay/epaper-dithering

`epaper-dithering.js` is the **unmodified ESM bundle** from the published npm
package (DESIGN_WEB_OD_APP_PLAN.md §2 — vendored, never hot-linked, so the
page has no external dependency and the CSP stays strict).

| | |
|---|---|
| Package | `@opendisplay/epaper-dithering` |
| Version | **6.0.0** |
| Source | `https://registry.npmjs.org/@opendisplay/epaper-dithering/-/epaper-dithering-6.0.0.tgz` |
| Tarball SHA-256 | `e9e83c56b0a5bd3b6c7f385affcd9f8b614f8e9c8cdd93b02e986f57e6bc432c` |
| Vendored file | `package/dist/index.js` → `epaper-dithering.js` |
| File SHA-256 | `b2f49de655d70e18aabd196438ec8321c1d0fee26bdf802635bf7bebbf580dcd` |
| Vendored on | 2026-08-24 |
| License | MIT |

The Rust/WASM core is embedded as inline base64, so there is no separate
`.wasm` fetch and no async init — it works from a module worker directly.

## Refreshing

Only from a tagged release, and update every hash above:

```bash
npm pack @opendisplay/epaper-dithering@<version>
sha256sum opendisplay-epaper-dithering-<version>.tgz
tar xzf opendisplay-epaper-dithering-<version>.tgz
cp package/dist/index.js httpdocs/app/v1/vendor/epaper-dithering.js
sha256sum httpdocs/app/v1/vendor/epaper-dithering.js
```

Then run `node --test tests/webapp/` — `dither.test.mjs` pins the exports and
palette ordering this app relies on.

## License (MIT)

Copyright (c) OpenDisplay contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
