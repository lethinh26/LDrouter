# Adaptive ordered fallback

**Ngày:** 2026-11-25 | **Baseline:** commit `d6fe0e1` trên branch `chore/remove-legacy-providers-20261125`, sau cleanup provider legacy và migration 0014 | **Trạng thái adaptive routing:** đã được duyệt; code phase 2–4 và regression phase 5 đã bổ sung trên branch, chưa deploy production.

## 1. Mục tiêu

- Combo là danh sách model theo thứ tự ưu tiên do admin đặt. Khi các model hoạt động ổn định với độ trễ tương đương, ưu tiên model đứng đầu.
- Tự chuyển model khi có lỗi hoặc chậm đáng kể, tự quay lại model ưu tiên cao sau khi phục hồi (failback), không ghim cứng một active model.
- Model chậm nhưng còn sử dụng được là dự phòng mềm. Khi model đang được ưu tiên hỏng, có thể quay lại model đứng trước ngay trong request nếu còn attempt/deadline và chưa commit output.
- Hoạt động với N model (1–16 theo API hiện hành), trên hai provider type OpenAI-compatible và Anthropic-compatible. Mỗi physical model tương ứng một candidate; không còn account-pool expansion.
- Cleanup provider legacy được triển khai độc lập trước adaptive fallback; không đưa adapter, account pool hay OAuth vào thiết kế mới.
- Không thay đổi ID công khai của model/combo, ACL, quota, alias, cache và streaming contract của hai provider được hỗ trợ. Không thêm round robin, hedging (gửi song song), Redis, background generation hay tính chi phí.

## 2. Hiện trạng đã kiểm tra

| Vị trí | Phát hiện |
| --- | --- |
| src/server/gateway/runner.ts — GatewayRunner.execute, candidate filtering | Model trong slow cooldown hoặc probe đang chạy bị loại hẳn khỏi candidates. A chậm, B chết => A không còn trong pool; tất cả chậm => có thể không còn candidate. |
| GatewayRunner.execute — attempt loop | Vòng lặp i++ một chiều, snapshot cố định, không có rescue/re-evaluate. Một số skip cũng tiêu hao attempt budget. |
| src/server/routing/combo.ts — selectCandidates, orderCandidates | Filter hard eligibility rồi sort position; không có so sánh tốc độ tương đối. |
| src/server/routing/combo-slow-fallback.ts:4–163 | Cooldown 5 phút; max slow count mặc định 3; fast không có state ban đầu bị bỏ qua. Chỉ lưu lastLatencyMs, thiếu sample đủ để so sánh; lease có expiry nhưng không có owner token. |
| GatewayRunner.execute — attempt outcome recording | Fast streaming ghi tại TTFT trước khi stream hoàn tất, chưa đủ bằng chứng recovery. Non-streaming dùng out.ttftMs (thực chất thời gian đọc toàn body với compatible HTTP). |
| src/server/routing/circuit.ts:37–62 | HALF_OPEN chưa claim một probe độc quyền, nhiều request có thể thử cùng provider. |
| GatewayRunner — isUpstreamHealthFailure, shouldRetryAttempt, classifyFailure | Health classification và fallback classification cần tách; tránh lỗi model/request-specific làm mở circuit cả provider. Giữ phân loại quota upstream chung độc lập với ACL/quota của API key. |
| src/server/routes/admin/providers.ts; src/server/providers/index.ts; src/server/upstream/client.ts | API và runtime chỉ hỗ trợ openai/anthropic; discovery và upstream calls dùng một API key đã mã hóa theo provider. |
| src/server/db/schema.ts; migrations/0014_remove_legacy_providers.sql | Runtime schema không còn account tables/FKs; request/attempt/daily aggregate giữ historical IDs. |
| src/server/db/migrate.ts; src/server/backup/restore-upload.ts | Startup dùng immutable SQL migrations; restore nâng cấp staging trước swap. Adaptive state cần migration mới và không restore lease đang hoạt động. |
| src/server/routes/admin/combos.ts; src/web/app/pages/combos.tsx | Đã có slow threshold/count, state, drag priority; giữ cấu hình hiện hữu, đổi ngữ nghĩa cooldown thành dự phòng mềm. |

GitNexus context GatewayRunner xác nhận callers chính: OpenAI/Anthropic gateway routes, admin model test và admin combo test. Phải re-index baseline đã cleanup và impact trước production edits. Regression cleanup độc lập với adaptive tests; chưa có dữ liệu latency production để hiệu chỉnh ngưỡng adaptive.

## 3. Baseline sau cleanup — không phải phạm vi adaptive implementation

Cleanup native Codex/Qoder đã được triển khai riêng trên branch `chore/remove-legacy-providers-20261125`. Các adapter, credential repositories, account pools, OAuth/import/refresh, Admin API/UI và test chuyên biệt được loại khỏi runtime. `GatewayRunner` thực thi trực tiếp physical model qua compatible HTTP client; một member tương ứng một candidate, nên adaptive attempt identity không cần account ID. Generic upstream quota/429 classification, API-key admission, ordered fallback và hard timeout hiện hành vẫn giữ.

Migration `0014_remove_legacy_providers.sql` xóa active provider/model/credential cấu hình cũ theo `providers.type`, dọn membership/slow-state, direct alias, ACL và cache tương ứng, disable combo/alias nếu combo không còn member, giữ thứ tự và ID còn lại. Generic request/attempt/audit history và daily aggregates giữ nguyên (account-specific attempt columns bị loại bỏ). Historical IDs vẫn đọc được dù active labels đã mất. Restricted key không bị mở quyền khi allowlist trở thành rỗng. Migrations 0005–0008 giữ nguyên vì cần cho upgrade từ version cũ.

Startup và restore staging dùng cùng SQL migration assets (schema version 14); thiếu assets, schema mới hơn hoặc migration history có gap phải fail closed. Full/compact backup cũ được migrate trước khi swap, không làm sống lại provider đã bỏ; failure giữ live DB. Operator cần full backup trước upgrade, rollback bằng bản app/DB cũ; không áp dụng migration trên live DB khi phát triển. Logical deletion không cam kết forensic erasure của backup/WAL cũ.

Các regression provider removal (fresh/old DB, backup v1/v2, ACL, order, cache/history, compatible providers, removed endpoint và build packaging) là điều kiện baseline phải xanh trước adaptive implementation; không chạy lại phần cleanup như một phase phát triển adaptive. Các case vẫn giữ trong ma trận mục 10 để tránh hồi quy.

## 4. Lựa chọn kiến trúc

A. Chỉ đổi hard cooldown thành soft reserve: ít code nhưng chưa hiểu tốc độ tương đối, không đủ đáp ứng failback ổn định.

B. **Adaptive ordered fallback + soft reserve + passive recovery** (đề xuất): giữ priority, có bằng chứng để tạm hạ ưu tiên, khôi phục tự động, không nhân upstream calls. Tách pure policy, state repository, runner orchestration, health.

C. Always-fastest hoặc racing/hedging: dễ bỏ priority, tăng tải/usage, dễ đảo liên tục. Không chọn.

Giữ mode fallback hiện tại. slowResponseFallbackEnabled bật toàn bộ adaptive behavior; tắt => ordered fallback thuần với các error triggers hiện có. Không áp dụng adaptive policy cho direct model hoặc alias-to-model.

## 5. Tham số đề xuất

| Tham số | Mặc định |
| --- | --- |
| Soft response threshold | Giữ setting hiện có: 60s, 1–600s |
| Absolute consecutive slow count | Giữ setting: 3, 1–20 |
| Similarity tolerance (quay lại priority cao) | max(2s, 20% latency đối chứng nhanh hơn) |
| Relative demotion margin | max(3s, 30% latency đối chứng) |
| Samples | Median 5 successful samples gần nhất; tối thiểu 3 mỗi member/workload để so sánh |
| Relative demotion | 3 observations liên tiếp vượt demotion margin, comparator đủ fresh samples và đang khả dụng |
| Recovery | 2 probes thành công liên tiếp đạt ngưỡng tương đương; nếu không có comparator, dưới absolute threshold |
| Freshness | 15 phút; stale samples không được dùng để ghim quyết định |
| Probe đầu tiên | Sau 30s; probe fail => 30/60/120/240/300s backoff, jitter 0–10% |
| Probe xác nhận | Sau 10s kể từ probe thành công đầu |
| Attempts | Giữ maxTotalAttempts (1–8); đếm actual upstream dispatch, skip không đếm |
| Rescue replay | Tối đa 1 lần lặp candidate đã soft timeout trong cùng request, chỉ khi hết candidate chưa thử và còn budget |
| Tổng thời gian request | Đề xuất advanced setting maxRequestDurationSeconds nullable (default null để giữ hành vi cũ); hard timeout mỗi attempt + cap luôn áp dụng |

Các con số là mặc định ban đầu chưa benchmark thực tế; named constants, ít settings, dễ hiệu chỉnh. Hysteresis: demotion margin lớn hơn recovery margin; không chuyển qua lại vì nhiễu nhỏ. Ở khoảng giữa hai margin giữ trạng thái ổn định hiện tại; nếu trở lại similarity band thì ưu tiên cao sau xác nhận. Khi normal candidate cuối là duy nhất, soft threshold không cắt nó; hard timeout vẫn áp dụng.

## 6. State, tín hiệu latency và health

- Hard eligibility: combo/member/model/provider enabled, upstreamAvailable, ACL, capability, provider circuit (open/probe busy), model-specific hard cooldown nếu có. Không bypass bất kỳ điều kiện nào khi rescue. Provider-wide và model-specific failures tách riêng; generic provider 429 respect Retry-After, không biến 400 invalid prompt thành provider down.
- Soft state: unknown / ready / suspect / degraded_absolute / degraded_relative / probe_due / probing. Degraded chỉ giảm thứ tự; không đồng nghĩa dead. Rescue là role của attempt, không phải state healthy.
- Sample key: combo membership ID + bounded workload bucket + generation. Tách streaming/non-streaming × reasoning on/off × estimated input short/long (<=8192 tokens) và non-stream output budget short/long (<=1024). Không so chéo bucket; sparse data giữ priority. Dùng actual elapsed monotonic, persisted wall time cho TTL.
- Streaming latency = dispatch tới first meaningful text/tool-call (TTFT), không tính metadata/SSE role/usage/headers. Tắt soft watchdog sau content đầu. Chỉ đưa successful sample/recovery khi stream kết thúc hợp lệ. Lỗi sau commit không được promote.
- Non-streaming latency = dispatch tới valid complete body; không trộn với TTFT. Giữ public log compatibility, thêm internal latency kind nếu cần.
- Timeout mềm là censored observation: latency >= threshold, không giả sample chính xác. Rescue trả thành công nhưng > threshold vẫn là slow observation. Empty output, malformed response, timeout hard, client cancel, cache hit không phải sample nhanh.
- Ghi sample cả khi model chưa từng slow, lưu tối đa 5 thành công kèm timestamp. Persist state nhỏ trong SQLite; không scan request history. Dọn state stale/removed bằng TTL/FK.
- Với comparator chết, unavailable hoặc data stale: vô hiệu relative demotion phụ thuộc comparator, tìm comparator hợp lệ khác hoặc về priority. Absolute cooldown vẫn là soft reserve. Re-evaluate mỗi request và sau failure.
- Chỉ học từ request thật. Khi primary chưa có bằng chứng chậm thì không phát sinh request riêng để đo backup; khi primary suspect và backup chưa có dữ liệu, có thể chọn một request thật để sample backup, tối đa một exploration mỗi combo/workload/60s, chỉ khi có ít nhất 3 primary observations >80% threshold hoặc chậm hơn baseline gần nhất >=30%, không chọn model đã hard-blocked. Đây là probe/diagnostic exception có reason riêng. Khi mẫu đủ hoặc primary ổn định, dừng exploration. Không gọi đồng thời hai upstream. Giới hạn: traffic thấp hoặc workload rất đa dạng => học chậm, ưu tiên giữ mặc định.
- Admin Test Combo bypass gateway cache, dùng policy thật để kiểm tra nhưng không trộn sample synthetic vào user workload.

## 7. Thuật toán chi tiết

### 7.1 Chọn candidate

1. Resolve, ACL, capability, limits. Load member theo position (tie-break member ID); lấy state, filter hard eligibility. **Giữ toàn bộ soft reserves trong pool.** Cache hit hợp lệ không claim lease hay học latency.
2. Tách normal (ready/unknown/suspect), recovery due, reserve (degraded) và hard blocked. Với fresh comparable samples: chỉ giảm priority khi đủ bằng chứng vượt demotion margin. Trong nhóm tương đương chọn position nhỏ nhất; với N members dùng fastest reliable reference rồi priority trong tolerance band, tránh comparator vòng/non-transitive pairwise sort. Unknown primary không bị hạ bởi model thiếu mẫu. Unknown backup được dùng khi failover/controlled exploration.
3. Probe đến hạn của member ưu tiên cao hơn normal đang chọn được thử trước. Atomic claim ngay trước dispatch; request khác tiếp tục normal. Lần probe đầu thành công chưa promote toàn traffic cho đến khi có lần xác nhận thứ hai. Probe failure re-arm cooldown/backoff.
4. Trước từng attempt re-read eligibility và state generation. Model bị xóa/disable, circuit mở, deadline hết hoặc lease bận => skip, không mất attempt. Không dùng snapshot cũ. Hạn chế skip bằng set (memberId, phase), không spin.
5. Nếu normal candidates hết, chọn reserve ngay trong request, không chờ cooldown. Nếu chỉ có reserve ngay từ đầu, dùng degraded-only serving mode cho traffic hợp lệ. Chọn theo priority giữa các model tương đương và bằng chứng latency đủ tin cậy. Không block toàn bộ traffic chỉ vì một slow probe lease đang chạy; probe độc quyền, degraded-only serving tuân limits thông thường và không được xác nhận recovery thay cho chủ lease.

### 7.2 Khi nào dùng soft watchdog

- Bật soft watchdog khi còn một alternative chưa thử khả dụng có cơ hội nhanh hơn (unknown hoặc reliable faster), đủ attempt và thời gian để thử. Không bật nếu last viable candidate, all-known-slow hoặc chỉ còn 1 attempt.
- Khi cả A/B đều chậm: không abort cả hai liên tiếp chỉ vì cùng vượt 60s. Cho last/rescue attempt đến hard deadline để có kết quả và sample thực; probe primary với hard deadline nếu cần đo đầy đủ (comparator cũng vượt/ngấp nghé threshold). Khi đủ evidence cả hai tương đương, chọn A và không soft abort A nếu B không có bằng chứng tốt hơn.
- Nếu A slow timeout trước khi B fail, và A đã bị thử, chỉ cho replay A một lần ở pha rescue, còn budget và chưa commit. Đây là lần gọi upstream mới, có thể tiêu thêm token; không ghép output hoặc resume request. Nếu cap=2 không replay thứ ba.
- Hard deadlines connect/first-token/idle/total/overall luôn thắng. Dùng AbortSignal thật, cancel upstream; không Promise.race để request chạy ngầm. Client disconnect cả stream và non-stream phải hủy upstream.

### 7.3 Vòng lặp runner

    pool = loadHardEligibleMembers()
    while actualAttempts < maxAttempts and not committed and not cancelled:
        refreshHardEligibilityAndSoftState()
        decision = pickDueRecoveryOrNormal() or pickRescueOrOneSoftReplay()
        if no decision: break
        if not claimRequiredLeases(): markSkipped(); continue
        try:
            actualAttempts += 1
            outcome = executeWithDeadlines(decision)
            recordFencedOutcome(outcome)
            return success
        catch error:
            recordFencedOutcome(error)
            if committed or cancelled or not fallbackAllowed(error): return failure
        finally:
            releaseOnlyOwnedLeases()
    return bestMeaningfulFailure()

- Hard failure được fallback theo trigger hiện có (connection/connect timeout/first-token/total/408/429/5xx). Trigger off => không rescue vòng qua. 400/unsupported/ACL/gateway 401–403 không fallback; provider credential errors giữ semantics mặc định. Empty response retry theo config; reserve attempt cho member khác trước retry, không nhân retry. Skip trước dispatch không tính attempt.
- B chết => đánh giá lại cả pool; A soft reserve còn hợp lệ được thử ngay; A hard blocked không thử. Nếu C normal tốt, có thể thử C trước A degraded theo policy. Không lặp hard-failed identity trong cùng request ngoài retry hợp lệ, không infinite loop.
- Stream đã commit text/tool-call => không đổi model kể cả A đã phục hồi hoặc B chết. Trả partial/error theo protocol. Cancel không làm degrade. Không fallback sau tool output.
- Lỗi cuối: 503 nếu mọi candidate hard-blocked/lease bận; 504 khi deadline hết; preserve upstream terminal error có ý nghĩa và trigger. Retry-After khi biết; không sleep chờ cooldown. Không giữ failed lastError khi attempt sau thành công.

## 8. Concurrency và circuit breaker

- Claim probe trong transaction CAS theo member/workload/generation, token owner và expiresAt. Lease deadline phù hợp hard/soft phase. Only owner release/update; stale owner không ghi đè lease mới. Outcome fencing theo epoch + attempt-start ordering để late success không xóa newer degrade và late failure không hủy recovery mới. Không giữ transaction qua network.
- Provider half-open: claim một probe độc quyền trên toàn provider (single process), release theo token. Thành công hoàn tất mới close; failure đúng scope re-open; cancel/soft timeout không kết luận provider down/healthy, release để thử sau. Nếu cần cả hai lease, claim theo thứ tự cố định và rollback claim thứ nhất nếu thứ hai fail.
- Provider circuit chỉ phản ánh lỗi thực sự cấp provider; model-specific failure làm giảm sức khỏe model riêng nếu xác định chắc. 429 transient tôn trọng Retry-After; không mở circuit bởi invalid client request. Cùng provider có nhiều model, nếu chỉ A lỗi model-specific thì B vẫn có thể chạy.
- Reset generation khi đổi threshold/count, enable/disable/reorder hoặc provider/model config ảnh hưởng latency. Member delete/re-add ID mới không nhận state cũ. Giữ samples khi reorder an toàn, reset relative decision; đổi tên không reset. Restore/restart clear active lease, TTL stale state; không restore in-memory breaker giả.
- Không hạn chế request thường bởi probe concurrency nếu degraded model là lựa chọn phục vụ duy nhất; giới hạn đã có của API key/provider và hard circuit vẫn áp dụng.

## 9. Kế hoạch triển khai theo thứ tự

### Phase 0 — Baseline, impact và boundary

- Re-index GitNexus; impact upstream từng symbol trước chỉnh sửa, report risk/callers, warn HIGH/CRITICAL. Đọc AGENTS con và toàn docs theo thứ tự; xác định FK graph/schema version và callers.
- Chạy baseline tests combo/gateway/circuit/migrations/backup/stats/admin. Lưu regression cases; không chạy migration trên live DB.
- Check worktree, tạo nhánh riêng nếu triển khai; không ghi đè user changes.

### Phase 1 — Gate baseline sau cleanup (không triển khai lại removal)

- Chỉ bắt đầu adaptive sau khi branch cleanup tại mục 3 được review và kiểm thử, không còn runtime legacy references; kiểm tra schema version 14 và test fresh/old DB, compatible providers, ACL, backup, package.
- Giữ review/commit cleanup độc lập với adaptive; DB rollback của cleanup cần pre-upgrade backup. Phase 2–5 chỉ chạy khi user duyệt adaptive implementation.

### Phase 2 — Policy thuần và state repository

- Tạo src/server/routing/combo-policy.ts: workload classification, latency comparison, candidate roles, deterministic picker, attempt history, soft-deadline decision, recovery schedule. Không I/O, inject clock/random.
- Giữ combo.ts load/filter/candidate config; thêm stable ordering, reason codes trong capabilities.ts.
- Migration 0015_adaptive_combo_state.sql (số xác nhận khi triển khai) thay hoặc mở rộng combo_member_slow_states theo membership/workload, sample ring, generation, lease owner/expiry, recovery and relative metadata, optional max duration. Legacy slow history không có workload => reset về unknown; giữ thresholds/count/configVersion. Backup runtime state excluded hoặc reset khi restore; không restore leases.
- Tests mới tests/unit/combo-policy.test.ts, tests/unit/combo-slow-fallback.test.ts, migration tests. Fake clock; test boundary, N members, stale/membership/generation/race/replay, deterministic results.

### Phase 3 — Runner, transport và health

- Refactor nhỏ GatewayRunner.execute ở đoạn plan/attempt loop sang policy decisions; giữ persistence/usage/cache/protocol paths. Revalidate after errors; attempts actual dispatch; reserve/replay bounded.
- Chuẩn hóa timeout/cancellation trong upstream/client.ts cho non-stream và streaming, soft vs hard reason. Non-stream use complete latency, streaming measure meaningful content + successful completion. Fix client disconnect propagation.
- Cải tiến routing/circuit.ts lease và scope error classification; model hard health nếu rõ ràng. Điều chỉnh direct model path không làm nó route sang model khác. Test circuit, failure classification, upstream mock, stream boundaries.
- Tích hợp reason codes selection: priority, relative_faster, recovery_probe, exploratory_sample, fallback_after_error, slow_reserve, rescue_replay, all_slow, skip_hard_blocked. Không đổi user-set order.

### Phase 4 — Admin/UI/observability

- src/server/routes/admin/combos.ts: giữ existing fields, thêm additive status (latency kind, median/sample count/freshness, state, probe due, comparator/reason, optional overall deadline) và reset-state action audited. Không để reset/reorder stale lease.
- src/web/app/pages/combos.tsx: show rank, health vs slow degradation, timing kind, recent median/sample count, next recovery, reason; badges rõ Preferred/Ready/Degraded/Probing/Down, không gọi mọi cooldown unavailable. Chỉ hiển thị preferred cho workload nếu có dữ liệu; không giả một active model chung. Giữ form shadcn và light/dark. Cảnh báo attempts cap, hard deadline <= soft threshold. Advanced optional deadline.
- Logs/metrics: attempt reason, actual dispatch latency, soft timeout/rescue/failback/probe count, all-hard-blocked, no raw prompts/credentials, bounded labels; request explorer hiển thị sequence A→B→A và actual attempts. Test cache hit no sample, statistics and error status.
- Docs/04, 02, 08, 10, 13, README/changelog cập nhật hành vi, defaults, migration/rollback/limitations.

### Phase 5 — Regression, load và release

- Mock provider controllable delays/errors; Vitest fake clock và barrier concurrency, không sleep 5 phút. HTTP integration OpenAI chat/responses và Anthropic messages, cả streaming/non-streaming, alias/ACL, admin/backup.
- Playwright combo reorder/edit, state badges, test combo, old provider creation reject và logs rescue sequence.
- pnpm lint, typecheck, unit/integration, critical Playwright, package build/pack, migrations fresh/upgrade, Docker build + compose health khi môi trường có Docker. Re-index, detect_changes trước commit. Báo blocker thật nếu thiếu runtime/tooling.
- Canary vận hành: so success rate, TTFT, p95 end-to-end, attempts/request, soft timeout count, failback frequency, 503 all-blocked trước/sau bằng traffic mock và staging; không đo chi phí. Tuning chỉ sau số liệu. Rollback bằng backup trước migration; tắt adaptive switch để ordered fallback mà không downgrade schema.

## 10. Ma trận nghiệm thu bắt buộc

| Scenario | Expected |
| --- | --- |
| Cold start, A/B unknown | A trước |
| A 10s, B 9s đủ mẫu | A vì tương đương |
| A 30s, B 8s, đủ evidence | B; A probe có lịch |
| A spike một lần rồi nhanh | Không đổi ưu tiên dài hạn |
| A slow liên tiếp 3 lần, B nhanh | B; A reserve |
| A cooldown, B 503 | B -> A rescue ngay nếu trigger bật |
| A cooldown, B hard circuit open trước request | A rescue ngay |
| A cooldown, B 429 | A nếu trigger bật; không chờ Retry-After dài |
| A soft timeout, B hard fail, cap=3 | A -> B -> A rescue replay một lần |
| Tình huống trên cap=2 | Không attempt thứ ba |
| A/B đều cooldown còn hoạt động | Không trả 503 chỉ vì slow |
| A=70s, B=72s; threshold 60s, hard >72s | Cho complete/đo mẫu, đủ evidence quay A |
| Chỉ một model chậm | Cho hoàn thành đến hard deadline |
| A/B đều hard down | 503, không bypass breaker |
| A trở lại 9s, B 8s; 2 successful recovery probes | A |
| A probe một lần nhanh rồi lỗi | Không promote; backoff |
| Latency dao động trong hysteresis | Không flip mỗi request |
| Comparator B chết / sample stale | Relative demotion không pin A |
| A/B/C/D nhiều tình trạng | Chọn candidate khả dụng theo policy; rescue không hardcode hai member |
| A không support tool/vision/JSON | B; không rescue A |
| Admin disable/delete/re-add trong flight | Không dispatch stale; late outcome không resurrect |
| A/B cùng provider, lỗi chỉ ở A | B có thể phục vụ, không open provider vô lý |
| Provider-wide circuit open | Skip mọi model provider, thử provider khác |
| 100 concurrent recovery requests | 1 probe/lease scope; normal/reserve traffic vẫn có đường |
| Lease expiry, old owner finish muộn | Không ghi đè new lease/state |
| Metadata-only SSE, empty 200, invalid JSON | Không fast sample; fallback nếu policy cho phép |
| First meaningful content rồi stream error | Không fallback, log partial; recovery không promote |
| TTFT nhanh, stream completion dài | Không soft-abort sau commit |
| Client disconnect trước/sau commit | Cancel upstream, không attempt thêm |
| Cache hit | Không học sample hoặc claim probe |
| Fallback trigger off | Dừng đúng policy |
| maxAttempts 1/2/3, skip trước dispatch | Không vượt cap, skip không tốn |
| Streaming vs non-stream / reasoning workload | Không nhiễm latency bucket |
| Hard timeout nhỏ hơn soft | Hard reason thắng |
| Overall deadline hết | Abort; không dispatch thêm |
| Config edit/restart/restore | Không stale lease, state không kẹt |
| Direct model, alias-to-model | Không fallback sang physical model khác |
| Adaptive switch off | Ordered fallback đúng position và triggers |
| Upgrade DB chứa legacy + supported | Xóa active legacy config/accounts; giữ supported, history, ACL |
| Combo chỉ chứa legacy | Disable rõ lý do; không tự chọn model ngoài combo |
| API key restricted mất allowlist cuối | Vẫn deny, không mở quyền |
| Old full/compact backup có legacy | Staging migrate sạch; không resurrect legacy |
| Legacy create/import route | Unsupported type 400 / removed endpoint 404 |
| Model tên có chữ codex/qoder nhưng provider compatible | Không bị xóa vì tên |
| Fresh install + restart | Schema chỉ hai provider, không legacy account tables |

## 11. Điểm cần review trước triển khai

- Baseline: cleanup provider legacy đã triển khai độc lập, generic request history/statistics vẫn giữ; operator backup trước khi upgrade, immutable migration history giữ nguyên.
- Chọn passive recovery + bounded exploration, không background LLM calls, không hedging. Tốc độ tương đương được định nghĩa bằng 20% hoặc 2 giây; relative demotion cần 30% hoặc 3 giây. Các ngưỡng này cần được kiểm chứng bằng traffic thực sau triển khai.
- Last viable model/rescue được phép vượt soft threshold nhưng không vượt provider hard timeout; nếu đã soft-abort cùng request, chỉ replay một lần khi còn budget.
- Không cam kết tất cả models sẽ được thử khi maxTotalAttempts thấp, không đảm bảo failback tức thời khi không có traffic hoặc không có sample đủ tin cậy. Không đo chất lượng output; ưu tiên admin biểu thị lựa chọn chất lượng.
- Adaptive routing đã được triển khai trên branch riêng theo phê duyệt. Migration 0015 giữ nguyên migration cũ, đổi slow history thành workload-aware state, thêm optional overall deadline và reset lease/epoch khi mở database. Test mới ở `tests/unit/combo-policy.test.ts`, `tests/unit/combo-adaptive-state.test.ts` và các integration test tương ứng. Để giảm tải máy phát triển, chỉ chạy tập trung các test thay đổi ở local; CI chịu trách nhiệm lint/typecheck/full suite/build/package, Playwright smoke và Docker Compose smoke trên runner độc lập. Kết quả CI, canary traffic và tuning production vẫn cần xác nhận trước release. Không merge hoặc deploy tự động từ branch phát triển.
