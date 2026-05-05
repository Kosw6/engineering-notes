# Recovery Process — 장애 복구 및 정합성 검증

> 이 문서는 각 장애 유형별로 **무엇을 해야 하는지 순서대로** 정리한 프로세스다.
> 완성 문서가 아니라 직접 검증하면서 채워가는 작업 기준서다.

---

## 전체 복구 프로세스 흐름

```
장애 감지 (Alert / 로그)
    ↓
장애 유형 분류
    ├── 인스턴스 장애  → 프로세스 1
    ├── Redis 장애     → 프로세스 2
    ├── Kafka 장애     → 프로세스 3
    └── 리소스 고갈   → 프로세스 4 (Scale-out)

복구 완료 후
    ├── 정합성 검증        → 프로세스 5
    ├── Kafka replay 감사  → 프로세스 6
    └── Kafka 가치 검증    → 프로세스 7 (B 서버 catch-up)
```

---

## 프로세스 1 — 인스턴스 장애 복구

### 목표
인스턴스가 죽었을 때 자동으로 재기동되고, 재기동된 인스턴스가 정상 상태로 합류하는지 확인한다.

### 해야 할 것

#### Step 1. ASG / Docker Compose 재기동 정책 설정
```yaml
# docker-compose.yml (로컬 테스트 기준)
services:
  trader-backend:
    restart: unless-stopped   # 장애 시 자동 재기동
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/actuator/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s       # 앱 기동 시간 여유
```

- [ ] `restart: unless-stopped` 설정 후 `docker kill trader-backend` → 자동 재기동 확인
- [ ] healthcheck 실패 시 재기동 트리거 확인

#### Step 2. 재기동 후 Redis warm-up 동작 확인

재기동된 인스턴스는 Redis 캐시가 비어있다.
아래 상태별로 복구 전략이 다르다.

| 상태 | 복구 전략 | 검증 방법 |
|------|---------|---------|
| 노드 락 | 복구 불필요 — TTL 만료 후 사용자가 재요청 | 재기동 후 락 점유 재시도 동작 확인 |
| version hint | Redis miss → DB fallback 자동 처리 | 재기동 직후 노드 편집 요청 → DB 조회 로그 확인 |
| autosave 캐시 | cold start 허용 → 첫 요청 시 DB 조회 | 재기동 직후 autosave 요청 → 정상 응답 확인 |

- [ ] 재기동 후 노드 편집 요청 → DB fallback 로그 확인
- [ ] 재기동 후 락 점유 요청 → 정상 처리 확인 (기존 락 만료 여부 포함)

#### Step 3. WebSocket 재연결 흐름 확인

인스턴스 재기동 시 기존 WebSocket 세션이 끊긴다.
클라이언트가 재연결 후 정상 상태로 복귀하는지 확인한다.

- [ ] 인스턴스 재기동 → 클라이언트 WebSocket 끊김 확인
- [ ] 클라이언트 재연결 → 캔버스 상태 정상 표시 확인
- [ ] 재연결 후 커서/노드 이벤트 정상 전파 확인

#### Step 4. Kafka Consumer Group 재합류 확인

재기동된 인스턴스가 Kafka consumer group에 재합류하면 partition rebalance가 발생한다.

- [ ] 재기동 후 Kafka consumer rebalance 로그 확인
- [ ] rebalance 완료 후 이벤트 소비 재개 확인
- [ ] rebalance 중 유실 이벤트 발생 여부 확인 (outbox에 저장된 것과 비교)

### 검증 지표

```promql
# 재기동 후 Kafka consume 재개 시점
rate(realtime_kafka_consume_redis_total{result="success"}[30s])

# 재기동 후 relay 종료 시점 (정상 복구 완료)
rate(realtime_relay_total[30s])
```

### 기록할 것

| 항목 | 측정값 |
|------|------|
| 재기동 소요 시간 | |
| WebSocket 재연결 소요 시간 | |
| Kafka rebalance 소요 시간 | |
| rebalance 중 이벤트 유실 건수 | |

---

## 프로세스 2 — Redis 장애 복구

### 목표
Redis 복구 후 앱이 자동으로 정상 상태로 전환되는지, 수동 개입 없이 Pub/Sub 리스너가 재시작되는지 확인한다.

### 해야 할 것

#### Step 1. Redis 복구 후 healthcheck 갱신 확인

```bash
# Redis 재기동
docker start redis

# 헬스체크 갱신 확인 (5초 이내)
grep "\[REALTIME-HEALTH\]" app.log | tail -5
# 기대: redis=true로 갱신됨
```

- [ ] Redis 재기동 → `[REALTIME-HEALTH] redis=true` 로그 확인 (최대 5초 이내)
- [ ] `isRedisAvailable()` 갱신 후 relay 중단 확인 (패널 8 라인이 0으로 복귀)

#### Step 2. SafeRedisMessageListenerContainer 재시작 확인

`RedisPubSubRecoveryScheduler`가 Redis 복구를 감지하고 컨테이너를 재시작해야 한다.

- [ ] Redis 복구 후 Pub/Sub 리스너 재시작 로그 확인
- [ ] 재시작 후 이벤트 수신 → WebSocket broadcast 정상 동작 확인

#### Step 3. 복구 후 첫 이벤트 정상 전파 확인

```
기대 흐름:
Redis 복구 → healthcheck 갱신 → relay 중단 → Redis Pub/Sub 직접 전파 재개
```

- [ ] 복구 후 발행된 이벤트가 relay 없이 직접 전파되는지 확인
- [ ] `[RELIABLE-REDIS-PUBLISH]` → `[RELIABLE-INBOUND]` 흐름 복귀 확인

#### Step 4. 복구 구간 동안 유실 이벤트 확인

Redis 장애 중 relay 또는 drop된 이벤트가 있는지 확인한다.

- [ ] relay된 이벤트 건수 확인 (패널 8 누적값)
- [ ] dropped 이벤트 건수 확인 (패널 11 누적값)
- [ ] dropped 이벤트에 대한 UX 영향 기술 (어떤 기능이 몇 초 영향받았는가)

### 기록할 것

| 항목 | 측정값 |
|------|------|
| Redis 복구 후 healthcheck 갱신 시간 | |
| Pub/Sub 리스너 재시작 시간 | |
| 복구 완료까지 총 MTTR | |
| relay 건수 (장애 구간) | |
| dropped 건수 (장애 구간) | |

---

## 프로세스 3 — Kafka 장애 복구

### 목표
Kafka 복구 후 outbox에 쌓인 이벤트가 빠짐없이 재발행되는지, 저장 건수와 재발행 건수가 일치하는지 확인한다.

### 해야 할 것

#### Step 1. Kafka 복구 후 healthcheck 갱신 확인

- [ ] Kafka 재기동 → `[REALTIME-HEALTH] kafka=true` 로그 확인
- [ ] `DefaultKafkaHealthChecker.isAvailable()` 성공 로그 확인

#### Step 2. Outbox scheduler 재발행 동작 확인

```bash
# outbox 재발행 시작 로그
grep "\[REALTIME-OUTBOX-REPUBLISH-START\]" app.log

# 재발행 성공 로그
grep "\[REALTIME-OUTBOX-REPUBLISH-SENT\]" app.log | wc -l

# 재발행 실패 로그
grep "\[REALTIME-OUTBOX-REPUBLISH-FAILED\]" app.log
```

- [ ] `[REALTIME-OUTBOX-REPUBLISH-START] size=N` 로그 확인
- [ ] SENT 건수 = 장애 구간 저장 건수 확인
- [ ] FAILED 로그 없음 확인

#### Step 3. DB에서 outbox 상태 전량 확인

```sql
-- 장애 구간 저장 건수 및 상태 확인
SELECT status, COUNT(*)
FROM realtime_outbox
WHERE created_at BETWEEN '장애시작' AND '장애종료'
GROUP BY status;

-- 기대 결과
-- SENT : N  (전량 재발행 완료)
-- PENDING : 0
-- FAILED : 0
```

- [ ] PENDING 0건 확인 (전량 재발행 완료)
- [ ] FAILED 0건 확인

#### Step 4. 재발행 이벤트 dedup 동작 확인

outbox에서 재발행된 이벤트가 KafkaConsumer에서 중복 처리되지 않는지 확인한다.

```bash
# dedup으로 skip된 이벤트 확인
# KafkaConsumer.consume()에서 isDuplicate=true 시 조용히 return
# 별도 로그 없음 → consumer에서 처리 로그가 두 번 뜨지 않으면 정상
grep "eventId=재발행된eventId" app.log
```

- [ ] 동일 eventId 처리 로그가 1회만 출력되는지 확인
- [ ] `[REALTIME-OUTBOX-DUPLICATE]` 로그로 중복 차단 확인

#### Step 5. PromQL로 건수 일치 확인

```promql
# 장애 구간 outbox 저장 누적
increase(realtime_outbox_save_total[장애구간])

# 복구 후 Kafka 재발행 성공 누적
increase(realtime_kafka_publish_total{result="success"}[복구구간])

# 두 값 일치 = 정합성 보장
```

- [ ] 두 값 캡처 후 일치 여부 기록

### 기록할 것

| 항목 | 측정값 |
|------|------|
| Kafka 복구 후 healthcheck 갱신 시간 | |
| outbox 저장 건수 (장애 구간) | |
| outbox 재발행 성공 건수 | |
| outbox 재발행 소요 시간 (전량 완료까지) | |
| 총 MTTR | |

---

## 프로세스 4 — 리소스 고갈 시 Scale-out

### 목표
CPU/메모리 고갈 또는 relay 폭주 상황에서 인스턴스를 추가하고, 추가된 인스턴스가 정상 합류하는지 확인한다.

### 해야 할 것

#### Step 1. Scale-out 트리거 조건 정의

로컬 테스트에서는 직접 인스턴스를 추가하고, 실제 운영에서는 아래 지표 기반 트리거를 설정한다.

| 트리거 지표 | 임계값 | 근거 |
|-----------|------|------|
| CPU 사용률 | > 70% 2분 이상 | `process_cpu_usage > 0.7` |
| relay dropped 발생 | > 0 30초 이상 | relay 모두 실패 = 인스턴스 처리 한계 |
| JVM Heap 사용률 | > 80% | `jvm_memory_used_bytes / jvm_memory_max_bytes > 0.8` |

```promql
# CPU 기반 scale-out 트리거 PromQL (Alert Rule로 등록)
process_cpu_usage > 0.7

# relay drop 기반 트리거
rate(realtime_relay_total{path="dropped"}[30s]) > 0

# Heap 기반 트리거
jvm_memory_used_bytes{area="heap"} / jvm_memory_max_bytes{area="heap"} > 0.8
```

- [ ] 각 지표를 Grafana Alert로 등록
- [ ] 임계값 도달 시 Alert 발동 확인

#### Step 2. 로컬 인스턴스 추가 (docker-compose scale)

```bash
# 두 번째 인스턴스 추가
docker-compose up -d --scale trader-backend=2

# 인스턴스 추가 확인
docker ps | grep trader-backend
```

- [ ] 두 번째 인스턴스 정상 기동 확인 (`/actuator/health` 응답)

#### Step 3. Kafka Consumer rebalance 확인

새 인스턴스가 consumer group에 합류하면 partition rebalance가 발생한다.

- [ ] rebalance 로그 확인 (Kafka consumer group 로그)
- [ ] rebalance 완료 후 두 인스턴스가 각각 partition을 처리하는지 확인
- [ ] rebalance 중 이벤트 처리 지연 시간 측정

#### Step 4. Redis Pub/Sub 자동 합류 확인

Redis Pub/Sub은 subscribe만 하면 자동으로 메시지를 수신한다.
새 인스턴스가 기동되면 추가 설정 없이 Pub/Sub 채널을 구독한다.

- [ ] 새 인스턴스 기동 후 Redis Pub/Sub 수신 로그 확인
- [ ] 기존 인스턴스 발행 이벤트가 새 인스턴스에도 수신되는지 확인

#### Step 5. Scale-out 후 부하 분산 확인

```promql
# 인스턴스별 relay 건수 비교 (instance 태그로 분리)
rate(realtime_relay_total[1m]) by (instance)

# 인스턴스별 Kafka consume 건수
rate(realtime_kafka_consume_total[1m]) by (instance)
```

- [ ] 두 인스턴스의 처리 건수가 분산되는지 확인
- [ ] CPU/메모리가 정상 범위로 복귀하는지 확인 (패널 19, 20)

### 기록할 것

| 항목 | 측정값 |
|------|------|
| Scale-out 트리거 발동 지표 | |
| 인스턴스 추가 소요 시간 | |
| Kafka rebalance 소요 시간 | |
| rebalance 중 이벤트 처리 지연 | |
| Scale-out 후 CPU 복귀 시간 | |

---

## 프로세스 5 — 복구 후 정합성 검증

### 목표
각 장애 복구 이후 DB 상태가 이벤트 처리 결과와 일치하는지 확인한다.

### 해야 할 것

#### Step 1. 노드 상태 정합성 확인

장애 구간 동안 처리된 노드 수정 이벤트가 DB에 정상 반영되었는지 확인한다.

```sql
-- 장애 구간 동안 수정된 노드 조회
SELECT node_id, updated_at, version
FROM canvas_node
WHERE updated_at BETWEEN '장애시작' AND '복구완료'
ORDER BY updated_at;

-- outbox에 저장된 이벤트와 node 버전 비교
SELECT o.event_id, o.sub_type, o.status, n.version
FROM realtime_outbox o
LEFT JOIN canvas_node n ON o.graph_id = n.graph_id
WHERE o.created_at BETWEEN '장애시작' AND '복구완료';
```

- [ ] outbox SENT 이벤트의 nodeId에 해당하는 DB 레코드 존재 확인
- [ ] 버전 불일치 레코드 없음 확인

#### Step 2. 락 상태 정합성 확인

장애 복구 후 잔여 락이 남아있지 않은지 확인한다.

```bash
# Redis에서 잔여 락 확인
redis-cli keys "lock:*"

# 기대: TTL 만료된 락 없음 또는 현재 정상 점유 중인 락만 존재
redis-cli keys "lock:*" | xargs -I{} redis-cli ttl {}
```

- [ ] TTL이 음수(-1, -2)인 락 없음 확인 (만료됐거나 정상 TTL)
- [ ] 현재 WebSocket 세션에 없는 userId의 락이 남아있지 않은지 확인

#### Step 3. 이벤트 처리 건수 정합성 확인

```promql
# 장애 구간 이벤트 처리 총량
increase(realtime_kafka_consume_total{result="received"}[장애구간])
+ increase(realtime_relay_total{path=~"grpc|http"}[장애구간])

# dropped 건수 (유실 허용 범위)
increase(realtime_relay_total{path="dropped"}[장애구간])
+ increase(realtime_volatile_relay_total{path="dropped"}[장애구간])
```

- [ ] 처리 건수 - dropped 건수 = 실제 전파된 이벤트 수 계산
- [ ] dropped 이벤트 중 Reliable 이벤트가 있는지 확인 (있으면 문제)
- [ ] dropped가 전부 Volatile이면 설계 범위 내 허용

### 기록할 것

| 항목 | 결과 |
|------|------|
| DB 정합성 불일치 건수 | |
| 잔여 락 건수 | |
| Reliable drop 건수 (0이어야 함) | |
| Volatile drop 건수 (허용 범위) | |

---

## 프로세스 6 — Kafka Replay 정합성 감사 (Audit)

### 목적

특정 graphId의 이벤트를 Kafka에서 replay해서 DB 현재 상태가 이벤트 로그와 일치하는지 감사한다.
Redis 복구 목적이 아니라 **"이벤트 로그 → DB 상태 일치 여부"** 를 사후 검증하는 용도다.

### 해야 할 것

#### Step 1. Kafka Consumer Group Offset 확인

```bash
# canvas-events 토픽의 현재 offset 확인
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-broadcast-group \
  --describe

# 출력 예시
# TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
# canvas-events   0          150             150             0
```

- [ ] 현재 consumer offset 기록 (replay 전 체크포인트)

#### Step 2. 특정 시점부터 replay할 offset 찾기

```bash
# 장애 시작 시각 기준 offset 조회
kafka-run-class.sh kafka.tools.GetOffsetShell \
  --broker-list localhost:9092 \
  --topic canvas-events \
  --time 장애시작_unix_timestamp_ms
```

- [ ] 장애 시작 시각에 해당하는 offset 확인

#### Step 3. Audit용 Consumer Group으로 replay

기존 consumer group offset을 건드리지 않고, **별도 audit consumer group**으로 replay한다.

```bash
# audit consumer group의 offset을 장애 시작 시점으로 리셋
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-audit-group \
  --topic canvas-events \
  --reset-offsets \
  --to-datetime 장애시작시각ISO \
  --execute

# audit consumer 실행 (별도 consumer 코드 또는 kafka-console-consumer)
kafka-console-consumer.sh \
  --bootstrap-server localhost:9092 \
  --topic canvas-events \
  --group canvas-audit-group \
  --from-beginning
```

> **주의**: 기존 `canvas-broadcast-group` offset은 절대 리셋하지 않는다.

- [ ] audit consumer group 생성 및 offset 리셋 확인
- [ ] replay된 이벤트 목록 확인 (graphId, subType, eventId)

#### Step 4. replay 이벤트와 DB 상태 비교

```sql
-- graphId=2 기준 장애 구간 이벤트 이력 (outbox 기준)
SELECT event_id, sub_type, graph_id, created_at, status
FROM realtime_outbox
WHERE graph_id = 2
AND created_at BETWEEN '장애시작' AND '복구완료'
ORDER BY created_at;

-- DB의 현재 노드 상태
SELECT node_id, version, updated_at
FROM canvas_node
WHERE graph_id = 2;
```

- [ ] replay된 이벤트 수 = outbox SENT 건수 일치 확인
- [ ] replay 이벤트의 subType이 DB 변경 이력과 일치하는지 확인
- [ ] 이벤트는 있는데 DB에 반영 안 된 건수 확인 (정합성 불일치 발견 시 원인 분석)

#### Step 5. 감사 결과 기록

| 항목 | 결과 |
|------|------|
| Replay 구간 | 장애시작 ~ 복구완료 |
| 대상 graphId | |
| Replay 이벤트 총 건수 | |
| DB 반영 확인 건수 | |
| 미반영 건수 (불일치) | |
| 불일치 원인 | |

### 문서에 명시할 포지셔닝

> Kafka replay는 Redis 상태 복구 목적으로 사용하지 않는다.
> Redis에 저장되는 상태(락, version hint, autosave 캐시)는 임시 상태이며,
> replay로 복원하면 TTL 오작동, 순서 역전, 이상 상태 재현 등의 부작용이 발생할 수 있다.
>
> 대신 Kafka replay는 장애 구간의 이벤트 로그와 DB 상태를 사후 대조하는
> 정합성 감사(audit) 도구로 사용한다.
> 불일치가 발견되면 해당 이벤트를 수동 재처리하거나 DB를 직접 보정한다.

---

## 프로세스 7 — 서버 다운 구간 Kafka Catch-up 검증

### 목표

멀티 인스턴스 환경에서 B 서버가 다운됐다가 복구됐을 때,
Kafka consumer가 다운 구간의 밀린 이벤트를 자동으로 catch-up하는지 검증한다.

이 검증의 핵심은 **"Redis Pub/Sub으로는 할 수 없는 것을 Kafka가 해주는가"** 를 수치로 증명하는 것이다.

---

### 배경 — Redis Pub/Sub과 Kafka의 차이

```
B 서버 다운 구간에서 A 서버가 이벤트를 발행하면:

Redis Pub/Sub: B가 없으므로 수신 불가 → 이벤트 영구 유실
Kafka:         B가 없어도 토픽에 저장됨 → B 복구 후 catch-up 가능
```

이게 이 시스템에서 Kafka가 존재하는 실질적 가치다.

---

### 중요: Kafka catch-up이 복구하는 것 vs 복구하지 않는 것

```
Kafka catch-up으로 복구되는 것:
  ✅ B 서버의 이벤트 감사 로그 (다운 구간 이벤트 기록 완성)
  ✅ 다운 구간 이벤트 건수 및 종류 파악 가능

Kafka catch-up으로 복구되지 않는 것:
  ❌ 캔버스 노드 상태 → DB가 source of truth (요청 시 DB에서 읽음)
  ❌ 락 상태 → TTL 만료 후 클라이언트가 재요청
  ❌ 커서 위치 → Volatile, 클라이언트 재연결 후 재전송
  ❌ WebSocket 세션 → 클라이언트 재연결로 복원
```

즉, **Kafka는 상태를 복구하는 게 아니라 이벤트 기록의 공백을 채운다.**

---

### 해야 할 것

#### Step 1. 멀티 인스턴스 환경 구성

```bash
# A, B 두 인스턴스 기동
docker-compose up -d --scale trader-backend=2

# 각 인스턴스 확인
docker ps | grep trader-backend
# → trader-backend_1 (A), trader-backend_2 (B)
```

- [ ] 두 인스턴스 healthcheck 통과 확인
- [ ] 각 인스턴스의 Kafka consumer group 합류 확인

```bash
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-broadcast-group \
  --describe
# PARTITION 0 → 인스턴스 A, PARTITION 1 → 인스턴스 B (2파티션 기준)
```

---

#### Step 2. B 서버 다운 전 기준선 확인

```bash
# B 서버 다운 직전 Kafka offset 기록
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-broadcast-group \
  --describe

# 기록: CURRENT-OFFSET (B 서버 기준)
```

- [ ] B 서버의 현재 offset 기록 (T_before)
- [ ] A, B 두 인스턴스의 `realtime_kafka_consume_total{result="received"}` 현재값 기록

---

#### Step 3. B 서버 강제 다운

```bash
# B 서버 강제 종료
docker stop trader-backend_2

# A 서버에서 계속 이벤트 발행 (WebSocket 클라이언트로 노드 편집 수행)
# → A 서버가 Redis Pub/Sub + Kafka에 이벤트 발행
```

- [ ] B 서버 종료 확인
- [ ] Kafka consumer group rebalance 발생 확인 (B의 파티션이 A로 이전)
- [ ] A 서버에서 이벤트 발행 계속 진행 (N개 발행, 기록)

```bash
# B 다운 중 A 서버가 발행한 이벤트 건수 확인
kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-broadcast-group \
  --describe
# LOG-END-OFFSET - CURRENT-OFFSET = B가 놓친 이벤트 수
```

- [ ] B가 놓친 이벤트 건수 기록 (N_missed)

---

#### Step 4. B 서버 복구 후 catch-up 확인

```bash
# B 서버 재기동
docker start trader-backend_2
```

- [ ] B 서버 healthcheck 통과 확인
- [ ] Kafka consumer group에 B 재합류 확인 (rebalance 발생)
- [ ] B의 LAG이 0으로 수렴하는 것 확인

```bash
# catch-up 진행 상황 모니터링 (반복 실행)
watch -n 1 kafka-consumer-groups.sh \
  --bootstrap-server localhost:9092 \
  --group canvas-broadcast-group \
  --describe
# LAG 컬럼이 N_missed → 0으로 줄어드는 것 확인
```

- [ ] LAG = 0 도달 시각 기록 (T_catchup_complete)
- [ ] catch-up 소요 시간 = T_catchup_complete - T_server_up 기록

---

#### Step 5. catch-up된 이벤트 로그 확인

```bash
# B 서버 로그에서 catch-up 이벤트 수신 확인
grep "\[KAFKA-CONSUMER\] event received" b_server.log | wc -l
# 기대: N_missed 건수와 일치
```

- [ ] B 서버 로그에서 `[KAFKA-CONSUMER] event received` 건수 = N_missed 확인
- [ ] catch-up 이벤트의 eventId 목록과 A 서버 발행 이벤트 목록 일치 확인

```promql
# B 서버(instance 태그 기준)의 catch-up 후 consume 건수
increase(realtime_kafka_consume_total{result="received", instance="B서버주소"}[catch-up구간])
```

---

#### Step 6. 상태 복구 방식 확인 (Kafka catch-up과 분리된 경로)

캔버스 상태가 Kafka가 아닌 DB에서 복구되는 것을 명시적으로 확인한다.

```bash
# B 서버 재기동 후 노드 조회 요청
curl http://B서버주소/api/canvas/graph/2/nodes

# DB fallback 로그 확인 (Redis cold start)
grep "DB fallback" b_server.log
```

- [ ] B 재기동 직후 노드 상태 조회 → DB에서 정상 응답 확인
- [ ] DB 응답값이 A 서버 기준 최신 상태와 일치하는지 확인
- [ ] Redis의 version hint가 B에서 cold start 후 DB로부터 채워지는지 확인

---

#### Step 7. Kafka 비활성화 시 UX 저하 시나리오 (핵심 검증)

이 단계가 포트폴리오의 핵심 증거다.
**"Kafka가 없으면 실제 사용자에게 어떤 일이 벌어지는가"** 를 재현한다.

---

##### 실험 1 — Kafka 활성화 (현재 구조, 정상 동작 기준선)

```bash
# 1. A, B 서버 정상 기동
# 2. User-A: 서버 A에 WebSocket 연결
# 3. User-B: 서버 B에 WebSocket 연결
# 4. 서버 B 강제 다운
docker stop trader-backend_2

# 5. User-A가 서버 A에서 아래 작업 수행
#    - Node 1 락 점유 (LOCK_ACQUIRE)
#    - Node 1 편집 완료 (EDIT_END)
#    - Node 2 락 점유 (LOCK_ACQUIRE)
#    - Node 2 편집 완료 (EDIT_END)

# 6. 서버 B 복구
docker start trader-backend_2

# 7. User-B 서버 B로 재연결

# 8. 서버 B의 Kafka catch-up 확인
grep "\[KAFKA-CONSUMER\] event received" b_server.log
```

**기대 결과:**
```
[KAFKA-CONSUMER] event received. eventId=aaa, subType=LOCK_ACQUIRED, graphId=1
[KAFKA-CONSUMER] event received. eventId=bbb, subType=LOCK_RELEASED, graphId=1
[KAFKA-CONSUMER] event received. eventId=ccc, subType=LOCK_ACQUIRED, graphId=1
[KAFKA-CONSUMER] event received. eventId=ddd, subType=LOCK_RELEASED, graphId=1
```

- [ ] 서버 B의 로그에 User-A의 다운 구간 이벤트 4건 catch-up 확인
- [ ] DB의 node 편집 결과가 User-B에게 정상 표시되는지 확인

---

##### 실험 2 — Kafka 비활성화 (UX 저하 재현)

```yaml
# application.yml — Kafka 비활성화
realtime:
  kafka:
    enabled: false
```

```bash
# 동일한 시나리오 재실행
# 1. A, B 서버 정상 기동 (Kafka disabled)
# 2. User-A: 서버 A, User-B: 서버 B
# 3. 서버 B 강제 다운
docker stop trader-backend_2

# 4. User-A가 서버 A에서 동일 작업 수행
#    - Node 1 락 점유 → 편집 완료
#    - Node 2 락 점유 → 편집 완료

# 5. 서버 B 복구
docker start trader-backend_2

# 6. User-B 서버 B로 재연결
```

**실제 발생하는 일:**

```
[상황 1] User-B가 서버 B에 재연결 직후 Node 1 락 점유 시도
  → Redis 락 확인: User-A의 락이 TTL 안에 있으면 LOCK_DENIED 반환 (정상)
  → Redis 락이 TTL 만료 이후라면 User-B가 락 획득 성공
  → 서버 B는 "Node 1이 방금 전까지 User-A에게 편집됐다"는 사실을 모름
  → 서버 B의 이벤트 로그: 공백 (LOCK_ACQUIRED/RELEASED 기록 없음)

[상황 2] 운영자가 "서버 B 다운 중 무슨 일이 있었나?" 조회 시
  → 서버 B의 Kafka consumer log: 0건 (catch-up 불가)
  → 서버 A의 Kafka consumer log: 있음 (A는 정상이었으므로)
  → 인스턴스 간 이벤트 로그 불일치 발생
```

```bash
# 서버 B 로그 확인
grep "\[KAFKA-CONSUMER\] event received" b_server.log
# 결과: 0건 (다운 구간 이벤트 없음)

# 서버 A 로그 확인
grep "\[KAFKA-CONSUMER\] event received" a_server.log
# 결과: 4건 (A는 정상 consume)

# DB의 노드 상태
curl http://B서버주소/api/canvas/graph/1/nodes
# Node 1, 2의 최신 내용은 DB에서 정상 반환 (DB는 정상이므로)
# → 노드 내용 자체는 정상이지만 "이 편집이 누가 언제 했는지" B는 모름
```

**UX 저하 구체적 영향:**

| UX 항목 | Kafka 활성화 | Kafka 비활성화 |
|--------|------------|--------------|
| 노드 편집 내용 | 정상 (DB에서 복원) | 정상 (DB에서 복원) |
| 편집 이력 조회 | B의 로그에 기록됨 | B의 로그에 공백 |
| 락 점유 이력 | LOCK_ACQUIRED/RELEASED 기록 | 기록 없음 |
| 다운 구간 진단 | Kafka로 재현 가능 | 재현 불가 |
| 인스턴스 간 로그 정합성 | A = B (catch-up 후) | A ≠ B (영구 불일치) |

- [ ] 실험 2에서 서버 B 로그 이벤트 수 = 0 확인
- [ ] 실험 1과 실험 2의 B 서버 이벤트 로그 건수 비교 스크린샷 캡처
- [ ] 두 실험의 DB 노드 상태는 동일함을 확인 (Kafka는 노드 상태와 무관)
- [ ] 인스턴스 간 로그 불일치 발생 확인

---

##### 두 실험 결과 요약 (문서에 기록)

| 항목 | 실험 1 (Kafka ON) | 실험 2 (Kafka OFF) |
|------|-----------------|------------------|
| 다운 구간 이벤트 수 (N_missed) | | |
| B 서버 catch-up 건수 | | (0 기대) |
| B 서버 이벤트 로그 완전성 | 완전 | 공백 |
| DB 노드 상태 정합성 | 정상 | 정상 |
| 인스턴스 간 로그 일치 | 일치 | 불일치 |
| 다운 구간 재현 가능 여부 | 가능 | 불가능 |

---

### 기록할 것

| 항목 | 측정값 |
|------|------|
| B 다운 구간 지속 시간 | |
| B 다운 중 A 발행 이벤트 수 (N_missed) | |
| B 복구 후 rebalance 소요 시간 | |
| catch-up 소요 시간 (LAG→0까지) | |
| catch-up 이벤트 수 (N_missed와 일치 여부) | |
| Kafka 비활성화 시 B 수신 이벤트 수 (비교) | |
| 캔버스 상태 복구 경로 | DB 조회 (Kafka 무관) |

---

### 문서에 명시할 포지셔닝

> **Kafka가 이 시스템에서 갖는 실질적 가치:**
>
> Redis Pub/Sub은 수신자가 없으면 이벤트가 영구 유실된다.
> B 서버가 다운된 구간의 이벤트는 Redis로는 복구 불가능하다.
>
> Kafka는 수신자 상태와 무관하게 이벤트를 토픽에 보존한다.
> B 서버가 복구된 후 자동으로 다운 구간의 이벤트를 catch-up하여
> 감사 로그의 공백을 채울 수 있다.
>
> **단, 캔버스 상태(노드 편집 결과)의 source of truth는 DB이며,**
> **Kafka catch-up은 상태를 복구하는 것이 아니라 이벤트 로그를 완성하는 것이다.**
> 클라이언트가 B 서버에 재연결하면 DB에서 최신 상태를 읽고,
> 락과 커서는 클라이언트 재연결 과정에서 자연스럽게 재설정된다.

---

## 전체 복구 프로세스 체크리스트

| # | 프로세스 | 완료 기준 |
|---|---------|---------|
| 1-1 | 인스턴스 자동 재기동 | restart 정책으로 재기동 확인 |
| 1-2 | Redis warm-up (cold start) | DB fallback 로그 확인 |
| 1-3 | WebSocket 재연결 | 클라이언트 재연결 후 정상 동작 |
| 1-4 | Kafka rebalance | rebalance 완료 후 consume 재개 |
| 2-1 | Redis healthcheck 갱신 | 5초 이내 `redis=true` 로그 |
| 2-2 | Pub/Sub 리스너 재시작 | 복구 후 이벤트 수신 확인 |
| 2-3 | relay 종료 확인 | 패널 8 라인 0으로 복귀 |
| 2-4 | 유실 이벤트 집계 | relay/dropped 건수 기록 |
| 3-1 | Kafka healthcheck 갱신 | `kafka=true` 로그 |
| 3-2 | outbox scheduler 재발행 | SENT 건수 = 저장 건수 |
| 3-3 | DB outbox 전량 SENT 확인 | SQL로 PENDING=0 확인 |
| 3-4 | dedup 동작 확인 | 중복 처리 로그 없음 |
| 4-1 | scale-out 트리거 정의 | Alert Rule 등록 |
| 4-2 | 인스턴스 추가 | 두 번째 인스턴스 healthcheck 통과 |
| 4-3 | Kafka rebalance 확인 | 파티션 분산 처리 확인 |
| 4-4 | Redis Pub/Sub 자동 합류 | 새 인스턴스 수신 확인 |
| 5-1 | 노드 상태 정합성 | DB 불일치 0건 |
| 5-2 | 락 상태 정합성 | 잔여 락 없음 |
| 5-3 | Reliable drop 0건 | dropped = Volatile만 |
| 6-1 | audit consumer group 설정 | offset 리셋 확인 |
| 6-2 | Kafka replay 실행 | 장애 구간 이벤트 재수집 |
| 6-3 | DB 상태 대조 | 이벤트 수 = DB 반영 수 |
| 6-4 | 불일치 원인 분석 | 불일치 시 원인 기록 |
| 7-1 | 멀티 인스턴스 구성 | A, B 두 인스턴스 정상 기동 |
| 7-2 | B 다운 전 offset 기록 | LAG = 0 기준선 확인 |
| 7-3 | B 강제 다운 + A 이벤트 발행 | N_missed 건수 기록 |
| 7-4 | B 복구 후 catch-up 확인 | LAG → 0, 소요 시간 기록 |
| 7-5 | catch-up 이벤트 로그 일치 | B 수신 건수 = N_missed |
| 7-6 | 상태 복구 경로 분리 확인 | 노드 상태는 DB에서 복원 |
| 7-7 | Kafka 비활성화 비교 실험 | 비활성화 시 이벤트 0개 유실 증명 |

---

## 설계 한계 및 향후 개선 항목

| 항목 | 현재 상태 | 개선 방향 |
|------|---------|---------|
| 인스턴스 자동 복구 | docker restart 정책 (로컬) | AWS ASG health check 기반 자동 교체 |
| Redis warm-up | cold start 허용 | 재기동 시 @PostConstruct로 주요 그래프 선 적재 |
| Kafka rebalance 중 유실 | 미검증 | rebalance listener로 처리 중 이벤트 보호 |
| Scale-out 자동화 | 수동 | CPU/메모리 메트릭 기반 HPA 또는 ASG 정책 |
| Kafka audit | 수동 실행 | 정기 감사 스케줄링 |
| 정합성 불일치 자동 감지 | 미구현 | audit 결과 기반 자동 보정 스크립트 |
