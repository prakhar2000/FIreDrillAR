import json, os
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

load_dotenv()
KEY = os.getenv("ASSEMBLYAI_API_KEY", "")
app = FastAPI()

MAX_HEAT_C = 40      # replace with Jiyi's safe number
NEUTRAL_C = 33       # roughly skin temperature
COOL_C = 20

def drive_dots(left, right, buzz, cool):
    """Translate the app's message into Dot commands. Replace the print with DataFeel SDK calls."""
    t_left = NEUTRAL_C + left * (MAX_HEAT_C - NEUTRAL_C)
    t_right = NEUTRAL_C + right * (MAX_HEAT_C - NEUTRAL_C)
    if cool:
        t_left = t_right = COOL_C
    print(f"L {t_left:.1f}C  R {t_right:.1f}C  buzz={buzz}  cool={cool}")
    # TODO (Devaj): set Dot temperatures, vibrate when buzz, LEDs red scaled by max(left, right)

@app.get("/health")
def health():
    return {"ok": True, "assemblyai_key": bool(KEY)}

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
            drive_dots(m.get("left", 0), m.get("right", 0), m.get("buzz", False), m.get("cool", False))
    except WebSocketDisconnect:
        drive_dots(0, 0, False, False)
