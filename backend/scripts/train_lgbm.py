"""
Train a global LightGBM model for M5 28-day sales forecasting.

This produces 3 files in final_models/:
  - lgb_global_model.pkl   (~10-20MB) — the trained booster
  - model_features.pkl     — feature list + categorical feature list
  - recent_history.pkl     (~50MB) — last 90 days of sales for lag computation at inference

Usage:
    cd backend
    python scripts/train_lgbm.py

Requires: m5-forecasting-accuracy/ directory at the repo root with:
  - sales_train_evaluation.csv
  - calendar.csv
  - sell_prices.csv
"""
import os
import sys
import time
import pickle
import numpy as np
import pandas as pd
import lightgbm as lgb

# ─── Paths ───────────────────────────────────────────────────────────────────

REPO_ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
DATA_DIR = os.path.join(REPO_ROOT, "m5-forecasting-accuracy")
OUTPUT_DIR = os.path.join(REPO_ROOT, "final_models")
os.makedirs(OUTPUT_DIR, exist_ok=True)

SALES_CSV = os.path.join(DATA_DIR, "sales_train_evaluation.csv")
CALENDAR_CSV = os.path.join(DATA_DIR, "calendar.csv")
PRICES_CSV = os.path.join(DATA_DIR, "sell_prices.csv")

# ─── Config ──────────────────────────────────────────────────────────────────

# Use last N days of the 1941-day series for training features
# d_1 to d_1913 = training history, d_1914 to d_1941 = evaluation/validation
TRAIN_END_DAY = 1913
VAL_START_DAY = 1886  # last 28 days of training as validation
TOTAL_DAYS = 1941

# How many days of history to use for feature engineering (keep memory manageable)
FEATURE_WINDOW = 200  # use last 200 days to build features

# Sample N items for training (None = all items, but OOM risk)
SAMPLE_ITEMS = 5000

# Lag and rolling features
LAGS = [7, 14, 28]
ROLLING_WINDOWS = [7, 28, 90]


def load_sales():
    """Load sales data and melt from wide to long format (memory-efficient)."""
    print("Loading sales data...")
    t = time.time()

    df = pd.read_csv(SALES_CSV)

    # Sample items if configured (huge memory savings)
    if SAMPLE_ITEMS and len(df) > SAMPLE_ITEMS:
        print(f"  Sampling {SAMPLE_ITEMS} items from {len(df)} total...")
        df = df.sample(n=SAMPLE_ITEMS, random_state=42).reset_index(drop=True)

    # Keep metadata columns
    meta_cols = ['id', 'item_id', 'dept_id', 'cat_id', 'store_id', 'state_id']
    start_day = max(1, TRAIN_END_DAY - FEATURE_WINDOW - max(ROLLING_WINDOWS))
    day_cols = [f'd_{i}' for i in range(start_day, TOTAL_DAYS + 1)]
    available_day_cols = [c for c in day_cols if c in df.columns]
    df = df[meta_cols + available_day_cols]

    # Melt to long format
    df_long = df.melt(
        id_vars=meta_cols,
        value_vars=available_day_cols,
        var_name='d',
        value_name='sales'
    )
    del df  # free wide-format memory immediately

    df_long['day_num'] = df_long['d'].str.replace('d_', '').astype(np.int16)
    df_long['sales'] = df_long['sales'].astype(np.int16)
    df_long.drop(columns=['d'], inplace=True)

    print(f"  Loaded {len(df_long):,} rows in {time.time()-t:.1f}s")
    return df_long


def load_calendar():
    """Load and preprocess calendar data."""
    print("Loading calendar...")
    cal = pd.read_csv(CALENDAR_CSV)
    cal['day_num'] = cal['d'].str.replace('d_', '').astype(int)
    cal['is_weekend'] = cal['wday'].isin([1, 2]).astype(int)
    cal['is_event'] = (cal['event_name_1'].fillna('') != '').astype(int)

    # Create a unified snap column per state
    cal['snap_CA_flag'] = cal['snap_CA']
    cal['snap_TX_flag'] = cal['snap_TX']
    cal['snap_WI_flag'] = cal['snap_WI']

    return cal[['day_num', 'wm_yr_wk', 'wday', 'month', 'year',
                'is_weekend', 'is_event', 'event_name_1', 'event_type_1',
                'event_name_2', 'event_type_2',
                'snap_CA_flag', 'snap_TX_flag', 'snap_WI_flag']]


def load_prices():
    """Load sell prices."""
    print("Loading prices...")
    prices = pd.read_csv(PRICES_CSV)
    return prices


def merge_calendar(df, cal):
    """Merge calendar features onto sales data."""
    print("Merging calendar features...")
    df = df.merge(cal, on='day_num', how='left')

    # Map snap to the correct state
    def get_snap(row):
        state = row['state_id']
        if state == 'CA':
            return row['snap_CA_flag']
        elif state == 'TX':
            return row['snap_TX_flag']
        elif state == 'WI':
            return row['snap_WI_flag']
        return 0

    df['snap'] = df.apply(get_snap, axis=1)
    df.drop(columns=['snap_CA_flag', 'snap_TX_flag', 'snap_WI_flag'], inplace=True)

    return df


def merge_prices(df, prices):
    """Merge sell prices and compute price features."""
    print("Merging prices...")
    df = df.merge(prices, on=['store_id', 'item_id', 'wm_yr_wk'], how='left')

    # Forward fill prices within each item-store group
    df.sort_values(['item_id', 'store_id', 'day_num'], inplace=True)
    df['sell_price'] = df.groupby(['item_id', 'store_id'])['sell_price'].ffill()
    df['sell_price'] = df['sell_price'].fillna(0)

    # Price rolling mean (28-day window approximation via wm_yr_wk groups)
    df['price_roll_mean_28'] = df.groupby(['item_id', 'store_id'])['sell_price'].transform(
        lambda x: x.rolling(4, min_periods=1).mean()
    )

    # Price is promo: current price < 90% of max historical price for this item
    max_price = df.groupby(['item_id', 'store_id'])['sell_price'].transform('max')
    df['price_is_promo'] = (df['sell_price'] < max_price * 0.9).astype(int)

    # Price vs category average
    cat_avg = df.groupby(['cat_id', 'store_id', 'wm_yr_wk'])['sell_price'].transform('mean')
    df['price_vs_cat_avg'] = np.where(cat_avg > 0, df['sell_price'] / cat_avg, 1.0)

    return df


def compute_lag_features(df):
    """Compute lag and rolling features per item-store."""
    print("Computing lag/rolling features (this takes a moment)...")
    t = time.time()

    df.sort_values(['item_id', 'store_id', 'day_num'], inplace=True)
    group = df.groupby(['item_id', 'store_id'])['sales']

    for lag in LAGS:
        df[f'lag_{lag}'] = group.shift(lag)

    for window in ROLLING_WINDOWS:
        rolled = group.shift(1).rolling(window, min_periods=1)
        df[f'roll_mean_{window}'] = rolled.mean().values
        df[f'roll_zero_rate_{window}'] = group.shift(1).rolling(window, min_periods=1).apply(
            lambda x: (x == 0).mean(), raw=True
        ).values

    print(f"  Lag features computed in {time.time()-t:.1f}s")
    return df


def prepare_training_data(df):
    """Split into train/validation and select features (in-place, no copy)."""

    features = [
        'item_id', 'dept_id', 'cat_id', 'store_id', 'state_id',
        'wm_yr_wk', 'wday', 'month', 'year',
        'event_name_1', 'event_type_1', 'event_name_2', 'event_type_2',
        'snap', 'sell_price', 'is_weekend', 'is_event',
        'price_roll_mean_28', 'price_is_promo', 'price_vs_cat_avg',
        'lag_7', 'lag_14', 'lag_28',
        'roll_mean_7', 'roll_zero_rate_7',
        'roll_mean_28', 'roll_zero_rate_28',
        'roll_mean_90', 'roll_zero_rate_90',
    ]

    cat_features = [
        'item_id', 'dept_id', 'cat_id', 'store_id', 'state_id',
        'event_name_1', 'event_type_1', 'event_name_2', 'event_type_2',
    ]

    # Filter in-place: drop rows where lags aren't available
    train_start = TRAIN_END_DAY - FEATURE_WINDOW
    mask = (
        df['lag_28'].notna() &
        df['roll_mean_90'].notna() &
        (df['day_num'] >= train_start)
    )
    df = df.loc[mask]

    # Encode categoricals in-place
    for col in cat_features:
        df[col] = df[col].fillna('Unknown').astype('category')

    # Split
    train_mask = df['day_num'] < VAL_START_DAY
    val_mask = (df['day_num'] >= VAL_START_DAY) & (df['day_num'] <= TRAIN_END_DAY)

    X_train = df.loc[train_mask, features]
    y_train = df.loc[train_mask, 'sales'].astype(float)
    X_val = df.loc[val_mask, features]
    y_val = df.loc[val_mask, 'sales'].astype(float)

    print(f"  Train: {len(X_train):,} rows, Val: {len(X_val):,} rows")
    print(f"  Features: {len(features)}")

    return X_train, y_train, X_val, y_val, features, cat_features


def train_model(X_train, y_train, X_val, y_val, cat_features):
    """Train LightGBM with Tweedie objective (handles zero-inflated sales)."""
    print("\nTraining LightGBM...")
    t = time.time()

    train_data = lgb.Dataset(
        X_train, label=y_train,
        categorical_feature=cat_features,
        free_raw_data=False
    )
    val_data = lgb.Dataset(
        X_val, label=y_val,
        categorical_feature=cat_features,
        reference=train_data,
        free_raw_data=False
    )

    params = {
        'objective': 'tweedie',
        'tweedie_variance_power': 1.1,
        'metric': 'rmse',
        'learning_rate': 0.05,
        'num_leaves': 127,
        'max_depth': -1,
        'min_child_samples': 50,
        'feature_fraction': 0.8,
        'bagging_fraction': 0.8,
        'bagging_freq': 1,
        'lambda_l1': 0.1,
        'lambda_l2': 1.0,
        'verbose': -1,
        'n_jobs': -1,
    }

    callbacks = [
        lgb.log_evaluation(period=100),
        lgb.early_stopping(stopping_rounds=50),
    ]

    model = lgb.train(
        params,
        train_data,
        num_boost_round=1000,
        valid_sets=[train_data, val_data],
        valid_names=['train', 'val'],
        callbacks=callbacks,
    )

    print(f"\n  Training complete in {time.time()-t:.1f}s")
    print(f"  Best iteration: {model.best_iteration}")
    print(f"  Best val RMSE: {model.best_score['val']['rmse']:.4f}")

    return model


def save_recent_history():
    """Save the last 90 days of sales for ALL item-stores (needed for lag features at inference)."""
    print("Saving recent history for inference (loading full dataset)...")
    t = time.time()

    # Load only the columns we need: metadata + last 90 days
    df = pd.read_csv(SALES_CSV, usecols=['id'] + [f'd_{i}' for i in range(TRAIN_END_DAY - 90 + 1, TRAIN_END_DAY + 1)])

    # Melt to long format
    day_cols = [c for c in df.columns if c.startswith('d_')]
    recent = df.melt(id_vars=['id'], value_vars=day_cols, var_name='d', value_name='sales')
    del df

    recent['day_num'] = recent['d'].str.replace('d_', '').astype(int)
    recent.drop(columns=['d'], inplace=True)

    # Convert day_num to actual dates for compatibility with inference code
    base_date = pd.Timestamp('2011-01-29')
    recent['date'] = recent['day_num'].apply(lambda d: base_date + pd.Timedelta(days=d-1))
    recent.drop(columns=['day_num'], inplace=True)

    output_path = os.path.join(OUTPUT_DIR, "recent_history.pkl")
    recent.to_pickle(output_path)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"  Saved recent_history.pkl ({size_mb:.1f} MB, {len(recent):,} rows) in {time.time()-t:.1f}s")


def main():
    print("=" * 60)
    print("M5 LightGBM Training Script")
    print("=" * 60)
    print()

    # 1. Load data
    sales_df = load_sales()
    cal_df = load_calendar()
    prices_df = load_prices()

    # 2. Merge features
    df = merge_calendar(sales_df, cal_df)
    df = merge_prices(df, prices_df)

    # Free memory
    del sales_df, cal_df, prices_df

    # 3. Compute lag features
    df = compute_lag_features(df)

    # 4. Prepare train/val splits
    X_train, y_train, X_val, y_val, features, cat_features = prepare_training_data(df)

    # 5. Save recent history (loads full dataset independently — only last 90 days)
    save_recent_history()

    # Free the big dataframe
    del df

    # 6. Train
    model = train_model(X_train, y_train, X_val, y_val, cat_features)

    # 7. Save model
    model_path = os.path.join(OUTPUT_DIR, "lgb_global_model.pkl")
    pickle.dump(model, open(model_path, 'wb'))
    size_mb = os.path.getsize(model_path) / (1024 * 1024)
    print(f"\n  Saved lgb_global_model.pkl ({size_mb:.1f} MB)")

    # 8. Save feature metadata
    features_meta = {
        'features': features,
        'cat_features': cat_features,
    }
    features_path = os.path.join(OUTPUT_DIR, "model_features.pkl")
    pickle.dump(features_meta, open(features_path, 'wb'))
    print(f"  Saved model_features.pkl")

    # 9. Quick validation check
    print("\n" + "=" * 60)
    print("VALIDATION CHECK")
    print("=" * 60)
    val_preds = model.predict(X_val)
    val_preds_clipped = np.clip(val_preds, 0, None)

    rmse = np.sqrt(np.mean((val_preds_clipped - y_val.values) ** 2))
    mae = np.mean(np.abs(val_preds_clipped - y_val.values))

    # Check how well it handles zeros
    zero_mask = y_val.values == 0
    non_zero_mask = ~zero_mask

    print(f"  Overall RMSE: {rmse:.4f}")
    print(f"  Overall MAE: {mae:.4f}")
    print(f"  Zero-day accuracy: {(val_preds_clipped[zero_mask] < 0.5).mean()*100:.1f}% correctly near-zero")
    if non_zero_mask.any():
        print(f"  Non-zero RMSE: {np.sqrt(np.mean((val_preds_clipped[non_zero_mask] - y_val.values[non_zero_mask])**2)):.4f}")

    print(f"\n  Sample predictions vs actuals:")
    sample_idx = np.random.choice(len(y_val), size=min(10, len(y_val)), replace=False)
    for i in sample_idx:
        print(f"    Actual: {y_val.values[i]:3.0f}  |  Predicted: {val_preds_clipped[i]:.2f}")

    print("\n" + "=" * 60)
    print("DONE! Files saved to final_models/")
    print("=" * 60)
    print(f"\nNext steps:")
    print(f"  1. Upload to S3:  python scripts/upload_data_to_s3.py")
    print(f"  2. Push code and redeploy")


if __name__ == "__main__":
    main()
