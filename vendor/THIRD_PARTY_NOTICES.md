# Third-party code and data notes

This file identifies bundled vendor assets that can look unusually compact or
generated during source review. Repository popularity is included only as
context, not as a security guarantee. Star counts were checked on 2026-10-18
and can change.

## JSZip

- File: `jszip.min.js`
- Upstream: [Stuk/JSZip](https://github.com/Stuk/jszip)
- Bundled version: 3.10.1, stated in the upstream file banner.
- GitHub stars: about 10.4k (checked 2026-10-18).
- License notices: retained in the file; JSZip is dual-licensed MIT/GPLv3 and
  its bundle also identifies pako under MIT.
- The file is the upstream minified browser distribution, not extension-authored
  logic. It has not been upgraded by this provenance note.
- Review note: the bundled `setImmediate` fallback contains legacy branches
  for `attachEvent`, a script-element `onreadystatechange` scheduler, and a
  non-function callback fallback using `new Function`. The script element is
  used as a local scheduling trick and is not assigned a remote `src`.
  `importScripts` appears in feature detection to avoid using `postMessage`
  inside worker environments; that name alone is not a remote script load.
  The extension's JSZip use is for local archive parsing. No reviewed business
  path passes remote JSON or other remote strings into this `new Function`
  fallback. These are compatibility behaviors in the bundled upstream build,
  not a finding of remote code execution. Keep the upstream version and notices
  intact; if these branches are ever removed, do so through a reproducible
  vendor build and validate behavior rather than editing minified code by hand.

## PDF.js

- Files: `pdf.mjs`, `pdf.worker.mjs`
- Upstream: [mozilla/pdf.js](https://github.com/mozilla/pdf.js), distributed as
  `pdfjs-dist` 6.4.299.
- GitHub stars: about 54k (checked 2026-10-18).
- License: Apache-2.0; the upstream license notices and version/build markers
  remain in both files.
- These are local upstream build artifacts. They are not loaded from a remote
  server at runtime.
- Runtime review note: `canvas-data.js` dynamically imports the packaged
  `vendor/pdf.mjs` file and sets `GlobalWorkerOptions.workerSrc` to the
  extension URL for the packaged `vendor/pdf.worker.mjs`. PDF.js contains an
  internal `_createCDNWrapper` helper for cross-origin worker URLs; in this
  extension call path the worker URL comes from `chrome.runtime.getURL`, so
  that helper's presence does not indicate a CDN worker is being loaded.

## OCR runtime and model

- Files: `ocr/tesseract-lib.js`, `ocr/tesseract-core.wasm`,
  `ocr/eng.traineddata`
- Related upstream project: [robertknight/tesseract-wasm](https://github.com/robertknight/tesseract-wasm),
  a WebAssembly build of Tesseract. Its GitHub page showed about 386 stars and
  listed v0.11.0 as its latest release when checked on 2026-10-18.
- The local checkout does not retain an exact upstream tag or commit for these
  OCR artifacts. `tesseract-lib.js` combines licensed third-party code,
  generated Emscripten runtime glue, and extension integration; it should not
  be described as an unmodified upstream file. Its large compact runtime block
  is generated code, not an attempt to hide extension behavior.
- The adjacent `ocr/LICENSE.md` contains the BSD-2-Clause notice for the
  Tesseract WASM component. Portions of `tesseract-lib.js` separately carry
  Google LLC Apache-2.0 notices.
- `eng.traineddata` is OCR language data, not executable JavaScript. The exact
  source revision of this data file is not recorded in the checkout.
- OCR binaries and model data are packaged locally and loaded by the extension;
  they are not fetched from a remote script host at runtime.
- Runtime review note: `ocr-frame.js` imports this packaged module from
  `./vendor/ocr/tesseract-lib.js`; the module's generated Emscripten glue and
  local `tesseract-core.wasm` implement OCR in the extension page. The
  `wasm-unsafe-eval` extension-page CSP permission is for WebAssembly
  compilation and does not enable arbitrary JavaScript `eval`. The OCR
  artifacts' exact source commit and the `eng.traineddata` revision are not
  recorded, so they should be pinned and hashed in a future reproducible vendor
  refresh.

## Relevant upstream source repositories

- JSZip: [github.com/Stuk/jszip](https://github.com/Stuk/jszip)
- pako dependency bundled by JSZip: [github.com/nodeca/pako](https://github.com/nodeca/pako)
- PDF.js: [github.com/mozilla/pdf.js](https://github.com/mozilla/pdf.js)
- Tesseract WASM build: [github.com/robertknight/tesseract-wasm](https://github.com/robertknight/tesseract-wasm)
- Tesseract OCR engine: [github.com/tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract)
- English trained data: [github.com/tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata)

These links identify upstream projects, not necessarily the exact source commit
used to produce every checked-in artifact. Preserve the distinction when
reviewing generated or minified vendor files.
