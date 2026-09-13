import os
import requests
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Токен твоего Telegram-бота
BOT_TOKEN = "8949478033:AAG7csA762eBS6QREe_gz0Q7vl_IOf5A_9Q"

class BookingData(BaseModel):
    branch: str
    surname: str
    name: str
    phone: str
    age: str
    chat_id: str

@app.get("/")
def read_root():
    return FileResponse("index.html")

# Эндпоинт, который проверяет фронтенд (HTML) при инициализации
@app.get("/api/data")
async def get_api_data():
    return {
        "status": "success",
        "club": "Academy Of Champions",
        "branches": [
            {"name": "Котлярова, 17", "coach": "Кардашян Самсон Врежикович"},
            {"name": "Зиповская, 42", "coach": "Расоян Рудик Романович"}
        ]
    }

@app.post("/send")
async def send_booking(data: BookingData):
    if not BOT_TOKEN or BOT_TOKEN == "ВАШ_ТОКЕН_БОТА_ЗДЕСЬ":
        raise HTTPException(status_code=500, detail="Токен бота не заполнен в коде")

    message_text = (
        f"📥 <b>Новая заявка на тренировку!</b>\n\n"
        f"📍 <b>Филиал:</b> {data.branch}\n"
        f"👤 <b>Фамилия и Имя:</b> {data.surname} {data.name}\n"
        f"📞 <b>Телефон:</b> {data.phone}\n"
        f"🎂 <b>Возраст:</b> {data.age}"
    )

    telegram_url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": data.chat_id,
        "text": message_text,
        "parse_mode": "HTML"
    }

    try:
        response = requests.post(telegram_url, json=payload, timeout=10)
        if response.status_code == 200:
            return {"status": "success", "message": "Заявка успешно отправлена"}
        else:
            raise HTTPException(status_code=500, detail=f"Telegram API Error: {response.text}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Подключаем раздачу статических файлов (картинки, стили и т.д., лежащие в корне проекта)
app.mount("/", StaticFiles(directory="."), name="static")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
