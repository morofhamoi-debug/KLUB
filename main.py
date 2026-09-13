import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

# Токен вашего бота (лучше через переменные окружения в Railway, но для примера можно так)
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "ВАШ_ТОКЕН_БОТА")

# ID чатов для разных филиалов
CHAT_ID_ZIPOVSTSKAYA = os.getenv("CHAT_ID_ZIPOVSTSKAYA", "ID_ЧАТА_ЗИПОВСКАЯ")
CHAT_ID_KOTLYAROVA = os.getenv("CHAT_ID_KOTLYAROVA", "ID_ЧАТА_КОТЛЯРОВА")

@app.route('/api/send-lead', methods=['POST'])
def send_lead():
    try:
        data = request.get_json()
        branch = data.get('branch')
        surname = data.get('surname')
        name = data.get('name')
        phone = data.get('phone')
        age = data.get('age')

        # Выбираем ID чата в зависимости от выбранного филиала
        if branch == "Зиповская, 42":
            target_chat_id = CHAT_ID_ZIPOVSTSKAYA
        elif branch == "Котлярова, 17":
            target_chat_id = CHAT_ID_KOTLYAROVA
        else:
            # Если филиал не выбран или другой, отправляем на Зиповскую (или куда укажете)
            target_chat_id = CHAT_ID_ZIPOVSTSKAYA

        # Формируем текст сообщения
        message = (
            f"🔥 Новая заявка с сайта!\n\n"
            f"📍 Филиал: {branch}\n"
            f"👤 Фамилия: {surname}\n"
            f"📛 Имя: {name}\n"
            f"📞 Телефон: {phone}\n"
            f"🎂 Возраст: {age}"
        )

        # Отправка в Telegram
        telegram_url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": target_chat_id,
            "text": message,
            "parse_mode": "HTML"
        }

        response = requests.post(telegram_url, json=payload)

        if response.status_code == 200:
            return jsonify({"success": True}), 200
        else:
            return jsonify({"success": False, "error": "Telegram API error"}), 500

    except Exception as e:
        print(e)
        return jsonify({"success": False, "error": "Server error"}), 500

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
