from config import app
from routes import websocket_endpoint, generate_report, health_check

app.websocket("/ws")(websocket_endpoint)
app.get("/report/{session_id}")(generate_report)
app.get("/health")(health_check)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
