import os
from fastapi import FastAPI
from openai import AsyncOpenAI
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="AI Interviewer Backend")

client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

active_sessions = {}
