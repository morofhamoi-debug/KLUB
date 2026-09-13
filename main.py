import os
from flask import Flask, request, jsonify
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

# Ваши реальные данные
TELEGRAM_BOT_TOKEN = "8949478033:AAG7csA762eBS6QREe_gz0Q7vl_IOf5A_9Q"
CHAT_ID_ZIPOVSTSKAYA = "5208615220"
CHAT_ID_KOTLYAROVA = "7800810111"

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
