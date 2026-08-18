import os
import json
import asyncio
import httpx
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents
from openai import AsyncOpenAI
from dotenv import load_dotenv
from routes.predict_routes import predict_sales, PredictionRequest

load_dotenv()

router = APIRouter()

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")

openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)
deepgram = DeepgramClient(DEEPGRAM_API_KEY)

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


async def generate_llm_and_tts(transcript: str, websocket: WebSocket, conversation_history: list):
    if transcript:
        print(f"User: {transcript}")
    
    # 1. Ask OpenAI
    response = await openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=conversation_history,
        tools=TOOLS,
        stream=True
    )

    # 2. Setup audio queue and background worker for parallel TTS
    sentence_queue = asyncio.Queue()
    
    async def tts_worker():
        url = "https://api.deepgram.com/v1/speak?model=aura-hera-en"
        headers = {
            "Authorization": f"Token {DEEPGRAM_API_KEY}",
            "Content-Type": "application/json"
        }
        async with httpx.AsyncClient() as client:
            while True:
                sentence = await sentence_queue.get()
                if sentence is None:
                    break
                
                try:
                    r = await client.post(url, headers=headers, json={"text": sentence}, timeout=10.0)
                    if r.status_code == 200:
                        await websocket.send_bytes(r.content)
                    else:
                        print(f"❌ Deepgram TTS Error: {r.status_code} {r.text}")
                except Exception as e:
                    print(f"❌ Deepgram TTS Network Error: {e}")
                
                sentence_queue.task_done()
                
    tts_task = asyncio.create_task(tts_worker())

    buffer = ""
    full_ai_response = ""
    
    # Variables for tool calling
    tool_call_id = None
    tool_function_name = None
    tool_arguments = ""
    
    async for chunk in response:
        delta = chunk.choices[0].delta
        
        if delta.tool_calls:
            tc = delta.tool_calls[0]
            if tc.id:
                tool_call_id = tc.id
            if tc.function.name:
                tool_function_name = tc.function.name
            if tc.function.arguments:
                tool_arguments += tc.function.arguments
                
        # Handle Normal Text
        elif delta.content:
            text_chunk = delta.content
            full_ai_response += text_chunk
            buffer += text_chunk
            
            # Send text chunks so the frontend UI can update instantly
            await websocket.send_json({"type": "text", "content": text_chunk})
            
            # Sentence Boundary Detection
            if any(punct in buffer for punct in ['.', '?', '!']):
                # Find the last punctuation index
                last_punct_idx = max(buffer.rfind('.'), buffer.rfind('?'), buffer.rfind('!'))
                
                # Split at the punctuation
                sentence = buffer[:last_punct_idx+1].strip()
                buffer = buffer[last_punct_idx+1:]
                
                if len(sentence) > 2: # Ignore stray whitespace/punctuation
                    sentence_queue.put_nowait(sentence)

    # Flush remaining buffer if there's no ending punctuation
    if buffer.strip() and len(buffer.strip()) > 2:
        sentence_queue.put_nowait(buffer.strip())
        
    if full_ai_response:
        print(f"🤖 AI: {full_ai_response}")
        # Save AI response to memory
        conversation_history.append({"role": "assistant", "content": full_ai_response})
    
    # 4. Wait for all sentences to be processed and sent
    sentence_queue.put_nowait(None)
    await tts_task
                    
    # Tell frontend the audio stream for this sentence is complete
    await websocket.send_json({"type": "audio_complete"})

    # 5. Execute Tool Call if requested
    if tool_function_name == "close_connection":
        print("🔧 Tool Call: close_connection")
        # Tell the frontend to disconnect gracefully
        await websocket.send_json({"type": "close"})
        return

    if tool_function_name == "predict_sales":
        print(f"🔧 Tool Call: {tool_function_name} with args {tool_arguments}")
        
        # Add the tool call to history so OpenAI knows it happened
        conversation_history.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": tool_function_name,
                        "arguments": tool_arguments
                    }
                }
            ]
        })
        
        try:
            args = json.loads(tool_arguments)
            
            # Fill in defaults if not provided
            req_data = {
                "item_id": args.get("item_id"),
                "store_id": args.get("store_id"),
                "price": args.get("price", 0.0),
                "is_weekend": args.get("is_weekend", 0),
                "is_snap_day": args.get("is_snap_day", 0)
            }
            
            # Run local prediction
            result = predict_sales(PredictionRequest(**req_data))
            
            # Append result to history
            conversation_history.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_function_name,
                "content": json.dumps(result)
            })
            
            print(f"✅ Tool Result: {result}")
            
            # Recursively call LLM to synthesize the tool result into speech
            await generate_llm_and_tts("", websocket, conversation_history)
            
        except Exception as e:
            print(f"❌ Tool Execution Error: {e}")
            # Tell LLM the tool failed
            conversation_history.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "name": tool_function_name,
                "content": json.dumps({"error": str(e)})
            })
            await generate_llm_and_tts("", websocket, conversation_history)

@router.websocket("/ws/voice")
async def voice_websocket(websocket: WebSocket):
    await websocket.accept()
    print("✅ Client connected to Voice WebSocket")
    
    try:
        # Create Deepgram live transcription connection
        dg_connection = deepgram.listen.asyncwebsocket.v("1")
        
        # Session Memory for the duration of the WebSocket connection
        conversation_context = {
            "history": [
                {
                    "role": "system", 
                    "content": "You are Jade, a highly intelligent and proactive AI voice assistant for the M5 Forecasting Engine. Keep answers brief (1-3 sentences) because they are spoken aloud. You have full memory of this conversation. Always address the user as 'boss'. When you return a prediction, speak proactively and autonomously like a real assistant (e.g., 'Sure boss, I ran the numbers myself. The prediction for [item] at [store] is [X]. Let me know if you need anything else, boss.'). If the user asks for a prediction without specifying price/weekend/snap day, just use the tool's default values automatically without asking. If the user asks you to close the connection, hang up, or says goodbye, use the close_connection tool immediately. You were built by Taasha Trinita."
                }
            ]
        }
        
        # Define what happens when Deepgram transcribes a word
        async def on_message(self, result, **kwargs):
            sentence = result.channel.alternatives[0].transcript
            if len(sentence) == 0:
                return
            
            # If the user finished their sentence, trigger the LLM!
            if result.is_final:
                # Add to memory
                conversation_context["history"].append({"role": "user", "content": sentence})
                
                # Send user transcript to frontend so they know they were heard
                asyncio.create_task(websocket.send_json({"type": "user_text", "content": sentence}))
                
                # Prevent memory from growing indefinitely (keep system prompt + last 20 messages)
                if len(conversation_context["history"]) > 21:
                    conversation_context["history"].pop(1)

                # Fire and forget: run the LLM+TTS pipeline asynchronously without blocking the incoming audio
                asyncio.create_task(generate_llm_and_tts(sentence, websocket, conversation_context["history"]))
                
        async def on_error(self, error, **kwargs):
            print(f"❌ Deepgram Error: {error}")
            
        dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        dg_connection.on(LiveTranscriptionEvents.Error, on_error)
        
        # Deepgram options required for raw PCM audio stream
        options = LiveOptions(
            model="nova-2",
            language="en-US",
            smart_format=True,
            interim_results=False,
            endpointing="1500" # Wait 1.5 seconds of silence before finalizing
        )
        
        await dg_connection.start(options)
        
        try:
            # Continuous loop to receive audio from React
            while True:
                data = await websocket.receive_bytes()
                # Instantly forward the raw audio to Deepgram STT
                await dg_connection.send(data)
                
        except WebSocketDisconnect:
            print("❌ Client disconnected from Voice WebSocket")
        finally:
            await dg_connection.finish()
            
    except Exception as e:
        print(f"❌ Exception in voice route: {e}")
