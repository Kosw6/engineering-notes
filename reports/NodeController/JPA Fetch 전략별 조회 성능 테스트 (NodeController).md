### NodeController 조회 성능 최적화: JPA Fetch 전략(Lazy, Batch, Fetch Join) 비교 및 캐시·메모리 영향 분석

## 📋 목차

- [1. 테스트 환경](#테스트-환경)
  - [1.1 성능저하 문제 확인](#성능저하-문제파악)
  - [1.2 테스트 결과-웜,콜드캐시](#테스트-결과)
- [2. JPA Fetch 전략 비교](#jpa-fetch-전략별-성능-비교)
  - [2.1 Postgres work_mem 설명 및 디스크 스필 확인](#비교-전-postgresql-work_mem-설명)
  - [2.2 Lazy Loading](#1️-lazy-loading)
  - [2.3 Fetch Join](#2️-fetch-join)
  - [2.4 Batch Fetch](#3️-batch-fetch-hibernatedefault_batch_fetch_size)
- [4. 종합 비교 및 결론](#종합-비교-요약)
- [5. 1차 결론](#1차-결론)
- [6. 2차 성능개선점 (목록조회)](#sec-2nd-optim)
  - [6.1 반환값 추가 요구사항](#반환값-추가-요구사항)
  - [6.2 행 폭증 제거](#1행-폭증-제거)
  - [6.3 부하테스트 결과(fetch join vs Native Query(Group By + JSON Aggregation)](#부하-테스트-결과노트까지-포함한-테스트)
  - [6.4 스키마, 노드 조회 구조 변경점 및 예상이점](#2-스키마-변경-및-서비스내의-노드-조회-구조-변경점)
  - [6.5.1 노드 컨텐츠 요약제공 테스트 결과(Explain)](#노드-컨텐츠-요약제공-explain-테스트-결과)
  - [6.5.2 노드 컨텐츠 요약제공 테스트 결과(K6 부하테스트)](#노드-컨텐츠-요약제공-부하-테스트-결과)

- `EndPoint:/api/nodes/{id}`

## 테스트 환경

| 항목                 | 설정                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| 서버 사양            | 4 Core / 16GB / SSD                                                                                        |
| DB                   | PostgreSQL 17 + TimescaleDB                                                                                |
| 커넥션 풀            | HikariCP max=150,idle=80                                                                                   |
| Redis                | max-active=128                                                                                             |
| 테스트 도구          | k6 v0.52                                                                                                   |
| 초기 부하 유형       | EdgeController와 비슷한 RPS를 상정하였을때 매우 큰 과부하 -> 요청량 >= 10000에 맞춰서 120RPS \* 90s로 진행 |
| 네트워크             | 내부 브릿지 (Docker Compose 환경)                                                                          |
| 고정 테스트 부하,RPS | 웜캐시로 진행 30RPS 2m -> 메인 테스트 120RPS 90s 시드값 777로 고정,메인 테스트만 포함하여 측정             |
| GC 지표 정의         | sum(rate(jvm_gc_pause_seconds_sum[5m]))                                                                    |
| JVM                  | OpenJDK Temurin 17 (64bit,JRE-only)                                                                        |
| GC 종류              | G1GC (Garbage-First)                                                                                       |
| 힙 초기/최대 크기    | Xms=248MB / Xmx=3942MB (컨테이너 자동 설정)                                                                |
| Heap Region Size     | 2MB                                                                                                        |
| Parallel Workers     | 4                                                                                                          |
| Max Pause Target     | 200ms (기본값, G1 MaxGCPauseMillis)                                                                        |
| String Deduplication | **Disabled** (명시 옵션 미사용)                                                                            |

---

## 서론 · 전체 요약

### 가정/범위

본 분석은 “목록 조회 중심, 읽기 위주 워크로드”를 전제로 한다.
요청당 노드 수는 제한적이며(≈10개), 각 노드에 소량의 연관 데이터(링크 ≈10개)가 연결된 구조를 가정한다.

목록 조회에서는 페이징이 필요 없고, 단건 상세 조회는 별도 API로 분리되어 있다.

쓰기·갱신 트래픽은 매우 낮아 조회 성능과 tail latency(p95) 안정성을 최우선 목표로 둔다.

### 1차 테스트(Node,Node_Note_link)

처음엔 EdgeController에 비해 NodeController의 처리량이 유독 낮게 나왔다.
같은 조건인데 RPS가 절반 수준(데이터 양 : Edge 약 400만 → Node 약 200만 정도)이라 이상해서 로그를 확인했더니,
`node_note_link` 테이블을 **Lazy 로딩**으로 긁어오면서 N+1 쿼리가 쏟아지고 있었다.

그래서 JPA에서 흔히 쓰는 세 가지 접근 — **Lazy / Batch Fetch / Fetch Join** — 을 전부 돌려보기로 했다.
각 전략을 동일 부하(120RPS, seed=777)로 3회씩 테스트했고,
결국 **Fetch Join**이 왕복 쿼리를 최소화하면서 p95가 가장 낮게 나왔다.

추가로 PostgreSQL의 **`work_mem`** 값(8MB → 128MB)을 조정해봤는데,
생각보다 영향이 없었다. 해시나 정렬이 아니라 쿼리 패턴 자체가 병목이라
디스크 스필도 DB레벨에서 확인결과 안 생겼고, 단순히 왕복 횟수가 성능을 결정하고 있었다.

---

### 2차 테스트(Node,Node_Note_link,Note)

1차에서 성능은 잡혔지만, UI 쪽 요구가 생겼다.
노드 목록에서 이제는 `noteId`만이 아니라 **`noteSubject`(제목)** 도 같이 내려줘야 했다.
이때 “행 폭증” 문제가 눈에 들어왔다. Node 10개에 링크 10개씩만 붙어도
조인 결과가 100행이 되는 구조였다.

그래서 **JSON Aggregation (`json_agg` + `GROUP BY`)** 을 써서
DB 단에서 한 번에 묶는 방식을 시도했다.
`EXPLAIN (ANALYZE)` 로 봤을 땐 잘 돌아갔고, 행 수도 확실히 줄었지만
막상 k6 부하를 걸어보니 p95가 오히려 더 늘었다.
집계·정렬·직렬화 CPU가 무거운걸로 확인했다.

결국 이 방법 대신에, 아예 **스키마 쪽을 손보는 방향으로 전환**했다.

---

### 3차 테스트(Node,Node_Note_link)

이번엔 근본적으로 구조를 바꿨다.
다대다 매핑 테이블(`node_note_link`)에 `note_subject` 컬럼을 직접 추가하고,
`note.subject`가 바뀔 때 자동으로 싱크되도록 **DB 트리거**를 달았다.
이렇게 하면 애플리케이션 쪽 코드를 거의 안 건드리고도 제목을 바로 조회할 수 있다.

또 하나 떠올랐던 아이디어가 “본문을 짧게 잘라서 보내면 더 빨라지지 않을까?”였다.
서비스 상 노드 본문은 어차피 화면에서 짧게 보여주니까,
서버에서 미리 **`substring(content, 1, 20)`** 으로 자른 프리뷰만 내려주는 테스트를 추가했다.

여기서부터는 조회 방식도 나눴다.
엔티티를 그대로 조립하는 **Fetch Join**,
필요한 필드만 딱 받는 **Projection**,
그리고 이전에 썼던 **Native + JSON Aggregation**.
총 네 가지 조합으로 돌렸다.

| 테스트 구조                         | 설명                     |
| ----------------------------------- | ------------------------ |
| 1. 500자\_3테이블\_JSON Aggregation | DB에서 json_agg로 묶음   |
| 2. 500자\_2테이블\_Projection       | DTO 형태로 필요한 필드만 |
| 3. 20자\_2테이블\_Projection        | 프리뷰 버전              |
| 4. 500자\_2테이블\_Fetch Join       | 기존 방식 개선판         |

원래는 “엔티티가 아닌 DTO Projection이 더 빠르겠지”라고 예상했는데,
결과는 반대로 나왔다.

**JSON Aggregation ≪ 500자 Projection ≪ 20자 Projection ≪ 500자 Fetch Join**
순으로 성능이 좋았다. Projection이 Fetch Join보다 느린 이유가 궁금해서
GC·스레드·커넥션·p95/p99를 전부 모니터링하면서 분석했다.

결론적으로, 둘 다 DB에서는 100행을 읽지만
**Fetch Join은 Hibernate가 1차 캐시 기준으로 부모(노드)를 Deduplicate** 한다.
즉, 같은 부모 엔티티가 여러 번 나와도 새로 객체를 안 만들고,
자식(링크)만 컬렉션에 추가한다.
반면 Projection은 **DTO 100개를 전부 새로 만든다.**

결과적으로 힙에 올라가는 객체 수가 10배 차이 나고,
GC에서 **Fetch Join의 Pause가 평균 5ms**, Projection은 **6ms** 정도였다.
이 차이가 결국 p95까지 이어졌다.
요약하면, 행 폭증 상황에서는 **Fetch Join이 메모리 효율과 GC 안정성 면에서 더 낫다**는 걸 확인했다.

추가로 20자 반환, 500자 반환 Projection의 경우 GC의 영향은 동일하였으며 부하테스트를 통한 20자에서 P95성능이 좋은 원인은 GC, JSON직렬화/역직렬화가 줄었음을 확인하게 되었다.

### 4차 테스트(Node, Node_Note_Link, Note)

3차 테스트를 통해 목록 조회 시 Fetch Join 기반 조회가 가장 낮은 p95를 보인다는 것을 확인했다.
다만 500자/20자 Projection 비교에서 GC Pause 차이는 크지 않았고, 오히려 p95 차이는 직렬화·페이로드 처리 비용의 영향일 가능성이 있다고 판단했다.
이에 본문(content) 크기가 GC·스레드·tail latency에 미치는 영향을 명확히 보기 위해, 노드 content를 `한글 기준 약 1만자(≈30KB)`로 확대한 뒤 추가 비교 실험을 진행했다.

테스트 목적

- GC(할당/수집) 영향과 JSON 직렬화 비용 중 어떤 요소가 병목을 크게 만드는지 분리해 확인한다.

비교 케이스

동일한 Fetch Join 기반 조회 흐름에서, content 처리 위치만 달리하여 3가지 케이스로 비교했다.

| 테스트 구조         | 설명                                                        |
| ------------------- | ----------------------------------------------------------- |
| 1. DB 레벨 프리뷰   | DB에서 substring(content, 1, 20)로 20자만 조회/반환         |
| 2. 원문 그대로 반환 | DB에서 1만자를 그대로 조회하여 응답으로 반환                |
| 3. APP 레벨 프리뷰  | DB에서 1만자를 조회한 뒤, 애플리케이션에서 20자로 잘라 반환 |

결과 요약

- content 원문(1만자)을 애플리케이션 레벨로 가져오는 케이스(2,3) 에서는
  할당량 증가 → GC Pause 누적 → 스레드 정지(STW) 증가 → 처리율 하락/큐잉 발생으로 이어지며,
  동일한 p95 구간에서 유지 가능한 RPS가 DB 레벨 프리뷰(1) 대비 약 5배 낮게 나타났다.

- 특히 원문을 그대로 반환하는 케이스는 특정 RPS 구간에서 GC Pause가 크게 증가하며 p95가 급격히 붕괴하는 현상이 관찰되었다.

- 반면 APP 레벨 프리뷰(3)는 원문 그대로 반환(2) 대비, 동일 RPS(예: 26 RPS)에서 붕괴가 발생하더라도
  붕괴 빈도가 낮고 상대적으로 더 안정적인 패턴을 보였다.
  이는 본 테스트에서 지배적인 원인은 GC/할당 압력이지만, 동시에 응답 JSON 직렬화 비용 역시 tail latency에 유의미한 영향을 준다는 근거로 해석할 수 있다.

해석 및 결론

해당 실험을 통해 목록 조회처럼 요청 수가 많은 구간에서 대용량 본문을 애플리케이션으로 가져오는 것은
GC(STW)와 스레드 지연을 유발하여 tail latency(p95)를 빠르게 붕괴시키는 주요 원인임을 확인했다.

따라서 최종적으로 목록 조회에서는 DB 레벨에서 프리뷰(20자)를 생성해 전달하고,
원문은 상세 조회에서만 Lazy Loading으로 분리하는 구조가 가장 합리적인 선택이라고 결론 내렸다.

또한 APP 레벨 프리뷰가 일부 안정성을 보인 점을 통해, GC 영향이 더 크지만 JSON 직렬화 비용도 무시할 수 없다는 점을 함께 확인했다.

## 결정 로그

- 10/31: 1차 테스트 진행 후 -> fetch join으로 결정
- 11/02: 추가 튜닝 방법 고안
- 11/03: JSON 집계 시도 → 행 수 감소는 성공, p95↑(집계 CPU) → 보류
- 11/08: 20자 프리뷰로 JSON 크기 축소 → p95 개선은 있으나 Fetch Join 대비 여전히 열세
- 11/12: 링크 테이블에 note_subject 물리화 + 트리거 동기화 → 애플리케이션 변경 최소화로 확정

## 재현 방법

```
# 1) 캐시 리셋(컨테이너 재시작 후 OS 페이지캐시 드롭)
# (리눅스) root 권한에서
sudo sync && sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'

docker compose down && docker compose up -d


# 2) 웜업 → 본부하 (seed 고정)
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e ENDPOINTS=list -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js
```

### 테스트 시 동일 본부하 시드에서의 편차

본 테스트는 본부하 단계의 시드를 고정하여 요청 순서를 동일하게 유지했으나,
웜업 단계는 랜덤으로 수행되어 실행마다 캐시 상태(DB shared_buffers, OS page cache 등)가 달라질 수 있다.

또한 p95는 tail latency 지표로, GC STW, 스케줄링 지연, 캐시 미스와 같은 일시적 이벤트에 민감하여
동일 조건에서도 수백 ms 수준의 변동이 발생할 수 있다.

다만 공정성을 위해 각 테스트는 2~3회 반복 수행하여 표에 기재하였다.

특히 1차 테스트의 경우 비교 대상 항목 수가 많아,
모든 결과를 개별적으로 기재할 경우 문서의 가독성이 저하될 수 있다고 판단하였다.
이에 따라 개별 변동에 따른 왜곡을 줄이면서도 대표성을 유지하기 위해
중앙값을 기준으로 정리하였다.

## 1차 테스트

### 성능저하 문제파악

- 지난 엣지 컨트롤러 부하테스트에 비해 낮은 처리량 확인

- 기존 데이터의 경우 노드-링크매핑테이블(node_note_link)-노트 다대일 구조

- 초기 테스트 구조 노드 1대 링크매핑테이블 1로 테스트 진행 Lazy로딩만 사용하였다.

- 개선 방향이 필요해보였고 확실한 비교를 위해 노드와 연결된 노트의 개수를 10개로 늘려서 테스트 진행

## 테스트 결과

### 웜캐시 테스트

- 각 동일 조건, (APP,DB)컨테이너 내린 후 재시작, OS캐시 제거 후 3회 중에 중앙값으로 기록

| 항목                      | RPS | P95        | Throughput (active) |
| ------------------------- | --- | ---------- | ------------------- |
| Lazy단건(work_mem:8)      | 120 | 1348.48 ms | 120.23 req/s        |
| Lazy단건(work_mem:128)    | 120 | 1561.42 ms | 120.23 req/s        |
| Lazy목록(work_mem:8)      | 120 | 2551.14 ms | 120.01 req/s        |
| Lazy목록(work_mem:128)    | 120 | 2753.94 ms | 120.01 req/s        |
| 배치단건(work_mem:8)      | 120 | 1464.53 ms | 120.23 req/s        |
| 배치단건(work_mem:128)    | 120 | 1720.38 ms | 120.23 req/s        |
| 배치목록(work_mem:8)      | 120 | 1887.67 ms | 120.01 req/s        |
| 배치목록(work_mem:128)    | 120 | 2714.83 ms | 120.01 req/s        |
| FetchJoin단건(work_mem:8) | 120 | 874.27 ms  | 120.22 req/s        |
| FetchJoin목록(work_mem:8) | 120 | 412.91 ms  | 120.01 req/s        |

### 콜드캐시 테스트

- 각 동일 조건, (APP,DB)컨테이너 내린 후 재시작, OS캐시 제거 후 3회 중에 중앙값으로 기록

| 항목                      | RPS | P95        | Throughput (active) |
| ------------------------- | --- | ---------- | ------------------- |
| Lazy단건(work_mem:8)      | 40  | 3362.82 ms | 40.70 req/s         |
| Lazy목록(work_mem:8)      | 40  | 6643.57 ms | 40.67 req/s         |
| 배치단건(work_mem:8)      | 40  | 7516.25 ms | 40.67 req/s         |
| 배치목록(work_mem:8)      | 40  | 7246.47 ms | 40.67 req/s         |
| FetchJoin단건(work_mem:8) | 40  | 3149.68 ms | 40.70 req/s         |
| FetchJoin목록(work_mem:8) | 40  | 4871.70 ms | 40.70 req/s         |

### 비교, 분석 전 PostgreSQL work_mem 설명

- work_mem이란?
  - PostgreSQL에서 정렬(Sort), 해시(Hash Join, Hash Aggregate) 등을 수행할 때
    연산당 사용할 수 있는 메모리 한도를 지정하는 파라미터
  - 기본값은 수 MB(현재 서비스는 8MB) 수준이며, 작을수록 디스크 임시파일(temp spill)이 늘어나고 크면 RAM을 더 사용

- 이번 테스트에서 설정값
  - 해당 서비스에서 기본값 8MB -> 테스트를 위해 128MB로 진행
  - 주의점 : 해당 설정은 모든 병렬쿼리에서 전역적으로 사용되므로 128MB처럼 과도하게 사용시 OOM, 성능저하 발생
  - work_mem의 크기에 따른 성능을 보고자 테스트 환경에서만 임의적으로 사용

- 이번 테스트에서 효과가 거의 없었던 이유
  - JPA Fetch 전략에 따른 차이는 **쿼리 패턴 및 왕복 횟수** 차이이지,
    정렬 또는 해시 작업량 차이가 아니기 때문이다.
  - 따라서 work_mem을 8MB→128MB로 늘려도 쿼리 플랜이나 I/O 패턴이 변하지 않아
    p95 개선이 관찰되지 않았다.

  <details>
  <summary>📜 work_mem관련 디스크 스필 확인로그 (클릭하여 보기)</summary>

```sql
# work_mem 8에서 PostgreSQL이 쿼리 수행 중 임시 디스크(temp) 를 사용했는지 확인하는 쿼리
trader=# SELECT datname,
trader-# temp_files,
trader-# temp_bytes,
trader-# (temp_bytes/1024/1024)::numeric(10,2) AS temp_mb
trader-# FROM pg_stat_database
trader-# ORDER BY temp_bytes DESC
trader-# LIMIT 10;
datname | temp_files | temp_bytes | temp_mb
-----------+------------+------------+---------
postgres | 0 | 0 | 0.00
trader | 0 | 0 | 0.00
template1 | 0 | 0 | 0.00
template0 | 0 | 0 | 0.00
(5 rows)

# temp_files:DB 레벨에서 생성된 임시파일 개수 (work_mem 초과 시 발생)
# temp_bytes:생성된 임시파일의 총 크기 (바이트 단위)
# temp_mb:위를 MB로 환산한 계산 컬럼

trader=#
trader=# SELECT queryid, calls, temp_blks_read, temp_blks_written,
trader-# (temp_blks_written\*8/1024)::numeric(10,2) AS temp_mb,
trader-# query
trader-# FROM pg_stat_statements
trader-# WHERE temp_blks_written > 0
trader-# ORDER BY temp_blks_written DESC
trader-# LIMIT 10;
queryid | calls | temp_blks_read | temp_blks_written | temp_mb | query
---------+-------+----------------+-------------------+---------+-------
(0 rows)

# temp_blks_read:임시파일에서 읽은 블록 수
# temp_blks_written:임시파일에 쓴 블록 수 (work_mem 초과 시 기록됨)
# temp_mb:8KB 블록을 MB로 환산
# query:해당 SQL 쿼리
```

  </details>

## JPA Fetch 전략별 성능 비교

### 1️. Lazy Loading

| 구분      | 콜드캐시              | 웜캐시                 |
| --------- | --------------------- | ---------------------- |
| 단건 조회 | p95 **3362ms** @40RPS | p95 **1348ms** @120RPS |
| 목록 조회 | p95 **6643ms** @40RPS | p95 **2551ms** @120RPS |

#### 설명

엔티티를 지연로딩(Lazy)으로 가져올 때, 연관 엔티티 접근 시마다 추가 쿼리가 발생해 **N+1 문제**가 발생한다.
단건은 상대적으로 덜하지만, 목록의 경우 **왕복 쿼리 횟수가 기하급수적으로 증가**하여 DB I/O 병목이 생긴다.
work_mem 8→128로 변경 시 큰 차이가 없으며, 이는 병목이 정렬/해시가 아니라 **왕복 I/O**을 확인할 수 있다.

  <details>
  <summary>📜 Lazy목록 로그 결과 (클릭하여 보기)</summary>

```
# 쿼리 11번 노드 1번 + 링크 10번
Hibernate:
    /* select
        n
    from
        Node n
    where
        n.page.id = :pageId
    order by
        n.id  */ select
            n1_0.id,
            n1_0.content,
            n1_0.created_date,
            n1_0.modified_date,
            n1_0.page_id,
            n1_0.record_date,
            n1_0.subject,
            n1_0.symb,
            n1_0.x,
            n1_0.y
        from
            node n1_0
        where
            n1_0.page_id=?
        order by
            n1_0.id
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id=?
```

  </details>

#### 장점

- 코드 단순, 필요한 시점에 로딩 → 초기 부하 적음
- 작은 연관관계(1:1, 1:소량)에서는 유효

#### 단점

- N+1 쿼리로 인한 대규모 목록 처리 성능 저하
- 캐시 미스 시 I/O 부담 심함
- RPS 상승 시 커넥션/락 대기 증가

#### 권장 상황

- **단건 중심 API**
- **연관관계 접근이 거의 없는 목록** (DTO projection으로 최소화)

---

### 2️. Fetch Join

| 구분      | 콜드캐시              | 웜캐시                |
| --------- | --------------------- | --------------------- |
| 단건 조회 | p95 **3149ms** @40RPS | p95 **874ms** @120RPS |
| 목록 조회 | p95 **4872ms** @40RPS | p95 **413ms** @120RPS |

#### 설명

`fetch join`으로 필요한 연관 엔티티를 한 번의 쿼리로 가져오면 **왕복 횟수가 최소화**되어 레이턴시가 급감한다.
테스트 결과, 웜 상태에서 단건 조회는 목록 조회는 **874ms(p95)** 목록 조회는 **412ms(p95)** 로 Lazy의 약 **6배 이상 빠르다**.

  <details>
  <summary>📜 fetch목록 로그 결과 (클릭하여 보기)</summary>

```
#쿼리 1번
Hibernate:
    /* select
        distinct n
    from
        Node n
    left join

    fetch
        n.noteLinks l
    where
        n.page.id = :pageId
    order by
        n.id  */ select
            distinct n1_0.id,
            n1_0.content,
            n1_0.created_date,
            n1_0.modified_date,
            nl1_0.node_id,
            nl1_0.id,
            nl1_0.note_id,
            n1_0.page_id,
            n1_0.record_date,
            n1_0.subject,
            n1_0.symb,
            n1_0.x,
            n1_0.y
        from
            node n1_0
        left join
            node_note_link nl1_0
                on n1_0.id=nl1_0.node_id
        where
            n1_0.page_id=?
        order by
            n1_0.id
```

  </details>

#### 장점

- 왕복 최소화 → **가장 낮은 p95**
- DB 캐시가 잡히면 매우 안정적이고 일관된 응답
- DTO projection과 병행 시 전송량 최소화 가능

#### 단점

- **한방 컬렉션 Fetch Join + 페이징 불가** (카르테시안/중복 문제)
  - Fetch Join 시 Page(Pageable)로 받기 제한적인 이유
  ```
  # 예를 들어 노드 A,B....Z가 있으며 각각 링크가 5개씩 있다고 한다면
  # 페이징으로 5개 만큼의 노드를 가지고 오고 싶을 때 보통 아래와 같은 쿼리로 조인한다.
  SELECT n
  FROM node n
  ORDER BY n.id
  LIMIT 5 OFFSET 0;
  # 하지만 페이징은 DB에서 행단위로 자르고 fetch join의 경우 연관된 링크까지 조인하여 중복된 행으로 펼쳐지게 된다.
  select *
  from node n
  left join node_note_link l on n.id = l.node_id
  order by n.id
  limit 5 offset 0;
  # (A,1),(A,2),(A,3),(A,4),(A,5),(B,1),(B,2),(B,3)...이런 구조로 펼쳐진다.
  # 따라서 기존의 의도는 노드 A,B,C,D,E와 연관된 링크를 가져오는 것이 아닌 LIMIT/OFFSET은 join 후 중복행에 적용되므로 노드 A의 5개 링크만 가져오게 되는 결과가 발생한다.
  ```

  - 해결방법 : 1.노드의 ID만 따로 페이징 -> 2. fetch join사용
  - MultipleBagFetchException문제
    - 현재 애플리케이션에는 없지만 만약 동시에 부모 1개에 2개 이상의 리스트 기반 컬렉션을 fetch join할 경우 **카르테시안 곱으로 인한 결과셋 폭증과 엔티티 매핑 혼란을 방지하기 위한 Hibernate의 보호 메커니즘**으로 예외를 발생시킨다.
    - [2단계 페이징,fetchJoin 관련링크](https://vladmihalcea.com/join-fetch-pagination-spring/?utm_source=chatgpt.com)
    - [MultipleBagFetchException 관련링크](https://thorben-janssen.com/hibernate-tips-how-to-avoid-hibernates-multiplebagfetchexception/?utm_source=chatgpt.com)
- 다중 fetch join 불가(하이버네이트 제약)
- 결과셋 폭증 위험 → 필요한 연관만 선택적으로

#### 권장 상황

- **읽기 중심 API**, 프론트 한 번의 호출로 완결되는 조회
- 목록은 `ID 페이지 → Fetch Join 2단계 조회` 패턴으로 안정화하기

```java
#실제 사용한 코드
#단건
@Query("""
select n.id
from Node n
where n.page.id = :pageId
order by n.id
""")
List<Long> findIdsByPageId(Long pageId, Pageable pageable);

@Query("""
select distinct n
from Node n
left join fetch n.noteLinks l
where n.id in :ids
order by n.id
""")
List<Node> findAllWithLinksByIds(Collection<Long> ids);
```

---

### 3️. Batch Fetch (`hibernate.default_batch_fetch_size`)

| 구분      | 콜드캐시              | 웜캐시                 |
| --------- | --------------------- | ---------------------- |
| 단건 조회 | p95 **7516ms** @40RPS | p95 **1465ms** @120RPS |
| 목록 조회 | p95 **7246ms** @40RPS | p95 **1888ms** @120RPS |

#### 설명

LazyLoading의 N+1 문제를 완화하기 위해 설정된 `default_batch_fetch_size`는
연관 엔티티를 **IN 쿼리(batch)** 로 묶어 한 번에 가져온다.
콜드에서는 효과 미미했지만, 웜캐시 목록에서 **2551→1888ms**로 개선되어 왕복 최소화 확인

  <details>
  <summary>📜 batch fetch목록 로그 결과 (클릭하여 보기)</summary>

```
#쿼리 2번 노드 + 링크배치
Hibernate:
    /* select
        n
    from
        Node n
    where
        n.page.id = :pageId
    order by
        n.id  */ select
            n1_0.id,
            n1_0.content,
            n1_0.created_date,
            n1_0.modified_date,
            n1_0.page_id,
            n1_0.record_date,
            n1_0.subject,
            n1_0.symb,
            n1_0.x,
            n1_0.y
        from
            node n1_0
        where
            n1_0.page_id=?
        order by
            n1_0.id
Hibernate:
    select
        nl1_0.node_id,
        nl1_0.id,
        nl1_0.note_id
    from
        node_note_link nl1_0
    where
        nl1_0.node_id = any (?)
```

  </details>

#### 장점

- Lazy보다 **왕복 수 감소 → 성능 개선**
- **페이징과 완벽히 호환가능**
- 코드 수정 없이 설정만으로 적용 가능

#### 단점

- 콜드 I/O 상황에서는 Lazy와 큰 차이 없음
- 배치 사이즈 과다 시 IN 리스트 커져 플랜 비효율
- 완전한 1회 쿼리는 아니므로 fetch join보단 느림

#### 권장 상황

- **페이징 필수 + 연관 소량 접근**
- fetch join 폭발 위험이 있는 중간 복잡도 엔티티
- 일반적으로 64~256 수준 권장

```yaml
spring:
  jpa:
    properties:
      hibernate.default_batch_fetch_size: 16
```

---

## 종합 비교 요약

| 전략        | 왕복 쿼리 수 | 페이징 호환 | 성능(p95, 웜) | 권장 상황                 |
| ----------- | ------------ | ----------- | ------------- | ------------------------- |
| Lazy        | 많음 (N+1)   | 호환        | 1348~2551ms   | 단건 조회, 소규모         |
| Batch Fetch | 중간         | 호환        | 1465~1888ms   | 목록(페이징 필수)         |
| Fetch Join  | 최소 (1회)   | 제한        | **413~874ms** | 읽기 집중, 즉시 응답 필요 |

---

## 1차 결론

> 동일 환경에서 JPA의 세 가지 Fetch 전략을 비교한 결과,
> **Fetch Join이 왕복 최소화로 가장 낮은 p95를 기록(412ms @120RPS)** 하였으며,
> **Batch Fetch는 페이징과 호환되면서 Lazy 대비 평균 25% 성능 개선**을 보였다.
> 단순 메모리 확장(work_mem 조정)은 효과가 없었으며, **쿼리 구조·왕복 최소화가 핵심 병목 요인**임을 확인하였다.
> 본 실험을 통해 API별 특성에 따라 Fetch 전략을 구분 적용하는 것이 대규모 트래픽 환경에서 필수적임을 확인했다.

---

### 🔁 테스트 단계 전환 안내

#### 테스트 단계 전환(1차 → 2차)

- 1차 테스트에서는 UI 요구가 없었기 때문에 노트 링크의 noteId만 반환하여 왕복 쿼리 수 최소화 전략을 검증했다.
  해당 실험을 통해 쿼리 횟수가 적을수록 성능이 유의미하게 개선됨을 확인하였다.
- 2차 테스트부터는 UI 요구(노드 하단에 노트 제목 표시 및 클릭 로딩)에 따라 반환 스키마를 noteId → {id,title}로 확장한다.
  스키마 변경에 따른 페이로드 증가를 감안하여, 2차에서는 Fetch Join 대신 DTO 프로젝션/네이티브 집계를 채택해 로우 폭증 없이 필드만 추가하도록 설계했다.
- 1차 테스트와 마찬가지로 동일 원칙(왕복 최소화)을 유지한 2차 실험을 설계하였다.

### 스키마 변화 (요약)

- 1차 테스트

```
{
  "id": 101,
  "subject": "…",
  "noteIds": [11, 12, 15],
  ...
}
```

- 2차 테스트

```
{
  "id": 101,
  "subject": "…",
  "notes": [{"id":11,"title":"제목A"}, …],
  ...
}
```

<br><br><br>
<a id="sec-2nd-optim"></a>

# 2차-성능개선점(목록조회)

- **테스트 범위 조정 배경**
  - 단건 조회는 실제 서비스 내에서 사용되지 않는다.
  - 초기 페이지 렌더링 시, 페이지에 해당하는 모든 노드 목록을 한 번에 조회하여 프론트에 저장하고 이를 기반으로 화면을 구성한다.
  - 따라서 단건 조회는 실사용 시나리오에 포함되지 않으며, 목록 조회만이 실질적인 성능 지표가 된다.

- **1차 테스트 목적**
  - 1차 테스트에서는 Fetch 전략(Lazy, Batch, Fetch Join)의 특성을 공정하게 비교하기 위해 **단건 조회와 목록 조회를 모두 포함**하였다.
  - 이를 통해 Fetch 전략별로 쿼리 수, 행 폭증, 응답 지연의 차이를 명확히 분석하였다.

- **2차 테스트 방향 및 목표**
  - 실서비스 구조를 반영하여 **목록 조회만을 대상으로 성능 튜닝을 진행**한다.
  - 2차 튜닝 목표: **목록 조회 기준 300 RPS에서 p95 ≈ 300ms 달성**.

## 반환값 추가 요구사항

- 기존 noteId만을 반환하는 API에서 note의 제목을 같이 반환하고자 한다.
- 이를 위해 노트 테이블 또한 조회하여야 한다.

## 1.행 폭증 제거

- 1차 테스트의 목록 조회는 페이지당 10개의 노드를 불러오지만,  
  JPA Fetch Join 구조상 노드와 링크가 조인되면서 **DB 단에서 실제 조회 행이 약 100행으로 폭증**하였다.  
  (노드 10개 × 링크 10개)

- 이러한 행 폭증(Row Explosion)은 네트워크 전송량과 ORM 매핑 오버헤드를 동시에 유발한다. 다만 Fetch Join ORM 매핑에서 1차 캐쉬로 객체레벨의 폭증은 줄일 수 있다.

- **2차 테스트에서는 Fetch Join 대신 Native Query(Group By + JSON Aggregation)** 를 사용하여  
  행 폭증을 최소화하고, 한 번의 쿼리로 노드-노트 링크 정보를 JSON 형태로 묶어 반환하도록 변경하였다.

- 아래는 psql로 행 폭증 감소 테스트를 진행한 결과다

  <details>
  <summary>📜 psql 로그 결과 (클릭하여 보기)</summary>

- Before: Node × Link = 10 × 10 = 100 rows

- 노드당 10개의 행으로 폭증된다

```sql
trader=# SELECT
trader-#   n.id AS node_id,
trader-#   n.subject AS node_subject,
trader-#   l.id AS link_id,
trader-#   l.note_id AS note_id,
trader-#   no.subject AS note_title
trader-# FROM node n
trader-# LEFT JOIN node_note_link l ON l.node_id = n.id
trader-# LEFT JOIN note no ON no.id = l.note_id
trader-# WHERE n.page_id = 200125
trader-# ORDER BY n.id, l.note_id;
node_id |   node_subject    | link_id | note_id | note_title
---------+-------------------+---------+---------+------------
      43 | subject_200125_1  | 2000401 |      29 | 안뇽하세요
      43 | subject_200125_1  | 2000402 |      30 | 123
      43 | subject_200125_1  | 2000403 |      31 | string
      43 | subject_200125_1  | 2000404 |      32 | string
      43 | subject_200125_1  | 2000405 |      33 | TEST
      43 | subject_200125_1  | 2000406 |      34 | asd
      43 | subject_200125_1  | 2000407 |      35 | 123
      43 | subject_200125_1  | 2000408 |      36 | 123
      43 | subject_200125_1  | 2000409 |      37 | DDC
      43 | subject_200125_1  | 2000410 |      38 | note_138

...
```

- After: Grouped by Node → 10 rows (notes aggregated as JSON array)

- 예상대로 10개의 노트id와 노트 제목이 한 행 JSON형식으로 나온다

```sql
trader=# SELECT
trader-#   n.id,
trader-#   n.x, n.y, n.subject, n.page_id,
trader-#   COALESCE(
trader(#     json_agg(json_build_object('id', l.note_id, 'title', no.subject)
trader(#              ORDER BY l.note_id)
trader(#       FILTER (WHERE l.note_id IS NOT NULL),
trader(#     '[]'::json
trader(#   ) AS notesJson
trader-# FROM node n
trader-# LEFT JOIN node_note_link l ON l.node_id = n.id
trader-# LEFT JOIN note no ON no.id = l.note_id
trader-# WHERE n.page_id = 200125
trader-# GROUP BY n.id, n.x, n.y, n.subject, n.page_id
trader-# ORDER BY n.id;
  id    |    x    |    y    |      subject      | page_id |                                                                                                                                                            notesjson
---------+---------+---------+-------------------+---------+---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
      43 |   457.3 | -226.57 | subject_200125_1  |  200125 | [{"id" : 29, "title" : "안뇽하세요"}, {"id" : 30, "title" : "123"}, {"id" : 31, "title" : "string"}, {"id" : 32, "title" : "string"}, {"id" : 33, "title" : "TEST"}, {"id" : 34, "title" : "asd"}, {"id" : 35, "title" : "123"}, {"id" : 36, "title" : "123"}, {"id" : 37, "title" : "DDC"}, {"id" : 38, "title" : "note_138"}]
  200043 ....
```

  </details>

  <details>
  <summary>📜 psql 로그 결과-행 수만 조회 (클릭하여 보기)</summary>

- 10개의 노드에 대해서 각 100개 10개, 결과 행의 수가 10분의 1로 줄어들어 행 폭증이 사라진 모습이다.
- Before: Node × Link = 10 × 10 = 100 rows

```sql
trader=# SELECT COUNT(*) AS row_count_before
trader-# FROM node n
trader-# LEFT JOIN node_note_link l ON l.node_id = n.id
trader-# LEFT JOIN note no ON no.id = l.note_id
trader-# WHERE n.page_id = 200125;
row_count_before
------------------
              100
(1개 행)
```

- After: Grouped by Node → 10 rows (notes aggregated as JSON array)

```sql
SELECT COUNT(*) AS row_count_after
FROM (
  SELECT n.id
  FROM node n
  LEFT JOIN node_note_link l ON l.node_id = n.id
  LEFT JOIN note no ON no.id = l.note_id
  WHERE n.page_id = 200125
  GROUP BY n.id
) t;

row_count_after
---
              10

(1개 행)

```

  </details>

- 결과적으로, json_agg와 GROUP BY를 이용하여  
  10배에 달하던 행 폭증이 제거

### 2차 부하 테스트 결과(노트까지 포함한 테스트)

> ① **1차 = Fetch Join (행 폭증 발생)**: Node×Link 조인으로 결과 행 수 증가(중복 병합은 애플리케이션에서 처리)  
> ② **2차 = JSON 집계 (행 폭증 미발생)**: DB에서 `json_agg`로 그룹화·집계하여 행 수 축소(집계 CPU 비용↑)

| 구분                              | 시나리오 | P95 (ms) | Throughput(active) | Fail Rate |
| --------------------------------- | -------- | -------- | ------------------ | --------- |
| **1차=Fetch Join(행 폭증 발생)**  | Case 1   | 4344.17  | 124.99             | 0.00%     |
|                                   | Case 2   | 2572.21  | 125.00             | 0.00%     |
|                                   | Case 3   | 2783.97  | 125.00             | 0.00%     |
| **2차=JSON 집계(행 폭증 미발생)** | Case 1   | 5212.05  | 123.62             | 0.00%     |
|                                   | Case 2   | 5355.46  | 124.83             | 0.00%     |
|                                   | Case 3   | 3961.93  | 125.01             | 0.00%     |

**해석 요약**

- ②는 **행 수는 줄었지만** `json_agg`/정렬(ORDER BY)/그룹화 비용이 커서 p95가 더 높게 측정됨.
- ①은 행 폭증으로 네트워크/매핑 오버헤드는 있지만, Hibernate가 부모 엔티티를 Identity Map으로 재사용(deduplicate) 하기 때문에, **부모 객체/대용량 필드 생성**이 row 수만큼 반복되지 않았다. 반면 JSON agg는 DB에서 그룹별 JSON 생성 및 정렬 비용이 발생해 DB CPU가 p95를 지배했다

- 따라서 3차 설계에서는 노트 본문을 집계하지 않고 링크 테이블만 반환하도록 구조를 단순화하였다.

- 단 기존의 노드목록조회에 노트ID와 제목이 필요하다는 점을 고려하여 링크 테이블의 스키마를 추가할 예정이다.

## 3차테스트

### 스키마 변경 및 서비스내의 노드 조회 구조 변경점

- 기존에는 노드 목록 조회로 모든 데이터를 선조회 후 개별조회 기능은 사용하지 않았다.
- 하지만 NativeQuery의 성능이 예상과 다르게 좋지 않고 fetch join또한 3개의 테이블을 조인해야 하기에 링크 테이블 스키마에 연결된 노트 제목을 추가하는 방향으로 가고자 한다.

```sql
#스키마 변경
ALTER TABLE node_note_link
ADD COLUMN note_subject VARCHAR(255);
#기존 데이터 복사
UPDATE node_note_link l
SET note_subject = n.subject
FROM note n
WHERE n.id = l.note_id;
#조회 예시
trader=# SELECT id, node_id, note_id, note_subject
trader-# FROM node_note_link
trader-# LIMIT 10;
  id   | node_id | note_id | note_subject
-------+---------+---------+--------------
30129 | 1280185 |   15090 | note_21790
30142 | 1410185 |   15063 | note_21763
30147 | 1460185 |   15131 | note_21831
30151 | 1500185 |   15089 | note_21789
30160 | 1590185 |   15053 | note_21753
30161 | 1600185 |   15038 | note_21738
30181 | 1800185 |   15109 | note_21809
30187 | 1860185 |   15132 | note_21832
30213 |  120186 |   15203 | note_21903
30221 |  200186 |   15191 | note_21891
(10 rows)

#노트 제목 변경시 자동 동기화 트리거, 해당 트리거로 애플리케이션 레벨 로직 수정X
#CASCADE로 노드,노트 삭제시에 링크도 삭제되기 때문에 insert, delete 는 제외
CREATE OR REPLACE FUNCTION trg_sync_note_subject()
RETURNS trigger AS $$
BEGIN
  UPDATE node_note_link
  SET note_subject = NEW.subject
  WHERE note_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sync_note_subject_after_update
AFTER UPDATE OF subject ON note
FOR EACH ROW
EXECUTE FUNCTION trg_sync_note_subject();


#노트 제목 변경 및 결과
trader=# UPDATE note
trader-# SET subject = 'updated_note_subject'
trader-# WHERE id = 15090;

trader=# SELECT id, node_id, note_id, note_subject
FROM node_note_link where note_id='15090';
  id   | node_id | note_id |     note_subject
-------+---------+---------+----------------------
30029 |  280185 |   15090 | updated_note_subject
30129 | 1280185 |   15090 | updated_note_subject
(2 rows)


```

### 스키마 변경안

- 기존 : 노드*노트*링크 테이블
  - 필드 : id, node_id, note_id
- 수정 : 노드*노트*링크 테이블
  - 필드 : id, node_id, note_id , note_subject

## 테스트 결과

1.  `NativeQuery + JSON Aggregation`를 사용하여 node, node_note_link, note테이블 조회(기존 스키마에서 JSON Aggregation사용)
    <details>
    <summary>📜 코드보기 (클릭하여 보기)</summary>

        ```java
        @Query(value = """
                select
                      n.id,
                      n.x,
                      n.y,
                      n.subject,
                      n.content,
                      n.symb,
                      n.record_date,
                      n.page_id,
                      n.created_date,
                      n.modified_date,
                      coalesce(
                        jsonb_object_agg(l.note_id, no.subject)
                          filter (where l.note_id is not null),
                        '{}'::jsonb
                      ) as notes_json
                    from node n
                    left join node_note_link l on l.node_id = n.id
                    left join note no on no.id = l.note_id
                    where n.page_id = :pageId
                    group by n.id, n.x, n.y, n.subject, n.content, n.symb,
                            n.record_date, n.page_id, n.created_date, n.modified_date
                    order by n.id
              """, nativeQuery = true)
          List<NodeRowProjection> findAllNodeRowProjectionByPageId(@Param("pageId") Long pageId);
        ```

        </details>

2.  node_note_link 테이블에 noteSubject를 포함해 `프로젝션`으로 조회(노트 컨텐츠 500자 조회, 수정된 스키마 사용)
    <details>
    <summary>📜 코드보기 (클릭하여 보기)</summary>

        ```java
        @Query("""
            select
                n.id                as id,
                n.x                 as x,
                n.y                 as y,
                n.subject           as subject,
                n.content           as contentPreview,
                n.page.id           as pageId,
                n.createdDate       as createdDate,
                n.modifiedDate      as modifiedDate,
                l.note.id           as noteId,
                no.subject          as noteSubject
            from Node n
            left join n.noteLinks l
            left join l.note no
            where n.page.id = :pageId
            order by n.id
          """)
          List<NodePreviewWithNoteProjection> findAllWithNotesByPageId(Long pageId);
        ```

        </details>

3.  node_note_link 테이블에 noteSubject를 포함해 `프로젝션`으로 조회(노트 컨텐츠 20자로 줄여서 조회, 수정된 스키마 사용)
    <details>
    <summary>📜 코드보기 (클릭하여 보기)</summary>

        ```java
        @Query("""
                select
                    n.id                as id,
                    n.x                 as x,
                    n.y                 as y,
                    n.subject           as subject,
                    substring(n.content, 1, 20) as contentPreview,
                    n.symb              as symb,
                    n.recordDate        as recordDate,
                    n.page.id           as pageId,
                    n.createdDate       as createdDate,
                    n.modifiedDate      as modifiedDate,
                    l.note.id           as noteId,
                    no.subject          as noteSubject
                from Node n
                left join n.noteLinks l
                left join l.note no
                where n.page.id = :pageId
                order by n.id
              """)
          List<NodePreviewWithNoteProjection> findAllPreviewWithNotesByPageId(Long pageId);
        ```

        </details>

4.  node_note_link 테이블에 noteSubject를 포함해 `fetch Join`으로 조회(노트 컨텐츠 500자 조회, 수정된 스키마 사용)
    <details>
    <summary>📜 코드보기 (클릭하여 보기)</summary>

        ```java
        @Query("""
        select distinct n
        from Node n
        left join fetch n.noteLinks l
        where n.page.id = :pageId
        order by n.id
        """)
        List<Node> findAllFetchByPageId(@Param("pageId") Long pageId);
        ```

        </details>

### DB EXPLAIN 결과 평균 (콜드 vs 웜 캐시, fetch join은 제외)

| 구분           | 캐시 상태 | 평균 Planning Time (ms) | 평균 Execution Time (ms) |
| -------------- | --------- | ----------------------- | ------------------------ |
| **JSON 조인**  | 콜드      | **51.14**               | **14.08**                |
| **JSON 조인**  | 웜        | **2.53**                | **1.32**                 |
| **500자 조회** | 콜드      | **41.26**               | **12.03**                |
| **500자 조회** | 웜        | **2.75**                | **0.91**                 |
| **20자 조회**  | 콜드      | **41.57**               | **12.26**                |
| **20자 조회**  | 웜        | **2.38**                | **1.34**                 |

---

**요약**

- cold에서 JSON 집계는 조인/집계로 인해 planning·execution 모두 증가하였고, warm에서는 실행 시간이 수렴해도 앱 레벨 직렬화/객체 생성 비용이 p95를 지배했다.

- substring 길이(20 vs 500)는 DB execution 차이가 거의 없었고, 차이는 응답 페이로드/직렬화/GC로 이동했다.

---

### 3차 K6 부하테스트 결과 평균 (콜드 vs 웜 캐시)

- 초기 캐시를 위해 30RPS 40초 진행 -> 본 부하 120RPS 90s진행

| 구분                                                         | RPS    | P95(ms)                     | 평균 처리량(req/s, 3회 평균) | 실패율 |
| ------------------------------------------------------------ | ------ | --------------------------- | ---------------------------- | ------ |
| **500자 3단계 테이블 조회 (NativeQuery + JSON Aggregation)** | 30→120 | 3956.36 → 3121.20 → 3615.47 | **120.91**                   | 0.00%  |
| **500자 2단계 테이블 조회 프로젝션**                         | 30→120 | 2126.32 → 3387.88 → 2656.24 | **120.83**                   | 0.00%  |
| **20자 2단계 테이블 조회 프로젝션**                          | 30→120 | 1345.88 → 2119.68 → 1450.58 | **120.90**                   | 0.00%  |
| **500자 2단계 테이블 조회 Fetch Join**                       | 30→120 | 1100.02 → 1489.86 → 924.54  | **120.91**                   | 0.00%  |

---

### 500자 기준 모니터링 성능 그래프

1. 500자 3단계 페이지 조회 `NativeQuery + JSON Aggregation`

![NativeQuery + JSON Aggregation](../../image/json_agg_3table.png)

2. 500자 2단계 조회 `프로젝션`

![500 Projection](../../image/500_projection_2table.png)

3. 500자 2단계 테이블 조회 `Fetch Join`

![500 Fetch Join](../../image/fetch_join_2table.png)

4. +20자 2단계 조회 `프로젝션`

![20 Projection](../../image/20_projection_2table.png)

#### 500자 콘텐츠 반환 모니터링 + k6부하테스트 분석 요약

| 구분                                           | GC Pause (s/s)       | p95/p99 응답시간(ms) | Thread / Connection 사용량              | 평균 처리량(req/s) |
| ---------------------------------------------- | -------------------- | -------------------- | --------------------------------------- | ------------------ |
| **3단계 JSON Aggregation (Native + json_agg)** | **6ms 이상 유지**    | 3956 → 3121 → 3615   | Busy Thread 폭 넓음 / Active 40~50 유지 | **120.91**         |
| **2단계 Projection (JPQL DTO)**                | **6ms 피크 후 급락** | 2126 → 3387 → 2656   | Busy Thread 짧고 빠른 복귀              | **120.83**         |
| **2단계 Fetch Join**                           | **4~5ms 유지**       | 1100 → 1489 → 924    | Busy Thread 안정 / Active <10           | **120.91**         |

## 1. GC , 메모리 관점

> ※ JVM 기본 G1GC 환경(Heap Max 3.9GB, Region 2MB, MaxGCPauseMillis≈200 기준)에서
> 모든 테스트를 수행하였으며, GC 설정은 기본값으로 유지하였다.

- **JSON Aggregation (3-Table, jsonb_object_agg)**
  - DB·JVM 양쪽에서 **문자열 기반 직렬화/역직렬화**가 대량 발생 → **임시 객체 폭증** → **GC Pause 누적**.
  - STW 구간이 길어지고 **Tomcat Busy 폭이 넓게** 유지됨.

- **Projection (2-Table, DTO)**
  - 직렬화 없이 **ResultSet → DTO 매핑**만 수행.
  - 다만 **조인으로 인한 행 폭증 -> DTO 개수 폭증**으로 **Eden 포화 → GC 발생**.
  - GC Pause 자체는 짧고 **안정화가 빠르다**.

- **Fetch Join (2-Table, 엔티티 그래프)**
  - DB 결과는 Projection과 동일하게 **행 폭증**이지만,
  - 하이버네이트가 **1차 캐시로 부모 엔티티를 Deduplicate**(ID 기준) → **부모 10개 + 링크 100개** 형태로 변환한다.
  - **큰 본문(content)** 은 부모당 1회만 할당되어 **중복 문자열 생성이 없음** → **STW 영향 최소**.

> **왜 이번 테스트에선 Fetch Join의 GC Pause가 더 낮았나?**
> Projection은 **행 수만큼 DTO + 문자열(500자)** 이 반복 생성되어 **총 객체 수가 더 많고**,
> Fetch Join은 **부모 Deduplicate + 컬렉션 누적**으로 **힙 객체 수가 줄었기 때문.**

### 500자 vs 20자 (Projection)

- **GC Pause는 거의 동일**
- 차이는 **p95 응답시간**에서 나타남 → 본문을 줄이면 **JSON 변환 비용**(네이티브/응답 직렬화)이 줄어들어 응답 분포가 개선되었다.
- 다만 반환되는 본문의 크기 차이가 그렇게 크지 않은 것으로 느껴져 이후에 1만자 vs 20자로 비교하려고 함

> **Stop-the-World(STW)**: GC 실행 시 JVM이 애플리케이션 스레드를 **일시 정지**하는 구간.
> STW가 길수록 p95/p99 스파이크, Busy thread 확대, 커넥션 반환 지연이 발생한다.

---

## 2. Thread , Connection 부하

- **JSON Aggregation**: Busy Thread **160+** 유지, Active 커넥션 **50+** 점유.
  직렬화/파싱이 **CPU bound**라 스레드 반환이 늦음.
- **Projection / Fetch Join**: Busy 폭 **짧고 빠른 복귀**, Active **10~15** 내외로 안정.

---

## 3. 응답시간 (p95/p99)

- **JSON Aggregation**: **3~4초 피크가 2회**, STW 이후 **backlog 해소가 길다**.
- **Projection**: **단일 피크 후 1~2초 내 복귀**, 분포 안정.
- **Fetch Join**: **p95 ≈ 1s** 수준, **Throughput/분산 가장 균일**.

---

## 결론

- **행 폭증이 있는 조회라면** GC 관점에서
  **Fetch Join(부모 Deduplicate + 컬렉션 누적) ≤ Projection(DTO 폭증) ≪ JSON Aggregation(직렬화/파싱 폭증)**
  순으로 유리했다.
- **JSON 집계**는 행 수는 줄이나 집계/정렬/직렬화 비용으로 인해 **CPU 바운드 + GC 압력이 커져** p95가 높아졌다.
- **본문 길이 축소(500→20자)** 는 **GC Pause에는 미미**, **JSON 변환 비용(p95)** 에서 체감 개선.
- 동일 RPS에서 **왕복 최소화 + 객체 수 최소화**가 **핵심 병목 해소 전략**임을 확인했다.

---

### 테스트와 분석을 통한 조회 전략 선택 가이드

| 상황                             | 권장 전략                                              | 이유/주의                                            |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| 페이징 필수, 연관 소량           | **Batch Fetch** (`hibernate.default_batch_fetch_size`) | N+1 완화 + 페이징 호환, 왕복 적당                    |
| 한 번에 화면 완결, 페이징 불필요 | **Fetch Join + 2단계(ID→fetch)**                       | 왕복 최소화(p95 유리), 컬렉션 페이징은 분리          |
| 행 폭증 매우 큼, CPU 여유        | **JSON Aggregation**                                   | 네트워크/행 수 감소, 대신 집계/정렬 CPU 및 GC 압력 ↑ |
| 대용량 본문 포함                 | **Projection(프리뷰 20자) + 상세 개별 조회**           | 응답 JSON 축소로 p95 안정                            |
| p95·GC 민감                      | **Fetch Join(부모 Deduplicate 유리)**                  | 객체 수/중복 감소로 STW 영향 최소화                  |

## 4차 테스트(fetch join + 노드 콘텐츠 20자)

- 같은 행 폭증 상황일때 DTO Projectione대신 엔티티 Fetch Join이 성능이 좋음(Deduplicate)
- 따라서 방향성을 fetch join으로 가되 프리뷰 같이 노드 컨텐츠를 20자로 줄여 반환하여 GC, JSON 직렬화/역직렬화의 오버헤드를 줄이고자 한다

### 해결방법

- DB에서 가져올 때에 콘텐츠 대신 20자로 줄인 데이터를 가져와야 한다
  1. 목록 조회에서는 콘텐츠 원본을 가져오지 않고 단건 상세조회에서 반환하도록 한다
  2. 목록 조회에서 콘텐츠 수정본을 가져오는 방식
  - 링크 테이블처럼 추가 스키마를 넣는 방식은 이미 콘텐츠가 존재하기에 불필요하다고 생각했다
  - 뷰를 생성하고 해당 뷰로 fetch join하는 방식을 생각했다

- 찾아보니 따로 뷰를 생성하지 않고 `@Formula("substring(content, 1, 20)")` 해당 방식으로 조회 할 수 있다는 것을 확인했다.

#### @Formula()란

- DB가 매번 계산해서 돌려주는 읽기 전용 가상 컬럼으로 엔티티를 로드할 때에 하이버네이트가 SELECT절에 끼워서 보낸다.

- 따라서 노드 엔티티에 읽기 전용 콘텐츠 필드를 추가하고 기존 원본 콘텐츠 필드는 LAZYLOADING으로 목록 조회시에는 원본 콘텐츠 대신 읽기 전용 콘텐츠를 가져오는 구조로 변경하려고 한다.

  <details>
    <summary>📜 코드보기 (클릭하여 보기)</summary>
    
  ```java
      //LazyLoading적용 테스트를 위한 all.get(0).getContent(); 추가
      @Transactional(readOnly = true)
      public List<ResponseNodeDto> findAllByPageId(Long pageId) {
          List<Node> all = nodeRepository.findAllFetchByPageId(pageId);
          List<ResponseNodeDto> list = all.stream().map(ResponseNodeDto::toResponseDtoList).collect(Collectors.toList());
          all.get(0).getContent(); // 이 시점에 2차 SELECT 발생해야 정상
          return list;
      }

      //dto변환 메서드 변경 -> node에서 content대신 ContentPreview를 담으면서 Content 미접근
      public static ResponseNodeDto toResponseDtoList(Node node) {
          Long pageId = (node.getPage() != null) ? node.getPage().getId() : null;

          Map<Long, String> notes = node.getNoteLinks().stream()
                  .filter(link -> link.getNote() != null)
                  .collect(Collectors.toMap(
                          link -> link.getNoteId(),
                          link -> link.getNoteSubject()
                  ));

          return ResponseNodeDto.builder()
                  .id(node.getId())
                  .x(node.getX())
                  .y(node.getY())
                  .subject(node.getSubject())
                  .content(node.getContentPreview())
                  .symb(node.getSymb())
                  .recordDate(node.getRecordDate())
                  .createdAt(node.getCreatedDate())
                  .modifiedAt(node.getModifiedDate())
                  .pageId(pageId)
                  .notes(notes)
                  .build();
      }

````

```sql
#20자 반환 및 LazyLoading 결과
Hibernate:
    /* select
        distinct n
    from
        Node n
    left join

    fetch
        n.noteLinks l
    where
        n.page.id = :pageId
    order by
        n.id  */ select
            distinct n1_0.id,
            substring(n1_0.content, 1, 20)::text,
            n1_0.created_date,
            n1_0.modified_date,
            nl1_0.node_id,
            nl1_0.id,
            nl1_0.note_id,
            nl1_0.note_subject,
            n1_0.page_id,
            n1_0.record_date,
            n1_0.subject,
            n1_0.symb,
            n1_0.x,
            n1_0.y
        from
            node n1_0
        left join
            node_note_link nl1_0
                on n1_0.id=nl1_0.node_id
        where
            n1_0.page_id=?
        order by
            n1_0.id
Hibernate: <--content LazyLoading 적용되는 것 확인
    select
        n1_0.content
    from
        node n1_0
    where
        n1_0.id=?

````

  </details>

## 추가 실험

테스트 시에 콘텐츠 차이가 별로 나지않아 보다 명확한 결과의 차이를 위해 테스트 데이터를 한글기준 약 1만자 콘텐츠당 30KB(한글기준 1만자)로 업데이트 하여 진행하려고 한다.
또한 동시에 성능저하가 JSON직렬화의 문제인지 파악하기 위해 1만자 content를 그대로 반환하는 것과 애플리케이션 내부에서 20자로 줄여 반환하는 테스트도 시행하였다.

  <br>
  1. 1만자 콘텐츠 -> 20자(DB)Fetch Join
    - DB조회 레벨에서 20자로 substring하여 가져옴
  2. 1만자 콘텐츠 반환 Fetch Join
    - DB에서 1만자 그대로 가져와서 반환
  3. 1만자 콘텐츠 -> 20자 변환(APP) Fetch Join
    - DB에서 1만자 그대로 가져온 후 20자로 줄여 반환

  <details>
    <summary>📜 변경 쿼리,확인 (클릭하여 보기)</summary>

```sql
--변경에 사용한 쿼리
trader=# UPDATE node
trader-# SET content = repeat('가', 10240)  -- 한글 1자(3byte) × 10240 = 30720 byte
trader-# WHERE page_id IN (
trader(#   200125, 210125, 370125, 380125, 390125,
trader(#   200126, 210126, 370126, 380126, 390126,
trader(#   200127, 210127, 370127, 380127, 390127,
trader(#   200128, 210128, 370128, 380128, 390128,
trader(#   200129, 360129, 370129, 380129, 390129
trader(# );
UPDATE 250

--확인용 쿼리
trader=# SELECT
trader-#   page_id,
trader-#   octet_length(content) AS bytes,
trader-#   char_length(content)  AS chars
trader-# FROM node
trader-# WHERE page_id IN (
trader(#   200125, 210125, 370125, 380125, 390125,
trader(#   200126, 210126, 370126, 380126, 390126,
trader(#   200127, 210127, 370127, 380127, 390127,
trader(#   200128, 210128, 370128, 380128, 390128,
trader(#   200129, 360129, 370129, 380129, 390129
trader(# )
trader-# LIMIT 20;
page_id | bytes | chars
---------+-------+-------
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200125 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
  200126 | 30720 | 10240
(20 rows)

```

  </details>

#### 4차 테스트 결과(각 2번 테스트)

본 비교는 동일 RPS 조건이 아닌, P95 지연시간이 유사한 구간에서의 최대 처리 가능 RPS(용량)를 비교한다.

추가로 1만자 content를 애플리케이션으로 가져오는 테스트의 경우 30 RPS 이상에서
대용량 문자열 로딩으로 인한 allocation rate 증가로
GC Pause가 급격히 증가하며 STW 시간이 누적되었다.
이로 인해 유효 처리율이 요청 도착률을 하회하면서 큐잉이 발생하였고,
결과적으로 p95 지연 시간이 급격히 붕괴되었다.

이러한 구간에서는 원인 비교가 어려워,
온전한 성능 비교를 위해 해당 테스트들은 본부하 25RPS로 진행하였다.

| 구분                                                     | RPS    | P95(ms)            | 평균 처리량(req/s, 3회 평균) | 실패율 |
| -------------------------------------------------------- | ------ | ------------------ | ---------------------------- | ------ |
| **1만자 콘텐츠 -> 20자(DB) Fetch Join**                  | 30→120 | 860.23 → 586.61    |                              | 0.00%  |
| **1만자 콘텐츠 반환 Fetch Join(안정 구간)**              | 8->25  | 865.19 ->411.86    | **25.01**                    | 0.00%  |
| **1만자 콘텐츠 반환 Fetch Join(붕괴 구간)**              | 8->26  | 2308.51 -> 3056.25 | **26.01**                    | 0.00%  |
| **1만자 콘텐츠 -> 20자 변환(APP) Fetch Join(안정 구간)** | 8->25  | 578.23 -> 205.71   | **25.01**                    | 0.00%  |
| **1만자 콘텐츠 -> 20자 변환(APP) Fetch Join(붕괴 구간)** | 8->26  | 806.48 -> 2394.04  | **26.01**                    | 0.00%  |

#### 모니터링 이미지

- 20자 프리뷰 반환(DB) 모니터링/RPS 120
  ![20_120RPS](../../image/folmula_20_fetchjoin.png)
- 1만자 원문 반환 모니터링/RPS 25
  ![10k_25RPS](../../image/10k_fetchjoin_safe.png)
- 1만자->20자 프리뷰 반환(APP) 모니터링/RPS 25
  ![10k_20_25RPS](../../image/10k_20_fetchjoin_safe.png)

#### GC 및 쓰레드에 관한 공식 문서

[링크-SafePoint단락 확인](https://openjdk.org/groups/hotspot/docs/HotSpotGlossary.html#SAFEPOINT)

- 위 링크의 GC와 쓰레드에 대한 설명 문단(Ctrl + F => SafePoint)

#### 요약 및 해석

- 분석을 위해 찾은 단락 번역내용

> 세이프포인트는 프로그램 실행 중 모든 GC 루트가 알려지고 모든 힙 객체 내용이 일관되는 ​​지점으로<br>
> GC가 실행하기 전에 모든 쓰레드는 세이프포인트에서 차단되어야 합니다.
> -->즉 GC가 실행되는 구간에서 쓰레드는 작업을 중단 -> GC발생 시간이 길 수록, 미세 지연이 늘어나는 구조

- 1만자,20자(DB) 테스트의 모니터링 스크린샷 좌측 상단 GC Pause와 우측 상단 쓰레드 부분을 보게 되면 둘다 Hikari,Thread풀은 안정하지만 1만자의 경우 20자보다 GC Pause가 길어지는 것을 확인할 수 있다.

- HikariConnection의 양은 안정적인 것으로 보아 부하는 애플리케이션의 병목이 주된 원인이며 이는 아래와 같은 분석으로 귀결된다.

- 20자(60byte) vs 1만자(30K byte) => 500배에 해당하는 콘텐츠 크기의 차이 및 특히 현재 목록조회에서는 요청당 노드 10개를 조회, 요청당 생성되는 총 객체의 콘텐츠 크기는 200byte vs 300Kbyte로 증가하게 된다.
  <br>
  => 객체 압박으로 이어지며 JSON 직렬화/역직렬화 부담 및 GC로 인한 쓰레드의 대기로 인한 지연이 겹쳐 심각한 부하를 일으키는 것을 알 수 있다.

- 직렬화 관련 분석 => 콘텐츠 데이터20자 변환(APP)이 1만자 그대로 반환보다 조금 더 빠르고,
  붕괴 구간에서도 상대적으로 덜 불안정한 이유는 애플리케이션에서 1만자를 20자로 줄여 반환하는 부분에서
  GC 압력 차이보다는 JSON 직렬화 비용 감소 효과가 더 크다고 생각된다.

- 다만 1만자를 애플리케이션으로 가져오는 두 가지 테스트의 경우 26RPS로 진입하게 되면서 붕괴가 일어나기 시작하였다.
  <br>이는 세 가지 테스트를 종합해본 결과 현재 테스트에서 직렬화보다 DB에서 가져온 데이터를 객체로 생성하는 과정에서 GC압박으로 인한 쓰레드 중지가 원인이 된다고 판단했다.

- <details>
  <summary>📜 객체 생성량과 GC관련 분석 보기</summary>

  </details>

- 마지막으로 이번 테스트를 진행하며 느낀 점은 기존의 모니터링은 쓰레드와 히카리 풀을 우선적으로 보았다면
  이번 4차 테스트와 위의 문서등을 확인하면서 여러 측정 지표에 대해서 종합적으로 분석해야 올바른 판단을 내릴 수 있다는 것을 알게되었다.

## 테스트 분석을 통한 최종 선택

1. 단건,목록 조회의 경우 3개의 table을 조회하는 것 대신 매핑 테이블에 필요한 컬럼을 추가하여 fetch join으로 조회한다. 이를 통해 행 폭증은 DB->애플리케이션으로 넘어오는 과정에서 Hibernate의 자동 1차 캐시로 줄인다.

2. 추가로 목록 조회의 경우 원본 콘텐츠를 그대로 가져오게 될 경우 가뜩이나 많은 요청량이 수반되어 부하가 심해지므로 데이터베이스에서 20자로 줄여서 받아와 객체 생성으로 인한 GC의 발생을 비교적 줄인다.

3. 기존 전체 Content데이터는 LazyLoading으로 수정하여 단건 조회시에 추가 조회 쿼리를 날려 반환하는 방식으로 오버헤드를 줄인다.

4. 목록 조회의 경우 위 1,2,3,4차 테스트를 진행하면서 최종 성능은 120RPS에 평균 700ms대를 기록하였으며 SLO(Service Level Objective)인 p95 300ms대 요청량을 추가 측정하여 아래와 같은 결과가 나왔다

| 구분                     | RPS    | P95(ms) | 평균 처리량(req/s, 3회 평균) | 실패율 |
| ------------------------ | ------ | ------- | ---------------------------- | ------ |
| 20자 프리뷰 + fetch join | 30→105 | 312.38  | 105.01                       | 0.00%  |

5. 본 실험에서 관측된 p95 붕괴는 DB/Hikari 지표보다 JVM allocation rate 증가와 GC safepoint 정지(STW) 누적과 더 강하게 상관관계를 보였다.
   관련 근거(JFR/JMC 이벤트 타임라인, allocation top classes, safepoint cause)는 별도 부록으로 정리하였다.
   !()[]
   | 20자 프리뷰 + fetch join | 30→105 | 273.21 | 105.01 | 0.00% |
   166RPS에서 유지 167RPS에서 throughtput 166.68req/s
   === k6 Summary (phase:main) ===  
   avg latency: 310.39 ms  
   p95 latency: 2020.69 ms  
   throughput: 67.50 req/s (avg over test)  
   throughput(active): 166.00 req/s (active-window)
   fail rate: 0.00%

## 전제/한계

본 결론은 대규모 목록 조회 + 행 폭증 가능성이 있는 환경에서 유효하다.

페이징이 필수이거나, 다중 컬렉션 Fetch Join이 필요한 경우에는 Batch Fetch 또는 2단계 ID 조회가 더 적합할 수 있다.

또한 연관 데이터 수가 크게 증가하거나 쓰기 비중이 높아질 경우, GC·락 경합 특성이 달라질 수 있다.

따라서 본 선택은 현재 데이터 분포와 요청 패턴에 최적화된 결과임을 전제로 한다.
