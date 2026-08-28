# تلفنخانه — اتصال یک سیستم VoIP واقعی | Telephone Exchange — Real VoIP Integration

> برای هر کاربری از این کیت. **این سند مستقل از سیستم VoIP خاصی نوشته شده** —
> چه Asterisk/FreePBX داشته باشی، چه ۳CX، چه هر PBX دیگری، تنها کاری که لازم
> است این است که یک اکستنشن (داخلی) بسازی که پیام صوتی ضبط‌شده را از طریق یک
> API کوچک HTTP در اختیار VCNP بگذارد. **این کیت هیچ سرور VoIP پیش‌فرضی ندارد
> و به هیچ سرویس خاصی وابسته نیست** — هر مشخصات زیر را روی زیرساخت خودت پیاده
> می‌کنی، بعد فقط چند متغیر محیطی را تنظیم می‌کنی.

For any user of this kit. This document is **PBX-agnostic** — whether you run
Asterisk/FreePBX, 3CX, or anything else, all you need is one extension that
exposes recorded voicemail through a small HTTP API. **This kit ships with no
default VoIP server and no dependency on any specific service** — you
implement the contract below against your own infrastructure, then point
three environment variables at it.

---

## ۱) معماری — چطور کار می‌کند | Architecture

```
تماس‌گیرنده                                                  تماس‌گیرنده
    │                                                             │
    ▼                                                             ▼
[اکستنشن/داخلی VoIP شما] --ضبط--> [API کوچک شما]  <--poll یا webhook--  [VCNP]
   (هر PBX ای)              (health/messages/audio/ack)      (این کیت)
```

دو راه برای اطلاع‌رسانی پیام تازه به VCNP وجود دارد — می‌توانی هرکدام یا هر
دو را پیاده کنی:

1. **Poll (ساده‌تر، بدون تغییر شبکه)** — VCNP هر چند ثانیه یک‌بار از تو
   می‌پرسد «پیام تازه‌ای هست؟» (`GET /v1/messages?since_seq=`). این سمتِ
   VCNP همیشه از قبل آماده است (`tools/voip-inbox-poll.js`) — کاری روی
   شبکه لازم نیست چون این درخواست از داخل کامپیوتر شما به بیرون می‌رود.
2. **Webhook / push (لحظه‌ای)** — سمت PBX تو بعد از ذخیرهٔ هر پیام یک
   `POST` کوتاه به VCNP می‌زند (`/api/voip-webhook`) تا فوراً بیاید و
   پیام را بردارد. این یعنی PBX تو باید بتواند به کامپیوتری که VCNP رویش
   اجرا می‌شود برسد — اگر آن کامپیوتر IP خصوصی دارد، به یک تونل SSH نیاز
   داری (نمونه در `tools/voip-tunnel-watchdog.ps1`؛ **هیچ سرویس ابری
   شخص‌ثالثی لازم نیست**).

---

## ۲) قراردادی که سمت VoIP باید پیاده کنی | The contract your VoIP side implements

یک سرویس HTTP کوچک (هر زبانی — Bash+curl، Python، Node، هرچه) با این چهار
مسیر. نمونهٔ کامل کارکرده در پیوست پایین این سند آمده.

| متد و مسیر | کار | ضروری؟ |
|---|---|---|
| `GET /v1/health` | `{"ok":true, "seq": <بزرگ‌ترین seq>}` | بله |
| `GET /v1/messages?since_seq=N&limit=50` | پیام‌های بعد از `N`؛ شکل هر پیام زیر آمده | بله |
| `GET /v1/messages/{id}/audio` | فایل صوتی پیام (هر مسیر پایداری) | بله |
| `POST /v1/messages/{id}/ack` | علامت «دریافت شد» — بدون بدنه | بله |

احراز هویت: `Authorization: Bearer <توکن دلخواه خودت>` روی همهٔ درخواست‌ها.

### شکل هر پیام (JSON)

```json
{
  "id": "20260828-073459-1317",
  "seq": 9,
  "ts": "2026-08-28T07:34:59Z",
  "extension": "108",
  "caller_id": "09134436530",
  "duration_ms": 9030,
  "audio_url": "/v1/messages/20260828-073459-1317/audio",
  "mime": "audio/wav",
  "bytes": 144558,
  "sample_rate": 8000,
  "channels": 1,
  "lang": "fa-IR",
  "transcript": null,
  "has_transcript": false,
  "acked_at": null
}
```

نکات مهم که کد VCNP دقیقاً بر همین‌ها تکیه می‌کند:

- **صدا باید WAV، مونو، ۸۰۰۰ هرتز، ۱۶-بیت PCM باشد** (فرمت استاندارد ضبط
  تلفنی). فرمت‌های دیگر (mp3, ogg) پشتیبانی نمی‌شوند.
- `id` باید یکتا و پایدار باشد (کلید idempotency سمت VCNP همین است، نه
  `seq`). `seq` فقط برای cursor صعودی است.
- `transcript`/`has_transcript`: اگر رونویسی نداری، همیشه `null`/`false`
  بگذار — **هرگز متن ساختگی نساز**؛ VCNP هم همین اصل را رعایت می‌کند.
- `bytes` باید دقیقاً با طول واقعی فایل صوتی برابر باشد (تست سلامت دانلود).
- سقف حجم پیشنهادی: ۱۲۰ ثانیه ضبط ⇒ حدود ۱.۹ مگابایت — VCNP تا ۲ مگابایت
  می‌پذیرد.

### Webhook (اختیاری، برای push لحظه‌ای)

بعد از ذخیرهٔ موفق هر پیام، یک `POST` به آدرسی که در تنظیمات VCNP دادی بزن.
بدنه اهمیتی ندارد (VCNP خودش دوباره از API بالا می‌خواند) — کافی است شناسهٔ
پیام را برای لاگ بفرستی:

```bash
curl -s -X POST "$VCNP_WEBHOOK_URL" \
     -H "Content-Type: application/json" \
     -H "X-Webhook-Secret: $SECRET" \
     -d "{\"id\":\"$MSG_ID\"}" \
     --max-time 5 --retry 1 &   # پس‌زمینه، هرگز مسدودکننده
```

---

## ۳) تنظیم سمت VCNP | Configure the VCNP side

فقط سه (یا چهار) متغیر محیطی، هرجا که سرور زندهٔ VCNP اجرا می‌شود:

```bash
export VOIP_INBOX_BASE='https://your-voip-host/your-api-path'
export VOIP_INBOX_TOKEN='...'          # همان توکنی که سمت VoIP تعریف کردی
export VOIP_INBOX_TO_ROLE='ceo'        # اختیاری — پیش‌فرض ceo
export VOIP_WEBHOOK_SECRET='...'       # فقط اگر از روش webhook استفاده می‌کنی
```

بعد یکی از این دو را انتخاب کن:

- **Poll** (ساده‌ترین): `node tools/voip-inbox-poll.js` را پیوسته اجرا نگه‌دار
  (هر ۱۰ تا ۲۰ ثانیه چک می‌کند).
- **Webhook**: سرور زنده (`npm run live`) خودش مسیر `POST /api/voip-webhook`
  را روشن می‌کند (چون `VOIP_INBOX_TOKEN` و `VOIP_INBOX_BASE` تنظیم‌اند)؛ فقط
  کافی است سمت PBX به آن برسد — در `tools/voip-tunnel-watchdog.ps1` یک نمونهٔ
  تونل SSH بدون وابستگی به سرویس ابری آمده.

از این به بعد، هر پیام صوتی واقعی دقیقاً از همان مسیر نوشتاری تلفنخانهٔ
مرورگری وارد دفتر می‌شود — یک جفت رویداد `phone_call_received` +
`message_posted` در `office/events.log.jsonl`، قابل مشاهده در استودیوی زنده.

---

## پیوست: نمونهٔ کامل کارکرده — Asterisk dialplan + سرویس HTTP

این پیوست همان چیزی است که برای اولین بار روی یک PBX واقعی (Asterisk/FreePBX)
پیاده و تست شد — یک نقطهٔ شروع، نه تنها راه ممکن.

### Dialplan (extensions.conf) — یک اکستنشن با گیت PIN

```
[voip-agent-inbox]
exten => 108,1,Answer()
 same => n,Read(APIN,agent-pin-prompt,4,,3,10)
 same => n,GotoIf($["${APIN}"="1234"]?record:reject)
 same => n(reject),Playback(access-denied)
 same => n,Hangup()
 same => n(record),Playback(agent-msg-prompt)
 same => n,Record(/var/spool/asterisk/agent-msgs/agent-${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)}-${CALLERID(num)}.wav,3,120,k)
 same => n,System(/usr/local/lib/voip-agent-inbox/bin/post-call.sh "${RECORDED_FILE}" "${CALLERID(num)}" "108" &)
 same => n,Hangup()
```

(رمز `1234` را با یک رمز واقعی عوض کن؛ `k` در `Record` یعنی سکوت ۳ ثانیه‌ای
پایان ضبط را تشخیص می‌دهد.)

### post-call.sh — ثبت پیام + وب‌هوک اختیاری

```bash
#!/bin/sh
# آرگومان‌ها: $1=مسیر فایل صوتی  $2=شماره تماس‌گیرنده  $3=اکستنشن
REC="$1"; CID="$2"; EXT="$3"
ID="$(basename "$REC" .wav)"
BYTES=$(stat -c%s "$REC")
DUR_MS=$(( $(soxi -D "$REC" 2>/dev/null | cut -d. -f1) * 1000 ))

# ثبت متادیتا (نمونه: یک فایل JSON در کنار صدا؛ در عمل معمولاً یک پایگاه‌داده)
cat > "/var/lib/voip-agent-inbox/${ID}.json" <<JSON
{"id":"${ID}","ts":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","extension":"${EXT}",
 "caller_id":"${CID}","duration_ms":${DUR_MS},"bytes":${BYTES},
 "mime":"audio/wav","sample_rate":8000,"channels":1,"lang":"fa-IR",
 "transcript":null,"has_transcript":false,"acked_at":null}
JSON

# زنگ‌خبر اختیاری — فقط اگر URL تنظیم شده باشد
if [ -n "$VCNP_WEBHOOK_URL" ]; then
  ( curl -s -X POST "$VCNP_WEBHOOK_URL" \
         -H "Content-Type: application/json" \
         -H "X-Webhook-Secret: ${VCNP_WEBHOOK_SECRET}" \
         -d "{\"id\":\"${ID}\"}" \
         --max-time 5 --retry 1 >/dev/null 2>&1 ) &
fi
```

### سرویس HTTP کوچک (health/messages/audio/ack)

هر زبانی کار می‌کند؛ منطقش فقط خواندن همان فایل‌های JSON + صوتی که
`post-call.sh` ساخته و تحویل آن‌ها طبق قرارداد بالا. اگر می‌خواهی این بخش
را هم برایت به‌عنوان یک اسکریپت Node.js زیرو-دیپندنسی آماده کنم (هم‌راستا با
بقیهٔ این کیت)، بگو تا بسازم.
