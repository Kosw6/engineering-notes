# PoC 2 - Kafka + Redis 기반 Failover & Fallback 및 충돌 제어

---

## 목차

1. [서론](#1-서론)
2. [아키텍처](#2-아키텍처)
3. [시스템 구성](#3-시스템-구성)
4. [핵심 설계](#4-핵심-설계)
5. [전체 흐름](#5-전체-흐름)
6. [검증 결과](#6-검증-결과)
7. [실제 검증 로그 (E2E)](#7-실제-검증-로그-e2e)
8. [결론](#8-결론)

---

## 1. 서론

샤딩 구조에서는 특정 서버 장애 시 해당 shard의 서비스 중단 및 상태 불일치 문제가 발생한다.

특히 fallback 환경에서는 서로 다른 인스턴스에서 요청이 처리되며, 편집 상태와 데이터 정합성 문제가 발생할 수 있다.

본 PoC에서는 이를 해결하기 위해 다음 구조를 설계하였다.

* failover 서버로 트래픽 우회
* Kafka 기반 이벤트 동기화
* Redis 기반 Draft 상태 관리 및 충돌 감지

---

## 2. 아키텍처

![아키텍쳐 다이어그램](../../image/poc2.png)

---

## 3. 시스템 구성

### Gateway

* shard 기반 라우팅
* failover 서버 선택

### Core

* 데이터 변경 시 Kafka 이벤트 발행

### WS Server

* Kafka 이벤트 소비
* Draft 상태 업데이트

### Redis

* Draft 상태 저장 (TTL 기반)

---

## 4. 핵심 설계

### 4.1 Failover 라우팅

```json
{
  "primaryShardId": 1,
  "selectedShardId": 2,
  "fallbackUsed": true
}
```

장애 발생 시 동일 groupId 요청을 다른 shard로 우회한다.

```java
RouteDecision decision = wsShardRouter.route(groupId, instances);
```

* groupId 기반 slot 계산
* shard 우선순위 기반 failover 서버 선택

---

### 4.2 Kafka 이벤트 동기화

```text
[KAFKA][RECEIVED] groupId=..., entityId=15 version=1 changedFields=[x,y]
```

모든 변경 사항은 Kafka 이벤트로 발행되며, 각 인스턴스에서 이를 소비한다.

fallback 환경에서는 인스턴스 간 메모리 상태 공유가 불가능하기 때문에 Kafka를 통해 이벤트 기반 상태 동기화를 수행한다.

---

### 4.3 Redis Draft 구조

```json
{
  "baseVersion": 0,
  "draftPatch": {},
  "dirtyFields": [],
  "serverChangedFieldsAfterEdit": []
}
```

Draft 상태는 짧은 생명주기를 가지며 빠른 접근이 필요하므로 Redis를 사용하여 저지연 처리 및 TTL 기반 자동 정리를 수행한다.

---

### 4.4 Kafka → Redis 반영

```java
@KafkaListener(topics = "canvas-events")
public void consume(CanvasEventEnvelope event) {
    Set<String> editingUsers =
        draftRedisStore.findEditingUsers(event.getGroupId(), event.getEntityId());

    for (String userIdStr : editingUsers) {
        DraftEditState draft = draftRedisStore.find(...);

        if (event.getVersion() > draft.getBaseVersion()) {
            draft.getServerChangedFieldsAfterEdit()
                 .addAll(event.getChangedFields());
        }
    }
}
```

서버 변경 사항을 Draft 상태에 반영한다.

---

### 4.5 충돌 감지 로직

```java
public String validate(...) {
    if (draft.getBaseVersion().equals(node.getVersion())) {
        return "SAFE";
    }

    Set<String> conflict = new HashSet<>(draft.getDirtyFields());
    conflict.retainAll(draft.getServerChangedFieldsAfterEdit());

    return conflict.isEmpty() ? "AUTO_MERGE" : "CONFLICT";
}
```

---

### 4.6 이벤트 발행

```java
canvasEventPublisher.publish(event);
```

모든 변경은 이벤트로 기록되어 인스턴스 간 공유된다.

---

## 5. 전체 흐름

### 5.1 Edit 시작

![edit\_start](../../image/poc2/1.edit_start.png)

```
draft 초기화 (baseVersion 설정)
```

---

### 5.2 Draft 작성

![draft](../../image/poc2/2.draft_patch.png)

```json
dirtyFields = ["subject"]
```

---

### 5.3 서버 변경 발생 (non-conflict)

![non\_conflict](../../image/poc2/3.non_confilct.png)

```json
serverChangedFieldsAfterEdit = ["x","y"]
```

---

### 5.4 Validate

![validate](../../image/poc2/4.validate.png)

```
AUTO_MERGE
```

---

### 5.5 재편집

![re\_edit](../../image/poc2/5.re_edit.png)

---

### 5.6 동일 필드 변경

![re\_draft](../../image/poc2/6.re_draft.png)

```json
serverChangedFieldsAfterEdit = ["subject"]
```

---

### 5.7 충돌 발생

![conflict](../../image/poc2/7.conflict.png)
![conflict\_postman](../../image/poc2/7.conflict_postman.png)

```
CONFLICT
```

---

## 6. 검증 결과

### 6.1 fallback 상태 유지

Kafka 이벤트를 통해 인스턴스 간 상태 동기화 확인

---

### 6.2 충돌 감지 성공

* 동일 필드 수정 → CONFLICT
* 다른 필드 수정 → AUTO_MERGE

---

### 6.3 서비스 지속성 확보

shard 장애 상황에서도 편집 기능 정상 동작

---

## 7. 실제 검증 로그 (E2E)

### 7.1 Gateway Failover 동작

정상 라우팅

```json
{
  "primaryShardId": 1,
  "selectedShardId": 1,
  "fallbackUsed": false
}
```

Failover 발생

```json
{
  "primaryShardId": 1,
  "selectedShardId": 2,
  "fallbackUsed": true
}
```

---

### 7.2 Kafka 이벤트 수신

```text
[KAFKA][RECEIVED] groupId=1, entityId=15, version=0
[KAFKA][SKIP] no editing users
```

---

### 7.3 Draft 생성

```redis
draft:1:15:101
{
  baseVersion: 0,
  draftPatch: {},
  dirtyFields: [],
  serverChangedFieldsAfterEdit: []
}
```

---

### 7.4 Draft 수정

```json
dirtyFields = ["subject"]
```

---

### 7.5 Non-Conflict

```text
[KAFKA][RECEIVED] version=1 changedFields=[x,y]
[KAFKA][UPDATED_DRAFT_META]
```

```json
serverChangedFieldsAfterEdit = ["x","y"]
```

---

### 7.6 Validate

```
AUTO_MERGE
```

---

### 7.7 Conflict

```text
[KAFKA][RECEIVED] version=2 changedFields=[subject]
```

```json
dirtyFields = ["subject"]
serverChangedFieldsAfterEdit = ["subject"]
```

```
CONFLICT
```

---

## 8. 결론

Kafka 기반 이벤트 동기화와 Redis 기반 Draft 상태 관리를 결합하여 멀티 인스턴스 환경에서도 다음을 달성하였다.

* 데이터 정합성 유지
* fallback 환경에서 상태 일관성 확보
* 필드 단위 충돌 감지 및 자동 병합 지원

---
