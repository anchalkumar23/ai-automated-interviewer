import base64
import os
import time
from io import BytesIO
from typing import Dict, List, Optional
import asyncio
from collections import deque
import tempfile

import cv2
import numpy as np
import pytesseract
from PIL import Image
from fastapi import WebSocket

from config import client


class InterviewSession:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.websocket: Optional[WebSocket] = None
        self.context = ""
        self.transcript = ""
        self.questions_asked: List[str] = []
        self.qa_pairs: List[Dict] = []
        self.last_question_time = 0
        self.last_speech_time = 0
        self.evaluation_scores = {
            "technical_depth": 0,
            "clarity": 0,
            "originality": 0,
            "understanding": 0,
            "overall": 0
        }
        self.processing_queue = asyncio.Queue()
        self.recent_ocr_texts = deque(maxlen=5)
        self.waiting_for_answer = False
        self.current_question = None
        self.interview_stage = "greeting"
        self.student_name = ""
        self.project_name = ""
        self.silence_start = None
        self.has_spoken_recently = False
        self.last_response_time = 0

    def _similarity(self, text1: str, text2: str) -> float:
        words1 = set(text1.lower().split())
        words2 = set(text2.lower().split())
        if not words1 or not words2:
            return 0.0
        intersection = len(words1 & words2)
        union = len(words1 | words2)
        return intersection / union if union > 0 else 0.0

    async def add_frame_context(self, frame_data: str):
        try:
            image_data = base64.b64decode(frame_data.split(',')[1])
            image = Image.open(BytesIO(image_data))

            cv_image = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
            gray = cv2.cvtColor(cv_image, cv2.COLOR_BGR2GRAY)
            processed = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

            extracted_text = pytesseract.image_to_string(processed, config='--psm 6')

            if extracted_text.strip():
                is_duplicate = any(
                    self._similarity(extracted_text, old_text) > 0.8
                    for old_text in self.recent_ocr_texts
                )

                if not is_duplicate:
                    self.context += f"\n[SCREEN]: {extracted_text.strip()}"
                    self.recent_ocr_texts.append(extracted_text)
                    if len(self.context) > 5000:
                        self.context = self.context[-3000:]

        except Exception as e:
            print(f"OCR error: {e}")

    async def add_audio_context(self, audio_data: str):
        try:
            audio_bytes = base64.b64decode(audio_data.split(',')[1])

            if len(audio_bytes) < 1000:
                return

            temp_dir = tempfile.gettempdir()
            temp_wav = os.path.join(temp_dir, f"audio_{self.session_id}_{int(time.time())}.wav")

            with open(temp_wav, 'wb') as f:
                f.write(audio_bytes)

            with open(temp_wav, 'rb') as audio_file:
                transcript = await client.audio.transcriptions.create(
                    model="whisper-1",
                    file=audio_file
                )

            os.remove(temp_wav)

            if transcript.text.strip():
                self.transcript += f" {transcript.text.strip()}"
                self.last_speech_time = time.time()
                self.has_spoken_recently = True
                self.silence_start = None

                if self.interview_stage == "awaiting_name":
                    lower_text = transcript.text.lower()
                    words = transcript.text.split()
                    for i, word in enumerate(words):
                        if word.lower() in ["i'm", "im", "name", "called"]:
                            if i + 1 < len(words):
                                self.student_name = words[i + 1].strip(".,!?")
                                break
                    if not self.student_name and len(words) > 0:
                        self.student_name = words[0].strip(".,!?")

                elif self.interview_stage == "project_intro":
                    lower_text = transcript.text.lower()
                    if "project" in lower_text or "built" in lower_text or "created" in lower_text:
                        words = transcript.text.split()
                        for i, word in enumerate(words):
                            if word.lower() in ["project", "called", "named"]:
                                if i + 1 < len(words):
                                    self.project_name = " ".join(words[i+1:i+4]).strip(".,!?")
                                    break

                if self.waiting_for_answer:
                    self.qa_pairs.append({
                        'question': self.current_question,
                        'answer': transcript.text.strip(),
                        'timestamp': time.time()
                    })
                    self.waiting_for_answer = False

                if len(self.transcript) > 3000:
                    self.transcript = self.transcript[-2000:]

        except Exception as e:
            print(f"STT error: {e}")

    async def should_ask_question(self) -> bool:
        current_time = time.time()

        if self.interview_stage in ["greeting", "awaiting_name", "project_intro"]:
            return False

        if self.waiting_for_answer:
            return False

        if current_time - self.last_question_time < 5:
            return False

        if len(self.questions_asked) >= 5:
            return False

        if self.has_spoken_recently:
            if self.silence_start is None:
                self.silence_start = current_time

            time_since_last_speech = current_time - self.last_speech_time
            if time_since_last_speech < 5:
                return False

        total_content = len(self.context + self.transcript)
        return total_content > 200

    async def generate_conversational_response(self) -> Optional[str]:
        try:
            current_time = time.time()

            if current_time - self.last_response_time < 15:
                return None

            if self.interview_stage == "greeting":
                self.interview_stage = "awaiting_name"
                self.last_response_time = current_time
                return "Hello! Welcome to your project presentation interview. I'm your AI interviewer today. Before we begin, could you please tell me your name?"

            elif self.interview_stage == "awaiting_name":
                if self.student_name:
                    self.interview_stage = "project_intro"
                    self.last_response_time = current_time
                    return f"Nice to meet you, {self.student_name}! I'm excited to learn about your project. Could you start by telling me what you've built and what problem it solves?"
                elif current_time - self.last_response_time > 5:
                    self.last_response_time = current_time
                    return "I didn't quite catch your name. Could you please tell me your name again?"
                return None

            elif self.interview_stage == "project_intro":
                if len(self.transcript) > 50:
                    self.interview_stage = "presentation"
                    self.last_response_time = current_time
                    name_part = f"{self.student_name}, " if self.student_name else ""
                    return f"Thank you {name_part}for that introduction! Please go ahead and share your screen to walk me through your project. I'll be listening carefully and will ask questions when you pause."
                elif current_time - self.last_response_time > 5:
                    self.last_response_time = current_time
                    return "Could you tell me a bit more about your project? What does it do?"
                return None

            return None

        except Exception as e:
            print(f"Conversational response error: {e}")
            return None

    async def generate_question(self) -> Optional[str]:
        if not await self.should_ask_question():
            return None

        try:
            name_part = f"{self.student_name}, " if self.student_name else ""

            prompt = f"""You are conducting a conversational project interview with a student. Be friendly and encouraging.

Student Name: {self.student_name or "the student"}
Screen Content: {self.context[-1000:]}
What They Said: {self.transcript[-1000:]}
Previous Questions: {', '.join(self.questions_asked)}

Generate ONE friendly, conversational question that:
1. Starts with a natural conversational phrase like "I'm curious about...", "That's interesting...", "Could you explain..."
2. Tests their technical understanding
3. Is relevant to what they just showed or said
4. Encourages them to elaborate
5. Hasn't been asked before

Keep it natural and conversational, not formal.

Question:"""

            response = await client.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=150,
                temperature=0.7
            )

            question = response.choices[0].message.content.strip()

            if question:
                self.questions_asked.append(question)
                self.current_question = question
                self.waiting_for_answer = True
                self.last_question_time = time.time()
                return question

        except Exception as e:
            print(f"Question generation error: {e}")

        return None

    async def update_evaluation(self):
        try:
            prompt = f"""Evaluate this student's project presentation on a scale of 1-10 for each category:

Content: {self.context[-1500:]}
Speech: {self.transcript[-1500:]}
Questions Asked: {len(self.questions_asked)}

Provide scores (1-10) for:
1. Technical Depth - Understanding of technical concepts and implementation
2. Clarity - Clear communication and explanation
3. Originality - Creativity and innovation in the solution
4. Understanding - Depth of knowledge about their own project

Return JSON format:
{{"technical_depth": X, "clarity": X, "originality": X, "understanding": X, "overall": X}}

Only return the JSON, no other text."""

            response = await client.chat.completions.create(
                model="gpt-4",
                messages=[{"role": "user", "content": prompt}],
                max_tokens=100,
                temperature=0.3
            )

            scores_text = response.choices[0].message.content.strip()
            import json
            scores = json.loads(scores_text)

            self.evaluation_scores.update(scores)

            if self.websocket:
                await self.websocket.send_text(json.dumps({
                    "type": "evaluation",
                    "scores": self.evaluation_scores
                }))

        except Exception as e:
            print(f"Evaluation error: {e}")
