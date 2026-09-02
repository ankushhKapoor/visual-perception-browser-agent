# Visual Perception Browser Agent

Visual Perception Browser Agent is a privacy-preserving Chrome extension and local computer-vision service. It collects visible webpage structure and screenshots, detects sensitive information locally, redacts it, and sends only sanitized visual/context data to the local FastAPI service.

## Current capabilities

### Browser and page perception

The extension extracts the currently visible page's:

- URL, title, viewport size, scroll position, and timestamp
- Visible text
- Visible DOM elements and bounding boxes
- Buttons, links, headings, images, inputs, textareas, selects, and content-editable elements
- Input types, labels, placeholders, ARIA roles, accessible names, and ARIA states
- Forms and their controls
- Interactive-element summaries

### Automatic capture triggers

The content script schedules a sanitized capture after these page events:

- `click`
- `input`
- `change`
- `submit`
- DOM mutations, including added/removed nodes, text changes, and attribute changes

Events are debounced for 1.2 seconds and captures are prevented from running concurrently. The extension action button can also start a capture manually. Browser pages that do not allow content scripts, such as Chrome internal pages, cannot be captured.

## Privacy and sanitization

Privacy processing happens in the content script before analysis or persistence of the exported payload.

### Detection sources

- Sensitive input metadata: password, email, phone, card, CVV, OTP, token, secret, and related field names/types
- Deterministic text patterns for email, phone, Aadhaar-like IDs, PAN-like IDs, and card numbers
- Luhn validation for card numbers
- Context and keyword detection for secrets and credentials
- Privacy fusion across DOM, text, OCR, ML, and face detections
- Optional local OCR through Tesseract.js
- Local face detection when the browser `FaceDetector` API or a compatible MediaPipe face landmarker is available

### Redaction policy

- Critical secrets such as passwords, OTPs, CVVs, cards, API keys, authentication tokens, and session secrets become `<SECRET>` or are blacked out.
- High-sensitivity values such as email, phone, government IDs, and faces are replaced with typed placeholders such as `<EMAIL_1>` or visually masked/blurred.
- Context-dependent detections require a confidence threshold before sanitization.
- Redaction actions include `BLACKOUT`, `MASK`, `PLACEHOLDER`, and `BLUR`.
- Detection regions are normalized and spatially fused before screenshot redaction.
- Raw values and raw-sensitive field names are removed from exported payloads.
- The final privacy gate blocks payloads containing raw sensitive fields, suspicious strings, or missing sanitization flags.
- The webpage itself is never modified; sanitized copies are generated for export and analysis.

The global flag `window.__ENABLE_LOCAL_OCR__ = true` enables OCR. OCR is disabled by default to avoid unnecessary processing.

## What is logged and where data is saved

### Sanitized text

After each successful capture, the sanitized visible page text is printed in the webpage's DevTools console with:

```text
Sanitized text fetched from screen:
```

Open the target page, press `F12`, and use the **Console** tab. Raw sensitive values should not appear in the exported/logged sanitized output.

### Sanitized screenshots in Downloads

Every successful sanitized capture is downloaded automatically to:

```text
C:\Users\<your-user>\Downloads\Extension_Screenshotss\
```

Files are named like:

```text
sanitized_capture_<timestamp>_<id>.png
```

Chrome's `downloads` permission and `conflictAction: "uniquify"` are used, so existing files are not overwritten.

### Persistent browser-local storage

The extension also keeps each capture in IndexedDB. Database and store names are:

```text
Database: visual-perception-browser-agent
Object store: sanitized-captures
```

Records contain the sanitized screenshot, sanitized text, safe summary, page URL/title, capture reason, timestamp, and IDs. Records are not automatically deleted.

On Windows, the underlying Chrome profile data is normally under:

```text
%LOCALAPPDATA%\Google\Chrome\User Data\Default\IndexedDB\
```

Use the extension service worker DevTools **Application -> IndexedDB** view to inspect records safely.

### Backend screenshot archive

When the local API is running, every sanitized screenshot uploaded to `/analyze` is also retained by the Python service in:

```text
yolo-opencv/sanitized_screenshots/
```

The API returns the saved filename, filesystem path, and retrieval URL. These generated files are local artifacts and should not be committed.

## Architecture and data flow

```text
Webpage event
    |
    v
content.js: DOM, accessibility, visible text, local PII detection
    |
    v
background.js: chrome.tabs.captureVisibleTab()
    |
    v
content.js: OCR/face detection, fusion, canvas redaction, privacy gate
    |                         \
    |                          +--> Downloads/Extension_Screenshotss/*.png
    |                          +--> IndexedDB: sanitized-captures
    v
POST /analyze with sanitized screenshot only
    |
    v
FastAPI -> OCR, visual regions, YOLO/OpenCV objects -> JSON
    |
    v
POST /perception with sanitized browser perception state
```

The raw screenshot exists temporarily in the browser capture/redaction flow. It is not sent to the backend, saved by the extension download path, or included in the browser perception payload.

## Repository structure

```text
visual-perception-browser-agent/
├── extensions/
│   ├── manifest.json
│   └── src/
│       ├── background.js              # MV3 service worker
│       ├── content.js                 # page extraction, events, redaction flow
│       ├── local-ocr.js               # optional Tesseract.js OCR
│       ├── privacy-classifier.js      # local PII classification
│       ├── privacy-core.js            # raw-field export rules
│       ├── privacy-fusion.js          # spatial detection fusion
│       ├── privacy-sanitizer.js       # placeholders and export sanitization
│       ├── privacy-sanitizer-test.js  # standalone sanitizer tests
│       └── privacy-engine-synthetic-tests.js
├── yolo-opencv/
│   ├── server.py                      # FastAPI service
│   ├── combined_detect.py             # OCR and combined visual pipeline
│   ├── detect.py                      # detection helpers
│   ├── opencv_detect.py               # OpenCV processing
│   ├── yolo11s.pt                     # local YOLO weights
│   └── sanitized_screenshots/         # retained API uploads
├── backend/                           # reserved backend/planner scaffold
├── benchmarks/                        # benchmark results and screenshots
├── privacy-test.html                  # browser privacy test page
├── index.html                         # project web entry page
├── package.json                       # Node/Vite build configuration
├── vite.config.mjs                    # CRX/Vite configuration
├── requirements.txt                   # Python dependencies
└── Detailed execution plan.md         # implementation plan
```

## Prerequisites

- Windows, macOS, or Linux
- Google Chrome or another Chromium browser with Chrome extension APIs
- Node.js and npm
- Python 3.10 or newer recommended
- Git
- Python dependencies listed in `requirements.txt`

## Installation

From the repository root:

```powershell
npm install
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

On macOS/Linux, activate the environment with:

```bash
source .venv/bin/activate
```

## Build and load the extension

Build the unpacked extension:

```powershell
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the generated repository `dist/` directory.
5. Reload any already-open webpages.

The source manifest is in `extensions/manifest.json`; the Vite/CRX build generates the loadable manifest and service-worker files in `dist/`. After changing extension code or permissions, run the build and reload the extension.

## Run the local visual backend

In a second terminal, from the repository root:

```powershell
.venv\Scripts\activate
cd yolo-opencv
python server.py
```

The service listens at:

```text
http://127.0.0.1:8000
```

The equivalent development command is:

```powershell
uvicorn server:app --reload
```

Check that it is running at `http://127.0.0.1:8000/health`. Expected response:

```json
{"status":"healthy"}
```

## How to use it

1. Start the backend if visual analysis is required.
2. Build and load `dist/` in Chrome.
3. Open a normal webpage containing text, controls, images, or forms.
4. Open DevTools on that webpage and select **Console**.
5. Interact with the page or click the extension action.
6. Watch for event, sanitized-text, redaction, analysis, and local-storage logs.
7. Open `Downloads\Extension_Screenshotss\` to view the sanitized PNG files.

The extension can still complete local capture and local storage when the backend is unavailable. Backend analysis and `/perception` delivery are optional; failures are reported in the console without discarding the local sanitized capture.

## API

### `GET /`

Returns basic service status.

### `GET /health`

Returns `{ "status": "healthy" }`.

### `POST /analyze`

Accepts multipart form data:

- `image`: PNG, JPEG, or WebP image
- `sanitized`: must be the string `true`

The server rejects non-image files and any request that does not explicitly mark the image as sanitized. It retains the upload in `yolo-opencv/sanitized_screenshots/`, runs the combined OCR/visual pipeline, and returns image metadata, detected text, regions, objects, and saved-file information.

### `GET /saved-screenshots/{filename}`

Retrieves a previously retained backend screenshot. Path traversal outside the screenshot directory is rejected.

### `POST /perception`

Accepts the sanitized browser perception state. The service prints a safe summary containing page metadata, interactive-element count, form count, visual-text count, visual-region count, object count, PII status, and redacted-region count.

## Extension messages

- `CAPTURE_SCREENSHOT`: asks the background worker to capture the visible tab.
- `RUN_PRIVACY_CAPTURE_AND_ANALYZE`: starts page extraction, redaction, local persistence, and optional backend analysis.
- `SEND_SANITIZED_FOR_ANALYSIS`: sends only the sanitized screenshot to `/analyze`.
- `STORE_SANITIZED_CAPTURE`: stores the sanitized screenshot and safe metadata in IndexedDB and Downloads.
- `SEND_BROWSER_PERCEPTION`: sends the sanitized structured state to `/perception`.

## Testing and known limitation

Build validation:

```powershell
npm run build
```

The repository also includes `privacy-sanitizer-test.js`, `privacy-engine-synthetic-tests.js`, and `privacy-test.html` for privacy checks. The current Node synthetic-test runner reaches an existing OCR test-harness error (`detectOCRTextRegions is not a function`); this is separate from the extension build and does not indicate a Vite build failure.

## Security and operational notes

- The API is bound for local development at `127.0.0.1:8000`.
- The backend currently enables permissive CORS for local integration.
- Do not expose the backend publicly without adding authentication, restricted CORS, request limits, and additional hardening.
- Sanitization is designed as a privacy boundary, but users should still avoid entering real secrets into test pages.
- Generated screenshots, model weights, virtual environments, and build output should remain local according to the repository's Git configuration.

## Current status

Implemented: Manifest V3 extension, DOM/accessibility extraction, event-triggered capture, screenshot redaction, local PII classification, fusion, optional OCR and face detection, privacy gate, sanitized text logging, permanent IndexedDB storage, Downloads export, FastAPI analysis, OCR/visual/object detection, retained backend screenshots, browser perception delivery, and local privacy test assets.
