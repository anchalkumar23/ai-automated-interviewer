import asyncio
import json
import uuid

from fastapi import WebSocket, WebSocketDisconnect

from config import active_sessions
from models import InterviewSession
from services import process_session_data


async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    session_id = str(uuid.uuid4())
    session = InterviewSession(session_id)
    session.websocket = websocket
    active_sessions[session_id] = session

    processor_task = asyncio.create_task(process_session_data(session))

    try:
        await websocket.send_text(json.dumps({
            "type": "session_id",
            "session_id": session_id
        }))

        while True:
            data = await websocket.receive_text()
            message = json.loads(data)

            await session.processing_queue.put({
                'type': message['type'],
                'content': message['data']
            })

    except WebSocketDisconnect:
        print(f"Client disconnected: {session_id}")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        processor_task.cancel()
        if session_id in active_sessions:
            del active_sessions[session_id]
