# Visual Perception Browser Agent

Visual Perception Browser Agent is a Chrome Manifest V3 extension with a native Side Panel. It understands a user request, inspects the current website, and executes a constrained browser task plan. Its primary rule is privacy-first:

> Raw screenshots and unredacted page context are not sent to the VLM.

The extension creates sanitised text and images **inside the browser first**. Only that sanitised context can reach the separate VLM server. The VLM plans; the extension validates and performs the real browser actions. There is no Python/FastAPI privacy, OCR, face-detection, or screenshot-analysis backend in the active pipeline.

## What we are doing

Browser agents need page text, forms, buttons, links, and sometimes screenshots. Those inputs may include names, email addresses, phone numbers, addresses, government IDs, bank details, passwords, faces, and scanned documents.

The project separates the work into two layers:

1. **Browser-local perception and privacy**: read visible DOM context, capture a screenshot only when needed, find PII, and construct a sanitised context locally.
2. **VLM planning and constrained execution**: send only sanitised context to a VLM, validate its JSON response, then let extension code execute allowed actions against the live page.

The visible chat is a Chrome Side Panel, so it reduces website width rather than injecting an overlay over the site. Content scripts run in the webpage to access its live DOM; the Side Panel and service worker use browser-level Chrome APIs.

## Architecture

\`\`\`text
Website tab
  │
  ├─ content.js: visible DOM, labels, forms, controls, element rectangles
  │
  ├─ local privacy pipeline
  │   ├─ DOM/label/pattern PII detection
  │   ├─ MediaPipe faces → pixel coordinates → blur
  │   ├─ Tesseract OCR → text coordinates → blackout sensitive text
  │   └─ canvas → sanitised screenshot
  │
  ▼
Sanitised DOM context and, only when needed, sanitised image
  │
  ▼
background.js / Side Panel → VLM server (:9001)
  │
  ▼
Local Qwen via vLLM OR hosted Gemini/OpenAI-compatible provider
  │
  ▼
validated tasks.json
  │
  ▼
Extension executes permitted browser actions on the live website
\`\`\`

## Terminology

### PII

**Personally Identifiable Information (PII)** is information that identifies a person directly or can reasonably be linked to one. This project protects, among other categories:

- full names, including recognised names repeated in unstructured prose;
- email addresses and phone numbers;
- residential/postal addresses;
- date of birth (DOB);
- Aadhaar/government-ID-like numbers, PAN-like IDs, account/card numbers and CVV;
- passwords, API tokens, UPI IDs;
- faces in screenshots and document photographs.

Not every number is PII. Product IDs, order IDs, quantities, prices, office codes, and similar operational values should remain visible when their surrounding context is non-sensitive.

### Redaction, blackout, blur and placeholders

**Redaction** means making protected information unavailable before sharing it.

- **Blackout**: an opaque black rectangle covers sensitive text/identifiers.
- **Blur**: a detected face region is blurred while the rest of the image remains visible.
- **Placeholders**: sensitive DOM text sent to a model is replaced with category labels such as \`<EMAIL_1>\`, \`<PHONE_1>\`, \`<ADDRESS_1>\`, \`<PERSON_1>\`, \`<UPI_ID_1>\`, and \`<GOVERNMENT_ID_1>\`.

A placeholder preserves the fact and category of a field without revealing its value.

## How the extension understands what to hide

Privacy detection is layered because websites, normal HTML text, scanned documents, and images need different methods.

### 1. DOM and form-value privacy

\`extensions/src/content.js\` reads visible text nodes, form values, labels, placeholders, ARIA/accessibility labels, attributes, and nearby value/label context. It applies local JavaScript rules:

1. **Pattern recognition** identifies strong formats: emails, phone numbers, card-like digits, Aadhaar-like 12-digit groups, PAN-like patterns, dates, UPI IDs, tokens, and passwords.
2. **Field semantics** identify values next to labels such as “Email address”, “Legal name”, “Mobile number”, “Address”, “DOB”, “CVV”, “Password”, “PAN”, “Bank account”, and “API token”.
3. **Name heuristics and repetition** treat a title-cased two/three-word value in person/document context as a candidate name. Mr/Ms/Dr can help, but is not required. Once identified, matching occurrences in unstructured visible prose are also redacted.
4. **Address heuristics** group nearby flat/road/locality/village/district/pincode fragments so an entire address is protected rather than one word.
5. **False-positive controls** use context so the system does not hide every number just because it is numeric.

This produces sanitised text and a local redaction map. It does not need a cloud model or GPU.

### 2. OCR privacy for screenshots/documents

Some information appears inside a scanned ID, canvas, image, or PDF and is not available as useful DOM text. Tesseract.js runs locally to read this visual text.

OCR produces:

- recognised text; and
- a bounding box: the pixels where that line/word was found.

The local classification rules decide whether the recognised line is a government ID, DOB, name, address, phone number, etc. The renderer then draws a black rectangle at the returned coordinates. Therefore OCR tells us both *what it read* and *where it read it*; local privacy logic decides whether it is sensitive.

### 3. Face detection and blur

The project performs **face detection**, not person identification. It does not determine who a face belongs to.

MediaPipe returns facial landmark coordinates around eyes, nose, mouth, and jaw. The extension calculates a padded rectangle around those coordinates and blurs that rectangle on a browser canvas. It scans bounded visible image tiles as well as the overall screenshot, which helps detect faces in image cards.

A BlazeFace short-range face-box detector is an additional fallback. Size, confidence, and face-aspect checks help prevent the previous failure mode of blurring an entire scenery image.

### 4. Merge and send

DOM-sensitive regions, OCR-sensitive regions, and face regions are merged. The raw screenshot is retained only in browser memory for the local canvas operation, then the sanitised canvas and sanitised text are used. The outgoing payload contains a privacy proof/redaction map and never intentionally includes the raw screenshot. The Side Panel preview is sanitised and temporary.

No privacy system is perfect: tiny text, low quality documents, unusual layouts/languages, and extreme face poses can reduce accuracy. The design uses overlapping safeguards rather than trusting one detector.

## Models and local runtimes

| Purpose | Current component | Why it is used |
|---|---|---|
| Face landmarks | MediaPipe Face Landmarker Lite, \`face_landmarker.task\` | Runs locally in browser and returns accurate face coordinates for targeted blur. It is lighter than a general visual model. |
| Face fallback | BlazeFace short range, \`blaze_face_short_range.tflite\` | Adds small face-box detection for clear portraits missed by landmark detection. |
| OCR engine | Tesseract.js | Runs locally, supports OCR text boxes/coordinates needed to place blackouts. |
| OCR languages | English + Hindi \`tessdata_best\` | Supports normal English pages and Indian document content; “best” data is larger but selected for better OCR quality. |
| HTML/web text | DOM semantics + local rules | Labels, attributes and strict value formats are quick, explainable and effective for sensitive form fields. |

### Why not a general model for every privacy decision?

A large visual or language model adds download size, RAM, latency, and false positives. It also does not automatically give safe, accurate screenshot pixel coordinates. MediaPipe gives face coordinates; Tesseract gives OCR coordinates; DOM context gives labels and values. Those outputs directly support targeted blur/blackout.

The active browser pipeline does **not** use Transformers.js, ONNX Runtime Web, YOLO, or a WebGPU inference model. Older notes/experiments may mention them, but they are not current extension dependencies.

## What are WebAssembly, WebGPU, ONNX, and Transformers.js?

| Term | What it is | Current project use |
|---|---|---|
| **WebAssembly (WASM)** | Portable binary code that runs efficiently in browsers. | Used by MediaPipe Tasks Vision and Tesseract.js for local CPU inference. |
| **WebGPU** | Browser API for GPU compute and graphics. | Not required by the active privacy pipeline. Chrome may use GPU for normal rendering. |
| **ONNX** | Machine-learning model interchange format commonly used by ONNX Runtime. | Not used in the active browser pipeline. |
| **Transformers.js** | JavaScript library for running transformer models in the browser, commonly via ONNX Runtime. | Not used in the active browser pipeline. It may be evaluated later for optional local named-entity recognition. |
| **TFLite** | Lightweight TensorFlow model format. | Used by the BlazeFace fallback asset via MediaPipe. |

These are formats/runtimes, not privacy models by themselves.

## Local Qwen trials and Gemini planning

The VLM understands user intent and creates a browser task plan. It does not directly click or execute arbitrary code.

We tried local Qwen-family vision models in the 3B and 7B range (some early work referred to “Qwen 3.5”). They were useful for local/private experimentation but did not give sufficiently consistent visual grounding, browser planning, and task-following quality for the required workflows. Local \`Qwen/Qwen2.5-VL-3B-Instruct\` through vLLM remains supported when a local deployment is required.

For better planning quality, the hosted configuration uses Gemini when selected. Provider credentials remain in \`server-vlm/.env\` or server environment variables, never in extension JavaScript or webpage content. Hosted providers receive the same sanitised payload policy as local providers.

\`\`\`env
# server-vlm/.env — do not commit API keys
MODEL_PROVIDER=gemini       # local, gemini, or openai
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
VLM_SERVER_PORT=9001
\`\`\`

## Do we send text, image, or both?

The agent does not always send an image.

1. **Question/answer requests start text-first.** The VLM gets sanitised visible text, metadata, forms, and interactive elements but no screenshot by default.
2. **Action requests usually use sanitised DOM context plus a sanitised image.** Visual grounding is useful when locating an on-screen control or understanding a changed UI.
3. **Navigation/dynamic updates** produce fresh sanitised context for the continuation so the model does not plan against stale page elements.
4. Before an image can leave the browser, local privacy processing completes. The server then limits the already-sanitised image size (default maximum side 1024 px, JPEG quality 75) before provider upload.

The decision is based on request type and visual grounding needs, not an assumption that every prompt needs a screenshot.

## tasks.json: plan, not executable code

The VLM returns JSON. \`server-vlm/task_parser.py\` extracts and validates it before the browser receives it. Arbitrary JavaScript, shell commands, and unrestricted browser instructions are not executed.

\`\`\`json
{
  \"taskId\": \"ab12cd34\",
  \"intent\": \"Run the visible C program\",
  \"type\": \"tasks\",
  \"answer\": \"\",
  \"task_complete\": false,
  \"requires_confirmation\": false,
  \"requires_screenshot\": false,
  \"reasoning\": \"The Run control is visible.\",
  \"status\": \"pending\",
  \"tasks\": [
    {
      \"step\": 1,
      \"action\": \"click\",
      \"description\": \"Click the Run button\",
      \"target\": {
        \"elementId\": \"element_7\",
        \"selector\": \"button.run\",
        \"rect\": { \"x\": 430, \"y\": 110, \"width\": 110, \"height\": 36 }
      }
    }
  ]
}
\`\`\`

Possible outcomes:

| Outcome | Meaning |
|---|---|
| \`answer\` | A text answer; no browser action needed. |
| \`tasks\` | One or more browser actions were planned. |
| \`mixed\` | Text answer and task list both present. |
| \`requires_confirmation\` | UI asks user approval before execution. |
| \`requires_screenshot\` | More visual context is requested rather than guessing. |
| invalid output | Parser rejects malformed or unsupported output. |

Allowed actions are: \`click\`, \`dblclick\`, \`rightclick\`, \`type\`, \`key\`, \`select\`, \`scroll\`, \`wait\`, \`navigate\`, \`hover\`, \`focus\`, \`clear\`, \`drag\`, \`opentab\`, \`closetabs\`, and \`screenshot\`.

The local executor in \`extensions/src/chatbot.js\` resolves element IDs/selectors/coordinates against the current DOM, executes one allowed action at a time, waits for updates, and updates status in the Side Panel. It can persist state before navigation and re-plan from the destination page. A call budget prevents uncontrolled loops.

## End-to-end workflow

\`\`\`text
User message in Side Panel
  → classify request: question or browser action
  → collect sanitised DOM context
  → if needed, capture screenshot locally
  → run DOM/OCR/face privacy redaction
  → send only sanitised payload to server
  → VLM returns answer / tasks / mixed / confirmation request
  → server validates tasks.json
  → extension executes allowed steps one by one
  → navigation/update: fresh sanitised context if continuation is needed
  → show complete, failed, stopped, or approval-needed status
\`\`\`

## The Chrome manifest and permissions

\`extensions/manifest.json\` is the extension **manifest**: Chrome’s required configuration file. It declares name/version, scripts, permissions, model assets, the Side Panel, and Content Security Policy.

Key declarations:

- **Manifest V3**: modern Chrome extension platform.
- **Background service worker**: browser-level routing, screenshot capture, Side Panel support, and Chrome tab actions.
- **Content scripts**: page-local DOM extraction and validated task execution.
- **Permissions**: \`activeTab\`, \`tabs\`, \`scripting\`, \`storage\`, \`sidePanel\`, and \`debugger\`.
- **Host permissions**: website access and connection to the configured local/VLM endpoint.
- **Web-accessible resources**: bundled MediaPipe, Tesseract and model assets.
- **\`wasm-unsafe-eval\`**: allows bundled WebAssembly runtimes to initialise in extension pages; it does not let websites execute arbitrary extension code.

Review permissions before installing. A general browser agent needs broad website access; production deployments should narrow that scope where possible.

## Resource use and GPU requirements

The current unpacked build is about **95 MB**, mainly because local privacy assets are bundled:

| Component | Approximate disk size |
|---|---:|
| MediaPipe WASM runtime | 34 MB |
| Tesseract OCR runtime | 30 MB |
| English + Hindi high-accuracy OCR data | 27 MB |
| Face models | 3.9 MB |

At idle the extension should use little CPU. During a privacy scan, OCR initialisation, screenshot canvas buffers, and face-image tiles temporarily increase CPU/RAM. Exact peak use depends on display resolution, image count, page complexity, and other Chrome tabs.

- **GPU for browser privacy:** not necessary. The active OCR/face pipeline runs via WASM on CPU.
- **GPU for local Qwen/vLLM:** recommended for useful local VLM speed; this is a server-side requirement, not an extension requirement.
- **Hosted Gemini/OpenAI:** no local VLM GPU required; server network access and API credentials are required.

## Installation

### Prerequisites

- Chrome/Chromium with Side Panel support;
- Node.js/npm to build from source;
- Python 3.10+ only when self-hosting the separate `server-vlm` service;
- local vLLM/Qwen or hosted Gemini/OpenAI-compatible provider credentials.

The local privacy scan works without a GPU. Agent chat/task planning requires the running \`server-vlm\` endpoint (or an equivalent deployment).

### Build/load extension

\`\`\`bash
npm install
npm run build
\`\`\`

Open \`chrome://extensions\`, enable **Developer mode**, click **Load unpacked**, and choose \`dist/\`.

### Run the separate VLM service (only if self-hosting)

\`\`\`bash
cd server-vlm
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# Linux/macOS: source .venv/bin/activate
python -m pip install -r requirements.txt
\`\`\`

Configure \`server-vlm/.env\`, then run \`./start.sh\` on Linux/macOS or \`./start.ps1\` in PowerShell.

\`\`\`bash
curl http://127.0.0.1:9001/health
\`\`\`

The default endpoint is \`http://127.0.0.1:9001/v1/agent\`. Never place provider API keys in the extension.

## Project layout

\`\`\`text
extensions/
  manifest.json                    Chrome MV3 configuration
  src/background.js                browser-level routing/capture/tasks
  src/content.js                   DOM extraction and privacy redaction
  src/local-vision-privacy.js      MediaPipe + Tesseract local vision
  src/chatbot.js                   page-local runtime/task executor
  public/home.html, home.js        native Side Panel UI
server-vlm/
  main.py                          VLM provider gateway service
  prompt_builder.py                compact sanitised model prompts
  task_parser.py                   strict tasks.json validation
  config.py                        environment configuration
dist/                              built unpacked extension
\`\`\`

## Security boundaries and limitations

- Raw screenshots are held only temporarily in browser memory for local sanitisation; they are not downloaded or sent to the VLM.
- The Side Panel preview is sanitised and temporary.
- The server checks privacy metadata and validates model output before execution.
- Provider keys remain server-side.
- A VLM cannot run arbitrary code: action parsing and allow-lists constrain plans.

This is an active prototype. OCR, face detection, and heuristic name recognition can miss unusual, tiny, low-quality, or multilingual content. Test with synthetic data, inspect sanitised output, and do not use an experimental browser agent as the only protection for highly sensitive production data.
