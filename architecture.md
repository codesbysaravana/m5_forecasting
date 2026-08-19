# M5 Forecasting Engine — Full Architecture Flow

## System Overview

```mermaid
graph TB
    subgraph Frontend["React Frontend (Vercel)"]
        UI[User Interface]
        FD[ForecastingDashboard.tsx<br/>Prophet View]
        FDLGB[ForecastingDashboardLightGBM.tsx<br/>LightGBM View]
        VO[VoiceOverlay.tsx<br/>Jade Voice Assistant]
    end

    subgraph Backend["FastAPI Backend (Render)"]
        API[main.py<br/>FastAPI App]
        PR[predict_routes.py]
        VR[voice_routes.py]
        DR[data_routes.py]
        AR[auth_routes.py]
    end

    subgraph Storage["External Services"]
        S3[AWS S3<br/>model-m5-forecasting-pkl]
        DB[(PostgreSQL<br/>Neon DB)]
        DG[Deepgram<br/>STT + TTS]
        OAI[OpenAI<br/>GPT-4o-mini]
    end

    UI --> FD
    UI --> FDLGB
    UI --> VO
    FD -->|POST /api/predict/prophet| PR
    FDLGB -->|POST /api/predict/lightgbm| PR
    VO -->|WebSocket /ws/voice| VR
    FD -->|POST /api/data/historical| DR
    FDLGB -->|POST /api/data/historical| DR
    UI -->|POST /auth/login| AR

    PR -->|Download models/data| S3
    DR -->|Query sales| DB
    AR -->|Auth queries| DB
    VR -->|Stream audio| DG
    VR -->|Chat completions| OAI
    VR -->|Tool call: predict| PR
```

---

## Prediction Flow — Region Gating

```mermaid
flowchart TD
    REQ[Incoming Prediction Request<br/>item_id + store_id + price + is_weekend + is_snap_day]

    REQ --> GATE{Which state?<br/>store_id prefix}

    GATE -->|TX stores| REAL[Real ML Prediction]
    GATE -->|CA / WI / Others| MOCK[Mock Prediction]

    subgraph Mock Path ["Mock Path (Zero RAM)"]
        MOCK --> SEED[Deterministic seed from<br/>hash of item_id + store_id]
        SEED --> CALC[Calculate base volume<br/>FOODS=4.5 / HOUSEHOLD=1.8 / HOBBIES=0.9]
        CALC --> MOD[Apply modifiers<br/>price_factor × weekend_boost × snap_boost]
        MOD --> POISSON[Generate 28 days<br/>Poisson distributed values]
        POISSON --> MRESP[Return mock response<br/>model_used: mock_XX_N]
    end

    subgraph Real Path ["Real ML Path (TX Only)"]
        REAL --> WHICH{Which endpoint<br/>was called?}
        WHICH -->|/api/predict/prophet| PROPHET[Prophet Pipeline]
        WHICH -->|/api/predict/lightgbm| LGBM[LightGBM Pipeline]
    end
```

---

## Prophet Prediction Pipeline (TX Only)

```mermaid
flowchart TD
    START[POST /api/predict/prophet<br/>TX store request]

    START --> FIND[Find Prophet .pkl model]

    FIND --> LOCAL{Check local paths}
    LOCAL -->|"../prophet_models/TX_1/ITEM.pkl"| FOUND
    LOCAL -->|"../texas_prophet_values/prophet_models/TX_1/ITEM.pkl"| FOUND
    LOCAL -->|"../prophet_models_texas/prophet_models/TX_1/ITEM.pkl"| FOUND
    LOCAL -->|Not found locally| S3DL[Download from S3<br/>prophet_models/TX_1/ITEM.pkl]
    S3DL --> CACHE1[Cache at ./models_cache/TX_1/ITEM.pkl]
    CACHE1 --> FOUND

    FOUND[Model loaded] --> FUTURE[make_future_dataframe<br/>periods=28]

    FUTURE --> REGRESSORS{Load calendar regressors?}
    REGRESSORS -->|calendar.csv found<br/>100KB from S3| REAL_REG[Real per-day values:<br/>snap, is_weekend, is_event]
    REGRESSORS -->|sell_prices.csv NOT loaded<br/>skipped to save RAM| FALLBACK[Fallback constants:<br/>user-provided price]

    REAL_REG --> PREDICT
    FALLBACK --> PREDICT

    PREDICT[prophet_model.predict] --> SLICE[Slice forecast DataFrame]

    SLICE --> DAILY["daily_predictions = yhat[-28:]<br/>(28 future days)"]
    SLICE --> HIST["historical_predictions = yhat[-58:-28]<br/>(30 past fitted days)"]

    DAILY --> ACTUALS[Load future_actuals<br/>from sales_train_evaluation.csv]
    ACTUALS --> RESP[Return JSON response]

    RESP --> RESPONSE["{ status: success,<br/>  predicted_sales: sum,<br/>  daily_predictions: [28],<br/>  historical_predictions: [30],<br/>  future_actuals: [28],<br/>  model_used: prophet_TX_1 }"]
```

---

## LightGBM Prediction Pipeline (TX Only)

```mermaid
flowchart TD
    START[POST /api/predict/lightgbm<br/>TX store request]

    START --> MODEL[Load global LightGBM model]

    subgraph Model Loading ["One-time Model Loading (cached in memory)"]
        MODEL --> MLOCAL{Check local paths}
        MLOCAL -->|"../final_models/lgb_global_model.pkl"| MFOUND
        MLOCAL -->|Not found| MS3[Download from S3<br/>data/lgb_global_model.pkl]
        MS3 --> MCACHE[Cache at ./data_cache/lgb_global_model.pkl]
        MCACHE --> MFOUND[Model in memory<br/>2 MB]
    end

    MFOUND --> FEATURES[Load model_features.pkl<br/>feature list + cat features]
    FEATURES --> HISTORY[Load recent_history.pkl<br/>90 days × 30K items = 56 MB]

    HISTORY --> BUILD[Build 28-row feature DataFrame]

    subgraph Feature Engineering ["_build_lgb_features()"]
        BUILD --> LOOKUP[Find item's sales history<br/>from recent_history.pkl]
        LOOKUP --> LAGS[Compute lag features<br/>lag_7, lag_14, lag_28]
        LAGS --> ROLLING[Compute rolling stats<br/>roll_mean_7/28/90<br/>roll_zero_rate_7/28/90]
        ROLLING --> CALENDAR[Add calendar features<br/>wday, month, year, is_weekend]
        CALENDAR --> META[Add item metadata<br/>item_id, dept_id, cat_id, store_id, state_id]
        META --> PRICE[Add price features<br/>sell_price, price_roll_mean_28]
        PRICE --> ENCODE[Encode categoricals<br/>astype category]
        ENCODE --> ORDER[Ensure column order<br/>matches training]
    end

    ORDER --> PREDICT["model.predict(feature_df)<br/>Returns 28 daily values"]

    PREDICT --> CLIP[Clip negatives to 0]
    CLIP --> HISTSALES[Get historical_actuals<br/>from recent_history last 30 days]
    HISTSALES --> ACTUALS[Get future_actuals<br/>from sales_train_evaluation.csv]
    ACTUALS --> RESP[Return JSON response]

    RESP --> RESPONSE["{ status: success,<br/>  predicted_sales: sum,<br/>  daily_predictions: [28],<br/>  historical_actuals: [30],<br/>  future_actuals: [28],<br/>  model_used: lightgbm_TX_1 }"]
```

---

## Frontend Chart Construction

```mermaid
flowchart TD
    FETCH["fetch(/api/predict/lightgbm)<br/>+ fetch(/api/data/historical)"]

    FETCH --> HIST_RESP["Historical response:<br/>[{day: 1912, sales: 3}, {day: 1913, sales: 1}, ...]"]
    FETCH --> PRED_RESP["Prediction response:<br/>{daily_predictions: [...], future_actuals: [...]}"]

    HIST_RESP --> BUILD_HIST["Build historical chart points:<br/>{day: date_string, dayNum: N,<br/> actual: sales, predicted: null}"]

    BUILD_HIST --> BRIDGE["Bridge point: last historical point<br/>predicted = actual<br/>(connects white → gold line)"]

    PRED_RESP --> BUILD_PRED["Append 28 forecast points:<br/>{day: date_string, dayNum: N,<br/> actual: future_actuals[i],<br/> predicted: daily_predictions[i]}"]

    BRIDGE --> CHART_DATA
    BUILD_PRED --> CHART_DATA[Combined chartData array]

    CHART_DATA --> RENDER[Recharts LineChart]

    subgraph Chart Rendering
        RENDER --> WHITE["Line dataKey=actual<br/>White solid line<br/>Historical + verification actuals"]
        RENDER --> GOLD["Line dataKey=predicted<br/>Gold dashed line<br/>Only appears from cutoff onward"]
    end

    subgraph Visual Result
        WHITE --> VIZ["Days 1-30: White line only (historical)<br/>Day 30: Bridge point (both lines meet)<br/>Days 31-58: Both lines (predicted vs actual)"]
    end
```

---

## Jade Voice Pipeline

```mermaid
sequenceDiagram
    participant User
    participant Browser as VoiceOverlay.tsx
    participant WS as WebSocket /ws/voice
    participant DG_STT as Deepgram STT
    participant LLM as OpenAI GPT-4o-mini
    participant DG_TTS as Deepgram TTS
    participant ML as predict_routes.py

    Note over Browser: Wake word "Hey Jade" detected<br/>via Web Speech API

    Browser->>Browser: Start AudioWorklet<br/>PCM 16kHz mono
    Browser->>WS: Connect WebSocket

    loop Audio Streaming
        Browser->>WS: Raw PCM audio chunks (100ms)
        WS->>DG_STT: Forward audio bytes
    end

    DG_STT-->>WS: Final transcript<br/>"predict sales for Foods 3 586 at Texas 1"

    WS->>Browser: {type: user_text, content: "..."}
    Note over Browser: Barge-in: stop any<br/>current playback

    WS->>LLM: Chat completion (streaming)<br/>with conversation history + tools

    alt Normal Text Response
        loop Token streaming
            LLM-->>WS: Text chunk
            WS->>Browser: {type: text, content: chunk}
        end

        Note over WS: Sentence boundary detected

        WS->>DG_TTS: POST /v1/speak<br/>{text: sentence}
        DG_TTS-->>WS: Raw PCM audio stream (24kHz)
        WS->>Browser: Binary audio chunks
        Note over Browser: PCM → AudioBuffer → play

    else Tool Call (predict_sales)
        LLM-->>WS: tool_call: predict_sales<br/>{item_id, store_id, ...}
        WS->>ML: predict_sales_lgb(req)
        ML-->>WS: {predicted_sales: 1611.35, ...}

        WS->>LLM: Tool result → synthesize response
        LLM-->>WS: "Sure boss, the prediction for..."
        WS->>DG_TTS: TTS stream
        DG_TTS-->>WS: Audio
        WS->>Browser: Binary audio

    else Tool Call (close_connection)
        LLM-->>WS: tool_call: close_connection
        WS->>Browser: {type: close}
        Note over Browser: Disconnect gracefully
    end
```

---

## S3 Storage Layout

```mermaid
graph LR
    subgraph S3["s3://model-m5-forecasting-pkl"]
        subgraph data["data/"]
            CAL[calendar.csv<br/>100 KB]
            SP[sell_prices.csv<br/>194 MB]
            STE[sales_train_evaluation.csv<br/>116 MB]
            LGM[lgb_global_model.pkl<br/>2 MB]
            MF[model_features.pkl<br/>< 1 KB]
            RH[recent_history.pkl<br/>56 MB]
        end

        subgraph prophet["prophet_models/"]
            TX1P[TX_1/FOODS_3_586.pkl<br/>TX_1/FOODS_3_090.pkl<br/>...]
            TX2P[TX_2/...]
            TX3P[TX_3/...]
        end
    end

    subgraph Render["Render Backend (Runtime)"]
        DC[data_cache/<br/>Downloaded on first request]
        MC[models_cache/<br/>Prophet .pkl cache]
    end

    data -->|"download_data_file_from_s3()"| DC
    prophet -->|"download_model_from_s3()"| MC
```

---

## Memory Budget (Render Production)

```mermaid
pie title RAM Usage on Render (512 MB Instance)
    "Python + FastAPI + uvicorn" : 50
    "numpy (lazy)" : 30
    "LightGBM model" : 2
    "recent_history.pkl" : 56
    "calendar.csv DataFrame" : 5
    "Request overhead" : 10
    "Available headroom" : 359
```

---

## Training Pipeline

```mermaid
flowchart LR
    subgraph Input["Raw M5 CSVs"]
        SALES[sales_train_evaluation.csv<br/>30,490 items × 1,941 days]
        CAL[calendar.csv]
        PRICES[sell_prices.csv]
    end

    subgraph Training["train_lgbm.py"]
        SAMPLE[Sample 5,000 items<br/>from 30,490]
        MELT[Melt wide → long<br/>1.6M rows]
        MERGE[Merge calendar + prices]
        FEAT[Compute lag/rolling features<br/>lag_7/14/28, roll_mean, zero_rate]
        SPLIT[Split train/val<br/>865K train, 140K val]
        TRAIN["LightGBM train<br/>objective: tweedie<br/>num_leaves: 127<br/>early_stopping: 50"]
    end

    subgraph Output["final_models/"]
        MODEL[lgb_global_model.pkl<br/>2 MB, 63 trees]
        FEATS[model_features.pkl<br/>29 features + 9 categoricals]
        HIST[recent_history.pkl<br/>ALL 30,490 items × 90 days]
    end

    SALES --> SAMPLE
    SAMPLE --> MELT --> MERGE
    CAL --> MERGE
    PRICES --> MERGE
    MERGE --> FEAT --> SPLIT --> TRAIN
    TRAIN --> MODEL
    TRAIN --> FEATS
    SALES -->|"Separate pass: last 90 days only"| HIST
```

---

## Deployment Flow

```mermaid
flowchart LR
    DEV[Local Development]

    DEV -->|"python scripts/train_lgbm.py"| TRAIN[Train Model<br/>Produces 3 .pkl files]
    TRAIN -->|"python scripts/upload_data_to_s3.py"| S3[Upload to S3]

    DEV -->|"git push"| GH[GitHub Repository]

    GH -->|Auto-deploy| VERCEL[Vercel<br/>React Frontend]
    GH -->|Auto-deploy| RENDER[Render<br/>FastAPI Backend]

    RENDER -->|First request| S3
    S3 -->|Download + cache| RENDER

    VERCEL -->|API calls| RENDER
```

---

## File Structure

```
cognizant/notebooks/
├── backend/
│   ├── main.py                          # FastAPI app entry point
│   ├── requirements.txt                 # Python dependencies
│   ├── render.yaml                      # Render deployment config
│   ├── routes/
│   │   ├── predict_routes.py            # /api/predict/prophet + /api/predict/lightgbm
│   │   ├── voice_routes.py              # /ws/voice WebSocket (Jade)
│   │   ├── data_routes.py              # /api/data/historical + insights
│   │   └── auth_routes.py              # /auth/login
│   ├── utils/
│   │   ├── s3_utils.py                  # S3 download helpers
│   │   ├── calendar_utils.py            # Calendar/price data loading
│   │   └── auth_utils.py               # JWT + password hashing
│   ├── db/
│   │   └── db.py                        # PostgreSQL connection + schema
│   └── scripts/
│       ├── train_lgbm.py                # LightGBM training script
│       ├── upload_data_to_s3.py         # Upload models + CSVs to S3
│       └── seed_admin.py                # Seed admin user
├── react_frontend/
│   ├── src/
│   │   ├── pages/
│   │   │   ├── ForecastingDashboard.tsx         # Prophet chart view
│   │   │   └── ForecastingDashboardLightGBM.tsx # LightGBM chart view
│   │   ├── components/
│   │   │   └── VoiceOverlay.tsx                 # Jade voice UI
│   │   └── config.ts                            # API_BASE_URL / WS_BASE_URL
│   └── public/
│       └── pcm-processor.js                     # AudioWorklet for mic capture
├── final_models/
│   ├── lgb_global_model.pkl             # Trained LightGBM (2 MB)
│   ├── model_features.pkl              # Feature schema
│   └── recent_history.pkl              # 90-day sales history (56 MB)
├── m5-forecasting-accuracy/             # Raw M5 competition data (gitignored)
│   ├── calendar.csv
│   ├── sell_prices.csv
│   └── sales_train_evaluation.csv
└── texas_prophet_values/                # Prophet models for TX (gitignored)
    └── prophet_models/
        ├── TX_1/
        ├── TX_2/
        └── TX_3/
```
