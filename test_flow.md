# 장애대응 테스트 흐름

## 현재 구조

- 멀티 환경 기준 테스트 진행
1. NodeEditService(각 서비스 코드에서 상태 저장하고 Redis Pub/Sub으로 즉시 전파하며, Kafka 퍼블리셔로 복구 로그 발행, Reliable), 커서 전파(CanvasRawWsHandler에서 분기로 수신하고 전파 Volatile)
2. 
- Reliable흐름: 서비스 코드에서 db작업등 완료하고 Redis Pub/Sub으로 즉시 전파 -> Redis Pub/Sub 리스너가 수신 후 브로드캐스트 진행  
  동시에 Kafka 퍼블리시를 수행하여 복구/replay용 이벤트 로그를 저장
- Volatile흐름: raw웹소켓 broadcast로 들어온 메세지를 redis pub/sub

## 테스트 유닛

### 레디스 장애시
레디스 장애시에는 상태 저장 및 즉시 전파가 불가능하다. 아래와 같은 기능이 중단
1. 편집 중 기능 불가(auto_save)
2. 노드 락 점유 불가(노드 이동기능 중단)
3. 노드 편집 완료시에 version Hint불가능(Diff를 DB에서 전체 조회하여야 함)
4. Reliable 이벤트 즉시 전파 불가 (WebSocket broadcast 지연 또는 실패)

### 레디스 펍/섭 장애시
1. 인스턴스 간 이벤트 즉시 전파 불가능
2. 같은 그룹원들끼리 상호작용 확인 불가(커서나 노드 수정,생성,이동등)
3. Volatile 이벤트는 유실 허용
4. Reliable 이벤트는 즉시 전파 실패, fallback 또는 Kafka 기반 복구 필요

### 카프카 장애시
1. Redis Pub/Sub이 정상일 경우 즉시 전파는 유지됨
2. Kafka 이벤트 로그 저장이 불가능하여 장애 이후 replay/catch-up 기반 상태 복구 불가능
3. outbox 저장을 통해 Kafka 복구 이후 재발행 필요

## 테스트 목적

본 테스트의 목적은 장애 상황에서 시스템이 정상 상태와 동일한 성능을 유지하는지 확인하는 것이 아니다.

Degrade Mode의 목적은 장애 발생 시 다음 상태로 전환하는 것이다.

- 기존 구조: 이벤트 전파 실패 또는 기능 중단
- 개선 구조: 일부 기능 축소, drop 허용, fallback, outbox 저장을 통해 서비스 지속 가능성 확보

따라서 Degrade Mode 미적용 상태는 정량 비교 대상이 아니라 실패 기준선으로 정의하고,
Degrade Mode 적용 상태에서는 fallback 성공률, drop count, outbox 저장 수, relay latency p95를 중심으로 검증한다.

## 테스트 구분

### 1. 정상 상태 Baseline

Redis, Redis Pub/Sub, Kafka가 모두 정상인 상태에서 기준 성능을 측정한다.

#### Reliable

- NodeEditService를 통해 노드 수정 요청 수행
- DB 저장 및 version 검증 수행
- Redis Pub/Sub을 통해 즉시 다른 인스턴스/세션으로 전파
- 동시에 Kafka에 복구/replay용 이벤트 로그 발행

측정 지표:

- API p95
- reliable publish count
- redis pub/sub publish count
- websocket broadcast count
- redis publish latency p95
- kafka publish latency p95
- kafka publish success count
- duplicate event count
- dedup count

#### Volatile

- CanvasRawWsHandler를 통해 CURSOR 이벤트 전송
- RealtimePublisher를 통해 Volatile 이벤트 발행
- Redis Pub/Sub으로 전파
- VolatileInboundHandler에서 latestKey 기준으로 publishLatest 수행

측정 지표:

- volatile publish count
- redis pub/sub publish count
- websocket broadcast count
- dropped count
- relay latency p95

### 2. Degrade Mode 미적용 상태

Degrade Mode가 없는 기존 구조에서는 Redis Pub/Sub 또는 Kafka 장애 시 이벤트 전파 자체가 실패한다.

이 상태에서는 정상 상태와 동일한 p95 비교가 불가능하다.
따라서 해당 구간은 수치 비교가 아니라 장애 시 한계를 설명하기 위한 실패 기준선으로 사용한다.

#### Redis 장애

- autosave 저장 불가
- lock 점유/해제 불가
- version hint 조회 불가
- Redis 기반 상태 캐시를 사용할 수 없어 DB fallback 필요

#### Redis Pub/Sub 장애

- 인스턴스 간 이벤트 전파 불가
- 같은 그래프에 접속한 사용자가 커서, 노드 이동, 수정 결과를 실시간으로 확인할 수 없음
- Volatile 이벤트는 유실
- Reliable 이벤트도 즉시 전파 불가

#### Kafka 장애 (기존 구조 기준)

- Kafka → Consumer → Redis Pub/Sub 전파 구조에서는 Kafka 장애 시 WebSocket broadcast까지 도달하지 못함
- 장애 후 replay 기반 상태 복구 불가

### 3. Degrade Mode 적용 상태

Degrade Mode 적용 후에는 장애 유형별로 이벤트 성격에 따라 다른 전략을 적용한다.

#### Volatile 전략

Volatile 이벤트는 커서 이동, 드래그 미리보기처럼 최신값만 의미 있는 이벤트다.

따라서 Redis Pub/Sub 장애나 relay 실패 상황에서 복잡한 재시도 또는 outbox 저장을 하지 않는다.
대신 drop을 허용하고, 정상화 이후 다음 최신 이벤트가 도착하면 화면 상태가 다시 갱신되도록 한다.

적용 전략:

- Redis Pub/Sub 정상: 즉시 전파
- Redis Pub/Sub 장애: drop 허용
- gRPC/HTTP fallback은 실험 대상으로만 측정
- 최종 구조에서는 Volatile fallback 제외 검토

측정 지표:

- volatile publish count
- dropped count
- drop rate
- redis publish failure count
- websocket broadcast count

#### Reliable 전략

Reliable 이벤트는 노드 수정, 락 상태 변경, 편집 종료처럼 상태 정합성에 영향을 주는 이벤트다.

따라서 장애 상황에서도 단순 drop하지 않고 fallback 또는 outbox를 통해 유실 가능성을 낮춘다.

적용 전략:

- Redis Pub/Sub 정상: 즉시 WebSocket 전파
- Redis Pub/Sub 장애: gRPC/HTTP relay fallback 실험
- Kafka 정상: replay/recovery용 이벤트 로그 저장
- Kafka 장애: outbox 저장 후 복구 시 재발행
- Redis 정상 + Kafka 장애: UX 전파는 유지, 복구 로그는 outbox로 보완
- Redis 장애 + Kafka 정상: 즉시 전파는 제한되지만 Kafka 로그는 유지되어 복구 가능

측정 지표:

- reliable publish count
- redis publish failure count
- grpc relay count
- http relay count
- relay latency p95
- relay dropped count
- kafka publish success/failure count
- outbox save count
- outbox save latency p95
- duplicate event count
- dedup count

## 테스트 시나리오

| 시나리오 | 이벤트 유형 | 입력 경로 | 장애 조건 | 기대 동작 | 주요 지표 |
|---|---|---|---|---|---|
| 정상 상태 | Volatile | WebSocket CURSOR | 없음 | Redis Pub/Sub 전파 | publish count, broadcast count |
| 정상 상태 | Reliable | NodeEditService | 없음 | Redis 즉시 전파 + Kafka 로그 저장 | API p95, Kafka latency |
| Redis 장애 | Volatile | WebSocket CURSOR | Redis down | drop 허용 | dropped count, drop rate |
| Redis 장애 | Reliable | NodeEditService | Redis down | 즉시 전파 실패, fallback 또는 기록 | relay count, failure count |
| Kafka 장애 | Reliable | NodeEditService | Kafka down, Redis 정상 | Redis 전파 유지 + outbox 저장 | websocket count, outbox count |
| Redis Pub/Sub 장애 | Volatile/Reliable | WS/REST | Pub/Sub 불가 | 전파 실패 또는 fallback/drop | failure count, dropped count |
| Redis + Kafka 장애 | Reliable | NodeEditService | Redis down, Kafka down | 즉시 전파 제한 + outbox 기반 복구 준비 | outbox count, failure count |

## 검증 관점

본 테스트는 장애 상황에서 모든 기능을 정상 상태와 동일하게 유지하는 것을 목표로 하지 않는다.

핵심 검증 관점은 다음과 같다.

1. 장애 발생 시 전체 기능 중단으로 이어지는가?
2. Volatile 이벤트는 유실을 허용하더라도 시스템 지연을 누적시키지 않는가?
3. Reliable 이벤트는 fallback 또는 outbox를 통해 유실 가능성을 낮추는가?
4. 장애 상황에서 사용자는 어떤 기능 축소를 경험하는가?
5. 복구 가능한 이벤트와 유실 허용 이벤트가 명확히 분리되어 있는가?
6. 병렬 전파 구조에서 eventId 기반 deduplication이 정상 동작하는가?

이를 통해 기존 구조의 “전파 불가” 상태를 Degrade Mode 적용 후 “기능 축소 상태의 서비스 지속”으로 전환할 수 있는지 검증한다.