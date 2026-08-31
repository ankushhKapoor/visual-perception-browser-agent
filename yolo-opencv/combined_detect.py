import cv2
import json
import sys
import re
from pathlib import Path

import easyocr
from ultralytics import YOLO


MIN_WIDTH_RATIO = 0.015
MIN_HEIGHT_RATIO = 0.015
MIN_AREA_RATIO = 0.001
MAX_AREA_RATIO = 0.80

IOU_THRESHOLD = 0.70
CONFIDENCE_THRESHOLD = 0.50
OCR_CONFIDENCE_THRESHOLD = 0.30

FIELD_ASSOCIATION_DISTANCE_RATIO = 0.35

BASE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = BASE_DIR.parent

RESULTS_DIR = PROJECT_DIR / "benchmarks" / "results"

RESULTS_DIR.mkdir(
    parents=True,
    exist_ok=True
)

JSON_OUTPUT_PATH = (
    RESULTS_DIR /
    "combined_detection.json"
)

IMAGE_OUTPUT_PATH = (
    RESULTS_DIR /
    "combined_detection.png"
)

MODEL_PATH = PROJECT_DIR / "yolo11s.pt"


def calculate_iou(box1, box2):
    x1 = max(
        box1["x"],
        box2["x"]
    )

    y1 = max(
        box1["y"],
        box2["y"]
    )

    x2 = min(
        box1["x"] + box1["width"],
        box2["x"] + box2["width"]
    )

    y2 = min(
        box1["y"] + box1["height"],
        box2["y"] + box2["height"]
    )

    intersection_width = max(
        0,
        x2 - x1
    )

    intersection_height = max(
        0,
        y2 - y1
    )

    intersection_area = (
        intersection_width *
        intersection_height
    )

    box1_area = (
        box1["width"] *
        box1["height"]
    )

    box2_area = (
        box2["width"] *
        box2["height"]
    )

    union_area = (
        box1_area +
        box2_area -
        intersection_area
    )

    if union_area <= 0:
        return 0

    return (
        intersection_area /
        union_area
    )


def convert_xyxy_to_xywh(box):
    return {
        "x": int(box["x1"]),
        "y": int(box["y1"]),
        "width": int(
            box["x2"] -
            box["x1"]
        ),
        "height": int(
            box["y2"] -
            box["y1"]
        )
    }


def box_center(box):
    return (
        box["x"] +
        box["width"] / 2,
        box["y"] +
        box["height"] / 2
    )


def detect_objects(image_path):
    model = YOLO(MODEL_PATH)

    results = model(
        str(image_path),
        conf=CONFIDENCE_THRESHOLD,
        verbose=False
    )

    detected_objects = []

    for result in results:
        if result.boxes is None:
            continue

        for box in result.boxes:
            confidence = float(
                box.conf[0]
            )

            class_id = int(
                box.cls[0]
            )

            class_name = (
                model.names[class_id]
            )

            x1, y1, x2, y2 = (
                box.xyxy[0].tolist()
            )

            detected_objects.append({
                "class": class_name,
                "confidence": round(
                    confidence,
                    4
                ),
                "bounding_box": {
                    "x1": round(x1, 2),
                    "y1": round(y1, 2),
                    "x2": round(x2, 2),
                    "y2": round(y2, 2)
                }
            })

    return detected_objects


def detect_regions(image):
    image_height, image_width = (
        image.shape[:2]
    )

    min_width = max(
        10,
        int(
            image_width *
            MIN_WIDTH_RATIO
        )
    )

    min_height = max(
        10,
        int(
            image_height *
            MIN_HEIGHT_RATIO
        )
    )

    min_area = max(
        100,
        int(
            image_width *
            image_height *
            MIN_AREA_RATIO
        )
    )

    max_area = (
        image_width *
        image_height *
        MAX_AREA_RATIO
    )

    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )

    blurred = cv2.GaussianBlur(
        gray,
        (5, 5),
        0
    )

    edges = cv2.Canny(
        blurred,
        50,
        150
    )

    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (5, 5)
    )

    edges = cv2.dilate(
        edges,
        kernel,
        iterations=1
    )

    contours, _ = cv2.findContours(
        edges,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE
    )

    candidate_regions = []

    for contour in contours:
        x, y, width, height = (
            cv2.boundingRect(contour)
        )

        area = (
            width *
            height
        )

        if width < min_width:
            continue

        if height < min_height:
            continue

        if area < min_area:
            continue

        if area > max_area:
            continue

        candidate_regions.append({
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "area": area
        })

    candidate_regions.sort(
        key=lambda region:
        region["area"],
        reverse=True
    )

    final_regions = []

    for region in candidate_regions:
        is_duplicate = False

        for kept_region in final_regions:
            iou = calculate_iou(
                region,
                kept_region
            )

            if iou >= IOU_THRESHOLD:
                is_duplicate = True
                break

        if not is_duplicate:
            final_regions.append(
                region
            )

    regions = []

    for index, region in enumerate(
        final_regions
    ):
        x = region["x"]
        y = region["y"]
        width = region["width"]
        height = region["height"]

        regions.append({
            "region_id": index + 1,
            "bounding_box": {
                "x": x,
                "y": y,
                "width": width,
                "height": height
            },
            "area": region["area"],
            "normalized_bounding_box": {
                "x": round(
                    x / image_width,
                    4
                ),
                "y": round(
                    y / image_height,
                    4
                ),
                "width": round(
                    width / image_width,
                    4
                ),
                "height": round(
                    height / image_height,
                    4
                )
            }
        })

    return (
        regions,
        len(contours),
        len(candidate_regions)
    )


def detect_text(image_path):
    reader = easyocr.Reader(
        ["en"],
        gpu=False
    )

    results = reader.readtext(
        str(image_path)
    )

    detected_text = []

    text_id = 1

    for result in results:
        points = result[0]
        text = result[1].strip()
        confidence = float(
            result[2]
        )

        if not text:
            continue

        if confidence < (
            OCR_CONFIDENCE_THRESHOLD
        ):
            continue

        x_coordinates = [
            point[0]
            for point in points
        ]

        y_coordinates = [
            point[1]
            for point in points
        ]

        x1 = int(
            min(x_coordinates)
        )

        y1 = int(
            min(y_coordinates)
        )

        x2 = int(
            max(x_coordinates)
        )

        y2 = int(
            max(y_coordinates)
        )

        detected_text.append({
            "text_id": text_id,
            "text": text,
            "confidence": round(
                confidence,
                4
            ),
            "bounding_box": {
                "x1": x1,
                "y1": y1,
                "x2": x2,
                "y2": y2
            }
        })

        text_id += 1

    return detected_text


def add_normalized_object_boxes(
    objects,
    image_width,
    image_height
):
    for obj in objects:
        box = obj[
            "bounding_box"
        ]

        obj[
            "normalized_bounding_box"
        ] = {
            "x1": round(
                box["x1"] /
                image_width,
                4
            ),
            "y1": round(
                box["y1"] /
                image_height,
                4
            ),
            "x2": round(
                box["x2"] /
                image_width,
                4
            ),
            "y2": round(
                box["y2"] /
                image_height,
                4
            )
        }

    return objects


def add_normalized_text_boxes(
    texts,
    image_width,
    image_height
):
    for text_data in texts:
        box = text_data[
            "bounding_box"
        ]

        text_data[
            "normalized_bounding_box"
        ] = {
            "x1": round(
                box["x1"] /
                image_width,
                4
            ),
            "y1": round(
                box["y1"] /
                image_height,
                4
            ),
            "x2": round(
                box["x2"] /
                image_width,
                4
            ),
            "y2": round(
                box["y2"] /
                image_height,
                4
            )
        }

    return texts


def normalize_text(text):
    text = text.lower()

    text = re.sub(
        r"[^a-z0-9\s]",
        " ",
        text
    )

    text = re.sub(
        r"\s+",
        " ",
        text
    )

    return text.strip()


def classify_sensitive_label(text):
    normalized = normalize_text(
        text
    )

    label_categories = {
        "PASSWORD": [
            "password",
            "passcode",
            "passwd"
        ],
        "PIN": [
            "pin",
            "mpin",
            "transaction pin",
            "security pin"
        ],
        "OTP": [
            "otp",
            "one time password",
            "verification code",
            "authentication code",
            "security code"
        ],
        "CVV": [
            "cvv",
            "cvc",
            "card verification value",
            "card security code"
        ],
        "CREDIT_CARD": [
            "credit card",
            "debit card",
            "card number",
            "card no"
        ],
        "BANK_ACCOUNT": [
            "bank account",
            "account number",
            "account no",
            "account id"
        ],
        "IFSC": [
            "ifsc",
            "ifsc code"
        ],
        "EMAIL": [
            "email",
            "email address",
            "e mail"
        ],
        "PHONE_NUMBER": [
            "phone",
            "phone number",
            "mobile",
            "mobile number",
            "contact number",
            "telephone"
        ],
        "AADHAAR": [
            "aadhaar",
            "aadhar",
            "aadhaar number",
            "aadhar number"
        ],
        "PAN": [
            "pan",
            "pan number"
        ],
        "PASSPORT": [
            "passport",
            "passport number"
        ],
        "NATIONAL_ID": [
            "national id",
            "identity number",
            "id number"
        ],
        "API_KEY": [
            "api key",
            "api token",
            "access key"
        ],
        "SECRET_KEY": [
            "secret",
            "secret key",
            "private key"
        ],
        "AUTH_TOKEN": [
            "auth token",
            "access token",
            "refresh token",
            "bearer token",
            "session token",
            "jwt"
        ],
        "DATE_OF_BIRTH": [
            "date of birth",
            "dob"
        ]
    }

    severity_map = {
        "PASSWORD": "CRITICAL",
        "PIN": "CRITICAL",
        "OTP": "CRITICAL",
        "CVV": "CRITICAL",
        "CREDIT_CARD": "CRITICAL",
        "BANK_ACCOUNT": "HIGH",
        "IFSC": "HIGH",
        "EMAIL": "HIGH",
        "PHONE_NUMBER": "HIGH",
        "AADHAAR": "HIGH",
        "PAN": "HIGH",
        "PASSPORT": "HIGH",
        "NATIONAL_ID": "HIGH",
        "API_KEY": "CRITICAL",
        "SECRET_KEY": "CRITICAL",
        "AUTH_TOKEN": "CRITICAL",
        "DATE_OF_BIRTH": "MEDIUM"
    }

    matches = []

    for category, keywords in (
        label_categories.items()
    ):
        for keyword in keywords:
            if keyword in normalized:
                matches.append({
                    "type": category,
                    "severity": severity_map[
                        category
                    ]
                })
                break

    return matches


def detect_sensitive_text_patterns(text):
    matches = []

    patterns = [
        (
            "EMAIL",
            "HIGH",
            r"\b[A-Z0-9._%+-]+"
            r"@[A-Z0-9.-]+"
            r"\.[A-Z]{2,}\b",
            re.IGNORECASE
        ),
        (
            "PHONE_NUMBER",
            "HIGH",
            r"\b(?:\+91[\s-]?)?"
            r"[6-9]\d{9}\b",
            0
        ),
        (
            "AADHAAR",
            "HIGH",
            r"\b\d{4}[\s-]?"
            r"\d{4}[\s-]?"
            r"\d{4}\b",
            0
        ),
        (
            "PAN",
            "HIGH",
            r"\b[A-Z]{5}"
            r"[0-9]{4}"
            r"[A-Z]\b",
            re.IGNORECASE
        ),
        (
            "CREDIT_CARD",
            "CRITICAL",
            r"\b(?:\d{4}[\s-]?){3}"
            r"\d{4}\b",
            0
        )
    ]

    for (
        sensitive_type,
        severity,
        pattern,
        flags
    ) in patterns:
        if re.search(
            pattern,
            text,
            flags
        ):
            matches.append({
                "type": sensitive_type,
                "severity": severity
            })

    return matches


def horizontal_distance(box1, box2):
    box1_right = (
        box1["x"] +
        box1["width"]
    )

    box2_right = (
        box2["x"] +
        box2["width"]
    )

    if box1_right < box2["x"]:
        return (
            box2["x"] -
            box1_right
        )

    if box2_right < box1["x"]:
        return (
            box1["x"] -
            box2_right
        )

    return 0


def vertical_distance(box1, box2):
    box1_bottom = (
        box1["y"] +
        box1["height"]
    )

    box2_bottom = (
        box2["y"] +
        box2["height"]
    )

    if box1_bottom < box2["y"]:
        return (
            box2["y"] -
            box1_bottom
        )

    if box2_bottom < box1["y"]:
        return (
            box1["y"] -
            box2_bottom
        )

    return 0


def detect_input_like_regions(
    regions,
    image_width,
    image_height
):
    candidates = []

    for region in regions:
        box = region[
            "bounding_box"
        ]

        width_ratio = (
            box["width"] /
            image_width
        )

        height_ratio = (
            box["height"] /
            image_height
        )

        aspect_ratio = (
            box["width"] /
            max(box["height"], 1)
        )

        if (
            width_ratio >= 0.08
            and
            height_ratio >= 0.02
            and
            height_ratio <= 0.20
            and
            aspect_ratio >= 1.5
        ):
            candidates.append(
                region
            )

    return candidates


def find_associated_field(
    text_data,
    input_candidates,
    image_width,
    image_height
):
    label_box = (
        convert_xyxy_to_xywh(
            text_data[
                "bounding_box"
            ]
        )
    )

    label_center_x, label_center_y = (
        box_center(label_box)
    )

    max_distance = (
        max(
            image_width,
            image_height
        ) *
        FIELD_ASSOCIATION_DISTANCE_RATIO
    )

    best_candidate = None
    best_score = float("inf")

    for candidate in input_candidates:
        field_box = candidate[
            "bounding_box"
        ]

        field_center_x, field_center_y = (
            box_center(field_box)
        )

        dx = abs(
            field_center_x -
            label_center_x
        )

        dy = abs(
            field_center_y -
            label_center_y
        )

        right_side = (
            field_box["x"] >=
            label_box["x"] +
            label_box["width"] -
            5
        )

        below = (
            field_box["y"] >=
            label_box["y"] +
            label_box["height"] -
            5
        )

        if not (
            right_side or below
        ):
            continue

        horizontal_gap = (
            horizontal_distance(
                label_box,
                field_box
            )
        )

        vertical_gap = (
            vertical_distance(
                label_box,
                field_box
            )
        )

        distance = (
            dx +
            dy +
            horizontal_gap +
            vertical_gap
        )

        if distance > max_distance:
            continue

        alignment_bonus = 0

        if right_side:
            alignment_bonus -= (
                max(
                    0,
                    50 - dy
                )
            )

        if below:
            alignment_bonus -= (
                max(
                    0,
                    50 - dx
                )
            )

        score = (
            distance +
            alignment_bonus
        )

        if score < best_score:
            best_score = score
            best_candidate = candidate

    return best_candidate


def add_normalized_xywh(
    box,
    image_width,
    image_height
):
    return {
        "x": round(
            box["x"] /
            image_width,
            4
        ),
        "y": round(
            box["y"] /
            image_height,
            4
        ),
        "width": round(
            box["width"] /
            image_width,
            4
        ),
        "height": round(
            box["height"] /
            image_height,
            4
        )
    }


def detect_sensitive_information(
    texts,
    regions,
    image_width,
    image_height
):
    sensitive_information = []

    input_candidates = (
        detect_input_like_regions(
            regions,
            image_width,
            image_height
        )
    )

    for text_data in texts:
        text = text_data[
            "text"
        ]

        label_matches = (
            classify_sensitive_label(
                text
            )
        )

        pattern_matches = (
            detect_sensitive_text_patterns(
                text
            )
        )

        all_matches = []

        for item in (
            label_matches +
            pattern_matches
        ):
            if item not in all_matches:
                all_matches.append(
                    item
                )

        for match in all_matches:
            sensitive_box = (
                convert_xyxy_to_xywh(
                    text_data[
                        "bounding_box"
                    ]
                )
            )

            detection_source = (
                "TEXT_PATTERN"
            )

            associated_region_id = None

            if match in label_matches:
                associated_field = (
                    find_associated_field(
                        text_data,
                        input_candidates,
                        image_width,
                        image_height
                    )
                )

                if associated_field:
                    sensitive_box = (
                        associated_field[
                            "bounding_box"
                        ].copy()
                    )

                    associated_region_id = (
                        associated_field[
                            "region_id"
                        ]
                    )

                    detection_source = (
                        "LABEL_AND_UI_CONTEXT"
                    )
                else:
                    detection_source = (
                        "SENSITIVE_LABEL"
                    )

            sensitive_information.append({
                "text_id":
                    text_data["text_id"],
                "detected_text":
                    text,
                "type":
                    match["type"],
                "severity":
                    match["severity"],
                "detection_source":
                    detection_source,
                "associated_region_id":
                    associated_region_id,
                "bounding_box":
                    sensitive_box,
                "normalized_bounding_box":
                    add_normalized_xywh(
                        sensitive_box,
                        image_width,
                        image_height
                    )
            })

    unique_detections = []

    for detection in (
        sensitive_information
    ):
        duplicate = False

        current_box = (
            detection[
                "bounding_box"
            ]
        )

        for existing in (
            unique_detections
        ):
            existing_box = (
                existing[
                    "bounding_box"
                ]
            )

            iou = calculate_iou(
                current_box,
                existing_box
            )

            if (
                iou >= 0.85
                and
                detection["type"] ==
                existing["type"]
            ):
                duplicate = True
                break

        if not duplicate:
            unique_detections.append(
                detection
            )

    return unique_detections


def draw_detections(
    image,
    objects,
    regions,
    texts,
    sensitive_information
):
    output_image = image.copy()

    for region in regions:
        box = region[
            "bounding_box"
        ]

        x = box["x"]
        y = box["y"]
        width = box["width"]
        height = box["height"]

        cv2.rectangle(
            output_image,
            (x, y),
            (
                x + width,
                y + height
            ),
            (255, 0, 0),
            2
        )

        cv2.putText(
            output_image,
            f"R{region['region_id']}",
            (
                x,
                max(y - 5, 15)
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 0, 0),
            2
        )

    for index, obj in enumerate(
        objects
    ):
        box = obj[
            "bounding_box"
        ]

        x1 = int(box["x1"])
        y1 = int(box["y1"])
        x2 = int(box["x2"])
        y2 = int(box["y2"])

        cv2.rectangle(
            output_image,
            (x1, y1),
            (x2, y2),
            (0, 255, 0),
            2
        )

        label = (
            f"O{index + 1}: "
            f"{obj['class']}"
        )

        cv2.putText(
            output_image,
            label,
            (
                x1,
                max(y1 - 5, 15)
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            2
        )

    for text_data in texts:
        box = text_data[
            "bounding_box"
        ]

        x1 = int(box["x1"])
        y1 = int(box["y1"])
        x2 = int(box["x2"])
        y2 = int(box["y2"])

        cv2.rectangle(
            output_image,
            (x1, y1),
            (x2, y2),
            (0, 0, 255),
            1
        )

        label = (
            f"T{text_data['text_id']}"
        )

        cv2.putText(
            output_image,
            label,
            (
                x1,
                max(y1 - 5, 15)
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.45,
            (0, 0, 255),
            1
        )

    for sensitive_data in (
        sensitive_information
    ):
        box = sensitive_data[
            "bounding_box"
        ]

        x = int(box["x"])
        y = int(box["y"])
        width = int(
            box["width"]
        )
        height = int(
            box["height"]
        )

        cv2.rectangle(
            output_image,
            (x, y),
            (
                x + width,
                y + height
            ),
            (0, 165, 255),
            3
        )

        label = (
            sensitive_data["type"]
        )

        cv2.putText(
            output_image,
            label,
            (
                x,
                max(y - 8, 20)
            ),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 165, 255),
            2
        )

    return output_image


def analyze_image(image_path):
    image_path = Path(
        image_path
    ).resolve()

    if not image_path.exists():
        raise FileNotFoundError(
            f"Image not found: "
            f"{image_path}"
        )

    image = cv2.imread(
        str(image_path)
    )

    if image is None:
        raise ValueError(
            f"Failed to load image: "
            f"{image_path}"
        )

    image_height, image_width = (
        image.shape[:2]
    )

    print(
        "\nImage dimensions: "
        f"{image_width} x "
        f"{image_height}"
    )

    print(
        "\nDetecting objects..."
    )

    objects = detect_objects(
        image_path
    )

    objects = (
        add_normalized_object_boxes(
            objects,
            image_width,
            image_height
        )
    )

    print(
        f"Objects detected: "
        f"{len(objects)}"
    )

    print(
        "\nDetecting visual regions..."
    )

    (
        regions,
        total_contours,
        candidate_regions
    ) = detect_regions(
        image
    )

    print(
        f"Final regions: "
        f"{len(regions)}"
    )

    print(
        "\nDetecting text..."
    )

    texts = detect_text(
        image_path
    )

    texts = (
        add_normalized_text_boxes(
            texts,
            image_width,
            image_height
        )
    )

    print(
        f"Text regions detected: "
        f"{len(texts)}"
    )

    print(
        "\nDetecting sensitive "
        "information..."
    )

    sensitive_information = (
        detect_sensitive_information(
            texts,
            regions,
            image_width,
            image_height
        )
    )

    print(
        f"Sensitive regions detected: "
        f"{len(sensitive_information)}"
    )

    output = {
        "image": {
            "path": str(
                image_path
            ),
            "filename":
                image_path.name,
            "width":
                image_width,
            "height":
                image_height
        },
        "detection_summary": {
            "total_objects":
                len(objects),
            "total_contours":
                total_contours,
            "candidate_regions":
                candidate_regions,
            "final_regions":
                len(regions),
            "total_text_regions":
                len(texts),
            "total_sensitive_regions":
                len(
                    sensitive_information
                )
        },
        "objects": objects,
        "regions": regions,
        "texts": texts,
        "sensitive_information":
            sensitive_information
    }

    annotated_image = (
        draw_detections(
            image,
            objects,
            regions,
            texts,
            sensitive_information
        )
    )

    return (
        output,
        annotated_image
    )


def main():
    if len(sys.argv) < 2:
        print(
            "Usage:\n"
            "python combined_detect.py "
            "\"path_to_image\""
        )
        return

    image_path = Path(
        sys.argv[1]
    ).resolve()

    print(
        "\nProcessing image:"
    )

    print(
        image_path
    )

    try:
        (
            output,
            annotated_image
        ) = analyze_image(
            image_path
        )

    except Exception as error:
        print(
            f"\nDetection failed:\n"
            f"{error}"
        )
        return

    with open(
        JSON_OUTPUT_PATH,
        "w",
        encoding="utf-8"
    ) as file:
        json.dump(
            output,
            file,
            indent=2,
            ensure_ascii=False
        )

    success = cv2.imwrite(
        str(IMAGE_OUTPUT_PATH),
        annotated_image
    )

    if not success:
        print(
            "\nFailed to save "
            "annotated image."
        )
        return

    summary = output[
        "detection_summary"
    ]

    print(
        "\nDetection completed "
        "successfully."
    )

    print(
        "\nJSON output:"
    )

    print(
        JSON_OUTPUT_PATH
    )

    print(
        "\nAnnotated image:"
    )

    print(
        IMAGE_OUTPUT_PATH
    )

    print(
        "\nSummary:"
    )

    print(
        f"Objects: "
        f"{summary['total_objects']}"
    )

    print(
        f"Contours: "
        f"{summary['total_contours']}"
    )

    print(
        f"Candidate regions: "
        f"{summary['candidate_regions']}"
    )

    print(
        f"Final regions: "
        f"{summary['final_regions']}"
    )

    print(
        f"Text regions: "
        f"{summary['total_text_regions']}"
    )

    print(
        f"Sensitive regions: "
        f"{summary['total_sensitive_regions']}"
    )


if __name__ == "__main__":
    main()