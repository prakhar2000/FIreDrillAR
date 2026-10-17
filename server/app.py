import atexit, json, os
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

from dots import Dots

load_dotenv()
KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
app = FastAPI()

dots = Dots()              # DataFeel driver, see dots.py
atexit.register(dots.off)

@app.get("/health")
def health():
    return {"ok": True, "assemblyai_key": bool(KEY), "dots": dots.status}

@app.get("/token")
async def token():
    if not KEY:
        raise HTTPException(500, "Set ASSEMBLYAI_API_KEY in server/.env")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get("https://streaming.assemblyai.com/v3/token",
                        params={"expires_in_seconds": 60}, headers={"Authorization": KEY})
    if r.status_code != 200:
        raise HTTPException(r.status_code, r.text)
    return r.json()          # {"token": "..."}

@app.websocket("/ws/heat")
async def heat(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            m = json.loads(await ws.receive_text())
            dots.update(m.get("left", 0), m.get("right", 0), m.get("buzz", False), m.get("cool", False))
    except WebSocketDisconnect:
        dots.update(0, 0, False, False)
