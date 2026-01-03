import asyncio
import json
import time


async def process_session_data(session):
    greeting_sent = False

    while True:
        try:
            if not greeting_sent and session.websocket:
                await asyncio.sleep(2)
                greeting = await session.generate_conversational_response()
                if greeting:
                    await session.websocket.send_text(json.dumps({
                        "type": "question",
                        "question": greeting,
                        "speak": True
                    }))
                    greeting_sent = True

            if not session.processing_queue.empty():
                data = await session.processing_queue.get()

                if data['type'] == 'frame':
                    await session.add_frame_context(data['content'])
                elif data['type'] == 'audio':
                    await session.add_audio_context(data['content'])

                    if session.interview_stage in ["awaiting_name", "project_intro"]:
                        await asyncio.sleep(1)
                        response = await session.generate_conversational_response()
                        if response and session.websocket:
                            await session.websocket.send_text(json.dumps({
                                "type": "question",
                                "question": response,
                                "speak": True
                            }))

                    elif session.interview_stage == "presentation":
                        question = await session.generate_question()
                        if question and session.websocket:
                            await session.websocket.send_text(json.dumps({
                                "type": "question",
                                "question": question,
                                "speak": True
                            }))

                if len(session.questions_asked) > 0 and time.time() % 60 < 1:
                    await session.update_evaluation()

            if session.has_spoken_recently:
                time_since_speech = time.time() - session.last_speech_time
                if time_since_speech > 3:
                    session.has_spoken_recently = False

            await asyncio.sleep(0.1)

        except Exception as e:
            print(f"Session processing error: {e}")
            await asyncio.sleep(1)
