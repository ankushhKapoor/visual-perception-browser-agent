import cv2
import json

MIN_WIDTH = 25
MIN_HEIGHT = 20
MIN_AREA = 1500

MAX_IMAGE_AREA_RATIO = 0.85
CONTAINMENT_THRESHOLD = 0.90
IOU_THRESHOLD = 0.65

image_path = "../benchmarks/screenshots/Test.png"
output_path = "../benchmarks/results/opencv_detection_improved.png"


def calculate_iou(box1, box2):
    x1 = max(box1["x"], box2["x"])
    y1 = max(box1["y"], box2["y"])

    x2 = min(
        box1["x"] + box1["width"],
        box2["x"] + box2["width"]
    )

    y2 = min(
        box1["y"] + box1["height"],
        box2["y"] + box2["height"]
    )

    intersection_width = max(0, x2 - x1)
    intersection_height = max(0, y2 - y1)

    intersection_area = intersection_width * intersection_height

    area1 = box1["width"] * box1["height"]
    area2 = box2["width"] * box2["height"]

    union_area = area1 + area2 - intersection_area

    if union_area == 0:
        return 0

    return intersection_area / union_area


def containment_ratio(inner, outer):
    x1 = max(inner["x"], outer["x"])
    y1 = max(inner["y"], outer["y"])

    x2 = min(
        inner["x"] + inner["width"],
        outer["x"] + outer["width"]
    )

    y2 = min(
        inner["y"] + inner["height"],
        outer["y"] + outer["height"]
    )

    intersection_width = max(0, x2 - x1)
    intersection_height = max(0, y2 - y1)

    intersection_area = intersection_width * intersection_height

    inner_area = inner["area"]

    if inner_area == 0:
        return 0

    return intersection_area / inner_area


def detect_regions(image_path):
    image = cv2.imread(image_path)

    if image is None:
        raise FileNotFoundError(
            f"Could not load image: {image_path}"
        )

    image_height, image_width = image.shape[:2]
    image_area = image_width * image_height

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
        (3, 3)
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

    total_contours = len(contours)

    candidates = []

    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)

        area = width * height

        if width < MIN_WIDTH:
            continue

        if height < MIN_HEIGHT:
            continue

        if area < MIN_AREA:
            continue

        if area / image_area > MAX_IMAGE_AREA_RATIO:
            continue

        candidates.append({
            "x": x,
            "y": y,
            "width": width,
            "height": height,
            "area": area
        })

    candidates.sort(
        key=lambda box: box["area"],
        reverse=True
    )

    after_containment = []

    for box in candidates:
        is_redundant = False

        for kept_box in after_containment:
            box_inside_kept = containment_ratio(
                box,
                kept_box
            )

            kept_inside_box = containment_ratio(
                kept_box,
                box
            )

            if box_inside_kept >= CONTAINMENT_THRESHOLD:
                is_redundant = True
                break

            if kept_inside_box >= CONTAINMENT_THRESHOLD:
                is_redundant = True
                break

        if not is_redundant:
            after_containment.append(box)

    final_boxes = []

    for box in after_containment:
        is_duplicate = False

        for kept_box in final_boxes:
            iou = calculate_iou(
                box,
                kept_box
            )

            if iou >= IOU_THRESHOLD:
                is_duplicate = True
                break

        if not is_duplicate:
            final_boxes.append(box)

    regions = []

    for index, box in enumerate(final_boxes):
        normalized_box = {
            "x": round(
                box["x"] / image_width,
                4
            ),
            "y": round(
                box["y"] / image_height,
                4
            ),
            "width": round(
                box["width"] / image_width,
                4
            ),
            "height": round(
                box["height"] / image_height,
                4
            )
        }

        regions.append({
            "region_id": index + 1,
            "bounding_box": {
                "x": box["x"],
                "y": box["y"],
                "width": box["width"],
                "height": box["height"]
            },
            "area": box["area"],
            "normalized_bounding_box": normalized_box
        })

    output = {
        "image": {
            "path": image_path,
            "width": image_width,
            "height": image_height
        },
        "total_contours": total_contours,
        "candidate_regions": len(candidates),
        "after_containment_filter": len(after_containment),
        "final_regions": len(regions),
        "regions": regions
    }

    return output


def save_detection_image(image_path, regions):
    image = cv2.imread(image_path)

    if image is None:
        raise FileNotFoundError(
            f"Could not load image: {image_path}"
        )

    for region in regions:
        box = region["bounding_box"]

        x = box["x"]
        y = box["y"]
        width = box["width"]
        height = box["height"]

        cv2.rectangle(
            image,
            (x, y),
            (x + width, y + height),
            (0, 255, 0),
            2
        )

        label = str(region["region_id"])

        cv2.putText(
            image,
            label,
            (x, max(y - 5, 15)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 0, 255),
            2
        )

    cv2.imwrite(
        output_path,
        image
    )

    print(
        f"\nDetection image saved to: {output_path}"
    )


if __name__ == "__main__":
    result = detect_regions(image_path)

    print(
        json.dumps(
            result,
            indent=2
        )
    )

    save_detection_image(
        image_path,
        result["regions"]
    )