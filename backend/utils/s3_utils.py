import os
import boto3
from botocore.exceptions import ClientError
from dotenv import load_dotenv

load_dotenv()

AWS_ACCESS_KEY_ID = os.getenv("AWS_ACCESS_KEY_ID")
AWS_SECRET_ACCESS_KEY = os.getenv("AWS_SECRET_ACCESS_KEY")
AWS_S3_BUCKET_NAME = os.getenv("AWS_S3_BUCKET_NAME", "model-m5-forecasting-pkl")
AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-2")

s3_client = None

def get_s3_client():
    global s3_client
    if s3_client is None and AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY:
        try:
            s3_client = boto3.client(
                "s3",
                aws_access_key_id=AWS_ACCESS_KEY_ID,
                aws_secret_access_key=AWS_SECRET_ACCESS_KEY,
                region_name=AWS_REGION
            )
        except Exception as e:
            print(f"Failed to initialize S3 client: {e}")
    return s3_client

def download_model_from_s3(store_id: str, item_id: str, local_dest_path: str) -> bool:
    """
    Downloads the specified Prophet model from S3 to the local destination path.
    Returns True if successful, False otherwise.
    """
    return _download_from_s3(f"prophet_models/{store_id}/{item_id}.pkl", local_dest_path)


def download_lgb_model_from_s3(store_id: str, item_id: str, local_dest_path: str) -> bool:
    """
    Downloads the specified LightGBM model from S3 to the local destination path.
    Returns True if successful, False otherwise.
    """
    return _download_from_s3(f"lightgbm_models/{store_id}/{item_id}.pkl", local_dest_path)


def download_data_file_from_s3(filename: str) -> str | None:
    """
    Downloads a data CSV from S3 (key: data/<filename>) to a local cache.
    Returns the local path if successful, None otherwise.
    Skips download if the file already exists locally.
    """
    cache_dir = os.path.join(os.getcwd(), "data_cache")
    local_path = os.path.join(cache_dir, filename)

    if os.path.exists(local_path):
        return local_path

    s3_key = f"data/{filename}"
    success = _download_from_s3(s3_key, local_path)
    return local_path if success else None


def _download_from_s3(s3_key: str, local_dest_path: str) -> bool:
    client = get_s3_client()
    if not client:
        print("S3 Client not configured. Cannot download.")
        return False

    os.makedirs(os.path.dirname(local_dest_path), exist_ok=True)

    try:
        print(f"Downloading {s3_key} from S3 bucket {AWS_S3_BUCKET_NAME}...")
        client.download_file(AWS_S3_BUCKET_NAME, s3_key, local_dest_path)
        print(f"Downloaded {s3_key} to {local_dest_path}")
        return True
    except ClientError as e:
        if e.response['Error']['Code'] == "404":
            print(f"{s3_key} does not exist in S3.")
        else:
            print(f"Failed to download {s3_key}: {e}")
        return False
    except Exception as e:
        print(f"Unexpected error downloading from S3: {e}")
        return False
