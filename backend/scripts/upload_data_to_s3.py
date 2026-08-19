"""
Upload the required data CSV files to S3 so the deployed backend can access them.

Usage:
    python scripts/upload_data_to_s3.py

Requires AWS credentials in .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).
Uploads to: s3://<bucket>/data/<filename>
"""
import sys
import os

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils.s3_utils import get_s3_client, AWS_S3_BUCKET_NAME

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "m5-forecasting-accuracy")

FILES_TO_UPLOAD = [
    "calendar.csv",
    "sell_prices.csv",
    "sales_train_evaluation.csv",
]


def upload():
    client = get_s3_client()
    if not client:
        print("ERROR: S3 client not configured. Check AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env")
        sys.exit(1)

    for filename in FILES_TO_UPLOAD:
        local_path = os.path.join(DATA_DIR, filename)
        if not os.path.exists(local_path):
            print(f"SKIP: {local_path} not found locally")
            continue

        s3_key = f"data/{filename}"
        size_mb = os.path.getsize(local_path) / (1024 * 1024)
        print(f"Uploading {filename} ({size_mb:.1f} MB) to s3://{AWS_S3_BUCKET_NAME}/{s3_key} ...")

        try:
            client.upload_file(local_path, AWS_S3_BUCKET_NAME, s3_key)
            print(f"  OK: {filename} uploaded successfully")
        except Exception as e:
            print(f"  FAILED: {e}")


if __name__ == "__main__":
    upload()
