from fastapi import APIRouter
from pydantic import BaseModel
import os
import joblib
from utils.s3_utils import download_model_from_s3, download_lgb_model_from_s3, download_data_file_from_s3

router = APIRouter()


class PredictionRequest(BaseModel):
    item_id: str
    store_id: str
    price: float
    is_weekend: int
    is_snap_day: int


def _get_future_actuals(item_id: str, store_id: str) -> list:
    """Load 28-day actuals from sales_train_evaluation.csv (local or S3)."""
    csv_path = os.path.join("..", "m5-forecasting-accuracy", "sales_train_evaluation.csv")
    if not os.path.exists(csv_path):
        csv_path = download_data_file_from_s3("sales_train_evaluation.csv")
    if not csv_path:
        return []

    prefix = f"{item_id}_{store_id}"
    try:
        with open(csv_path, "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith(prefix):
                    parts = line.strip().split(',')
                    return [int(x) for x in parts[1919:1947]]
    except Exception:
        pass
    return []


# ─── Shared: Mock predictions + region gating ───────────────────────────────

import numpy as np

# Only Texas gets real ML; other regions get instant mock predictions (zero RAM)
REAL_ML_STATES = {"TX"}


def _mock_prediction(req: PredictionRequest) -> dict:
    """Generate plausible mock predictions for non-TX regions. Zero memory cost."""
    seed = hash(f"{req.item_id}_{req.store_id}") % 10000
    rng = np.random.default_rng(seed)

    cat = req.item_id.split('_')[0] if '_' in req.item_id else 'HOBBIES'
    base_map = {'FOODS': 4.5, 'HOUSEHOLD': 1.8, 'HOBBIES': 0.9}
    base = base_map.get(cat, 1.5)

    price_factor = max(0.5, 1.0 - (req.price - 5.0) * 0.03)
    weekend_boost = 1.2 if req.is_weekend else 1.0
    snap_boost = 1.15 if req.is_snap_day else 1.0
    mean_daily = base * price_factor * weekend_boost * snap_boost

    daily_predictions = []
    for i in range(28):
        day_factor = 1.0 + 0.1 * np.sin(i * 0.9 + seed * 0.01)
        val = float(rng.poisson(max(0.1, mean_daily * day_factor)))
        daily_predictions.append(val)

    pred_sum = sum(daily_predictions)
    historical_actuals = [int(rng.poisson(max(0.1, mean_daily * (1 + 0.05 * np.sin(j))))) for j in range(30)]

    return {
        "status": "success",
        "item_id": req.item_id,
        "predicted_sales": pred_sum,
        "daily_predictions": daily_predictions,
        "historical_predictions": [float(rng.poisson(max(0.1, mean_daily))) for _ in range(30)],
        "future_actuals": [],
        "model_used": f"mock_{req.store_id}"
    }


# ─── Prophet Prediction ─────────────────────────────────────────────────────

@router.post("/predict")
@router.post("/predict/prophet")
def predict_sales(req: PredictionRequest):
    state = req.store_id.split('_')[0] if '_' in req.store_id else ""
    if state not in REAL_ML_STATES:
        return _mock_prediction(req)

    local_dev_paths = [
        os.path.join("..", "prophet_models", req.store_id, f"{req.item_id}.pkl"),
        os.path.join("..", "texas_prophet_values", "prophet_models", req.store_id, f"{req.item_id}.pkl"),
        os.path.join("..", "prophet_models_texas", "prophet_models", req.store_id, f"{req.item_id}.pkl"),
    ]

    pkl_path = None
    for path in local_dev_paths:
        if os.path.exists(path):
            pkl_path = path
            break

    if pkl_path is None:
        pkl_path = os.path.join(os.getcwd(), "models_cache", req.store_id, f"{req.item_id}.pkl")
        if not os.path.exists(pkl_path):
            success = download_model_from_s3(req.store_id, req.item_id, pkl_path)
            if not success:
                return {
                    "status": "error",
                    "model": f"Prophet model not found for {req.item_id} at {req.store_id} (not locally or in S3)"
                }

    try:
        from prophet import Prophet

        prophet_model = joblib.load(pkl_path)
        future = prophet_model.make_future_dataframe(periods=28)

        try:
            from utils.calendar_utils import get_forecast_regressors
            regressors = get_forecast_regressors(req.store_id, req.item_id, future['ds'])
            future['sell_price'] = regressors['sell_price'].values
            future['price_is_promo'] = regressors['price_is_promo'].values
            future['price_vs_cat_avg'] = regressors['price_vs_cat_avg'].values
            future['snap'] = regressors['snap'].values
            future['is_weekend'] = regressors['is_weekend'].values
            future['is_event'] = regressors['is_event'].values
        except Exception as cal_err:
            print(f"Warning: Calendar data unavailable, using fallback constants: {cal_err}")
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

        future_actuals = _get_future_actuals(req.item_id, req.store_id)

        return {
            "status": "success",
            "item_id": req.item_id,
            "predicted_sales": prophet_pred_sum,
            "daily_predictions": daily_predictions,
            "historical_predictions": historical_predictions,
            "future_actuals": future_actuals,
            "model_used": f"prophet_{req.store_id}"
        }
    except Exception as e:
        print(f"Prophet inference failed: {e}")
        import traceback
        traceback.print_exc()
        return {
            "status": "error",
            "model": f"Prophet inference failed: {str(e)}"
        }


# ─── LightGBM Prediction ────────────────────────────────────────────────────

import pandas as pd

_lgb_global_model = None
_recent_history: pd.DataFrame | None = None
_model_features: dict | None = None


def _load_global_lgb_model():
    """Load the single global LightGBM model (from local or S3)."""
    global _lgb_global_model
    if _lgb_global_model is not None:
        return _lgb_global_model

    local_paths = [
        os.path.join("..", "final_models", "lgb_global_model.pkl"),
        os.path.join(os.getcwd(), "final_models", "lgb_global_model.pkl"),
    ]

    for path in local_paths:
        if os.path.exists(path):
            _lgb_global_model = joblib.load(path)
            return _lgb_global_model

    # Try S3
    s3_path = download_data_file_from_s3("lgb_global_model.pkl")
    if s3_path:
        _lgb_global_model = joblib.load(s3_path)
        return _lgb_global_model

    return None


def _get_recent_history() -> pd.DataFrame | None:
    global _recent_history
    if _recent_history is not None:
        return _recent_history

    local_paths = [
        os.path.join("..", "final_models", "recent_history.pkl"),
        os.path.join(os.getcwd(), "final_models", "recent_history.pkl"),
    ]

    for path in local_paths:
        if os.path.exists(path):
            _recent_history = joblib.load(path)
            return _recent_history

    # Try S3
    s3_path = download_data_file_from_s3("recent_history.pkl")
    if s3_path:
        _recent_history = joblib.load(s3_path)
        return _recent_history

    return None


def _get_model_features() -> dict | None:
    global _model_features
    if _model_features is not None:
        return _model_features

    local_paths = [
        os.path.join("..", "final_models", "model_features.pkl"),
        os.path.join(os.getcwd(), "final_models", "model_features.pkl"),
    ]

    for path in local_paths:
        if os.path.exists(path):
            _model_features = joblib.load(path)
            return _model_features

    # Try S3
    s3_path = download_data_file_from_s3("model_features.pkl")
    if s3_path:
        _model_features = joblib.load(s3_path)
        return _model_features

    return None


def _build_lgb_features(req: PredictionRequest, history_df: pd.DataFrame, features_meta: dict) -> pd.DataFrame:
    """Build a feature DataFrame for 28-day LightGBM prediction using recent history."""
    item_store_id = f"{req.item_id}_{req.store_id}_validation"
    item_history = history_df[history_df['id'] == item_store_id].sort_values('date').copy()

    if item_history.empty:
        item_store_id = f"{req.item_id}_{req.store_id}_evaluation"
        item_history = history_df[history_df['id'] == item_store_id].sort_values('date').copy()

    sales_values = item_history['sales'].values if not item_history.empty else np.zeros(90)

    # Parse item metadata from item_id
    parts = req.item_id.split('_')
    cat_id = parts[0] if len(parts) >= 1 else "UNKNOWN"
    dept_id = f"{parts[0]}_{parts[1]}" if len(parts) >= 2 else "UNKNOWN"
    state_id = req.store_id.split('_')[0] if '_' in req.store_id else "XX"

    rows = []
    for day_offset in range(28):
        # Extend sales with zeros for future days (we predict iteratively but simplify here)
        extended_sales = np.concatenate([sales_values, np.zeros(day_offset)])

        lag_7 = float(extended_sales[-(7 + day_offset)] if len(extended_sales) > (7 + day_offset) else 0)
        lag_14 = float(extended_sales[-(14 + day_offset)] if len(extended_sales) > (14 + day_offset) else 0)
        lag_28 = float(extended_sales[-(28 + day_offset)] if len(extended_sales) > (28 + day_offset) else 0)

        window_7 = extended_sales[-(7 + day_offset):len(extended_sales) - day_offset] if len(extended_sales) > (7 + day_offset) else np.zeros(7)
        window_28 = extended_sales[-(28 + day_offset):len(extended_sales) - day_offset] if len(extended_sales) > (28 + day_offset) else np.zeros(28)
        window_90 = extended_sales[-(90 + day_offset):len(extended_sales) - day_offset] if len(extended_sales) > (90 + day_offset) else extended_sales[:max(1, len(extended_sales) - day_offset)]

        roll_mean_7 = float(np.mean(window_7)) if len(window_7) > 0 else 0.0
        roll_mean_28 = float(np.mean(window_28)) if len(window_28) > 0 else 0.0
        roll_mean_90 = float(np.mean(window_90)) if len(window_90) > 0 else 0.0

        roll_zero_rate_7 = float(np.mean(window_7 == 0)) if len(window_7) > 0 else 1.0
        roll_zero_rate_28 = float(np.mean(window_28 == 0)) if len(window_28) > 0 else 1.0
        roll_zero_rate_90 = float(np.mean(window_90 == 0)) if len(window_90) > 0 else 1.0

        # Calendar features (simplified — a full version would look up the calendar CSV)
        base_date = pd.Timestamp('2016-04-25') + pd.Timedelta(days=day_offset)
        wday = base_date.dayofweek + 1
        month = base_date.month
        year = base_date.year
        is_weekend = 1 if wday >= 6 else int(req.is_weekend)

        row = {
            "item_id": req.item_id,
            "dept_id": dept_id,
            "cat_id": cat_id,
            "store_id": req.store_id,
            "state_id": state_id,
            "wm_yr_wk": 11617 + (day_offset // 7),
            "wday": wday,
            "month": month,
            "year": year,
            "event_name_1": "No_Event",
            "event_type_1": "No_Event",
            "event_name_2": "No_Event",
            "event_type_2": "No_Event",
            "snap": req.is_snap_day,
            "sell_price": req.price,
            "is_weekend": is_weekend,
            "is_event": 0,
            "price_roll_mean_28": req.price,
            "price_is_promo": 0,
            "price_vs_cat_avg": 1.0,
            "lag_7": lag_7,
            "lag_14": lag_14,
            "lag_28": lag_28,
            "roll_mean_7": roll_mean_7,
            "roll_zero_rate_7": roll_zero_rate_7,
            "roll_mean_28": roll_mean_28,
            "roll_zero_rate_28": roll_zero_rate_28,
            "roll_mean_90": roll_mean_90,
            "roll_zero_rate_90": roll_zero_rate_90,
        }
        rows.append(row)

    df = pd.DataFrame(rows)

    # Encode categoricals the same way the training pipeline did
    cat_features = features_meta.get("cat_features", [])
    for col in cat_features:
        if col in df.columns:
            df[col] = df[col].astype("category")

    # Ensure column order matches training
    expected_features = features_meta.get("features", list(df.columns))
    for col in expected_features:
        if col not in df.columns:
            df[col] = 0
    df = df[expected_features]

    return df


@router.post("/predict/lightgbm")
def predict_sales_lgb(req: PredictionRequest):
    state = req.store_id.split('_')[0] if '_' in req.store_id else ""

    if state not in REAL_ML_STATES:
        return _mock_prediction(req)

    # Real LightGBM inference for Texas
    model = _load_global_lgb_model()
    if model is None:
        return _mock_prediction(req)

    features_meta = _get_model_features()
    if features_meta is None:
        return _mock_prediction(req)

    history_df = _get_recent_history()
    if history_df is None:
        return _mock_prediction(req)

    try:
        feature_df = _build_lgb_features(req, history_df, features_meta)
        predictions_raw = model.predict(feature_df)
        daily_predictions = [max(0.0, float(x)) for x in predictions_raw]
        pred_sum = sum(daily_predictions)

        # Compute historical context from recent_history for chart overlay
        item_store_id = f"{req.item_id}_{req.store_id}_validation"
        item_history = history_df[history_df['id'] == item_store_id].sort_values('date')
        if item_history.empty:
            item_store_id = f"{req.item_id}_{req.store_id}_evaluation"
            item_history = history_df[history_df['id'] == item_store_id].sort_values('date')

        historical_sales = [max(0, int(x)) for x in item_history['sales'].values[-30:]]

        future_actuals = _get_future_actuals(req.item_id, req.store_id)

        return {
            "status": "success",
            "item_id": req.item_id,
            "predicted_sales": pred_sum,
            "daily_predictions": daily_predictions,
            "historical_actuals": historical_sales,
            "future_actuals": future_actuals,
            "model_used": f"lightgbm_{req.store_id}"
        }
    except Exception as e:
        print(f"LightGBM inference failed: {e}")
        return _mock_prediction(req)
