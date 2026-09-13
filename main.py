import os
import requests
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI()

# Разрешаем CORS-запросы со всех доменов (или укажите ваш сайт/GitHub Pages)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Токен бота берется из переменных окружения Railway (TELEGRAM_BOT_TOKEN)
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

class BookingData(BaseModel):
    branch: str
    surname: str
    name: str
    phone: str
    age: str
    chat_id: str

@app.post("/send")
async def send_booking(data: BookingData):
    if not BOT_TOKEN:
        raise HTTPException(status_code=500, detail="Bot token is not configured on server")

    # Формируем красивое сообщение для тренера/администратора
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
