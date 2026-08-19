import os
import boto3
from dotenv import load_dotenv

# Load AWS credentials from .env file
load_dotenv()

AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_S3_BUCKET_NAME = os.getenv("AWS_S3_BUCKET_NAME", "model-m5-forecasting-pkl")
AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-2")

def upload_models_to_s3():
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        print("❌ Error: AWS credentials not found in .env file.")
        print("Please add AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY to your .env file.")
        return

    s3_client = boto3.client(
        "s3",
        aws_access_key_id=AWS_ACCESS_KEY_ID,
        aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
        region_name=AWS_REGION
    )

    # Path to the local models folder
    base_dir = os.path.join("..", "..", "prophet_models_texas", "prophet_models")
    
    if not os.path.exists(base_dir):
        print(f"Error: Local models folder not found at {base_dir}")
        return

    print(f"Starting bulk upload to S3 Bucket: {AWS_S3_BUCKET_NAME}")
    
    # Iterate through all store folders (TX_1, TX_2, TX_3)
    upload_count = 0
    for store_id in os.listdir(base_dir):
        store_path = os.path.join(base_dir, store_id)
        
        if os.path.isdir(store_path):
            # Iterate through all .pkl files in the store folder
            for item_file in os.listdir(store_path):
                if item_file.endswith(".pkl"):
                    local_file_path = os.path.join(store_path, item_file)
                    
                    # Target S3 path: prophet_models/TX_1/HOBBIES_1_001.pkl
                    s3_key = f"prophet_models/{store_id}/{item_file}"
                    
                    try:
                        print(f"Uploading {s3_key}...")
                        s3_client.upload_file(local_file_path, AWS_S3_BUCKET_NAME, s3_key)
                        upload_count += 1
                    except Exception as e:
                        print(f"Failed to upload {s3_key}: {e}")

    print(f"Finished! Successfully uploaded {upload_count} models to S3.")

if __name__ == "__main__":
    upload_models_to_s3()
