import sys
import shutil
import tempfile
from pathlib import Path

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware

from combined_detect import analyze_image


BASE_DIR = Path(__file__).resolve().parent

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
    image: UploadFile = File(...)
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
        with tempfile.NamedTemporaryFile(
            delete=False,
            suffix=suffix
        ) as temp:
            temp_file = Path(temp.name)

            shutil.copyfileobj(
                image.file,
                temp
            )

        output, annotated_image = analyze_image(
            temp_file
        )

        output["image"]["source"] = "api_upload"

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