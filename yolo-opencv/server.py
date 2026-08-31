import sys
import shutil
from uuid import uuid4
from pathlib import Path

import cv2
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, Request
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from combined_detect import analyze_image


BASE_DIR = Path(__file__).resolve().parent
SANITIZED_SCREENSHOTS_DIR = BASE_DIR / "sanitized_screenshots"
SANITIZED_SCREENSHOTS_DIR.mkdir(exist_ok=True)

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
    sanitized: str = Form(...)
):
    if sanitized.lower() != "true":
        raise HTTPException(
            status_code=400,
            detail="Only locally sanitized screenshots are accepted"
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

    suffix = Path(image.filename or "screenshot.png").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        suffix = ".png"

    screenshot_id = uuid4().hex
    saved_screenshot = SANITIZED_SCREENSHOTS_DIR / f"{screenshot_id}{suffix}"

    try:
        with saved_screenshot.open("wb") as output_file:
            shutil.copyfileobj(image.file, output_file)

        output, annotated_image = analyze_image(
            saved_screenshot
        )

        output["image"]["source"] = "api_upload"
        output["image"]["sanitized"] = True
        output["image"]["savedScreenshot"] = {
            "id": screenshot_id,
            "filename": saved_screenshot.name,
            "path": str(saved_screenshot),
            "retrievalUrl": f"/saved-screenshots/{saved_screenshot.name}"
        }

        return output

    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=str(error)
        )

    finally:
        await image.close()



@app.get("/saved-screenshots/{filename}")
def get_saved_screenshot(filename: str):
    requested_file = (SANITIZED_SCREENSHOTS_DIR / filename).resolve()

    if requested_file.parent != SANITIZED_SCREENSHOTS_DIR.resolve():
        raise HTTPException(status_code=400, detail="Invalid screenshot filename")

    if not requested_file.is_file():
        raise HTTPException(status_code=404, detail="Saved screenshot not found")

    return FileResponse(requested_file)


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

        dom_context = perception_state.get("domContext", {})
        visual_context = perception_state.get("visualContext", {})

        interactive_elements = dom_context.get(
            "interactiveElements",
            []
        )

        forms = dom_context.get(
            "forms",
            []
        )

        visual_text = visual_context.get(
            "texts",
            []
        )

        visual_regions = visual_context.get(
            "regions",
            []
        )

        objects = visual_context.get(
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