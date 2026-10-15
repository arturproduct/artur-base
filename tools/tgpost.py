#!/usr/bin/env python3
"""Artur product · публикация постов в Telegram через своего бота.

Берёт файлы posts/*.json, отправляет в канал те, что ещё не публиковались,
и записывает ссылки на готовые посты в posts/published.json.

Комментарии. Под постом с кнопками Telegram не показывает свою кнопку комментариев,
поэтому после публикации в основной канал бот добавляет первой строкой кнопку
«Открыть комментарии» — как Add Native Comments в ControllerBot. Ссылка ведёт в тред
поста в чате обсуждения. Чтобы бот нашёл этот тред, он должен быть админом
в чате обсуждения канала. Номер треда можно задать и вручную: "comments_thread" в posts/<id>.json.

Переменные окружения:
  BOT_TOKEN     токен бота (секрет)
  CHANNEL       основной канал: @username или id вида -100…
  TEST_CHANNEL  тестовый канал или личка для превью (необязательно)
  POST          id одного поста (имя файла без .json); пусто = все неопубликованные
  TO            куда слать, test или main; действует только вместе с POST
  FORCE         true = отправить, даже если этот пост в этот канал уже уходил

Повторный запуск с POST=<id> и TO=main (без FORCE) пост заново не отправляет, а чинит уже вышедший:
  • добавляет кнопку комментариев, если её нет;
  • заменяет ролик или картинку, если в posts/<id>.json "media_version" больше, чем у вышедшего поста
    (номер поста, просмотры, реакции и комментарии сохраняются, текст и кнопки остаются те же).
"""
import glob, json, mimetypes, os, sys, time, urllib.error, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POSTS = os.path.join(ROOT, "posts")
PUB = os.path.join(POSTS, "published.json")
TOKEN = os.environ.get("BOT_TOKEN", "").strip()
CHANNELS = {"main": os.environ.get("CHANNEL", "").strip(), "test": os.environ.get("TEST_CHANNEL", "").strip()}
API = os.environ.get("TG_API", "https://api.telegram.org") + f"/bot{TOKEN}/"
COMMENTS_TEXT = "Открыть комментарии"
WAIT_FORWARD = int(os.environ.get("WAIT_FORWARD", "45"))  # сколько секунд ждать копию поста в чате обсуждения


class TgError(Exception):
    pass


def api(method, fields, files=None, fatal=True):
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
        if fatal:
            raise SystemExit(f"Telegram ответил ошибкой ({method}): {res.get('description')}")
        raise TgError(res.get("description") or "ошибка")
    return res["result"]


def rows(buttons):
    if not buttons:
        return []
    rs = buttons if isinstance(buttons[0], list) else [buttons]
    return [[{"text": b["text"], "url": b["url"]} for b in row] for row in rs]


def keyboard(buttons):
    rs = rows(buttons)
    return {"inline_keyboard": rs} if rs else None


def post_url(result, chat):
    mid = result["message_id"]
    c = result.get("chat") or {}
    if c.get("username"):
        return f"https://t.me/{c['username']}/{mid}"
    cid = str(c.get("id") or chat)
    return f"https://t.me/c/{cid[4:]}/{mid}" if cid.startswith("-100") else ""


def media_file(post):
    media = post.get("media", "")
    path = os.path.join(ROOT, media)
    if not media or not os.path.exists(path):
        raise SystemExit(f"  нет файла медиа: {media}")
    ext = os.path.splitext(media)[1].lower()
    kind = post.get("kind") or ("photo" if ext in (".png", ".jpg", ".jpeg", ".webp") else "animation")
    return path, kind, media


def send(post, target):
    chat = CHANNELS.get(target, "")
    if not chat:
        print(f"  пропуск: не задан канал для «{target}» (переменная {'CHANNEL' if target == 'main' else 'TEST_CHANNEL'})")
        return None
    path, kind, media = media_file(post)
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
    rec = {"message_id": result["message_id"], "url": post_url(result, chat), "chat": chat,
           "date": time.strftime("%Y-%m-%d %H:%M", time.gmtime(result.get("date", time.time()))),
           "media_version": int(post.get("media_version", 1))}
    if not rec["url"]:
        rec.pop("url")  # превью в личку: ссылки на сообщение нет
    return rec


# ---------- комментарии ----------

def find_thread(channel_id, post_id, group_id, wait):
    """Ищет копию поста, которую Telegram сам переслал в чат обсуждения, и возвращает её номер."""
    deadline = time.time() + wait
    offset = None
    found = None
    while time.time() < deadline and not found:
        fields = {"timeout": 5, "allowed_updates": ["message"]}
        if offset:
            fields["offset"] = offset
        try:
            updates = api("getUpdates", fields, fatal=False)
        except TgError as e:
            print(f"  комментарии: бот не может читать обновления ({e}). Номер треда можно задать вручную: \"comments_thread\" в файле поста")
            return None
        for u in updates:
            offset = u["update_id"] + 1
            m = u.get("message") or {}
            if (m.get("chat") or {}).get("id") != group_id or not m.get("is_automatic_forward"):
                continue
            fo = m.get("forward_origin") or {}
            src_chat = (fo.get("chat") or m.get("forward_from_chat") or {}).get("id")
            src_id = fo.get("message_id") or m.get("forward_from_message_id")
            if src_chat == channel_id and src_id == post_id:
                found = m["message_id"]
    if offset:
        try:
            api("getUpdates", {"offset": offset, "timeout": 0}, fatal=False)  # отметить прочитанными
        except TgError:
            pass
    return found


def add_comments(post, rec, thread=None):
    """Добавляет к посту в канале первой строкой кнопку «Открыть комментарии».
    thread — номер треда, заданный вручную (только для починки уже вышедшего поста)."""
    if post.get("comments") is False:
        return False
    try:
        channel = api("getChat", {"chat_id": rec["chat"]}, fatal=False)
        group_id = channel.get("linked_chat_id")
        if not group_id:
            print("  комментарии: у канала нет чата обсуждения, кнопку не добавляю")
            return False
        group = api("getChat", {"chat_id": group_id}, fatal=False)
    except TgError as e:
        print(f"  комментарии: не удалось получить данные канала ({e})")
        return False
    thread = thread or find_thread(channel["id"], rec["message_id"], group_id, WAIT_FORWARD)
    if not thread:
        print("  комментарии: бот не увидел пост в чате обсуждения. Добавьте @ArturProductBot админом в чат обсуждения канала "
              "и запустите ещё раз с этим постом и to: main — пост не продублируется, добавится только кнопка")
        return False
    gid = str(group_id)
    if group.get("username"):
        url = f"https://t.me/{group['username']}/{thread}?thread={thread}"
    else:
        url = f"https://t.me/c/{gid[4:] if gid.startswith('-100') else gid.lstrip('-')}/1000000?thread={thread}"
    markup = {"inline_keyboard": [[{"text": COMMENTS_TEXT, "url": url}]] + rows(post.get("buttons"))}
    try:
        api("editMessageReplyMarkup", {"chat_id": rec["chat"], "message_id": rec["message_id"], "reply_markup": markup}, fatal=False)
    except TgError as e:
        print(f"  комментарии: не удалось добавить кнопку ({e})")
        return False
    rec["comments_url"] = url
    print(f"  комментарии: кнопка добавлена → {url}")
    return True


# ---------- замена медиа в уже вышедшем посте ----------

def replace_media(post, rec):
    """Меняет ролик или картинку в опубликованном посте, не удаляя его. Текст и кнопки передаются заново,
    иначе Telegram их сотрёт; кнопка комментариев сохраняется."""
    path, kind, media = media_file(post)
    im = {"type": kind, "media": "attach://file", "caption": post.get("caption", ""), "parse_mode": post.get("parse_mode", "Markdown")}
    if kind == "video":
        im["supports_streaming"] = True
    rs = rows(post.get("buttons"))
    if rec.get("comments_url"):
        rs = [[{"text": COMMENTS_TEXT, "url": rec["comments_url"]}]] + rs
    fields = {"chat_id": rec["chat"], "message_id": rec["message_id"], "media": im,
              "reply_markup": {"inline_keyboard": rs} if rs else None}
    with open(path, "rb") as f:
        data = f.read()
    try:
        api("editMessageMedia", fields, {"file": (os.path.basename(media), data)}, fatal=False)
    except TgError as e:
        if "not modified" not in str(e):
            print(f"  медиа: не удалось заменить ({e})")
            return False
        print("  медиа: в посте уже этот файл")
    rec["media_version"] = int(post.get("media_version", 1))
    rec["media_updated"] = time.strftime("%Y-%m-%d %H:%M", time.gmtime())
    print(f"  медиа: заменено на {media} (версия {rec['media_version']})")
    return True


def save(published):
    with open(PUB, "w", encoding="utf-8") as f:
        json.dump(published, f, ensure_ascii=False, indent=2)


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
            rec = published[key]
            if not only:
                continue
            changed = False
            where = rec.get("url", rec["message_id"])
            # новый ролик или картинка: заменить в вышедшем посте, не отправляя заново
            if int(post.get("media_version", 1)) > int(rec.get("media_version", 1)):
                print(f"{pid} → {target}: уже опубликован ({where}), заменяю медиа")
                changed |= replace_media(post, rec)
            # пост в канале без кнопки комментариев: добавить кнопку
            if target == "main" and not rec.get("comments_url") and post.get("comments") is not False:
                print(f"{pid} → {target}: уже опубликован ({where}), добавляю кнопку комментариев")
                changed |= add_comments(post, rec, post.get("comments_thread"))
            if changed:
                save(published)
            else:
                print(f"{pid} → {target}: уже опубликован ({where}), менять нечего")
            continue
        print(f"{pid} → {target}")
        res = send(post, target)
        if not res:
            continue
        published[key] = {"id": pid, "to": target, **res}
        save(published)
        print(f"  готово: {res.get('url') or res['message_id']}")
        if target == "main" and add_comments(post, published[key]):
            save(published)
        done += 1
    if not os.path.exists(PUB):
        save(published)
    print(f"Отправлено постов: {done}" if done else "Новых постов для отправки нет")


if __name__ == "__main__":
    main()
