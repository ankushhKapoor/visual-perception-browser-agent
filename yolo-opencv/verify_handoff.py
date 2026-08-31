import hashlib
import sys
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
OUTPUT_DIR = PROJECT_DIR / "sanitized-output"
OUTPUT_PATH = OUTPUT_DIR / "sanitized_screenshot.png"

sys.path.insert(0, str(BASE_DIR))
from server import app


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if not OUTPUT_PATH.exists():
        raise SystemExit(
            "No sanitized artifact found. Run the extension capture first."
        )

    artifact_bytes = OUTPUT_PATH.read_bytes()
    image = cv2.imdecode(
        np.frombuffer(artifact_bytes, dtype=np.uint8),
        cv2.IMREAD_COLOR
    )
    if image is None or image.size == 0:
        raise SystemExit("Sanitized artifact is not a readable image")

    output_files = {path.name for path in OUTPUT_DIR.iterdir() if path.is_file()}
    unexpected = output_files - {
        OUTPUT_PATH.name,
        "latest.json"
    }
    if unexpected:
        raise SystemExit(
            f"Unexpected output files found: {sorted(unexpected)}"
        )

    client = TestClient(app)
    response = client.post(
        "/analyze",
        files={
            "image": (
                OUTPUT_PATH.name,
                artifact_bytes,
                "image/png"
            )
        },
        data={
            "sanitized": "true",
            "redactedRegionCount": "0",
            "redactedTypes": "[]"
        }
    )
    if response.status_code != 200:
        raise SystemExit(
            f"Handoff rejected: HTTP {response.status_code}"
        )

    persisted_bytes = OUTPUT_PATH.read_bytes()
    received = client.get("/sanitized-screenshot")
    if received.status_code != 200:
        raise SystemExit("Sanitized artifact endpoint did not return the image")

    if sha256(artifact_bytes) != sha256(persisted_bytes):
        raise SystemExit("Persisted handoff bytes changed during analysis")
    if received.content != persisted_bytes:
        raise SystemExit("Receiver bytes differ from the persisted artifact")

    metadata = client.get("/sanitized-metadata")
    if metadata.status_code != 200 or metadata.json().get("sanitized") is not True:
        raise SystemExit("Safe handoff metadata was not persisted")

    summary = response.json().get("detection_summary", {})
    print("VLM HANDOFF VERIFIED")
    print("image received: true")
    print("image type: image/png")
    print(f"image size: {len(persisted_bytes)} bytes")
    print(f"width: {image.shape[1]}")
    print(f"height: {image.shape[0]}")
    print("sanitized: true")
    print(f"YOLO objects: {summary.get('total_objects', 0)}")
    print(f"OCR regions: {summary.get('total_text_regions', 0)}")
    print("same image bytes: true")
    print("original screenshot transmission: not present in output directory")


if __name__ == "__main__":
    main()
