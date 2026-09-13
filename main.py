import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests

app = FastAPI()

# Включаем CORS, чтобы сайт мог отправлять запросы на сервер
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Разрешить запросы с любых сайтов (или укажите ваш домен)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

BRANCH_CHAT_IDS = {
    "Котлярова, 17": os.getenv("CHAT_ID_KOTLYAROVA"),
    "Зиповская, 42": os.getenv("CHAT_ID_ZIPOVSKAYA"),
}


class Lead(BaseModel):
  branch: str
  surname: str
  name: str
  phone: str
  age: str


@app.post("/api/send-lead")
def receive_lead(lead: Lead):
  chat_id = BRANCH_CHAT_IDS.get(lead.branch)

  if not chat_id or not TOKEN:
    raise HTTPException(status_code=400, detail="Ошибка конфигурации сервера")

  message = (
      f"🎯 <b>Новая заявка!</b>\n\n"
      f"📍 <b>Филиал:</b> {lead.branch}\n"
      f"👤 <b>ФИО:</b> {lead.surname} {lead.name}\n"
      f"📞 <b>Телефон:</b> {lead.phone}\n"
      f"🎂 <b>Возраст:</b> {lead.age}"
  )

  url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
  payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}

  response = requests.post(url, json=payload)

  if response.status_code != 200:
    raise HTTPException(status_code=500, detail="Ошибка отправки в Telegram")

  return {"status": "success"}
