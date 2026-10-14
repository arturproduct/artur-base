#!/usr/bin/env python3
"""Artur product · публикация постов в Telegram через своего бота.

Берёт файлы posts/*.json, отправляет в канал те, что ещё не публиковались,
и записывает ссылки на готовые посты в posts/published.json.

Переменные окружения:
  BOT_TOKEN     токен бота (секрет)
  CHANNEL       основной канал: @username или id вида -100…
  TEST_CHANNEL  тестовый канал (необязательно)
  POST          id одного поста (имя файла без .json); пусто = все неопубликованные
  TO            куда слать, test или main; действует только вместе с POST
  FORCE         true = отправить, даже если этот пост в этот канал уже уходил
"""
import glob, json, mimetypes, os, sys, time, urllib.error, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, "posts")
PUB = os.path.join(POSTS, "published.json")
TOKEN = os.environ.get("BOT_TOKEN", "").strip()
CHANNELS = {"main": os.environ.get("CHANNEL", "").strip(), "test": os.environ.get("TEST_CHANNEL", "").strip()}
API = os.environ.get("TG_API", "https://api.telegram.org") + f"/bot{TOKEN}/"


def api(method, fields, files=None):
    boundary = uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        if v is None:
            continue
        if not isinstance(v, str):
            v = json.dumps(v, ensure_ascii=False)
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
    for k, (fn, data) in (files or {}).items():
        ctype = mimetypes.guess_type(fn)[0] or "application/octet-stream"
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{fn}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(API + method, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            res = json.load(e)
        except Exception:
            res = {"ok": False, "description": f"HTTP {e.code}"}
    if not res.get("ok"):
        raise SystemExit(f"Telegram ответил ошибкой: {res.get('description')}")
    return res["result"]


def keyboard(buttons):
    if not buttons:
        return None
    rows = buttons if isinstance(buttons[0], list) else [buttons]
    return {"inline_keyboard": [[{"text": b["text"], "url": b["url"]} for b in row] for row in rows]}


def post_url(result, chat):
    mid = result["message_id"]
    username = (result.get("chat") or {}).get("username")
    if username:
        return f"https://t.me/{username}/{mid}"
    cid = str((result.get("chat") or {}).get("id") or chat)
    return f"https://t.me/c/{cid[4:]}/{mid}" if cid.startswith("-100") else ""


def send(post, target):
    chat = CHANNELS.get(target, "")
    if not chat:
        print(f"  пропуск: не задан канал для «{target}» (переменная {'CHANNEL' if target == 'main' else 'TEST_CHANNEL'})")
        return None
    media = post.get("media", "")
    path = os.path.join(ROOT, media)
    if not media or not os.path.exists(path):
        raise SystemExit(f"  нет файла медиа: {media}")
    ext = os.path.splitext(media)[1].lower()
    kind = post.get("kind") or ("photo" if ext in (".png", ".jpg", ".jpeg", ".webp") else "animation")
    method, field = {"photo": ("sendPhoto", "photo"), "video": ("sendVideo", "video"), "animation": ("sendAnimation", "animation")}[kind]
    fields = {
        "chat_id": chat,
        "caption": post.get("caption", ""),
        "parse_mode": post.get("parse_mode", "Markdown"),
        "reply_markup": keyboard(post.get("buttons")),
        "disable_notification": post.get("silent", False),
    }
    if kind in ("video", "animation"):
        fields["supports_streaming"] = True
    with open(path, "rb") as f:
        data = f.read()
    result = api(method, fields, {field: (os.path.basename(media), data)})
    return {"message_id": result["message_id"], "url": post_url(result, chat), "chat": chat,
            "date": time.strftime("%Y-%m-%d %H:%M", time.gmtime(result.get("date", time.time())))}


def main():
    if not TOKEN:
        raise SystemExit("Не задан BOT_TOKEN")
    only = os.environ.get("POST", "").strip()
    to = os.environ.get("TO", "").strip()
    force = os.environ.get("FORCE", "").strip().lower() in ("1", "true", "yes")
    published = {}
    if os.path.exists(PUB):
        with open(PUB, encoding="utf-8") as f:
            published = json.load(f)
    files = sorted(p for p in glob.glob(os.path.join(POSTS, "*.json")) if os.path.basename(p) != "published.json")
    done = 0
    for p in files:
        pid = os.path.splitext(os.path.basename(p))[0]
        if only and pid != only:
            continue
        with open(p, encoding="utf-8") as f:
            post = json.load(f)
        target = (to if only and to else post.get("to", "test")).lower()
        key = f"{pid}:{target}"
        if key in published and not force:
            continue
        print(f"{pid} → {target}")
        res = send(post, target)
        if not res:
            continue
        published[key] = {"id": pid, "to": target, **res}
        with open(PUB, "w", encoding="utf-8") as f:
            json.dump(published, f, ensure_ascii=False, indent=2)
        print(f"  готово: {res['url'] or res['message_id']}")
        done += 1
    if not os.path.exists(PUB):
        with open(PUB, "w", encoding="utf-8") as f:
            json.dump(published, f, ensure_ascii=False, indent=2)
    print(f"Отправлено постов: {done}" if done else "Новых постов для отправки нет")


if __name__ == "__main__":
    main()
