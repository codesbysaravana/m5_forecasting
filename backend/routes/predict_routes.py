from fastapi import APIRouter
from pydantic import BaseModel
import lightgbm as lgb
import os
import joblib
import pandas as pd
from utils.s3_utils import download_model_from_s3

router = APIRouter()

MODEL_PATH = "models/lgb_model.txt"
model = None

def load_lgb_model():
    global model
    if os.path.exists(MODEL_PATH):
        print("Loading Model...") 
        model = lgb.Booster(model_file=MODEL_PATH)
        print("Model Loaded Success")
    else:
        print(f"Warning: Model Not Found at {MODEL_PATH}")

class PredictionRequest(BaseModel):
    item_id: str
    store_id: str
    price: float
    is_weekend: int
    is_snap_day: int

@router.post("/predict")
def predict_sales(req: PredictionRequest):
    if model is None:
        return {
            "status": "mock",
            "model": "Not Available"
        }

    # Texas Hybrid Forecasting Logic
    if req.store_id.startswith("TX_"):
        # The frontend calls backend which is in `backend` folder, so we go up one level for local dev
        local_dev_path = os.path.join("..", "prophet_models_texas", "prophet_models", req.store_id, f"{req.item_id}.pkl")
        
        if os.path.exists(local_dev_path):
            pkl_path = local_dev_path
        else:
            # Safe internal cache for production (e.g. Render)
            pkl_path = os.path.join(os.getcwd(), "models_cache", req.store_id, f"{req.item_id}.pkl")
            if not os.path.exists(pkl_path):
                # Attempt to download from S3
                success = download_model_from_s3(req.store_id, req.item_id, pkl_path)
                if not success:
                    return {
                        "status": "error",
                        "model": f"Prophet model not found for {req.item_id} at {req.store_id} (not locally or in S3)"
                    }
            
        try:
            # Need prophet imported locally so we don't crash if it fails globally
            from prophet import Prophet
            
            prophet_model = joblib.load(pkl_path)
            
            future = prophet_model.make_future_dataframe(periods=28)
            
            # The Texas Prophet models require these exact regressors to predict
            future['sell_price'] = req.price
            future['price_is_promo'] = 0
            future['price_vs_cat_avg'] = 1.0
            future['snap'] = req.is_snap_day
            future['is_weekend'] = req.is_weekend
            future['is_event'] = 0
            
            forecast = prophet_model.predict(future)
            
            future_28_days = forecast['yhat'].iloc[-28:]
            history_30_days = forecast['yhat'].iloc[-58:-28] if len(forecast) >= 58 else forecast['yhat'].iloc[:-28]
            
            prophet_pred_sum = float(future_28_days.clip(lower=0).sum())
            daily_predictions = [max(0.0, float(x)) for x in future_28_days]
            historical_predictions = [max(0.0, float(x)) for x in history_30_days]
            
            # Fetch the TRUE actuals for the 28-day future window to show deviation perfectly
            future_actuals = []
            csv_path = os.path.join("..", "m5-forecasting-accuracy", "sales_train_evaluation.csv")
            prefix = f"{req.item_id}_{req.store_id}"
            try:
                with open(csv_path, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.startswith(prefix):
                            parts = line.strip().split(',')
                            # d_1914 to d_1941 (28 days) are at index 1919 to 1946
                            future_actuals = [int(x) for x in parts[1919:1947]]
                            break
            except Exception as ex:
                print(f"Could not load future actuals: {ex}")
                pass
            
            print(f"--- PROPHET PREDICTION for {req.item_id} at {req.store_id} ---")
            print(f"Total 28-day sum: {prophet_pred_sum}")
            print(f"Daily values: {daily_predictions}")
            
            return {
                "status": "success",
                "item_id": req.item_id,
                "predicted_sales": prophet_pred_sum,
                "daily_predictions": daily_predictions,
                "historical_predictions": historical_predictions,
                "future_actuals": future_actuals,
                "model_used": f"prophet_texas_{req.store_id}"
            }
        except Exception as e:
            print(f"Prophet inference failed: {e}")
            import traceback
            traceback.print_exc()
            return {
                "status": "error",
                "model": f"Prophet inference failed: {str(e)}"
            }

    # Fallback to general LightGBM model
    features = [[
        req.price,
        req.is_weekend,
        req.is_snap_day
    ]]

    prediction = model.predict(features)
    daily_val = float(prediction[0])
    
    return {
        "status": "success",
        "item_id": req.item_id,
        "predicted_sales": daily_val * 28,
        "daily_predictions": [daily_val] * 28,
        "historical_predictions": [daily_val] * 30,
        "future_actuals": [],
        "model_used": "lightgbm_base"
    }
