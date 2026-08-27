# Visual Perception Browser Agent

Privacy-preserving browser-based vision agent for SIH26171.

## Project Goal

The system processes visual context locally in the browser, detects sensitive information, sanitizes it before transmission, and sends only anonymized context to the server-side AI pipeline.

## Branch Structure

- `main` – Stable project branch
- `dev` – Overall development branch
- `neha` – Common implementation and Member 1 work
- `screenparser-approach` – ScreenParser-based UI detection approach
- `yolo-opencv-approach` – YOLO + OpenCV-based UI detection approach

## Common Components

- DOM extraction
- Accessibility information
- Screenshot capture
- OCR
- Privacy and redaction pipeline
- Shared data structures
- Benchmarking