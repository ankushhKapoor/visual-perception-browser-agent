# Visual Perception Browser Agent

## SIH26171 – Privacy-Preserving Browser Vision Agent

A browser-based perception system designed to collect and structure webpage information by combining **DOM understanding** with **screenshot-based visual perception**.

The system is implemented as a Chrome Extension with a local FastAPI backend. It extracts meaningful browser context, captures the visible webpage, performs OCR and visual analysis, maps structural and visual information together, and generates a structured **Browser Perception State** for downstream components.

---

# Table of Contents

- [Project Overview](#project-overview)
- [Problem Context](#problem-context)
- [Objectives](#objectives)
- [Current Scope](#current-scope)
- [System Architecture](#system-architecture)
- [Complete Data Flow](#complete-data-flow)
- [Components](#components)
- [Browser Context Extraction](#browser-context-extraction)
- [Screenshot Capture](#screenshot-capture)
- [Visual Perception Pipeline](#visual-perception-pipeline)
- [OCR Processing](#ocr-processing)
- [Object and Visual Region Detection](#object-and-visual-region-detection)
- [Bounding Boxes](#bounding-boxes)
- [DOM to Visual Mapping](#dom-to-visual-mapping)
- [Browser Perception State](#browser-perception-state)
- [Chrome Extension Architecture](#chrome-extension-architecture)
- [Backend API](#backend-api)
- [Project Structure](#project-structure)
- [Installation](#installation)
- [Running the Project](#running-the-project)
- [Testing the Pipeline](#testing-the-pipeline)
- [Current Implementation Status](#current-implementation-status)
- [Integration with Other Components](#integration-with-other-components)
- [Future Work](#future-work)
- [Technologies Used](#technologies-used)

---

# Project Overview

Modern webpages cannot always be understood using HTML or DOM information alone.

A webpage may contain information rendered through:

- Images
- Canvas elements
- Dynamically generated components
- Visually positioned UI elements
- Screenshot-only text
- Graphics
- Content that is difficult to interpret from the DOM

At the same time, relying only on screenshots loses important structural information available directly from the browser.

This project combines both approaches.

The system collects:

```text
DOM Information
        +
Interactive Elements
        +
Forms
        +
Accessibility Context
        +
Screenshot
        +
OCR Results
        +
Visual Regions
        +
Object Detection
        ↓
Browser Perception State