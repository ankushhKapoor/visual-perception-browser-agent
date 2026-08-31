import sys
import tempfile
import json
from pathlib import Path

import cv2
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from combined_detect import analyze_image


BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent
SANITIZED_OUTPUT_DIR = PROJECT_DIR / "sanitized-output"
SANITIZED_OUTPUT_PATH = SANITIZED_OUTPUT_DIR / "sanitized_screenshot.png"
SANITIZED_METADATA_PATH = SANITIZED_OUTPUT_DIR / "latest.json"

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


@app.get("/sanitized-screenshot")
def sanitized_screenshot():
    if not SANITIZED_OUTPUT_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="No sanitized screenshot has been saved yet"
        )

    return FileResponse(
        SANITIZED_OUTPUT_PATH,
        media_type="image/png",
        filename="sanitized_screenshot.png"
    )


@app.get("/sanitized-metadata")
def sanitized_metadata():
    if not SANITIZED_METADATA_PATH.exists():
        raise HTTPException(
            status_code=404,
            detail="No sanitized screenshot metadata has been saved yet"
        )

    return json.loads(
        SANITIZED_METADATA_PATH.read_text(encoding="utf-8")
    )


@app.post("/analyze")
async def analyze_screenshot(
    image: UploadFile = File(...),
    sanitized: bool = Form(False),
    redacted_region_count: int = Form(
        0,
        alias="redactedRegionCount"
    ),
    redacted_types: str = Form("[]")
):
    if not sanitized:
        raise HTTPException(
            status_code=400,
            detail="Only sanitized screenshots may be analyzed"
        )

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
        image_bytes = await image.read()
        if not image_bytes:
            raise HTTPException(
                status_code=400,
                detail="Uploaded image is empty"
            )

        SANITIZED_OUTPUT_DIR.mkdir(
            parents=True,
            exist_ok=True
        )
        SANITIZED_OUTPUT_PATH.write_bytes(image_bytes)

        try:
            safe_redacted_types = json.loads(redacted_types)
        except json.JSONDecodeError:
            safe_redacted_types = []

        if not isinstance(safe_redacted_types, list):
            safe_redacted_types = []

        metadata = {
            "image": "sanitized-output/sanitized_screenshot.png",
            "imageType": "image/png",
            "sanitized": True,
            "redactedRegionCount": max(0, redacted_region_count),
            "redactedTypes": [
                str(item) for item in safe_redacted_types
                if isinstance(item, str)
            ]
        }
        SANITIZED_METADATA_PATH.write_text(
            json.dumps(metadata, indent=2),
            encoding="utf-8"
        )

        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix
        ) as temp:
            temp_file = Path(temp.name)
            temp.write(image_bytes)

        output, annotated_image = analyze_image(
            temp_file
        )

        output["image"]["path"] = (
            "sanitized-output/sanitized_screenshot.png"
        )
        output["image"]["source"] = "api_upload"
        output["image"]["sanitized_output"] = (
            "sanitized-output/sanitized_screenshot.png"
        )

        return output

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
            "URL:",
            page.get("url")
        )

        print(
            "Title:",
            page.get("title")
        )

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