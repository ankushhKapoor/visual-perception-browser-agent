
````md
# Visual Perception Browser Agent

A browser-based visual perception system that combines **webpage DOM information** with **screenshot-based computer vision** to generate structured information about the currently visible browser page.

This project is part of the work for **SIH26171**, focusing on browser perception and visual understanding.

---

## Overview

Webpages contain two important types of information:

1. **Structural information**
   - DOM elements
   - Buttons
   - Links
   - Forms
   - Input fields
   - Page metadata

2. **Visual information**
   - Text rendered on the screen
   - Images
   - Visual regions
   - Objects
   - Screen coordinates

Using only the DOM may miss information that exists visually.

Using only screenshots may miss important semantic and structural information available in the browser.

This project combines both sources of information to build a structured representation of the current browser state.

---

## Architecture

```text
                    ┌─────────────────────┐
                    │      Webpage        │
                    └──────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
       DOM / Browser Context            Screenshot Capture
                │                             │
                ▼                             ▼
       Interactive Elements             Visual Analysis
       Forms                            ├── OCR
       Page Information                 ├── Visual Regions
       Element Metadata                 └── Object Detection
                │                             │
                └──────────────┬──────────────┘
                               │
                               ▼
                  Browser Perception State
                               │
                               ▼
                       Local FastAPI Server
````

---

# Features

## Browser Context Extraction

The browser-side component collects useful webpage information, including:

* Current page URL
* Page title
* Interactive elements
* Buttons
* Links
* Input fields
* Forms
* Element metadata
* Accessibility-related information
* Element positions where available

---

## Screenshot Capture

The Chrome Extension captures the currently visible browser tab using the Chrome Tabs API.

The screenshot can then be processed by the local visual perception backend.

---

## OCR

The visual pipeline extracts text from screenshots.

This helps identify text that may not be directly available through normal DOM extraction.

OCR results can include:

* Detected text
* Confidence
* Bounding boxes
* Spatial coordinates

---

## Visual Region Detection

The screenshot analysis pipeline identifies meaningful visual regions and spatial information.

These regions help provide visual context about the webpage.

---

## Object Detection

The project includes an OpenCV/YOLO-based visual detection pipeline for detecting objects and visual content.

Detected information can include:

* Object label
* Confidence
* Bounding box
* Position

---

## Browser Perception State

The browser and visual information are combined into a structured perception state.

The state can contain information such as:

```json
{
  "page": {},
  "interactiveElements": [],
  "forms": [],
  "visualText": [],
  "visualRegions": [],
  "objects": [],
  "privacy": {},
  "summary": {}
}
```

This structured output can be used by downstream components for further reasoning or browser automation.

---

# Project Structure

```text
visual-perception-browser-agent/
│
├── extensions/
│   │
│   ├── manifest.json
│   │
│   └── src/
│       ├── background.js
│       └── content.js
│
├── benchmarks/
│   ├── results/
│   │   └── .gitkeep
│   │
│   └── screenshots/
│       └── .gitkeep
│
├── yolo-opencv/
│   ├── combined_detect.py
│   ├── detect.py
│   ├── opencv_detect.py
│   └── server.py
│
├── .gitignore
├── README.md
└── requirements.txt
```

---

# Components

## Chrome Extension

The browser extension is responsible for interacting with the active webpage.

### `extensions/manifest.json`

Defines the Chrome Extension configuration.

The project uses:

* Manifest Version 3
* Background service worker
* Content scripts
* Required browser permissions

---

### `extensions/src/content.js`

The content script runs in the webpage context.

Its responsibilities include:

* Collecting webpage information
* Extracting relevant DOM context
* Identifying interactive elements
* Extracting form-related information
* Communicating with the background service worker
* Building browser perception information

---

### `extensions/src/background.js`

The background service worker handles browser-level operations.

Its responsibilities include:

* Receiving messages from the content script
* Capturing visible browser screenshots
* Sending screenshots to the backend
* Sending sanitized screenshots when required
* Sending browser perception information to the server

---

# Visual Perception Backend

The visual analysis code is located in:

```text
yolo-opencv/
```

---

## `combined_detect.py`

This file provides the combined visual analysis pipeline.

It is responsible for processing an image and generating structured visual information.

The analysis can include:

* OCR
* Text detection
* Bounding boxes
* Visual regions
* Object detection
* Image metadata

---

## `detect.py`

Contains detection-related functionality for the visual processing pipeline.

---

## `opencv_detect.py`

Contains OpenCV-based image processing and detection functionality.

---

## `server.py`

Runs the FastAPI backend.

The server provides endpoints for:

* Checking server health
* Receiving images for visual analysis
* Receiving browser perception information

---

# API Endpoints

## Root

```http
GET /
```

Returns basic information about the API service.

---

## Health Check

```http
GET /health
```

Example response:

```json
{
  "status": "healthy"
}
```

---

## Screenshot Analysis

```http
POST /analyze
```

Accepts an image through multipart form data.

The extension sends only the locally redacted screenshot. The backend keeps
that sanitized upload in `yolo-opencv/sanitized_screenshots/` and does not
delete it after analysis. The `/analyze` response includes the saved filename,
local path, and retrieval URL for later VLM processing. Generated screenshots
are ignored by Git.

### Input

```text
image
```

### Processing Flow

```text
Screenshot
    │
    ▼
POST /analyze
    │
    ▼
FastAPI Server
    │
    ▼
combined_detect.py
    │
    ├── OCR
    ├── Visual Detection
    ├── Object Detection
    └── Bounding Box Processing
    │
    ▼
Structured JSON Result
```

---

## Browser Perception

```http
POST /perception
```

Receives the structured browser perception state.

The received information may include:

* Page information
* Interactive elements
* Forms
* Visual text
* Visual regions
* Objects
* Privacy metadata
* Summary information

---

# Message Flow

The extension communicates internally using Chrome runtime messages.

The implemented message flow includes:

---

## Capture Screenshot

```text
content.js
    │
    │ CAPTURE_SCREENSHOT
    ▼
background.js
    │
    ▼
chrome.tabs.captureVisibleTab()
    │
    ▼
Screenshot
```

---

## Capture and Analyze

```text
content.js
    │
    │ CAPTURE_AND_ANALYZE
    ▼
background.js
    │
    ▼
Capture Screenshot
    │
    ▼
POST /analyze
    │
    ▼
Visual Analysis
```

---

## Send Sanitized Screenshot

```text
SEND_SANITIZED_FOR_ANALYSIS
```

This message is used to send a sanitized screenshot to the visual analysis backend when integrated with the privacy-processing flow.

---

## Send Browser Perception State

```text
SEND_BROWSER_PERCEPTION
```

The structured perception state is sent to:

```text
POST /perception
```

---

# Complete Workflow

```text
┌─────────────────────┐
│   User Opens Page   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│    content.js       │
│                     │
│ Extract Browser     │
│ Context             │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   background.js     │
│                     │
│ Capture Screenshot  │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│   FastAPI Backend   │
│                     │
│    POST /analyze    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Visual Perception   │
│                     │
│ • OCR               │
│ • Regions           │
│ • Objects           │
│ • Bounding Boxes    │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Structured Visual   │
│ Information         │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Browser Perception  │
│ State               │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ POST /perception    │
└─────────────────────┘
```

---

# Installation

## Prerequisites

Make sure the following are installed:

* Python
* Google Chrome or another Chromium-based browser
* Git

---

## Clone the Repository

```bash
git clone <repository-url>
cd visual-perception-browser-agent
```

---

## Create a Virtual Environment

### Windows

```powershell
python -m venv .venv
.venv\Scripts\activate
```

### Linux/macOS

```bash
python3 -m venv .venv
source .venv/bin/activate
```

---

## Install Dependencies

```bash
pip install -r requirements.txt
```

---

# Running the Backend

Navigate to the backend directory:

```powershell
cd yolo-opencv
```

Run:

```powershell
python server.py
```

Alternatively, depending on the FastAPI configuration:

```powershell
uvicorn server:app --reload
```

The server is expected to run locally on:

```text
http://127.0.0.1:8000
```

---

# Checking the Backend

Open:

```text
http://127.0.0.1:8000/health
```

Expected response:

```json
{
  "status": "healthy"
}
```

---

# Loading the Chrome Extension

## Step 1

Open Chrome and navigate to:

```text
chrome://extensions
```

---

## Step 2

Enable:

```text
Developer mode
```

---

## Step 3

Click:

```text
Load unpacked
```

---

## Step 4

Select the appropriate extension directory containing:

```text
manifest.json
```

For this repository, verify the extension structure before loading and select the directory expected by Chrome.

---

# Testing

To test the complete pipeline:

## 1. Start the backend

```powershell
cd yolo-opencv
python server.py
```

---

## 2. Verify the backend

Open:

```text
http://127.0.0.1:8000/health
```

---

## 3. Load the Chrome Extension

Load the unpacked extension from:

```text
chrome://extensions
```

---

## 4. Open a Test Webpage

Use a webpage containing:

* Text
* Buttons
* Links
* Forms
* Images

---

## 5. Trigger the Perception Flow

The expected processing flow is:

```text
Browser Context
      +
Screenshot
      │
      ▼
Visual Analysis
      │
      ▼
Structured Perception Data
      │
      ▼
FastAPI Server
```

---

# Benchmark Directories

The repository contains directories for benchmark data:

```text
benchmarks/
├── results/
└── screenshots/
```

Generated screenshots and benchmark results are excluded from version control.

The directories are retained using `.gitkeep` files.

---

# Model Files

Large model weights are intentionally excluded from the repository.

Examples include:

```text
*.pt
*.pth
*.onnx
```

If the visual detection pipeline requires a model file, it must be placed in the appropriate local directory before running the detection pipeline.

For example:

```text
yolo-opencv/models/
```

or according to the paths configured in the source code.

---

# Technologies Used

## Browser

* JavaScript
* Chrome Extension Manifest V3
* Chrome Runtime API
* Chrome Tabs API

## Backend

* Python
* FastAPI
* Uvicorn

## Computer Vision

* OpenCV
* YOLO-based object detection
* OCR
* Image processing

---

# Current Scope

The current implementation focuses on:

* Browser perception
* DOM context extraction
* Interactive element detection
* Form extraction
* Screenshot capture
* OCR-based visual text extraction
* Visual region processing
* Object detection
* Bounding box processing
* Structured browser perception data
* Local backend communication

---

# Integration

This project is designed to provide browser perception information that can be consumed by downstream components.

The generated structured context can support future stages such as:

```text
Browser Perception
        │
        ▼
Context Understanding
        │
        ▼
Task Reasoning
        │
        ▼
Action Planning
        │
        ▼
Browser Automation
```

The current repository primarily focuses on the **browser perception and visual analysis layer**.

---

# Important Notes

* The backend currently runs locally.
* Model weights are not committed to the repository.
* Generated benchmark screenshots and results are excluded from Git.
* The project uses a Chrome Extension for browser-side data collection.
* Visual analysis is performed through the Python backend.

---

# Status

## Implemented

* [x] Chrome Extension structure
* [x] Manifest V3 configuration
* [x] Content script
* [x] Background service worker
* [x] Browser runtime messaging
* [x] Screenshot capture
* [x] FastAPI backend
* [x] Image upload endpoint
* [x] OCR integration
* [x] Visual detection pipeline
* [x] Object detection integration
* [x] Browser perception endpoint
* [x] Structured perception data flow
* [x] Benchmark directory structure
* [x] Git configuration for generated files and model weights

---
