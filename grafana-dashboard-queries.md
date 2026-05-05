# Grafana Dashboard Queries — Realtime Degrade Mode 장애 테스트

## 사전 조건

### build.gradle 확인 (이미 추가됨)
```groovy
implementation 'org.springframework.boot:spring-boot-starter-actuator'
implementation 'io.micrometer:micrometer-registry-prometheus'
```

### application.yml
```yaml
management:
  endpoints:
    web:
      exposure:
        include: prometheus, health, info
  metrics:
    export:
      prometheus:
        enabled: true
```

### prometheus.yml (Docker Compose)
```yaml
scrape_configs:
  - job_name: 'trader-backend'
    scrape_interval: 5s
    static_configs:
      - targets: ['host.docker.internal:8080']
    metrics_path: '/actuator/prometheus'
```

---

## Micrometer → Prometheus 네이밍 규칙

| Micrometer 코드 | Prometheus 메트릭명 |
|----------------|-------------------|
| `counter("realtime.relay")` | `realtime_relay_total` |
| `timer("realtime.relay.latency")` | `realtime_relay_latency_seconds_bucket/count/sum` |
| `counter("realtime.kafka.publish")` | `realtime_kafka_publish_total` |
| `timer("realtime.kafka.publish.latency")` | `realtime_kafka_publish_latency_seconds_bucket/count/sum` |
| `timer("realtime.outbox.save.latency")` | `realtime_outbox_save_latency_seconds_bucket/count/sum` |
| `counter("realtime.outbox.save")` | `realtime_outbox_save_total` |
| `counter("realtime.kafka.consume.redis")` | `realtime_kafka_consume_total` |
| `counter("realtime.volatile.relay")` | `realtime_volatile_relay_total` |
| `timer("realtime.volatile.relay.latency")` | `realtime_volatile_relay_latency_seconds_bucket/count/sum` |

---

## Row 1 — 정상 상태 Baseline (Reliable)

### [패널 1] API p95 Latency
```promql
histogram_quantile(0.95,
  rate(http_server_requests_seconds_bucket{
    uri!~".*/actuator.*"
  }[1m])
)
```
> Panel type: Time series | Unit: seconds

---

### [패널 2] Kafka Publish 초당 성공 건수
```promql
rate(realtime_kafka_publish_total{result="success"}[1m])
```
> Panel type: Time series | 정상 상태에서 0 이상 유지 확인

---

### [패널 3] Kafka Publish Latency p95
```promql
histogram_quantile(0.95,
  rate(realtime_kafka_publish_latency_seconds_bucket[1m])
)
```
> Panel type: Time series | Unit: seconds

---

### [패널 4] Kafka Consume → Redis Pub/Sub 성공률
```promql
rate(realtime_kafka_consume_total{result="success"}[1m])
/
(
  rate(realtime_kafka_consume_total{result="success"}[1m])
  + rate(realtime_kafka_consume_total{result="failed"}[1m])
)
```
> Panel type: Gauge | Unit: percentunit (0~1) | 정상 상태에서 1.0 유지

---

### [패널 5] Kafka Consume → Redis 성공 / 실패 건수 비교
```promql
rate(realtime_kafka_consume_total[1m])
```
> Panel type: Time series | Legend: `{{result}}` | result=success/failed 라인 비교

---

## Row 2 — 정상 상태 Baseline (Volatile)

### [패널 6] Volatile Publish 초당 건수 (routeMode별)
```promql
rate(realtime_volatile_relay_total[1m])
```
> Panel type: Time series | Legend: `{{path}}` | 정상 상태에서 dropped=0 확인

---

### [패널 7] Volatile Drop Rate
```promql
rate(realtime_volatile_relay_total{path="dropped"}[1m])
/
rate(realtime_volatile_relay_total[1m])
```
> Panel type: Gauge | Unit: percentunit | 정상 상태에서 0%

---

## Row 3 — Degrade Mode (Reliable — Redis Pub/Sub 장애 시)

### [패널 8] Reliable Relay 경로별 건수
```promql
rate(realtime_relay_total[1m])
```
> Panel type: Time series | Legend: `{{path}}` | path=grpc/http/dropped 라인 비교
> Redis 장애 시 grpc 또는 http 라인이 증가하는 것을 확인

---

### [패널 9] Reliable Relay Latency p95 (경로별)
```promql
histogram_quantile(0.95,
  rate(realtime_relay_latency_seconds_bucket[1m])
)
```
> Panel type: Time series | Legend: `{{path}}` | Unit: seconds
> gRPC vs HTTP latency 비교에 사용

---

### [패널 10] Reliable Relay — gRPC vs HTTP 평균 Latency 비교
```promql
rate(realtime_relay_latency_seconds_sum[1m])
/
rate(realtime_relay_latency_seconds_count[1m])
```
> Panel type: Bar gauge | Legend: `{{path}}` | Unit: seconds
> gRPC/HTTP 결정 근거 자료로 사용

---

### [패널 11] Reliable Drop 건수 (gRPC/HTTP 모두 실패 시)
```promql
rate(realtime_relay_total{path="dropped"}[1m])
```
> Panel type: Time series | 임계치 알람용 — 이 수치가 0 이상이면 relay 모두 실패

---

## Row 4 — Degrade Mode (Kafka 장애 시)

### [패널 12] Kafka Publish 시도 / 성공 / 실패 건수
```promql
rate(realtime_kafka_publish_total[1m])
```
> Panel type: Time series | Legend: `{{result}}` | result=attempt/success/failed
> Kafka down 시 failed 라인이 증가하는 것을 확인

---

### [패널 13] Outbox Save 건수 (초당)
```promql
rate(realtime_outbox_save_total{result="success"}[1m])
```
> Panel type: Time series | Kafka 장애 시 이 수치가 증가해야 정상 동작

---

### [패널 14] Outbox Save Latency p95
```promql
histogram_quantile(0.95,
  rate(realtime_outbox_save_latency_seconds_bucket[1m])
)
```
> Panel type: Time series | Unit: seconds | DB 저장 지연 확인

---

### [패널 15] Kafka Publish 실패율
```promql
rate(realtime_kafka_publish_total{result="failed"}[1m])
/
rate(realtime_kafka_publish_total{result="attempt"}[1m])
```
> Panel type: Gauge | Unit: percentunit | Kafka down 시 1.0(100%)에 수렴하는 것 확인

---

## Row 5 — Degrade Mode (Volatile — Redis Pub/Sub 장애 시)

### [패널 16] Volatile Drop 건수 (초당)
```promql
rate(realtime_volatile_relay_total{path="dropped"}[1m])
```
> Panel type: Time series | Redis 장애 시 drop 허용 확인

---

### [패널 17] Volatile relay 실험 — gRPC vs HTTP 건수
```promql
rate(realtime_volatile_relay_total{path=~"grpc|http"}[1m])
```
> Panel type: Time series | Legend: `{{path}}` | routeMode 변경 실험 시 사용

---

### [패널 18] Volatile relay 실험 — gRPC vs HTTP Latency p95
```promql
histogram_quantile(0.95,
  rate(realtime_volatile_relay_latency_seconds_bucket[1m])
)
```
> Panel type: Time series | Legend: `{{path}}` | Unit: seconds

---

## Row 6 — 시스템 리소스 (장애 전/후 비교)

### [패널 19] JVM Heap 사용량
```promql
jvm_memory_used_bytes{area="heap"}
```
> Panel type: Time series | Unit: bytes | 장애 상황에서 메모리 증가 없는지 확인

---

### [패널 20] CPU 사용률
```promql
process_cpu_usage
```
> Panel type: Time series | Unit: percentunit | relay/outbox 처리 시 CPU 영향 확인

---

### [패널 21] GC Pause 시간
```promql
rate(jvm_gc_pause_seconds_sum[1m])
```
> Panel type: Time series | Unit: seconds | relay 폭주 시 GC 압박 확인

---

### [패널 22] HTTP 요청 에러율 (5xx)
```promql
rate(http_server_requests_seconds_count{status=~"5.."}[1m])
/
rate(http_server_requests_seconds_count[1m])
```
> Panel type: Time series | Unit: percentunit | 장애가 API 레이어까지 전파되는지 확인

---

## Row 7 — Spring Kafka 내장 메트릭 (Kafka 장애 확인 보조)

### [패널 23] Kafka Consumer Lag (최대)
```promql
kafka_consumer_fetch_manager_records_lag_max
```
> Panel type: Time series | Kafka down 시 lag이 쌓이는 것 확인
> 인스턴스에서 노출 안 되면 생략 가능

---

### [패널 24] Kafka Listener 처리 시간 p95
```promql
histogram_quantile(0.95,
  rate(spring_kafka_listener_seconds_bucket[1m])
)
```
> Panel type: Time series | Unit: seconds | consume 처리 시간 확인

---

## Row 8 — eBPF (커널/네트워크/디스크 레벨 보조 지표)

> eBPF exporter가 Docker Compose에 추가된 경우에만 사용
> 앱 메트릭만으로 확인하기 어려운 시스템 레벨 영향을 보조적으로 검증

### [패널 25] TCP Retransmit Rate (네트워크 재전송)
```promql
rate(ebpf_exporter_tcp_retransmit_total[1m])
```
> Panel type: Time series | Unit: ops/s
> relay(gRPC/HTTP), Kafka 통신 장애 시 재전송 증가 여부 확인

---

### [패널 26] Disk Write Latency p95 (Outbox / DB write 영향)
```promql
histogram_quantile(0.95,
  rate(ebpf_exporter_ext4_latency_seconds_bucket{operation="write"}[1m])
)
```
> Panel type: Time series | Unit: seconds
> Kafka 장애 → outbox save 증가 시 디스크 write latency 영향 확인

---

### [패널 27] Disk Read Latency p95 (DB fallback 영향)
```promql
histogram_quantile(0.95,
  rate(ebpf_exporter_ext4_latency_seconds_bucket{operation="read"}[1m])
)
```
> Panel type: Time series | Unit: seconds
> Redis 장애 → DB 전체 조회 증가 시 read latency 확인

---

### [패널 28] OOM Kill 발생 여부
```promql
increase(ebpf_exporter_oom_kill_total[5m])
```
> Panel type: Stat | 리소스 고갈 상황에서 프로세스 강제 종료 여부 확인

---

## Row 9 — 로그 기반 흐름 검증

> 메트릭은 수치를 보여주고, 로그는 **어떤 경로로 전파되었는지** 흐름을 증명한다.
> logstash-logback-encoder 기준 JSON 출력이므로 grep/Loki 둘 다 사용 가능.

### 로그 태그 전체 목록 (코드 기준)

| 태그 | 위치 | 레벨 | 의미 |
|------|------|------|------|
| `[VOLATILE-ROUTE]` | DegradableVolatilePublisher | INFO | Volatile 발행 시작, routeMode 확인 |
| `[VOLATILE]` | DegradableVolatilePublisher | DEBUG | Volatile publish 실패/skip |
| `[VOLATILE-gRPC]` | GrpcVolatilePublisher | DEBUG | gRPC publish skip (예외 발생 시) |
| `[VOLATILE-HTTP]` | HttpVolatilePublisher | DEBUG | HTTP publish skip (예외 발생 시) |
| `[VOLATILE-INBOUND]` | VolatileInboundHandler | INFO | Volatile 수신 후 broadcast |
| `[RELIABLE-REDIS-PUBLISH]` | DegradableReliablePublisher | INFO | Redis Pub/Sub 발행 시작 |
| `[RELIABLE-INBOUND]` | ReliableInboundHandler | INFO | Reliable 수신 후 broadcast |
| `[REALTIME]` | DegradableReliablePublisher | WARN | Redis Pub/Sub 실패 → relay 시도 |
| `[REALTIME-RELAY]` | DegradableReliablePublisher | WARN | relay 경로 (gRPC/HTTP/dropped) |
| `[REALTIME-OUTBOX]` | DegradableReliablePublisher | WARN | Kafka 실패 → outbox 저장 |
| `[REALTIME-OUTBOX-SAVED]` | RealtimeOutboxService | WARN | outbox DB 저장 완료 |
| `[REALTIME-OUTBOX-SKIP]` | RealtimeOutboxService | DEBUG | Volatile 이벤트 → outbox 저장 생략 |
| `[REALTIME-OUTBOX-DUPLICATE]` | RealtimeOutboxService | DEBUG | eventId 중복 → 저장 생략 |
| `[REALTIME-OUTBOX-RACE-DUPLICATE]` | RealtimeOutboxService | DEBUG | 동시 저장 경합 → 중복 처리 |
| `[REALTIME-OUTBOX-REPUBLISH-START]` | RealtimeOutboxRepublishScheduler | INFO | outbox 재발행 스케줄러 시작 |
| `[REALTIME-OUTBOX-REPUBLISH-SENT]` | RealtimeOutboxRepublishScheduler | INFO | outbox → Kafka 재발행 성공 |
| `[REALTIME-OUTBOX-REPUBLISH-FAILED]` | RealtimeOutboxRepublishScheduler | WARN | outbox 재발행 실패 |
| `[KAFKA-CONSUMER]` | KafkaConsumer | WARN | Kafka consume 후 Redis 실패 |
| `[KAFKA-CONSUMER-RELAY]` | KafkaConsumer | WARN | Kafka consumer relay 경로 |
| `[KAFKA]` | KafkaReliablePublisher / DefaultKafkaHealthChecker | WARN | Kafka publish 실패 / 헬스체크 실패 |
| `[REALTIME-HEALTH]` | RealtimeHealthCheckScheduler | DEBUG | 헬스체크 결과 (redis/kafka/grpc/http) |

---

### 시나리오별 기대 로그 시퀀스

#### 시나리오 1 — 정상 상태 (Reliable 전체 흐름)

```
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx, subType=LOCK_ACQUIRED
INFO  [KAFKA] publish attempt (내부 kafkaTemplate.send)
INFO  [RELIABLE-INBOUND] roomKey=team:1:graph:2, eventId=xxx   ← 다른 인스턴스 수신
```

> Redis Pub/Sub → 수신 인스턴스 RELIABLE-INBOUND까지 도달 확인

---

#### 시나리오 2 — 정상 상태 (Volatile 전체 흐름)

```
INFO  [VOLATILE-ROUTE] mode=redis, eventId=xxx
INFO  [VOLATILE-INBOUND] roomKey=team:1:graph:2, latestKey=xxx  ← 다른 인스턴스 수신
```

> VOLATILE-ROUTE → VOLATILE-INBOUND까지 이어지는 것 확인

---

#### 시나리오 3 — Redis Pub/Sub 장애 (Reliable → gRPC relay)

```
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx, subType=LOCK_ACQUIRED
WARN  [REALTIME] Redis Pub/Sub failed, trying relay. eventId=xxx, reason=...
WARN  [REALTIME-RELAY] relayed via gRPC. eventId=xxx
INFO  [RELIABLE-INBOUND] roomKey=team:1:graph:2, eventId=xxx   ← gRPC 수신 인스턴스
```

> REALTIME → REALTIME-RELAY(gRPC) → RELIABLE-INBOUND 흐름 확인

---

#### 시나리오 4 — Redis Pub/Sub 장애 (Reliable → HTTP relay)

```
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx, subType=LOCK_ACQUIRED
WARN  [REALTIME] Redis Pub/Sub failed, trying relay. eventId=xxx, reason=...
WARN  [REALTIME-RELAY] relayed via HTTP. eventId=xxx
```

> gRPC 불가 → HTTP로 넘어가는 순서 확인

---

#### 시나리오 5 — Redis Pub/Sub 장애 (gRPC/HTTP 모두 불가 → drop)

```
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx, subType=LOCK_ACQUIRED
WARN  [REALTIME] Redis Pub/Sub failed, trying relay. eventId=xxx, reason=...
WARN  [REALTIME-RELAY] no relay available. eventId=xxx dropped.
```

> drop 발생 확인 — 이 로그와 메트릭 패널 11(dropped count) 동시 캡처

---

#### 시나리오 6 — Kafka 장애 (outbox 저장)

```
WARN  [KAFKA] publish failed: ...
WARN  [REALTIME-OUTBOX] Kafka publish failed. saved to outbox. eventId=xxx, reason=...
WARN  [REALTIME-OUTBOX-SAVED] eventId=xxx, graphId=2, subType=LOCK_ACQUIRED
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx, subType=LOCK_ACQUIRED   ← Redis는 정상 전파
```

> Kafka 실패 → outbox 저장 → Redis 전파는 계속 진행 확인

---

#### 시나리오 7 — Outbox 재발행 (Kafka 복구 후)

```
INFO  [REALTIME-OUTBOX-REPUBLISH-START] size=5
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=xxx, graphId=2, subType=LOCK_ACQUIRED
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=yyy, graphId=2, subType=NODE_EDIT
```

> 스케줄러가 PENDING 이벤트를 순차 재발행하는 흐름 확인

---

#### 시나리오 8 — Kafka Consumer Redis 실패 → relay

```
WARN  [KAFKA-CONSUMER] Redis Pub/Sub failed, trying relay. eventId=xxx, reason=...
WARN  [KAFKA-CONSUMER-RELAY] relayed via gRPC. eventId=xxx
```

> Kafka consumer 경로에서 Redis 장애 시 relay 동작 확인
> DegradableReliablePublisher의 relay와 별도 경로임에 주의

---

#### 시나리오 9 — Volatile drop (Redis 장애)

```
INFO  [VOLATILE-ROUTE] mode=redis, eventId=xxx
DEBUG [VOLATILE] publish skipped. routeMode=redis, eventId=xxx, reason=Redis unavailable
```

> VOLATILE-ROUTE 직후 skipped — VOLATILE-INBOUND 없이 종료됨을 확인
> 메트릭 패널 16(dropped count) 동시 캡처

---

### grep 패턴 (로컬 로그 파일 직접 확인)

```bash
# Degrade 진입 전체 (Redis Pub/Sub 실패)
grep -E "\[REALTIME\]|\[KAFKA-CONSUMER\]" app.log

# relay 경로 확인
grep -E "\[REALTIME-RELAY\]|\[KAFKA-CONSUMER-RELAY\]" app.log

# drop만 필터
grep "dropped\." app.log

# Outbox 흐름 전체
grep -E "\[REALTIME-OUTBOX" app.log

# Outbox 재발행
grep -E "\[REALTIME-OUTBOX-REPUBLISH" app.log

# 특정 eventId 전체 추적
grep "eventId=abc-123" app.log

# 헬스체크 결과 확인
grep "\[REALTIME-HEALTH\]" app.log
```

---

### Loki LogQL (Grafana Loki 연동 시)

> Promtail + Loki를 Docker Compose에 추가한 경우 사용
> logstash-logback-encoder JSON 출력이므로 `| json` 파서 사용

```logql
# Degrade 진입 로그
{job="trader-backend"} |= "[REALTIME]" or "[KAFKA-CONSUMER]"

# relay 경로별 필터
{job="trader-backend"} |= "[REALTIME-RELAY]" | json | line_format "{{.message}}"

# drop 발생만
{job="trader-backend"} |= "dropped."

# Outbox 저장 로그
{job="trader-backend"} |= "[REALTIME-OUTBOX-SAVED]"

# Outbox 재발행 성공/실패
{job="trader-backend"} |= "[REALTIME-OUTBOX-REPUBLISH"

# 특정 eventId 전체 생애주기 추적
{job="trader-backend"} |= "eventId=abc-123-def"

# 헬스체크 상태 변화 (WARN 레벨만)
{job="trader-backend"} | json | level="WARN" |= "[REALTIME-HEALTH]"
```

---

### 로그 + 메트릭 동시 캡처 기준

| 시나리오 | 로그에서 확인할 태그 | 메트릭 패널 |
|---------|-------------------|-----------|
| 정상 Reliable 흐름 | RELIABLE-REDIS-PUBLISH → RELIABLE-INBOUND | 패널 2, 3 |
| 정상 Volatile 흐름 | VOLATILE-ROUTE → VOLATILE-INBOUND | 패널 6 |
| Redis 장애 → gRPC relay | REALTIME → REALTIME-RELAY(gRPC) | 패널 8, 9 |
| Redis 장애 → HTTP relay | REALTIME → REALTIME-RELAY(HTTP) | 패널 8, 9 |
| gRPC/HTTP 모두 실패 → drop | REALTIME-RELAY(dropped) | 패널 11 |
| Kafka 장애 → outbox | REALTIME-OUTBOX → REALTIME-OUTBOX-SAVED | 패널 12, 13, 14 |
| Kafka 복구 → 재발행 | REALTIME-OUTBOX-REPUBLISH-START → SENT | 패널 13 |
| Volatile drop | VOLATILE → publish skipped | 패널 16 |

---

## 패널 배치 요약 (대시보드 구성 순서)

| Row | 패널 번호 | 테스트 시나리오 |
|-----|---------|---------------|
| Row 1 | 1~5 | 정상 Baseline — Reliable |
| Row 2 | 6~7 | 정상 Baseline — Volatile |
| Row 3 | 8~11 | Degrade — Redis Pub/Sub 장애 (Reliable relay) |
| Row 4 | 12~15 | Degrade — Kafka 장애 (Outbox) |
| Row 5 | 16~18 | Degrade — Volatile drop / relay 실험 |
| Row 6 | 19~22 | 시스템 리소스 |
| Row 7 | 23~24 | Kafka 내장 메트릭 보조 |
| Row 8 | 25~28 | eBPF (네트워크/디스크/커널 레벨) |
| Row 9 | — | 로그 기반 흐름 검증 (grep / LogQL) |

---

## 핵심 검증 포인트 (스크린샷 캡처 기준)

| 시나리오 | 캡처해야 할 것 | 기대 동작 |
|---------|-------------|---------|
| 정상 상태 | 패널 2, 3, 4, 6 + 시나리오 1,2 로그 | Kafka success↑, drop=0 |
| Redis Pub/Sub 장애 | 패널 8, 9, 11 + 시나리오 3,4,5 로그 | grpc/http 라인 증가, drop 확인 |
| Kafka 장애 | 패널 12, 13, 14, 15 + 시나리오 6 로그 | failed↑, outbox save↑ |
| Kafka 복구 | 패널 13 + 시나리오 7 로그 | REPUBLISH-SENT 순차 출력 |
| gRPC vs HTTP 비교 | 패널 9, 10, 17, 18 | latency 수치 비교 |
| Volatile drop 허용 | 패널 16, 17 + 시나리오 9 로그 | dropped↑, 시스템 지연 없음 |
| 시스템 영향 없음 증명 | 패널 19, 20, 22 | 장애 전후 heap/CPU 안정적 |

---

---

# 심화 검증 — 면접관 예상 질문 대응

---

## 검증 A — 헬스체크 갭 이중 방어 확인

### 배경

`RealtimeHealthCheckScheduler`는 5초 주기로 헬스 상태를 갱신한다.
Redis가 다운됐을 때 최대 5초간 `isRedisAvailable() = true` 상태가 유지될 수 있다.
이 갭 구간에서 실제로 relay가 동작하는지 확인한다.

### 검증 방법

```
1. Redis를 정상 상태로 기동
2. 이벤트 발행 시작
3. Redis를 강제 종료 (docker stop redis)
4. 헬스체크 갱신 전(5초 이내)에 이벤트 발행
5. 로그에서 흐름 확인
```

### 기대 로그 시퀀스

```
# 헬스체크가 아직 갱신 안 된 상태
INFO  [RELIABLE-REDIS-PUBLISH] eventId=xxx          ← isRedisAvailable=true로 진입
WARN  [REALTIME] Redis Pub/Sub failed, trying relay. eventId=xxx   ← 실제 publish 시 실패 감지
WARN  [REALTIME-RELAY] relayed via gRPC. eventId=xxx              ← try-catch 이중 방어 동작

# 헬스체크 갱신 이후
DEBUG [REALTIME-HEALTH] redis=false, kafka=true, grpc=true, http=true
WARN  [REALTIME] Redis Pub/Sub failed, trying relay. eventId=yyy   ← 이후에도 동일 경로
```

### 검증 포인트

- 헬스체크 갱신 전에도 relay가 동작하는가 → **try-catch 이중 방어로 보장**
- 헬스체크 갱신 후 동작이 동일한가 → **`isRedisAvailable=false` 이후에도 동일 경로**
- 갭 구간 동안 drop이 발생하지 않는가 → **패널 11(dropped count) = 0 확인**

### 문서에 명시할 설계 판단

> 헬스체크는 불필요한 publish 시도를 줄이기 위한 선제 차단이다.
> 실제 장애 감지는 try-catch 기반 실패 처리가 담당한다.
> 따라서 헬스체크 주기(5초)와 무관하게 이벤트 유실이 발생하지 않는다.

---

## 검증 B — Dedup 경계 동작 확인

### 배경

`RealtimeEventDeduplicator`는 Redis에 `realtime:event:seen:{eventId}` 키를 TTL 10분으로 저장한다.
Outbox 재발행 시 동일 eventId가 다시 Kafka로 발행되면 consumer에서 중복 처리를 막아야 한다.

### 검증 방법 — TTL 이내 중복 방지

```
1. Kafka 장애 → outbox 저장 (eventId=A)
2. Kafka 복구 → outbox scheduler가 eventId=A 재발행
3. KafkaConsumer가 eventId=A 소비
4. deduplicator.isDuplicate("A") = true → 처리 생략 확인
```

### 기대 로그

```
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=A    ← 재발행
# KafkaConsumer에서 별도 로그 없이 조용히 skip됨 (isDuplicate=true → early return)
```

### 검증 방법 — TTL 초과 시 중복 허용 (설계 한계 명시)

```
1. eventId=A로 이벤트 발행 (dedup TTL 10분 설정)
2. application.yml에서 TTL을 10초로 임시 단축
3. 10초 후 동일 eventId=A로 재발행
4. consumer가 중복 처리하는지 확인
```

### 문서에 명시할 설계 판단

> 현재 dedup은 Redis TTL 10분 이내에서만 중복을 차단한다.
> TTL 초과 후 동일 eventId가 재발행되면 중복 전파가 발생할 수 있다.
> 실시간 캔버스 이벤트 특성상 최신 상태가 덮어쓰는 구조이므로 실용적 영향은 제한적이다.
> TTL은 운영 환경에서 replay 주기를 고려하여 조정이 필요하다.

---

## 검증 C — Outbox 이벤트 순서 역전 가능성 확인

### 배경

`RealtimeOutboxRepublishScheduler`는 `createdAt ASC` 순으로 재발행한다.
단, Kafka 파티션 키가 설정되지 않으면 재발행된 이벤트가 다른 파티션으로 분산될 수 있다.
같은 graphId의 이벤트가 서로 다른 파티션에 들어가면 consumer 처리 순서가 역전될 수 있다.

### 검증 방법

```
1. 동일 graphId에 대해 이벤트 3개 발행 (eventId=A, B, C, createdAt 순)
2. Kafka를 장애 처리하여 outbox에 3개 저장
3. Kafka 복구 후 재발행
4. KafkaConsumer 수신 순서 로그로 확인
```

### 기대 로그 (순서 보장 시)

```
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=A
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=B
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=C
# consumer 수신도 A → B → C 순
```

### 역전 발생 시 로그

```
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=A
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=B
INFO  [REALTIME-OUTBOX-REPUBLISH-SENT] eventId=C
# consumer 수신은 A → C → B 순 (파티션 분산으로 역전)
```

### 문서에 명시할 설계 판단

> 현재 KafkaReliablePublisher의 파티션 키는 별도로 설정되어 있지 않다.
> graphId를 파티션 키로 사용하면 동일 그래프의 이벤트가 동일 파티션에 순서대로 적재된다.
> 실시간 캔버스 이벤트 특성상 순서 역전이 UX에 미치는 영향은 "일시적 상태 불일치"이며,
> 다음 이벤트 도착 시 자연스럽게 정합성이 회복된다.

### 개선 방향 (향후 적용 시)

```java
// KafkaReliablePublisher에서 graphId를 파티션 키로 사용
kafkaTemplate.send(topic, String.valueOf(event.getGraphId()), event)
             .get(1, TimeUnit.SECONDS);
```

---

## 검증 D — MTTR (Mean Time To Recovery) 측정

### 목적

장애 발생 시점부터 정상 전파 재개까지 걸리는 시간을 측정한다.
Degrade Mode 적용의 실질적 UX 효과를 수치로 증명하는 자료가 된다.

### 측정 방법

```
1. 정상 상태에서 이벤트 발행 시작 (t=0)
2. Redis 또는 Kafka 강제 종료 (t=T_down)
3. 마지막 정상 전파 로그 시각 기록 → T_last_ok
4. 첫 번째 relay/outbox 동작 로그 시각 기록 → T_first_degrade
5. 장애 서비스 복구 (t=T_up)
6. 첫 번째 정상 전파 재개 로그 시각 기록 → T_first_recovery
```

### MTTR 계산

```
장애 감지 시간 = T_first_degrade - T_last_ok
               (헬스체크 주기 최대 5초 + try-catch 즉시 감지)

서비스 복구 시간 = T_first_recovery - T_up
                 (헬스체크 재갱신 최대 5초 + Redis/Kafka 재연결 시간)
```

### Grafana에서 측정할 PromQL

```promql
# 장애 진입 시점 — relay 첫 발생 시각
min(timestamp(realtime_relay_total > 0))

# 정상 복구 시점 — relay 종료 후 Redis publish success 재개
min(timestamp(rate(realtime_kafka_consume_total{result="success"}[30s]) > 0))
```

### 문서에 기록할 항목

| 측정 항목 | Redis 장애 | Kafka 장애 |
|---------|-----------|-----------|
| 장애 감지 시간 | 실측값 기록 | 실측값 기록 |
| Degrade 전환 시간 | 실측값 기록 | 실측값 기록 |
| 서비스 복구 시간 | 실측값 기록 | 실측값 기록 |
| 이벤트 유실 건수 | 실측값 기록 | 실측값 기록 |

---

## 검증 E — Alert Rule 정의 (운영 기준)

### 목적

Degrade Mode 진입을 사람이 인지할 수 있도록 임계값 기반 Alert를 정의한다.
실제 발동 여부는 장애 테스트 중 확인한다.

### Alert Rule 목록

#### Alert 1 — Redis relay 진입 (Degrade 시작)
```yaml
# Grafana Alert Rule
expr: rate(realtime_relay_total[1m]) > 0
for: 10s
labels:
  severity: warning
annotations:
  summary: "Realtime relay activated — Redis Pub/Sub may be down"
  description: "relay path={{ $labels.path }}, rate={{ $value }}"
```

#### Alert 2 — relay drop 발생 (relay 모두 실패)
```yaml
expr: rate(realtime_relay_total{path="dropped"}[1m]) > 0
for: 5s
labels:
  severity: critical
annotations:
  summary: "Realtime event dropped — all relay paths failed"
```

#### Alert 3 — Outbox 적재 급증 (Kafka 장애 지속)
```yaml
expr: rate(realtime_outbox_save_total[1m]) > 5
for: 30s
labels:
  severity: warning
annotations:
  summary: "Outbox accumulating — Kafka may be down"
  description: "save rate={{ $value }}/s"
```

#### Alert 4 — Outbox 재발행 실패 반복
```yaml
expr: rate(realtime_kafka_publish_total{result="failed"}[2m]) > 0
for: 1m
labels:
  severity: critical
annotations:
  summary: "Kafka republish failing — outbox not draining"
```

#### Alert 5 — Volatile drop rate 임계 초과
```yaml
expr: >
  rate(realtime_volatile_relay_total{path="dropped"}[1m])
  /
  rate(realtime_volatile_relay_total[1m])
  > 0.5
for: 30s
labels:
  severity: warning
annotations:
  summary: "Volatile drop rate > 50% — Redis Pub/Sub degraded"
```

### 장애 테스트 중 확인할 것

```
1. Redis 강제 종료 → Alert 1 발동 시각 기록
2. gRPC/HTTP 모두 종료 → Alert 2 발동 시각 기록
3. Kafka 강제 종료 30초 유지 → Alert 3 발동 시각 기록
4. Alert 발동 시각 vs 실제 장애 발생 시각 차이 = Alert 지연 시간
```

---

## 검증 F — 복구 정합성 검증 (Outbox → Kafka → Consumer)

### 목적

Kafka 장애 중 outbox에 저장된 이벤트가 복구 후 빠짐없이 재발행되었는지 확인한다.
저장 건수 = 재발행 성공 건수임을 숫자로 증명한다.

### 검증 방법

```
1. Kafka 장애 상태에서 N개 이벤트 발행 → outbox에 N개 저장 확인
2. Kafka 복구
3. outbox scheduler 실행 → REPUBLISH-SENT 로그 N개 확인
4. DB에서 outbox 상태 조회 → 전체 SENT 확인
```

### DB 조회 쿼리

```sql
-- 장애 구간 outbox 저장 건수
SELECT status, COUNT(*)
FROM realtime_outbox
WHERE created_at BETWEEN '장애시작시각' AND '장애종료시각'
GROUP BY status;

-- 기대 결과: PENDING=0, SENT=N (전량 재발행 완료)
-- 비정상: PENDING>0 → 재발행 미완료 / FAILED>0 → 재발행 실패
```

### PromQL로 건수 비교

```promql
# outbox 저장 누적 건수
increase(realtime_outbox_save_total[장애구간])

# Kafka 재발행 성공 누적 건수
increase(realtime_kafka_publish_total{result="success"}[복구구간])

# 두 값이 일치하면 정합성 보장 확인
```

---

## 검증 G — 설계 한계 명시 (정직한 포트폴리오)

> 면접관이 "완벽한 시스템이라 생각하냐"고 물었을 때의 답변 근거

### 현재 구조의 보장 범위

| 항목 | 보장 수준 | 근거 |
|------|---------|------|
| Reliable 이벤트 at-least-once | Redis TTL 10분 이내 보장 | dedup TTL 기준 |
| Volatile 이벤트 | best-effort, 유실 허용 | 최신값 덮어쓰기 구조 |
| Outbox 재발행 순서 | createdAt ASC 발행, consumer 순서 미보장 | 파티션 키 미설정 |
| 헬스체크 갭 보호 | try-catch 이중 방어로 보완 | 갭 최대 5초 |
| 장애 감지 시간 | 최대 5초 (헬스체크 주기) | try-catch로 즉시 감지 가능 |

### 향후 개선 가능 항목 (현재 미적용, 인지하고 있음)

| 항목 | 현재 | 개선 방향 |
|------|------|---------|
| Outbox 순서 보장 | 미보장 | graphId를 Kafka 파티션 키로 사용 |
| Dedup TTL 초과 중복 | 허용 | 이벤트 버전 기반 idempotent 처리 |
| 부하 상황 검증 | 단일 이벤트 기준 | k6로 동시 접속 부하 추가 예정 |
| Alert 자동화 | 수동 확인 | PagerDuty 또는 Slack webhook 연동 |
| MTTR SLO 정의 | 미정의 | 실측값 기반 목표값 설정 예정 |

---

## 전체 검증 항목 완성 체크리스트

| # | 검증 항목 | 완료 기준 |
|---|---------|---------|
| 1 | 정상 상태 Baseline (Reliable) | 메트릭 패널 1~5 캡처 + 로그 시퀀스 1 확인 |
| 2 | 정상 상태 Baseline (Volatile) | 메트릭 패널 6~7 캡처 + 로그 시퀀스 2 확인 |
| 3 | Redis Pub/Sub 장애 → gRPC relay | 패널 8,9 + 로그 시퀀스 3 |
| 4 | Redis Pub/Sub 장애 → HTTP relay | 패널 8,9 + 로그 시퀀스 4 |
| 5 | gRPC/HTTP 모두 실패 → drop | 패널 11 + 로그 시퀀스 5 |
| 6 | Kafka 장애 → outbox 저장 | 패널 12~15 + 로그 시퀀스 6 |
| 7 | Kafka 복구 → outbox 재발행 | 패널 13 + 로그 시퀀스 7 |
| 8 | Volatile drop 허용 | 패널 16 + 로그 시퀀스 9 |
| 9 | gRPC vs HTTP latency 비교 | 패널 9,10,17,18 수치 기록 |
| 10 | 시스템 리소스 안정성 | 패널 19,20,22 장애 전후 비교 |
| A | 헬스체크 갭 이중 방어 확인 | 갭 구간 relay 동작 + dropped=0 |
| B | Dedup TTL 이내 중복 방지 | outbox 재발행 후 consumer skip 확인 |
| C | Outbox 순서 역전 가능성 확인 | 수신 순서 로그 기록 + 설계 한계 명시 |
| D | MTTR 측정 | 장애 감지 시간 / 복구 시간 수치 기록 |
| E | Alert Rule 발동 확인 | 장애 테스트 중 Alert 발동 시각 기록 |
| F | 복구 정합성 확인 | outbox 저장 건수 = 재발행 성공 건수 |
| G | 설계 한계 문서화 | 보장 범위 표 + 향후 개선 항목 명시 |
