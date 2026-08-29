# Privacy-Preserving Browser Vision Agent

SIH prototype — minimal end-to-end pipeline from Chrome Extension → FastAPI → Dummy Planner → Action Execution.

## Project Structure

```
visual-perception-browser-agent/
├── backend/           # FastAPI server
│   ├── main.py
│   ├── routers/agent.py
│   ├── models/schemas.py
│   ├── planner/
│   │   ├── base.py          # Abstract interface
│   │   └── dummy_planner.py # Keyword-matching planner
│   └── requirements.txt
│
└── extension/         # Chrome Extension (MV3 + TypeScript)
    ├── src/
    │   ├── types.ts
    │   ├── content.ts
    │   ├── background.ts
    │   └── popup.ts
    ├── public/
    │   ├── manifest.json
    │   └── popup.html
    ├── webpack.config.js
    ├── tsconfig.json
    └── package.json
```

---

## Quickstart

### 1. Backend

```bash
cd backend

# Create & activate virtual environment
python -m venv .venv
# Windows:
.venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Start the server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The backend uses a separate OpenAI-compatible VLM server by default. Start a
Qwen vision model with vLLM on port 8001, then start the backend:

```bash
vllm serve Qwen/Qwen2.5-VL-3B-Instruct --port 8001
cd backend
set PLANNER_MODE=vlm
set VLM_BASE_URL=http://localhost:8001/v1
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

On PowerShell, use `$env:PLANNER_MODE="vlm"` and
`$env:VLM_BASE_URL="http://localhost:8001/v1"`. Set `PLANNER_MODE=dummy` to
run without a VLM server.

Swagger UI available at: http://localhost:8000/docs

### 2. Chrome Extension

```bash
cd extension

npm install
npm run build     # one-time build → dist/
# or
npm run dev       # watch mode for development
```

Then in Chrome:
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/dist/` directory

---

## Testing

### Test the API directly

```bash
curl -X POST http://localhost:8000/agent/step \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "test-001",
    "task": "Click the login button",
    "url": "https://example.com",
    "page_title": "Example",
    "visible_text": "Welcome to our site. Please login.",
    "ui_elements": [
      {"id": "ag-1", "role": "button", "tag": "button", "text": "Login", "attributes": {}},
      {"id": "ag-2", "role": "textbox", "tag": "input",  "text": "", "attributes": {"type": "email"}}
    ]
  }'
```

Expected response:
```json
{
  "session_id": "test-001",
  "action": { "type": "CLICK", "target_id": "ag-1" },
  "reasoning": "Clicking element 'ag-1' (role=button, text='Login').",
  "done": false
}
```

### Test the Extension

1. Navigate to any page (e.g., https://google.com)
2. Click the extension icon
3. Type a task: `Type hello in the search box`
4. Click **Run Step**
5. Observe the action being executed on the page and the result displayed in the popup

---

## Architecture

```
Chrome Extension (popup)
        │
        │  RUN_AGENT_STEP
        ▼
  background.ts (service worker)
        │
        ├─ COLLECT_STATE ──► content.ts ──► BrowserState
        │
        ├─ POST /agent/step ──► FastAPI ──► DummyPlanner
        │                                       │
        │                                  AgentAction
        │
        └─ EXECUTE_ACTION ──► content.ts ──► DOM manipulation
```

### Adding the Real VLM

Replace `DummyPlanner` with a `VLMPlanner` that implements `BasePlanner.plan()`:

```python
# backend/planner/vlm_planner.py
class VLMPlanner(BasePlanner):
    def plan(self, context: AgentStepRequest) -> tuple[AgentAction, str]:
        prompt = ContextBuilder.build(context)
        raw = vlm_client.complete(prompt)   # call your GPU server
        action = ActionValidator.parse(raw)
        return action, raw
```

Then in `routers/agent.py`, change:
```python
# from planner.dummy_planner import DummyPlanner
from planner.vlm_planner import VLMPlanner
_planner = VLMPlanner()
```

That's the only change needed.
