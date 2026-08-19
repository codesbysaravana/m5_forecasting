import os
import pandas as pd
import numpy as np
from typing import Optional

_calendar_df: Optional[pd.DataFrame] = None
_price_lookup: Optional[dict] = None
_cat_avg_lookup: Optional[dict] = None
_item_max_lookup: Optional[dict] = None

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "m5-forecasting-accuracy")


def _resolve_data_path(filename: str) -> Optional[str]:
    """Find a data CSV locally or download from S3."""
    local_path = os.path.join(DATA_DIR, filename)
    if os.path.exists(local_path):
        return local_path

    from utils.s3_utils import download_data_file_from_s3
    return download_data_file_from_s3(filename)


def _load_calendar():
    global _calendar_df
    if _calendar_df is not None:
        return _calendar_df

    cal_path = _resolve_data_path("calendar.csv")
    if cal_path is None:
        raise FileNotFoundError("calendar.csv not found locally or in S3")
    df = pd.read_csv(cal_path, parse_dates=["date"])
    df["is_weekend"] = df["wday"].isin([1, 2]).astype(int)
    df["is_event"] = (df["event_name_1"].fillna("") != "").astype(int)
    df = df.set_index("date")
    _calendar_df = df
    return _calendar_df


def _load_sell_prices():
    global _price_lookup, _cat_avg_lookup, _item_max_lookup
    if _price_lookup is not None:
        return

    # Only load from local filesystem — never download from S3.
    # sell_prices.csv is 194MB and builds ~500MB of dicts in RAM,
    # which will OOM on constrained environments like Render.
    prices_path = os.path.join(DATA_DIR, "sell_prices.csv")
    if not os.path.exists(prices_path):
        raise FileNotFoundError("sell_prices.csv not available (skipped to save RAM)")
    df = pd.read_csv(prices_path)

    df["cat_id"] = df["item_id"].str.split("_").str[0]

    # Build dict using vectorized zip (faster than itertuples for large DataFrames)
    _price_lookup = dict(zip(
        zip(df["store_id"], df["item_id"], df["wm_yr_wk"]),
        df["sell_price"]
    ))

    # Category average: (store_id, cat_id, wm_yr_wk) -> avg price
    _cat_avg_lookup = df.groupby(["store_id", "cat_id", "wm_yr_wk"])["sell_price"].mean().to_dict()

    # Item max: (store_id, item_id) -> max price
    _item_max_lookup = df.groupby(["store_id", "item_id"])["sell_price"].max().to_dict()


def _get_snap_col(store_id: str) -> str:
    state = store_id.split("_")[0]
    return f"snap_{state}"


def get_forecast_regressors(store_id: str, item_id: str, dates: pd.Series) -> pd.DataFrame:
    """
    Returns a DataFrame aligned with `dates` containing correct per-day regressor values.
    Columns: sell_price, price_is_promo, price_vs_cat_avg, snap, is_weekend, is_event
    """
    cal = _load_calendar()
    _load_sell_prices()

    cat_id = item_id.split("_")[0]
    snap_col = _get_snap_col(store_id)

    dt_index = pd.to_datetime(dates)

    # --- Calendar-based regressors (vectorized via reindex) ---
    cal_aligned = cal.reindex(dt_index)
    is_weekend = cal_aligned["is_weekend"].fillna(0).astype(int).values
    is_event = cal_aligned["is_event"].fillna(0).astype(int).values
    snap = cal_aligned[snap_col].fillna(0).astype(int).values
    wm_yr_wk_arr = cal_aligned["wm_yr_wk"].values

    # For dates outside calendar range, infer weekend from day of week
    missing_mask = cal_aligned["wm_yr_wk"].isna()
    if missing_mask.any():
        weekdays = dt_index[missing_mask].weekday
        is_weekend[missing_mask.values] = np.isin(weekdays, [5, 6]).astype(int)

    # --- Price lookups (vectorized via numpy) ---
    n = len(dates)
    sell_price = np.full(n, np.nan)

    # Batch lookup: build price array from the lookup dict
    for i in range(n):
        wk = wm_yr_wk_arr[i]
        if not np.isnan(wk):
            p = _price_lookup.get((store_id, item_id, int(wk)))
            if p is not None:
                sell_price[i] = p

    # Forward-fill then back-fill missing prices
    mask = np.isnan(sell_price)
    if not mask.all():
        # Forward fill
        idx = np.where(~mask, np.arange(n), 0)
        np.maximum.accumulate(idx, out=idx)
        sell_price = np.where(mask, sell_price[idx], sell_price)
        # Back fill remaining leading NaNs
        still_nan = np.isnan(sell_price)
        if still_nan.any():
            first_valid = np.argmax(~np.isnan(sell_price))
            sell_price[:first_valid] = sell_price[first_valid]
    else:
        sell_price[:] = 1.0

    # --- price_vs_cat_avg (vectorized) ---
    price_vs_cat_avg = np.ones(n)
    for i in range(n):
        wk = wm_yr_wk_arr[i]
        if not np.isnan(wk):
            cat_avg = _cat_avg_lookup.get((store_id, cat_id, int(wk)))
            if cat_avg and cat_avg > 0:
                price_vs_cat_avg[i] = sell_price[i] / cat_avg

    # --- price_is_promo ---
    item_max = _item_max_lookup.get((store_id, item_id))
    if item_max and item_max > 0:
        price_is_promo = (sell_price < item_max * 0.9).astype(int)
    else:
        price_is_promo = np.zeros(n, dtype=int)

    return pd.DataFrame({
        "sell_price": sell_price,
        "price_is_promo": price_is_promo,
        "price_vs_cat_avg": price_vs_cat_avg,
        "snap": snap,
        "is_weekend": is_weekend,
        "is_event": is_event,
    }, index=dates.index)


def preload_data():
    """Preload calendar and price data at startup to avoid cold-start latency."""
    print("Preloading calendar data...")
    _load_calendar()
    print("Preloading sell prices data (this may take a moment)...")
    _load_sell_prices()
    print("Calendar and price data loaded successfully.")
