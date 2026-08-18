# M5 Forecasting Engine

An end-to-end, full-stack forecasting platform featuring real-time data visualization, predictive machine learning models, and an autonomous AI voice assistant named **Jade**.

## 🌟 Features

- **Predictive Engine**: Powered by LightGBM to accurately forecast item sales across different stores based on historical metrics, pricing, and external events.
- **Enterprise RBAC (Role-Based Access Control)**:
  - **Master Admins**: Full access to the interactive HQ Map, cross-store analytics, and the Admin Panel for provisioning new managers.
  - **Store Owners**: Secure, locked-down access restricted solely to their assigned store's Forecasting Dashboard.
- **AI Voice Assistant (Jade)**: A fully integrated, real-time voice assistant built with OpenAI (GPT-4o) and Deepgram (STT/TTS). Jade can analyze your data, remember conversational context, and execute machine learning predictions on your behalf through Tool Calling.
- **Modern UI**: A premium, responsive, glassmorphism-inspired React interface featuring real-time Recharts visualizations and Feature Impact driver analysis.
- **Robust Backend**: A high-performance FastAPI server managing REST endpoints, JWT Authentication, asynchronous WebSocket streams, and PostgreSQL databases.

## 🏗️ Architecture

```mermaid
graph TD
    %% Core Components
    Client([💻 Web Client / React])
    API[⚡ FastAPI Backend]
    DB[(🐘 Neon PostgreSQL)]
    Model[[🧠 LightGBM Model]]
    
    %% AI Pipeline
    STT((🎙️ Deepgram STT))
    LLM((🤖 OpenAI LLM))
    TTS((🔊 Deepgram TTS))

    %% Connections
    Client <-->|REST API (Auth/Predict)| API
    Client <-->|WebSockets (Voice)| API
    
    API <--> DB
    API <--> Model
    
    API -.-> STT
    API -.-> LLM
    API -.-> TTS
    
    classDef minimalist fill:none,stroke:#d4af37,stroke-width:1px,color:#fff;
    class Client,API,DB,Model,STT,LLM,TTS minimalist;
```

## 🚀 Tech Stack

- **Frontend:** React 19, Vite, TypeScript, React Router, Recharts, React Simple Maps.
- **Backend:** Python, FastAPI, Uvicorn, Psycopg2, Passlib, JWT.
- **Machine Learning:** LightGBM, Pandas, NumPy.
- **AI / Voice:** OpenAI (GPT-4o), Deepgram (Aura TTS, Nova STT).
- **Database:** PostgreSQL (NeonDB).

## 🛠️ Getting Started

### Prerequisites
- Node.js (v18+)
- Python (v3.11+)
- A remote PostgreSQL database (like Neon)

### 1. Backend Setup
```bash
cd backend
python -m venv venv
source venv/Scripts/activate  # (or venv/bin/activate on Mac/Linux)
pip install -r requirements.txt
```

Create a `.env` file in the `backend/` directory with your API keys:
```env
DATABASE_URL=postgresql://...
GROQ_API_KEY=your_key
DEEPGRAM_API_KEY=your_key
OPENAI_API_KEY=your_key
JWT_SECRET_KEY=super-secret-key-for-dev
```

**Seed the Master Admin Account:**
```bash
python scripts/seed_admin.py
# Creates: admin@m5.com / adminpassword
```

Start the FastAPI server:
```bash
uvicorn main:app --reload
```

### 2. Frontend Setup
```bash
cd react_frontend
npm install
```
*(Note: If you run into peer dependency issues with React 19 and react-simple-maps, ensure you run `npm install --legacy-peer-deps` or use the provided `.npmrc` file.)*

Start the Vite development server:
```bash
npm run dev
```

## 🔐 Security & Routing
- Public signups are intentionally **disabled** to protect proprietary forecasting data.
- New accounts can only be provisioned by an `ADMIN` through the internal Admin Panel.
- **Store Owners** are hard-routed to `/dashboard/store/:storeId` upon login and cannot access the HQ Map or other store data.

## 🧠 Meet Jade
Jade is not just a chatbot—she is integrated directly into the system's prediction layer. When connected to the WebSocket overlay, you can ask her to forecast sales:

> *"Hey Jade, can you predict the sales for item HOBBIES_1 in store CA_1?"*

She will autonomously trigger the `predict_sales` tool, compute the numbers using the LightGBM model, and speak the results back to you instantly.
