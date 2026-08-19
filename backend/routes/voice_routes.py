import os
import json
import asyncio
import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents
from openai import AsyncOpenAI
from dotenv import load_dotenv
from routes.predict_routes import predict_sales, predict_sales_lgb, PredictionRequest

load_dotenv()

router = APIRouter()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)
deepgram = DeepgramClient(DEEPGRAM_API_KEY)

_tts_http_client = httpx.AsyncClient(timeout=15.0)

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "predict_sales",
            "description": "Predict future sales for a specific item at a specific store. Use this whenever the user asks for a sales prediction or forecast.",
            "parameters": {
                "type": "object",
                "properties": {
                    "item_id": {
                        "type": "string",
                        "description": "The ID of the item, e.g., 'HOBBIES_1_001'."
                    },
                    "store_id": {
                        "type": "string",
                        "description": "The ID of the store, e.g., 'CA_1'."
                    },
                    "price": {
                        "type": "number",
                        "description": "The price of the item. Default to 0 if not provided."
                    },
                    "is_weekend": {
                        "type": "integer",
                        "description": "1 if the prediction is for a weekend, 0 otherwise. Default to 0."
                    },
                    "is_snap_day": {
                        "type": "integer",
                        "description": "1 if it is a SNAP (food stamp) day, 0 otherwise. Default to 0."
                    }
                },
                "required": ["item_id", "store_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "close_connection",
            "description": "Close the WebSocket connection and hang up the voice call. Use this when the user says 'close the connection', 'hang up', or 'goodbye'.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": []
            }
        }
    }
]

TTS_URL = "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=24000"
TTS_HEADERS = {
    "Authorization": f"Token {DEEPGRAM_API_KEY}",
    "Content-Type": "application/json"
}


async def stream_tts_to_ws(sentence: str, websocket: WebSocket, cancelled: asyncio.Event):
    """Stream a single sentence's TTS audio to the client. Stops early if cancelled."""
    try:
        async with _tts_http_client.stream("POST", TTS_URL, headers=TTS_HEADERS, json={"text": sentence}) as r:
            if r.status_code == 200:
                async for chunk in r.aiter_bytes(4096):
                    if cancelled.is_set():
                        return
                    await websocket.send_bytes(chunk)
            else:
                body = await r.aread()
                print(f"TTS Error: {r.status_code} {body.decode()}")
    except Exception as e:
        print(f"TTS Network Error: {e}")


async def generate_llm_and_tts(
    transcript: str,
    websocket: WebSocket,
    conversation_history: list,
    cancelled: asyncio.Event,
):
    """Stream LLM response and pipe sentences to TTS concurrently."""
    if transcript:
        print(f"User: {transcript}")

    if cancelled.is_set():
        return

    response = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=conversation_history,
        tools=TOOLS,
        stream=True,
    )

    # TTS worker with prefetch: allows next sentence to start fetching
    # while current sentence is still streaming
    sentence_queue: asyncio.Queue[str | None] = asyncio.Queue()

    async def tts_worker():
        while True:
            sentence = await sentence_queue.get()
            if sentence is None:
                break
            if cancelled.is_set():
                sentence_queue.task_done()
                break
            await stream_tts_to_ws(sentence, websocket, cancelled)
            sentence_queue.task_done()

    tts_task = asyncio.create_task(tts_worker())

    buffer = ""
    full_ai_response = ""

    tool_call_id = None
    tool_function_name = None
    tool_arguments = ""

    async for chunk in response:
        if cancelled.is_set():
            break

        delta = chunk.choices[0].delta

        if delta.tool_calls:
            tc = delta.tool_calls[0]
            if tc.id:
                tool_call_id = tc.id
            if tc.function.name:
                tool_function_name = tc.function.name
            if tc.function.arguments:
                tool_arguments += tc.function.arguments

        elif delta.content:
            text_chunk = delta.content
            full_ai_response += text_chunk
            buffer += text_chunk

            await websocket.send_json({"type": "text", "content": text_chunk})

            # Sentence boundary: split on .?! but not on common abbreviations
            if any(p in buffer for p in ['. ', '? ', '! ', '.\n', '?\n', '!\n']):
                last_idx = max(
                    buffer.rfind('. '),
                    buffer.rfind('? '),
                    buffer.rfind('! '),
                    buffer.rfind('.\n'),
                    buffer.rfind('?\n'),
                    buffer.rfind('!\n'),
                )
                if last_idx >= 0:
                    sentence = buffer[:last_idx + 1].strip()
                    buffer = buffer[last_idx + 1:]
                    if len(sentence) > 3:
                        sentence_queue.put_nowait(sentence)

    # Flush remaining buffer
    if buffer.strip() and len(buffer.strip()) > 3:
        sentence_queue.put_nowait(buffer.strip())

    if full_ai_response:
        print(f"AI: {full_ai_response}")
        conversation_history.append({"role": "assistant", "content": full_ai_response})

    # Signal TTS worker to finish
    sentence_queue.put_nowait(None)
    await tts_task

    if not cancelled.is_set():
        await websocket.send_json({"type": "audio_complete"})

    # Handle tool calls
    if tool_function_name == "close_connection":
        print("Tool Call: close_connection")
        await websocket.send_json({"type": "close"})
        return

    if tool_function_name == "predict_sales":
        print(f"Tool Call: {tool_function_name} with args {tool_arguments}")

        conversation_history.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": tool_call_id,
                "type": "function",
                "function": {
                    "name": tool_function_name,
                    "arguments": tool_arguments
                }
            }]
        })

        try:
            args = json.loads(tool_arguments)
            req_data = {
                "item_id": args.get("item_id"),
                "store_id": args.get("store_id"),
                "price": args.get("price", 0.0),
                "is_weekend": args.get("is_weekend", 0),
                "is_snap_day": args.get("is_snap_day", 0)
            }
            req_obj = PredictionRequest(**req_data)
            # Prefer LightGBM for voice (faster, handles intermittent zeros better)
            result = predict_sales_lgb(req_obj)
            if result.get("status") == "error":
                result = predict_sales(req_obj)

            conversation_history.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_function_name,
                "content": json.dumps(result)
            })
            print(f"Tool Result: {result}")
            await generate_llm_and_tts("", websocket, conversation_history, cancelled)

        except Exception as e:
            print(f"Tool Execution Error: {e}")
            conversation_history.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_function_name,
                "content": json.dumps({"error": str(e)})
            })
            await generate_llm_and_tts("", websocket, conversation_history, cancelled)


@router.websocket("/ws/voice")
async def voice_websocket(websocket: WebSocket):
    await websocket.accept()
    print("Client connected to Voice WebSocket")

    try:
        dg_connection = deepgram.listen.asyncwebsocket.v("1")

        conversation_history = [
            {
                "role": "system",
                "content": (
                    "You are Jade, a highly intelligent and proactive AI voice assistant for the M5 Forecasting Engine. "
                    "Keep answers brief (1-3 sentences) because they are spoken aloud. You have full memory of this conversation. "
                    "Always address the user as 'boss'. When you return a prediction, speak proactively like a real assistant "
                    "(e.g., 'Sure boss, I ran the numbers. The prediction for [item] at [store] is [X].'). "
                    "If the user asks for a prediction without specifying price/weekend/snap day, use default values automatically. "
                    "If the user says goodbye or asks to hang up, use the close_connection tool immediately. "
                    "You were built by Taasha Trinita."
                )
            }
        ]

        # Cancellation event — set when a new utterance arrives to interrupt current response
        current_cancel = asyncio.Event()
        current_task: asyncio.Task | None = None

        async def on_message(self, result, **kwargs):
            nonlocal current_cancel, current_task

            sentence = result.channel.alternatives[0].transcript
            if not sentence:
                return

            if result.is_final:
                conversation_history.append({"role": "user", "content": sentence})

                # Notify frontend of user's speech
                try:
                    await websocket.send_json({"type": "user_text", "content": sentence})
                except Exception:
                    return

                # Barge-in: cancel any in-flight LLM+TTS pipeline
                if current_task and not current_task.done():
                    current_cancel.set()
                    try:
                        await asyncio.wait_for(current_task, timeout=2.0)
                    except (asyncio.TimeoutError, Exception):
                        current_task.cancel()

                # Trim history: keep system prompt + last 20 messages
                while len(conversation_history) > 21:
                    conversation_history.pop(1)

                # Launch new pipeline
                current_cancel = asyncio.Event()

                async def run_pipeline(text, cancel_evt):
                    try:
                        await generate_llm_and_tts(text, websocket, conversation_history, cancel_evt)
                    except Exception as e:
                        print(f"LLM pipeline error: {e}")

                current_task = asyncio.create_task(run_pipeline(sentence, current_cancel))

        async def on_error(self, error, **kwargs):
            print(f"Deepgram Error: {error}")

        dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        dg_connection.on(LiveTranscriptionEvents.Error, on_error)

        options = LiveOptions(
            model="nova-2",
            language="en-US",
            smart_format=True,
            interim_results=False,
            encoding="linear16",
            sample_rate=16000,
            endpointing="750",
        )

        await dg_connection.start(options)

        try:
            while True:
                data = await websocket.receive_bytes()
                await dg_connection.send(data)

        except WebSocketDisconnect:
            print("Client disconnected from Voice WebSocket")
        finally:
            if current_task and not current_task.done():
                current_cancel.set()
                current_task.cancel()
            await dg_connection.finish()

    except Exception as e:
        print(f"Exception in voice route: {e}")
