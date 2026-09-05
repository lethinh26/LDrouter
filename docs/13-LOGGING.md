Hiện tại LDRouter đang có một lỗi khó debug trong luồng:

Claude Code
→ 9router
→ LDRouter
→ upstream provider

Vấn đề hiện tại là **Docker logs gần như không có thông tin request**, nên chưa thể xác định lỗi nằm ở request parsing, routing, combo capability, upstream request, streaming hay response.

Nhiệm vụ của bạn bây giờ:

# MỤC TIÊU

Tạm thời KHÔNG tập trung sửa bug.

Trước tiên hãy implement một hệ thống **debug logging chi tiết toàn bộ request lifecycle** để khi tôi chạy:

```bash
docker logs -f ldrouter
```

tôi có thể nhìn thấy toàn bộ quá trình một request đi qua LDRouter.

Logging phải đi ra `stdout/stderr` để Docker tự thu thập.

Không chỉ log lỗi.

Phải log cả:

* request vào LDRouter
* request parsing
* normalized request
* routing
* combo selection
* capability detection
* provider/account selection
* request gửi upstream
* upstream HTTP status
* upstream headers quan trọng
* streaming lifecycle
* response trả client
* exception
* socket/network error
* abort
* timeout
* request duration

---

# 1. REQUEST ID

Mỗi request phải có một request ID duy nhất.

Ví dụ:

```text
req_01HXYZ...
```

Nếu incoming request đã có:

```text
x-request-id
```

thì có thể reuse.

Nếu không thì generate.

MỌI log liên quan request đó phải chứa cùng requestId.

Ví dụ:

```text
[req_abc123] [INCOMING]
[req_abc123] [NORMALIZE]
[req_abc123] [ROUTER]
[req_abc123] [UPSTREAM]
[req_abc123] [STREAM]
[req_abc123] [DONE]
```

Mục tiêu là có thể grep:

```bash
docker logs ldrouter 2>&1 | grep req_abc123
```

và thấy toàn bộ lifecycle.

---

# 2. LOG INCOMING HTTP REQUEST

Đối với các endpoint quan trọng:

```text
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
GET /v1/models
```

nếu tồn tại.

Log:

```text
timestamp
requestId
method
url
path
query
content-type
content-length
user-agent
host
x-forwarded-for
cf-ray
cf-connecting-ip
accept
accept-encoding
connection
```

Ví dụ:

```text
[req_xxx] [INCOMING]
POST /v1/chat/completions
content-type=application/json
content-length=183742
user-agent=...
cf-ray=...
```

---

# 3. TUYỆT ĐỐI KHÔNG LOG SECRET

Phải redact:

```text
Authorization
API keys
Cookies
Set-Cookie
password
secret
token
access_token
refresh_token
provider credentials
```

Ví dụ:

KHÔNG:

```text
Authorization: Bearer ld-abcdef123456
```

mà:

```text
Authorization: Bearer ld-***REDACTED***
```

Hoặc bỏ hẳn authorization khỏi log.

Không làm lộ API key kể cả trong exception object.

---

# 4. LOG RAW/INCOMING BODY

Đây là phần rất quan trọng.

Đối với `/v1/chat/completions`, cần log đủ thông tin để so sánh request Test Model với request từ Claude Code.

Log summary:

```js
{
  model,
  stream,

  bodyKeys: Object.keys(body),

  messagesCount,
  toolsCount,

  max_tokens,
  max_completion_tokens,

  temperature,
  top_p,

  reasoning_effort,
  reasoning,
  thinking,

  tool_choice,
  parallel_tool_calls,

  response_format,
  stream_options,

  messageRoles
}
```

Ví dụ:

```text
[req_xxx] [BODY SUMMARY]

model=vl/gpt-5.4
stream=true
messages=42
tools=18
bodyKeys=[
  "model",
  "messages",
  "tools",
  "tool_choice",
  "stream",
  "max_tokens",
  "reasoning_effort"
]
```

---

# 5. DEBUG MODE PHẢI CÓ KHẢ NĂNG LOG FULL BODY

Tạo environment variable:

```text
DEBUG_HTTP=true
```

và:

```text
DEBUG_HTTP_BODY=true
```

Khi:

```text
DEBUG_HTTP_BODY=true
```

thì log full sanitized JSON body.

Ví dụ:

```text
[req_xxx] [INCOMING BODY]
{
   ...
}
```

Không truncate body nếu đang debug, trừ khi quá lớn.

Nếu phải giới hạn thì để limit rất lớn và log:

```text
bodySize=xxx bytes
bodyTruncated=true
```

Mục đích là tôi có thể lấy **chính xác payload Claude Code → 9router → LDRouter** để replay bằng curl.

---

# 6. LOG MESSAGE STRUCTURE

Đừng chỉ log số lượng messages.

Log từng message theo cấu trúc an toàn.

Ví dụ:

```text
[req_xxx] [MESSAGES]

#0
role=system
contentType=string
contentLength=18342

#1
role=user
contentType=array
contentParts=3

#2
role=assistant
content=null
toolCalls=2

#3
role=tool
toolCallId=call_abc
contentLength=3521
```

Đặc biệt detect:

```text
content === null
Array.isArray(content)
tool_calls
role=tool
reasoning_content
image_url
input_text
output_text
```

Tôi muốn nhìn thấy nếu Claude/9router đang tạo một message shape khác bình thường.

---

# 7. LOG TOOLS

Claude Code có thể gửi rất nhiều tools.

Log:

```text
toolsCount
serializedToolsSize
```

và từng tool:

```text
index
name
descriptionLength
schemaSize
schemaDepth nếu dễ tính
```

Ví dụ:

```text
[req_xxx] [TOOLS]
count=21
serializedSize=85321

tool[0]:
name=Read
schemaSize=2231

tool[1]:
name=Edit
schemaSize=4821
```

Trong `DEBUG_HTTP_BODY=true`, log full sanitized tools JSON.

---

# 8. LOG NORMALIZATION

Tìm chỗ LDRouter normalize/sanitize/transform request.

Ví dụ có thể tên là:

```text
normalizeRequest
transformRequest
sanitizePayload
prepareRequest
buildProviderPayload
```

Log BEFORE và AFTER.

Ví dụ:

```text
[req_xxx] [NORMALIZE BEFORE]
bodyKeys=[...]

[req_xxx] [NORMALIZE AFTER]
bodyKeys=[...]
removedKeys=[...]
addedKeys=[...]
changedFields=[...]
```

Nếu model name thay đổi:

```text
inputModel=gpt-5.4
resolvedModel=vl/gpt-5.4
```

phải log.

---

# 9. LOG MODEL RESOLUTION

Tôi muốn thấy chính xác quá trình:

```text
requested model
↓
alias
↓
combo
↓
provider
↓
real upstream model
```

Ví dụ:

```text
[req_xxx] [MODEL RESOLVE]

requested=gpt-5.4
type=combo

combo=gpt-5.4

candidate[0]:
provider=vl
model=gpt-5.4
resolvedModel=vl/gpt-5.4
```

Nếu direct:

```text
requested=vl/gpt-5.4
provider=vl
upstreamModel=gpt-5.4
```

---

# 10. LOG CAPABILITY DETECTION

Đây là phần CỰC KỲ QUAN TRỌNG vì hiện đang có lỗi:

```text
No combo member satisfies the request capabilities or availability
```

Tìm chính xác code sinh error đó.

Trước khi filter candidates, log:

```text
[req_xxx] [CAPABILITIES REQUIRED]

tools=?
stream=?
vision=?
reasoning=?
json=?
structuredOutput=?
parallelToolCalls=?
```

Sau đó cho mỗi candidate:

```text
[req_xxx] [CAPABILITY CANDIDATE]

model=vl/gpt-5.4

supported:
tools=true/false/undefined
vision=true/false/undefined
reasoning=true/false/undefined
parallelToolCalls=true/false/undefined
...
```

Nếu reject:

```text
[req_xxx] [CAPABILITY REJECT]

model=vl/gpt-5.4
reason=reasoning_required_but_not_supported
required=true
modelValue=undefined
```

KHÔNG chỉ log:

```text
No combo member satisfies...
```

Tôi cần biết **TẠI SAO từng member bị loại**.

Nếu filter vì availability:

```text
reason=account_locked
```

Nếu filter vì capability:

```text
reason=tools
```

Nếu filter vì rate limit:

```text
reason=rate_limit
```

Từng candidate phải có rejection reason cụ thể.

---

# 11. LOG ACCOUNT SELECTION

Khi provider có nhiều account/key:

```text
[req_xxx] [ACCOUNT SELECT]

provider=vl
accountsTotal=3
available=2
locked=1
selectedAccount=<safe identifier>
```

Không log API key.

Có thể log account ID/hash cuối:

```text
accountId=acc_123
```

hoặc:

```text
keyFingerprint=...92af
```

nhưng tuyệt đối không log full key.

Nếu account locked:

```text
lockedUntil
lastStatus
lastError
```

---

# 12. LOG UPSTREAM REQUEST

Ngay trước khi fetch upstream:

```text
[req_xxx] [UPSTREAM REQUEST]

provider=vl
method=POST
url=https://xxxxx/v1/chat/completions
model=gpt-5.4
stream=true
contentLength=...
```

Log sanitized headers.

Không log upstream Authorization.

Trong debug body mode:

```text
[req_xxx] [UPSTREAM BODY]
{...}
```

Đây là cực kỳ quan trọng.

Tôi muốn so sánh:

```text
incoming body
vs
normalized body
vs
upstream body
```

---

# 13. LOG FETCH / NETWORK LIFECYCLE

Bao quanh upstream fetch bằng try/catch.

Log:

```text
fetchStart
DNS/fetch error nếu có
response received
status
statusText
duration
```

Nếu exception:

```text
name
message
code
cause
stack
```

Đặc biệt inspect:

```text
ECONNRESET
ECONNREFUSED
ETIMEDOUT
UND_ERR_SOCKET
UND_ERR_CONNECT_TIMEOUT
UND_ERR_HEADERS_TIMEOUT
AbortError
TypeError: fetch failed
premature close
socket hang up
```

Ví dụ:

```text
[req_xxx] [UPSTREAM FETCH ERROR]

name=TypeError
message=fetch failed
cause.code=UND_ERR_SOCKET
cause.socket.localAddress=...
stack=...
```

Phải log nested `cause`.

Node `fetch`/Undici thường giấu lỗi thật trong:

```js
error.cause
```

nên đừng chỉ log:

```js
err.message
```

Hãy log full error object/cause/stack.

---

# 14. LOG UPSTREAM RESPONSE

Ngay khi upstream trả response:

```text
[req_xxx] [UPSTREAM RESPONSE]

status=200
content-type=text/event-stream
content-length=...
transfer-encoding=chunked
server=...
durationToHeaders=...
```

Nếu non-2xx:

Đọc body và log FULL response body trong debug mode:

```text
[req_xxx] [UPSTREAM ERROR BODY]
...
```

Nếu JSON:

```json
{"error": ...}
```

Nếu HTML:

```html
<!DOCTYPE html>...
```

phải log nguồn response đó.

---

# 15. STREAMING DEBUG

Đây là phần rất quan trọng vì lỗi có thể chỉ xảy ra khi Claude stream.

Khi `stream=true`, log lifecycle:

```text
[req_xxx] [STREAM START]

upstreamConnected=true
```

Sau đó không nhất thiết log full mọi token vì quá spam.

Nhưng log:

```text
chunkCount
bytesReceived
firstChunkTime
lastChunkTime
```

Với DEBUG cực sâu, có thể log first 3-5 chunks.

Ví dụ:

```text
[req_xxx] [STREAM FIRST CHUNK]
data: {...}
```

Sau đó:

```text
[req_xxx] [STREAM END]

chunks=392
bytes=182934
duration=...
finishedNormally=true
```

Nếu lỗi giữa stream:

```text
[req_xxx] [STREAM ERROR]

chunksBeforeError=21
bytesBeforeError=14219

name=...
message=...
cause=...
stack=...
```

Phải phân biệt:

```text
upstream stream error
client disconnected
AbortController abort
parser error
response transformer error
```

---

# 16. CLIENT DISCONNECT / ABORT

Log các event:

```text
request aborted
response close
socket close
client disconnected
```

Ví dụ:

```text
[req_xxx] [CLIENT DISCONNECT]

afterMs=3821
streaming=true
upstreamAborted=true
```

Claude Code/9router có thể abort connection và đây có thể là nguyên nhân rất quan trọng.

---

# 17. LOG RESPONSE VỀ CLIENT

Trước khi request hoàn thành:

```text
[req_xxx] [RESPONSE]

status=200
content-type=...
stream=true
```

Sau khi hoàn tất:

```text
[req_xxx] [DONE]

status=200
durationMs=4231
```

Nếu lỗi:

```text
[req_xxx] [DONE]

status=502
durationMs=30021
error=true
```

---

# 18. GLOBAL ERROR HANDLERS

Hiện tại nếu có uncaught error có thể process chết và Cloudflare chỉ hiện:

```text
502 Bad Gateway
Host Error
```

Implement logging cho:

```js
process.on("uncaughtException", ...)
process.on("unhandledRejection", ...)
```

Log:

```text
[FATAL] uncaughtException
[FATAL] unhandledRejection
```

bao gồm:

```text
message
stack
cause
```

KHÔNG được swallow lỗi một cách nguy hiểm chỉ để process tiếp tục.

Mục tiêu trước tiên là nhìn thấy lỗi.

---

# 19. FASTIFY / SERVER ERROR HANDLER

Nếu dùng Fastify:

kiểm tra và implement:

```js
fastify.setErrorHandler(...)
```

Log:

```text
requestId
route
method
statusCode
error.name
error.message
error.stack
error.cause
```

Nếu response chưa được gửi, trả JSON error thay vì để connection chết.

Trong DEBUG:

```json
{
  "error": {
    "message": "...",
    "type": "internal_server_error",
    "request_id": "req_xxx"
  }
}
```

Không trả stack trace ra client production.

Stack chỉ log server-side.

---

# 20. BODY PARSER ERRORS

Phải log cả lỗi trước khi vào route handler:

```text
invalid JSON
body too large
content length mismatch
unsupported content type
```

Đặc biệt log configured:

```text
bodyLimit
requestTimeout
headersTimeout
keepAliveTimeout
```

Khi server start, print:

```text
[CONFIG]
bodyLimit=...
requestTimeout=...
...
```

---

# 21. DOCKER LOGGING

Quan trọng:

Logging phải sử dụng:

```text
stdout
stderr
```

Ví dụ Pino/Fastify logger.

KHÔNG chỉ ghi file bên trong container.

Tôi phải xem được bằng:

```bash
docker logs -f ldrouter
```

và:

```bash
docker logs ldrouter --since 10m
```

Nếu app hiện đang disable request logging, hãy bật hoặc xây custom logging phù hợp.

---

# 22. DEBUG ENV

Implement ít nhất:

```env
LOG_LEVEL=debug
DEBUG_HTTP=true
DEBUG_HTTP_BODY=true
DEBUG_UPSTREAM=true
DEBUG_STREAM=true
```

Default production có thể:

```env
LOG_LEVEL=info
DEBUG_HTTP=false
DEBUG_HTTP_BODY=false
DEBUG_UPSTREAM=false
DEBUG_STREAM=false
```

Nhưng hiện tại tôi cần bật toàn bộ để debug.

---

# 23. FORMAT LOG

Ưu tiên structured logs nhưng phải dễ đọc trong:

```bash
docker logs -f ldrouter
```

Ví dụ:

```text
[2026-09-05T...] [req_abc] [INCOMING] POST /v1/chat/completions
[2026-09-05T...] [req_abc] [MODEL] requested=vl/gpt-5.4
[2026-09-05T...] [req_abc] [CAPABILITY] tools=true reasoning=true
[2026-09-05T...] [req_abc] [UPSTREAM] POST ...
[2026-09-05T...] [req_abc] [UPSTREAM RESPONSE] 200
[2026-09-05T...] [req_abc] [STREAM] started
[2026-09-05T...] [req_abc] [STREAM ERROR] UND_ERR_SOCKET ...
```

Hoặc JSON structured log cũng được nếu project đã dùng Pino.

Quan trọng nhất là requestId phải nhất quán.

---

# 24. ĐỪNG LÀM THAY ĐỔI HÀNH VI ROUTING

Ở bước này:

KHÔNG:

* sửa combo algorithm
* sửa capability logic
* đổi provider routing
* đổi retry behavior
* strip thêm request field
* tự động workaround lỗi

Chỉ thêm observability/logging.

Nếu phát hiện bug rõ ràng trong lúc đọc code thì ghi lại, nhưng chưa sửa behavior nếu không cần thiết để logging hoạt động.

Tôi muốn tái hiện bug một lần sau khi patch logging.

---

# 25. SAU KHI IMPLEMENT

Chạy test hiện có.

Đảm bảo:

```text
normal chat vẫn chạy
stream vẫn chạy
tools vẫn chạy
combo vẫn giữ behavior cũ
```

Sau đó cho tôi biết:

1. Những file đã sửa
2. Logging được thêm ở những layer nào
3. Env nào cần thêm vào Docker
4. Cách rebuild/restart
5. Lệnh để theo dõi log
6. Nếu phát hiện code path đáng nghi, chỉ ra nhưng chưa đoán nếu chưa có evidence

Cuối cùng cung cấp chính xác command để tôi chạy.

Ví dụ nếu dùng docker run:

```bash
docker logs -f --tail 200 ldrouter
```

Nếu dùng docker compose:

```bash
docker compose logs -f --tail=200 latedev-router
```

---

# KẾT QUẢ MONG MUỐN

Sau khi tôi reproduce:

Claude Code
→ 9router
→ LDRouter

tôi phải nhìn được kiểu:

```text
[req_xxx] Incoming request
[req_xxx] Incoming body
[req_xxx] Normalize
[req_xxx] Required capabilities
[req_xxx] Candidate selection
[req_xxx] Selected provider/account
[req_xxx] Upstream request
[req_xxx] Upstream response
[req_xxx] Stream start
[req_xxx] ERROR / disconnect / finish
```

Từ đó chúng ta mới tiếp tục xác định root cause.

Hãy implement logging thực tế trong codebase, không chỉ viết đề xuất.
Sau khi implement xong, chạy tests và báo lại diff/tóm tắt thay đổi.
