import json
import sys
import shutil
import tempfile
import re
from datetime import datetime, timezone
from pathlib import Path

import cv2
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware

from combined_detect import analyze_image


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = BASE_DIR.parent / "photos" / "output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

RAW_PII_PATTERNS = (
    re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
    re.compile(r"\b(?:\+91[\s-]?)?[6-9]\d{9}\b"),
    re.compile(r"\b(?:\d{4}[\s-]?){3}\d{4}\b"),
    re.compile(r"\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b"),
    re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b", re.IGNORECASE),
)


def contains_raw_pii(value):
    if isinstance(value, str):
        return any(pattern.search(value) for pattern in RAW_PII_PATTERNS)
    if isinstance(value, dict):
        return any(contains_raw_pii(item) for item in value.values())
    if isinstance(value, list):
        return any(contains_raw_pii(item) for item in value)
    return False


def apply_redaction_regions(image_path, regions):
    image = cv2.imread(str(image_path))
    if image is None:
        raise ValueError(f"Failed to load image: {image_path}")

    image_height, image_width = image.shape[:2]
    for region in regions:
        source = str(region.get("source", "")).lower()
        category = str(
            region.get("category", region.get("type", ""))
        ).upper()
        if source not in {"input", "text"} or not category:
            continue

        box = region.get("rect", region.get("bounding_box", region))
        try:
            x = int(float(box.get("x", 0)))
            y = int(float(box.get("y", 0)))
            width = int(float(box.get("width", 0)))
            height = int(float(box.get("height", 0)))
        except (TypeError, ValueError):
            continue

        if width <= 0 or height <= 0:
            continue

        x1 = max(0, min(image_width, x))
        y1 = max(0, min(image_height, y))
        x2 = max(x1, min(image_width, x + width))
        y2 = max(y1, min(image_height, y + height))
        crop = image[y1:y2, x1:x2]
        if crop.size:
            strategy = str(region.get("strategy", "BLACKOUT")).upper()
            if strategy == "BLACKOUT":
                image[y1:y2, x1:x2] = (0, 0, 0)
                continue
            sigma = max(3, min(18, round(max(crop.shape[:2]) * 0.08)))
            image[y1:y2, x1:x2] = cv2.GaussianBlur(
                crop,
                (0, 0),
                sigmaX=sigma,
                sigmaY=sigma
            )

    if not cv2.imwrite(str(image_path), image):
        raise OSError(f"Failed to apply redaction regions: {image_path}")

app = FastAPI(
    title="Visual Perception Browser Agent API",
    version="0.1.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


@app.get("/")
def root():
    return {
        "status": "running",
        "service": "Visual Perception Browser Agent"
    }


@app.get("/health")
def health():
    return {
        "status": "healthy"
    }


@app.post("/analyze")
async def analyze_screenshot(
    image: UploadFile = File(...),
    redaction_regions: str = Form("[]"),
    privacy_proof: str = Form("")
):
    if not image.content_type:
        raise HTTPException(
            status_code=400,
            detail="No image content type provided"
        )

    if not image.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Uploaded file must be an image"
        )

    suffix = Path(
        image.filename or "screenshot.png"
    ).suffix

    if not suffix:
        suffix = ".png"

    temp_file = None

    try:
        try:
            proof = json.loads(privacy_proof)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="Privacy proof is required") from error

        if (
            not isinstance(proof, dict)
            or proof.get("sanitized") is not True
            or proof.get("rawScreenshotIncluded") is not False
            or not isinstance(proof.get("redactionMap"), list)
        ):
            raise HTTPException(status_code=400, detail="Privacy gate rejected unsanitized image")

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix
        ) as temp:
            temp_file = Path(temp.name)

            shutil.copyfileobj(
                image.file,
                temp
            )

        try:
            regions = json.loads(redaction_regions)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="Invalid redaction regions") from error

        if not isinstance(regions, list):
            raise HTTPException(status_code=400, detail="Redaction regions must be a list")

        output, annotated_image = analyze_image(
            temp_file
        )

        output["image"]["source"] = "api_upload"
        output["privacy"]["client_redaction_regions"] = len(regions)
        output["privacy"]["privacy_gate"] = "passed"

        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        screenshot_path = OUTPUT_DIR / f"sanitized_screenshot_{timestamp}.png"
        annotated_path = OUTPUT_DIR / f"annotated_screenshot_{timestamp}.png"
        json_path = OUTPUT_DIR / f"sanitized_screenshot_{timestamp}.json"

        if not shutil.copyfile(temp_file, screenshot_path):
            raise OSError(f"Failed to save screenshot output: {screenshot_path}")

        if not cv2.imwrite(str(annotated_path), annotated_image):
            raise OSError(f"Failed to save annotated output: {annotated_path}")

        output["artifacts"] = {
            "sanitizedScreenshot": str(screenshot_path),
            "annotatedScreenshot": str(annotated_path),
            "analysisJson": str(json_path)
        }

        output["artifacts"]["latestSanitizedScreenshot"] = str(
            OUTPUT_DIR / "latest_sanitized.png"
        )
        output["artifacts"]["latestReport"] = str(
            OUTPUT_DIR / "latest_report.json"
        )

        with json_path.open("w", encoding="utf-8") as output_file:
            json.dump(output, output_file, indent=2, ensure_ascii=False)

        shutil.copyfile(screenshot_path, OUTPUT_DIR / "latest_sanitized.png")
        shutil.copyfile(annotated_path, OUTPUT_DIR / "latest_annotated.png")
        shutil.copyfile(json_path, OUTPUT_DIR / "latest_report.json")

        return output

    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=str(error)
        )

    finally:
        await image.close()

        if (
            temp_file is not None
            and temp_file.exists()
        ):
            temp_file.unlink()


@app.post("/perception")
async def receive_perception_state(
    request: Request
):
    try:
        perception_state = await request.json()

        if not perception_state:
            raise HTTPException(
                status_code=400,
                detail="Perception state is empty"
            )

        privacy = perception_state.get("privacy", {})
        if (
            not isinstance(privacy, dict)
            or privacy.get("sanitized") is not True
            or privacy.get("rawScreenshotIncluded") is not False
            or contains_raw_pii(perception_state)
        ):
            raise HTTPException(
                status_code=400,
                detail="Privacy gate rejected unsanitized perception"
            )

        page = perception_state.get(
            "page",
            {}
        )

        summary = perception_state.get(
            "summary",
            {}
        )

        interactive_elements = perception_state.get(
            "interactiveElements",
            []
        )

        forms = perception_state.get(
            "forms",
            []
        )

        visual_text = perception_state.get(
            "visualText",
            []
        )

        visual_regions = perception_state.get(
            "visualRegions",
            []
        )

        objects = perception_state.get(
            "objects",
            []
        )

        privacy = perception_state.get(
            "privacy",
            {}
        )

        print("\n========== BROWSER PERCEPTION STATE RECEIVED ==========")

        print(
            "Interactive elements:",
            len(interactive_elements)
        )

        print(
            "Forms:",
            len(forms)
        )

        print(
            "Visual text regions:",
            len(visual_text)
        )

        print(
            "Visual regions:",
            len(visual_regions)
        )

        print(
            "Objects:",
            len(objects)
        )

        print(
            "PII detected:",
            privacy.get(
                "piiDetected",
                False
            )
        )

        print(
            "Redacted regions:",
            privacy.get(
                "redactedRegionCount",
                0
            )
        )

        print(
            "=======================================================\n"
        )

        return {
            "success": True,
            "message": (
                "Browser perception state "
                "received successfully"
            ),
            "received": {
                "pageUrl":
                    page.get("url"),

                "interactiveElements":
                    len(
                        interactive_elements
                    ),

                "forms":
                    len(forms),

                "visualTextRegions":
                    len(
                        visual_text
                    ),

                "visualRegions":
                    len(
                        visual_regions
                    ),

                "objects":
                    len(objects),

                "piiDetected":
                    privacy.get(
                        "piiDetected",
                        False
                    ),

                "redactedRegionCount":
                    privacy.get(
                        "redactedRegionCount",
                        0
                    )
            }
        }

    except HTTPException:
        raise

    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=str(error)
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000
    )