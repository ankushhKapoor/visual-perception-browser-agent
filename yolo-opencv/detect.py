from ultralytics import YOLO
import json

CONFIDENCE_THRESHOLD = 0.5

model = YOLO("yolo11s.pt")


def detect_objects(image_path):
    results = model(image_path)
    detections = []

    for result in results:
        for box in result.boxes:
            class_id = int(box.cls[0])
            confidence = float(box.conf[0])

            if confidence < CONFIDENCE_THRESHOLD:
                continue

            x1, y1, x2, y2 = box.xyxy[0].tolist()

            detection = {
                "class": model.names[class_id],
                "confidence": round(confidence, 4),
                "bounding_box": {
                    "x1": round(x1, 2),
                    "y1": round(y1, 2),
                    "x2": round(x2, 2),
                    "y2": round(y2, 2)
                }
            }

            detections.append(detection)

    return detections


if __name__ == "__main__":
    image_path = "../benchmarks/screenshots/Test.png"

    detections = detect_objects(image_path)

    print(json.dumps(detections, indent=2))