from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import os

from db.db import db, init_db
from routes.auth_routes import router as auth_router
from routes.predict_routes import router as predict_router, load_lgb_model
from routes.voice_routes import router as voice_router
from routes.data_routes import router as data_router

app = FastAPI(title="M5 Forecasting Engine")

# --- Middleware ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_event():
    load_lgb_model()
    try:
        from utils.calendar_utils import preload_data
        preload_data()
    except Exception as e:
        print(f"Warning: Could not preload calendar data: {e}")

@app.get("/")
def read_root():
    return {"Welcome to M5 Forecasting"}

# --- Hook up the Routers ---
app.include_router(auth_router, prefix="/auth", tags=["Authentication"])
app.include_router(predict_router, prefix="/api", tags=["Prediction"])
app.include_router(voice_router, tags=["Voice"])
app.include_router(data_router, prefix="/api/data", tags=["Data"])
