# SIH26171 — Agent Flow and Team Implementation Guide

## On-device Visual Perception for Light-weight Browser Agents

**Team:** Neha, Rakshita, Ankush

## Project Goal
Build a privacy-preserving browser agent that understands browser context locally, detects and redacts sensitive/PII information before any network request, sends only sanitized context to a server-side LLM/VLM, receives structured actions, and executes them in the browser.

---

# 1. Mandatory Privacy Boundary

```text
NEHA: RAW LOCAL CONTEXT
        ↓
RAKSHITA: PRIVACY DETECTION + REDACTION
        ↓
SANITIZED CONTEXT ONLY
        ↓
ANKUSH: SERVER-SIDE REASONING
```

**Critical rule:** Raw sensitive data must not leave the client. Rakshita sends Ankush only sanitized text, sanitized visual context when needed, safe element identifiers, and redaction metadata.

---

# 2. Overall Architecture

```text
USER TASK
    ↓
EXTENSION CHAT INTERFACE
    ↓
NEHA — LOCAL CONTEXT & VISUAL PERCEPTION
DOM + Accessibility + Screenshot + OCR + UI Vision
    ↓
RAKSHITA — PRIVACY FILTER
PII Detection + Local Classification + Face Detection + Redaction
    ↓
ONLY SANITIZED CONTEXT LEAVES DEVICE
    ↓
ANKUSH — SERVER AGENT
LLM/VLM + Reasoning + Task State + Action Queue
    ↓
STRUCTURED ACTION JSON
    ↓
BROWSER EXECUTION
    ↓
NEW STATE → REPEAT
```

---

# 3. Neha — Browser Context, Text Extraction and Visual Perception

## Main Responsibility
Make the extension observe and understand the current browser state locally.

## Tasks

### Browser extension foundation
- Set up the browser extension architecture.
- Use Manifest V3 where applicable.
- Implement content scripts.
- Implement background/service worker communication.
- Implement communication with the popup/chat interface.
- Define reusable message formats.

### DOM extraction
Extract visible:
- Text
- Buttons
- Inputs and text areas
- Links
- Forms
- Labels and headings
- Element roles
- Bounding boxes
- Visibility state
- Enabled/disabled state

Rules:
- Prefer visible, relevant information.
- Avoid hidden data, tokens, or unnecessary script data.

### Accessibility extraction
Extract:
- `role`
- `aria-label`
- Accessible name
- Input type
- Placeholder
- Associated labels
- Element geometry

DOM and accessibility information should be the first choice because they are usually cheaper and more accurate than visual inference.

### Screenshot capture
Implement local viewport capture and provide:
- Screenshot
- Width and height
- Viewport dimensions
- Scroll position
- Device pixel ratio

The raw screenshot remains local until privacy processing is complete.

### OCR
Use OCR only when DOM information is insufficient, such as:
- Text inside images
- Canvas-rendered text
- PDF-like content
- Screenshot-only content

OCR output should include text, bounding box, and confidence.

### Local UI vision
Implement the local visual perception required by the SIH problem statement.

Possible targets:
- Buttons
- Input fields
- Icons
- Dialogs
- Forms
- Important visual regions

Do not run a heavy vision model continuously.

Preferred flow:
```text
Page/state change
    ↓
Is DOM sufficient?
    ├─ Yes → use DOM
    └─ No  → run visual perception
```

### Context output
Provide Rakshita:
```text
DOM context
Accessibility context
OCR results + coordinates
UI detections
Raw screenshot locally
Viewport metadata
```

## Model/technology suggestions
These are suggestions, not mandatory requirements.

- DOM/API understanding: no model initially.
- OCR: Tesseract.js or a browser-compatible lightweight OCR/ONNX option.
- UI detection: lightweight YOLO/ONNX detector, UI-specific detector, or lightweight ViT/equivalent.
- Runtime: ONNX Runtime Web.
- Acceleration: WebGPU when available.
- Fallback: WASM/CPU.

## If hardware is weak
- Use lower image resolution.
- Run models conditionally.
- Cache unchanged screen states.
- Prefer DOM before OCR or vision.

## Extra add-ons
- Page change detection.
- Screenshot hashing to avoid duplicate inference.
- Adaptive resolution.
- Confidence scores.
- Local performance logging.

---

# 4. Rakshita — Privacy Detection and Redaction

## Main Responsibility
Own the privacy boundary and ensure sensitive information is detected and sanitized before any network request.

## Privacy categories

### Critical
- Password
- OTP
- Credit/debit card details
- CVV
- API key
- Authentication token
- Session secret

### High sensitivity
- Email
- Phone number
- Government ID
- Financial information
- Employee/student ID
- Face

### Context-dependent
- Name
- Address
- Date of birth
- Other identifiers

## Tasks

### DOM-based privacy detection
Use:
- Input type
- `autocomplete`
- Name and ID
- Placeholder
- Labels
- ARIA attributes

Example:
```html
<input type="password">
```

Should immediately produce:
```text
PASSWORD → CRITICAL → BLACKOUT
```

### Rule-based text PII detection
Implement local detection using:
- Regex
- Format validation
- Pattern matching
- Context/keyword rules

Examples:
- Email
- Phone
- Card-like numbers
- OTP-like values
- Known secret patterns

### Local small privacy model
Use ML mainly for ambiguous cases.

Possible approaches:
- Lightweight NER/token classification model.
- Small text classifier: PUBLIC / PERSONAL / SENSITIVE / SECRET.
- Hybrid fusion.

Recommended order:
```text
DOM rules
    +
Regex
    +
Small local NER/classifier for ambiguous cases
    ↓
Final privacy decision
```

### Local deployment suggestions
Investigate:
- Transformers.js
- ONNX Runtime Web
- WebGPU
- WASM/CPU fallback

CPU strategy:
- Small/quantized model.
- Short text chunks.
- Run ML only when rules are uncertain.
- Cache repeated results.

### Face detection
Use a lightweight local face detector, for example a MediaPipe-compatible approach.

Output:
```text
FACE + BOUNDING BOX + CONFIDENCE
```

### Privacy fusion
Combine:
```text
DOM signals
+
OCR text
+
Rules/regex
+
Local model classification
+
Face detection
+
UI/geometry context
```

Fuse overlapping regions and add suitable safety margins.

### Coordinate mapping
Correctly map coordinates between:
- OCR resolution
- Screenshot resolution
- devicePixelRatio
- Browser zoom
- Viewport and scroll coordinates

Use one final screenshot coordinate system.

### Screenshot redaction
Implement local image modification.

**BLACKOUT**
- Password
- OTP
- API keys
- Tokens
- Card numbers

**BLUR**
- Faces

**MASK / PLACEHOLDER**
- Email
- Phone
- Name

### DOM/text sanitization
Example:
```text
Original: ankush@example.com
Sanitized: <EMAIL_1>
```

The server should know that information was intentionally redacted but must not receive the original value.

### Mandatory final privacy gate
Before any outbound request:

```text
OUTBOUND PAYLOAD
    ↓
FINAL PRIVACY CHECK
    ↓
Leak detected?
    ├─ Yes → block/re-redact
    └─ No  → send
```

## Output to Ankush
Only provide:
- Sanitized DOM/text
- Sanitized screenshot when required
- Redaction metadata
- Safe UI element identifiers

Never provide raw detected secrets or unredacted PII to the server module.

## Extra add-ons
- Privacy confidence score.
- Strict/balanced policy modes.
- Privacy audit log without raw values.
- Synthetic PII test suite.
- Final outbound payload scanner.

---

# 5. Ankush — Server Agent, LLM/VLM and Browser Action Loop

## Main Responsibility
Build the server-side intelligence and agent execution loop using **sanitized context only**.

## Tasks

### Backend server
Suggested direction:
```text
Python + FastAPI
```

Implement:
- API endpoints
- Request validation
- Response validation
- Error handling
- Logging
- Session/task state

### Server-side LLM/VLM
The server receives:
```text
User task
+
Sanitized DOM/text
+
Sanitized screenshot only when needed
+
Redaction metadata
```

The official PS permits open-source/open-weight deployable models and allows cloud-hosted versions during SIH.

### LLM vs VLM routing

**Text/DOM-first path**
```text
User task + sanitized DOM/accessibility
    ↓
LLM
    ↓
Action
```

Use when structured context is sufficient.

**Visual path**
```text
User task + sanitized screenshot + sanitized DOM
    ↓
VLM
    ↓
Action
```

Use when visual understanding is necessary:
- Spatial reasoning
- Canvas
- Image-heavy UI
- Ambiguous icons
- Poor DOM representation

Do not send screenshots by default.

### Model suggestions
Investigate model families rather than locking the project to one model:
- Qwen text/instruction models for structured text reasoning.
- Qwen VL/multimodal models or comparable open-weight VLMs for visual reasoning.
- Smaller variants or quantized models when resources are limited.

Select after measuring:
- VRAM/RAM needs
- UI reasoning quality
- Latency
- Deployment complexity

### Hardware strategy

**Server GPU available**
- Use VLM when visual context is required.
- Optimize or quantize where useful.

**Limited GPU**
- Prefer smaller VLM.
- Reduce sanitized image resolution.
- Use DOM-first routing.

**CPU-only**
- Prefer structured text/DOM-first reasoning.
- Use smaller/quantized LLM.
- Invoke visual reasoning only when essential.

### Agent prompt
The model should:
- Use only provided sanitized context.
- Understand redaction placeholders.
- Never attempt to reconstruct private values.
- Return structured actions.
- Avoid arbitrary JavaScript generation.

### Structured actions
Example:
```json
{
  "status": "CONTINUE",
  "action": "CLICK",
  "target": {"element_id": "el_001"},
  "confidence": 0.94
}
```

Supported actions can include:
- CLICK
- TYPE
- SCROLL
- SELECT
- PRESS_KEY
- WAIT
- DONE
- ASK_USER_CONFIRMATION

### Task queue/state
Maintain state for multi-step tasks.

Example:
```text
Open Gmail
→ Click Compose
→ Fill recipient
→ Fill subject
→ Fill body
→ Ask confirmation before sending
```

Keep task ID, current step, and action history.

### Browser action loop
```text
SANITIZED STATE
    ↓
SERVER MODEL
    ↓
NEXT ACTION
    ↓
EXTENSION EXECUTES
    ↓
NEW STATE
    ↓
LOCAL PRIVACY PROCESSING
    ↓
NEW SANITIZED STATE
    ↓
REPEAT
```

Prefer one validated action or a small next step at a time to avoid stale UI errors.

### Action safety
Support confirmation for potentially irreversible actions:
- SEND
- DELETE
- PAY
- TRANSFER

### Performance logging
Measure:
- Request time
- Model inference time
- Response parsing
- Total server latency
- Number of agent iterations

## Extra add-ons
- Action confidence thresholds.
- Retry on unexpected UI changes.
- JSON schema validation.
- LLM/VLM routing.
- Explainable action trace.
- Limited task-scoped memory.

---

# 6. Extension Chatbot Interface

Build a simple chatbot-like extension UI.

Suggested components:
- Task text input
- Send/start button
- Current status
- Privacy status
- Action progress
- Confirmation dialog

Example:
```text
✓ Screen context captured locally
✓ Sensitive data detected
✓ Sensitive regions redacted locally
✓ Sanitized context sent
→ Clicking Compose
```

Do not expose raw private values in logs or debug panels.

---

# 7. Demo Use Case — Gmail Email Drafting

Example task:

> Draft an email to the project coordinator saying that the prototype is ready.

Flow:

```text
User enters task
    ↓
Neha captures current browser context
    ↓
Rakshita detects visible PII and redacts it
    ↓
Only sanitized context is sent to Ankush's server
    ↓
LLM/VLM selects next action
    ↓
Extension executes action
    ↓
New state is processed again
    ↓
Repeat until draft is complete
    ↓
Ask user confirmation before final SEND
```

For the demo, visibly show:
```text
RAW SCREEN — LOCAL ONLY
    ↓
DETECTED SENSITIVE REGIONS
    ↓
SANITIZED SCREEN
    ↓
SERVER PAYLOAD
```

---

# 8. Shared Interfaces

## Neha → Rakshita
- Visible DOM
- Accessibility data
- OCR text + bounding boxes
- UI detections
- Raw screenshot kept locally
- Viewport metadata

## Rakshita → Ankush
- Sanitized DOM
- Sanitized text
- Sanitized screenshot if required
- Redaction metadata
- Safe element identifiers

## Ankush → Extension
Example:
```json
{
  "action": "CLICK",
  "target": {"element_id": "el_001"}
}
```

The extension executes the action and produces the next browser state.

---

# 9. Shared Data Contracts

## Sensitive region
```typescript
interface SensitiveRegion {
  type: string;
  confidence: number;
  bbox?: BoundingBox;
  action: "BLACKOUT" | "BLUR" | "MASK";
  source: string[];
}
```

## Sanitized context
```typescript
interface SanitizedContext {
  sanitizedText: string;
  sanitizedDom: unknown;
  redactions: SensitiveRegion[];
  visualContextRequired: boolean;
  sanitizedImage?: unknown;
}
```

## Agent action
```typescript
interface AgentAction {
  status: "CONTINUE" | "DONE" | "CONFIRMATION_REQUIRED";
  action?: string;
  target?: { element_id?: string };
  confidence?: number;
}
```

---

# 10. Implementation Philosophy

Do not use ML for everything.

```text
CHEAP / DETERMINISTIC FIRST
    ↓
DOM
Accessibility
Rules
Regex
    ↓
LIGHTWEIGHT ML WHEN NEEDED
    ↓
OCR
UI detection
PII classifier
Face detection
    ↓
SERVER-SIDE HEAVY REASONING
    ↓
LLM / VLM
```

This directly helps:
- Visual accuracy
- PII detection
- Redaction quality
- Client resource utilization
- Latency

---

# 11. Technology Directions

## Browser side
Investigate:
- JavaScript/TypeScript
- Browser Extension APIs
- ONNX Runtime Web
- Transformers.js
- WebGPU
- WebAssembly
- Canvas/OffscreenCanvas

## Client runtime strategy
```text
WebGPU available?
    ├─ Yes → accelerated inference
    └─ No  → WASM/CPU fallback
```

## Server side
Investigate:
- Python
- FastAPI
- Open-weight LLM/VLM
- Quantization where appropriate

---

# 12. Add-ons That Can Make the Project Stand Out

Add these only after the core pipeline works.

## Privacy Firewall
A final validator checks every outbound payload.

## Adaptive Perception
```text
DOM sufficient?
    ├─ Yes → skip vision
    └─ No  → run visual model
```

## Privacy Explanation Panel
Show categories, not private values:
```text
✓ 1 Email masked
✓ 1 Password field blocked
✓ 1 Face blurred
```

## Redaction Overlay
Show the local transformation from original screen to sanitized screen.

## Performance Metrics
Show:
- Local inference latency
- Number of models invoked
- Resource usage where measurable
- Server latency
- End-to-end latency

---

# 13. Things That Must Not Happen

Do not:
- Send raw screenshots to the server.
- Send PII first and redact it server-side.
- Depend only on a heavy local model.
- Run vision inference continuously without need.
- Attempt to reconstruct redacted values.
- Return arbitrary executable JavaScript from the LLM.
- Automatically execute dangerous final actions without confirmation.

---

# 14. Minimum Successful Prototype

The final MVP should prove:

1. User enters a natural-language task.
2. Browser state is understood locally.
3. Sensitive information is detected locally.
4. Screenshot/text is redacted locally.
5. Raw sensitive information does not leave the client.
6. Sanitized context reaches the server.
7. Server-side LLM/VLM interprets the sanitized context.
8. The server returns a structured action.
9. The browser executes the action.
10. At least one meaningful multi-step task is completed.

---

# 15. Final Ownership Summary

| Member | Primary Ownership |
|---|---|
| **Neha** | Extension context acquisition, DOM/accessibility extraction, screenshots, OCR, local UI vision |
| **Rakshita** | PII detection, local privacy model, face detection, coordinate mapping, sanitization, screenshot redaction, final privacy gate |
| **Ankush** | Backend, LLM/VLM integration, task state/queue, reasoning, structured actions, server routing, agent loop |

All three members should jointly participate in final integration and testing.

---

# Final Principle

> **Use lightweight local intelligence to understand and protect the user's screen, then use powerful server-side AI only on sanitized context for reasoning and browser task execution.**

The priority is not to build the largest AI pipeline. The priority is a reliable, demonstrable end-to-end system that satisfies all SIH26171 requirements.
