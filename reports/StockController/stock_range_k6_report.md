# 📈 StockController 조회 성능 최적화

### PostgreSQL + TimescaleDB 하이퍼테이블 및 청크 전략 분석

--- 

## 🚀 Summary

### 🎯 문제

* 약 **2,600만 행 시계열 데이터 조회 성능 저하**
* **5~7 RPS에서도 과부하 발생**
* **p95 300ms 목표 미달 (최대 7,247ms)**

---

### 🔍 원인

* 단일 테이블 구조 (Hypertable 미적용)
* 비효율적인 시간 분할 (조회 패턴: 90일)
* 과도한 chunk 수로 인한 **planner 비용 증가**
* 인덱스 최적화 부족

---

### 🛠 해결

* TimescaleDB **Hypertable 적용 (시간 + 공간 분할)**
* 조회 패턴 기준 **chunk 전략 재설계 (30일 → 90일)**
* 인덱스 최적화 (symb, timestamp)
* 공간 분할 튜닝 (8 → 4 비교 실험)
* EXPLAIN ANALYZE + k6로 성능 검증

---

### 📈 결과

* 인덱스 적용만으로 **약 10배 개선**
* Hypertable 적용 후 p95:

  * **7,247ms → 235ms (약 28배 개선)**
* chunk 튜닝으로 추가 **30% 개선**
* 최종:

  * **300 RPS / p95 235ms 달성**

---
### 💼 UX 영향

고부하 상황(300 RPS) 기준, 하이퍼테이블 적용 전에는 p95 약 7.2초 수준으로,
사용자는 차트 조회 및 기간 변경 시 긴 로딩과 응답 지연을 경험할 수 있었다.

특히 반복 조회 기반의 차트 서비스 특성상:

- 종목 탐색
- 기간 변경
- 연속 차트 조회

과 같은 흐름에서 UX 단절이 발생할 수 있는 수준이었다.

하이퍼테이블 및 chunk 전략 적용 후 p95는 약 235ms까지 감소하였고,

사용자 관점에서는:

- 차트 조회가 즉각적으로 반응하고
- 반복 탐색 시 대기감이 크게 감소하며
- 고부하 상황에서도 연속 조회 흐름이 자연스럽게 유지되는 수준으로 개선되었다.

이는 단순 평균 응답속도 개선이 아니라,
고부하 환경에서도 사용자의 조회 흐름 단절을 줄이는 데 초점을 두고 최적화한 결과이다.

---

### 💡 핵심 인사이트

* 시계열 DB는 execution보다 **planner cost 영향이 더 큼**
* chunk 수가 많을수록 성능 저하 발생
* read-heavy 환경에서는 **chunk 수를 줄이는 것이 효과적**
* 단순 튜닝이 아니라 **데이터 구조 설계가 성능을 결정**

---



## 전제조건

> 본 테스트는 동일한 조회 조건에서 시계열 데이터 조회 쿼리의 실행 시간이 P95 기준 7,247ms에서 235ms로 약 28배 개선되었으며,<br>
> 이는 인덱스 부재로 인한 Full Scan 구조에서 Index + Hypertable 기반 Chunk Pruning 구조로 전환되며 execution plan이 변경된 결과입니다.

> 해당 결과는 동일한 부하 조건에서 쿼리 실행 성능을 기준으로 측정된 값이며,<br>
> 실제 운영 환경에서는 커넥션 풀, 동시성 수준, 네트워크 및 I/O 상태 등에 따라 전체 응답 시간과 처리량은 달라질 수 있습니다.

# 📋 목차

- [1. 서론](#1-서론)
- [2. 테스트 환경](#2-테스트-환경)
- [3. 문제 정의 및 1차 결과](#3-문제-정의-및-1차-결과)
- [4. 하이퍼테이블 누락 확인](#4-하이퍼테이블-누락-확인)
- [5. 하이퍼테이블 구조](#5-하이퍼테이블-구조)
- [6. 청크 전략 비교](#6-청크-전략-비교)
- [7. 공간 분할 장단점](#7-공간분할의-장단점)
- [8. 부하 테스트](#8-k6부하테스트-테스트-고정시드-추가)
- [9. 최종 결과](#9-하이퍼-테이블-적용-전후-테스트-결과)
- [10. 최종 설계 결정](#10-하이퍼테이블-최종-선택-결과)
- [11. 전제 및 한계](#11-전제한계)
- [12. 조회 전략](#12-1d--1w--1m--1y-단위-조회-전략)

---------

# 1. 서론

본 문서는 대규모 시계열 데이터(약 2,600만 건)를 대상으로
Stock 조회 API의 성능 병목을 분석하고 개선한 과정을 정리한 것이다.

해당 서비스는 다음과 같은 특징을 가진다:

- **Append-only 구조**
  - 데이터는 배치로 적재되며 수정/삭제는 거의 없음
- **Read-heavy 워크로드**
  - 대부분 조회 요청 (차트/분석)
- **조회 패턴 고정**
  - 특정 종목(symb)에 대해 약 90일 구간 반복 조회

초기에는 일반 PostgreSQL 테이블 구조에서
낮은 RPS에서도 병목이 발생하였고,
단순 인덱스 튜닝만으로는 한계가 존재했다.

이에 따라 TimescaleDB 기반 하이퍼테이블 구조를 도입하고,
시간/공간 청크 전략을 비교 실험하여
최적의 조회 성능을 달성하는 것을 목표로 하였다.

# 2. 테스트 환경

| 항목                 | 설정                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------- |
| 서버 사양            | 4 Core / 16GB / SSD                                                                   |
| DB                   | PostgreSQL 17 + TimescaleDB                                                           |
| 커넥션 풀            | HikariCP max=125,idle=80                                                              |
| 테스트 도구          | k6 v0.52                                                                              |
| 초기 부하 유형       | ramping-arrival 20RPS 시작으로도 과부하 -><br>매우 낮은 constant-arrival-rate(5~7RPS) |
| 네트워크             | 내부 브릿지 (Docker Compose 환경)                                                     |
| 데이터 구성          | 약 2,600만 행 규모의 OHLCV 시계열 데이터. PostgreSQL 17 + TimescaleDB로 확장하여 운용 |
| GC 지표 정의         | sum(rate(jvm_gc_pause_seconds_sum[5m]))                                               |
| JVM                  | OpenJDK Temurin 17 (64bit,JRE-only)                                                   |
| GC 종류              | G1GC (Garbage-First)                                                                  |
| 힙 초기/최대 크기    | Xms=248MB / Xmx=3942MB (컨테이너 자동 설정)                                           |
| Heap Region Size     | 2MB                                                                                   |
| Parallel Workers     | 4                                                                                     |
| Max Pause Target     | 200ms (기본값, G1 MaxGCPauseMillis)                                                   |
| String Deduplication | **Disabled** (명시 옵션 미사용)                                                       |

# 3. 문제 정의 및 1차 결과

## 1차 테스트 결과

| 항목     | 설정                |
| -------- | ------------------- |
| RPS      | 8RPS                |
| 시간     | 1분으로 짧은 테스트 |
| 목표 P95 | <300ms              |
| 결과 P95 | 315ms               |

## 문제점 요약

- 테스트가 진행이 되지 않을 정도의 병목이 발생하고 있음
- DB쿼리 성능저하로 인한 병목으로 진단
- 하이퍼테이블 누락

## 해결방법

- 인덱스 확인 및 최적화(symb,timestamp),(symb),(timestamp)인덱싱
- 하이퍼 테이블 적용
- 청크 변경 기존(30day로 운영중)

| 항목           | RPS | P95       | throughtput | failRate |
| -------------- | --- | --------- | ----------- | -------- |
| stock(인덱싱X) | 10  | 342.14 ms | 10.01 req/s  | 0.00%    |
| stock(인덱싱O) | 10  | 32.06 ms  | 10.01 req/s  | 0.00%    |

- 개선율 약 10~11배 성능 향상

# 4. 하이퍼테이블 누락 확인

```sql
SELECT
  hypertable_schema,
  hypertable_name,
  num_dimensions,
  num_chunks,
  compression_enabled
FROM timescaledb_information.hypertables
ORDER BY hypertable_schema, hypertable_name;
```

- 위 쿼리로 확인 결과 덤프/복원 과정에서 하이퍼테이블 메타데이터 누락 확인<br>
  -> 하이퍼테이블 추가
- 시간청크와 더불어 공간 청크에 대해서 알게된 후 시간,공간 청크를 각각 나누어 하이퍼 테이블을 생성 및 기존 데이터를 복사하여 Explain으로 쿼리 성능 비교

```sql
#3개월 데이터에 대해서 해당 쿼리를 비롯한 총 5개 다른 주식심볼값을 기준으로 테스트
#웜 캐시의 경우 같은 쿼리를 3번 반복 후 마지막 값으로 기록
#각 쿼리마다 테이블(stock,stock_new)의 소요시간 계산
EXPLAIN (ANALYZE, BUFFERS, TIMING, SUMMARY)
SELECT *
FROM stock
WHERE symb = 'ALGT'
AND timestamp BETWEEN '2022-01-01' AND '2022-04-01'
ORDER BY timestamp ASC;

EXPLAIN (ANALYZE, BUFFERS, TIMING, SUMMARY)
SELECT *
FROM stock
WHERE symb = 'CNOB'
AND timestamp BETWEEN '2024-01-01' AND '2024-04-01'
ORDER BY timestamp ASC;
...
```

> **Warm cache** 구간에서는 planner 재사용과 buffer hit으로 인해  
> 실제 차이가 0.1–0.2 ms 이내로 수렴하여 동일한 값으로 표기하였다.  
> **Cold/Warm execution time** 또한 동일한 인덱스 경로를 사용하므로  
> 측정값의 변동이 미미하며 근사치로 동일한 값으로 표기하였다.

| 항목                 | 평균 planningTime | 평균 executionTime |
| -------------------- | ----------------- | ------------------ |
| stock_30d_32콜드캐시 | 49ms              | 3ms                |
| stock_30d_8콜드캐시  | 47ms              | 3ms                |
| stock_30d_32웜캐시   | 3ms               | 0.4ms              |
| stock_30d_8웜캐시    | 3ms               | 0.4ms              |

| 항목                 | 평균 planningTime | 평균 executionTime |
| -------------------- | ----------------- | ------------------ |
| stock_90d_8 콜드캐시 | 31ms              | 3ms                |
| stock_90d_4 콜드캐시 | 23ms              | 3ms                |
| stock_90d_8 웜캐시   | 3ms               | 0.3ms              |
| stock_90d_4 웜캐시   | 3ms               | 0.3ms              |

- 실행 시간은 0.3–3ms로 거의 동일하나, 청크 수/파티션 수 차이에 따른 planner 오버헤드가 cold에서 planning time으로 나타났다.

- warm에서는 buffer hit + plan cache 영향으로 planning이 3ms로 수렴하여, 차이는 **콜드 플래닝 비용** 구간에서만 의미가 있다

# 5. 하이퍼테이블 구조

- TimescaleDB의 하이퍼테이블은 데이터를 시간(Time), 공간(Space)으로 나누어 관리한다.
- 테스트에 사용한 스키마의 경우 <br>시간은 timestamp값 <br>공간은 symb(주식티커)을 설정했다.

- 청크 분할은 다음 순서로 이루어진다(분할 순서: 시간 → 공간)

  1. 시간 기준 분할 (chunk_time_interval)

     - 우선 데이터를 timestamp 값 기준으로 일정 주기(예: 30일, 90일) 단위로 나눈다.

     - 이 단계에서 여러 symb의 데이터가 같은 시간 구간 청크에 포함된다.

  2. 공간 기준 분할 (num_partitions)

     - 이후 각 시간 청크 내부에서 symb 컬럼의 해시(hash) 값을 이용해 num_partitions 개의 버킷으로 나눈다.

     - 예시: hash(symb) % num_partitions

     - 동일한 해시 결과를 갖는 symb 값(즉, 같은 종목)은 항상 같은 버킷(같은 물리 청크)에 저장된다.

# 6. 청크 전략 비교

## 인터벌 30에서의 비교

- 애플리케이션의 조회기능은 주로 90일간격으로 조회하여 테스트에 반영하였다.
- 30일 인터벌(공간청크 차이 없음) : 3~4개 시간청크 스캔
- 90일 인터벌+공간청크8개 : 대게 1개 시간청크 스캔 → 결과 PlanningTime 35% 감소

## 인터벌 90에서의 비교

- 공간을 8로 나눈 것과 4로 나눈 것의 예시
  - 공간을 8로 나누었을 경우 8개의 버킷, 4로 나눌 경우 4개의 버킷만 스캔하면 됨 -> 평균 PlanningTime 20%감소
- 최종적으로 같은 90일 간격 공간청크(8)보다 대략 30%,<br>
  처음 30일간격보다 PlanningTime 55% 감소

# 7. 공간분할의 장단점

1. 공간청크가 클 수록(num_partitions ↓)

- 장점:

  - Planner 오버헤드 ↓
    - 청크 수가 적어 쿼리 계획을 세우는 시간이 짧다.
  - I/O효율 ↑
    - 큰 청크를 연속적으로 읽으므로 디스크 접근이 더 효율적이다.
  - 통계·인덱스 관리 간단
    - ANALYZE, VACUUM 등 관리 주기가 단순하다.
    - 청크 10개와 500의 경우 같은 ANALYZE를 돌려도 10번 500을 돌려야 하는 차이가 있음

- 단점:

  - 락 경합 및 쓰기 병목 ↑
    - insert,update가 같은 청크에 몰리게 되어 락·인덱스 경합 발생.
  - 병렬처리 효율 ↓

    - TimescaleDB의 병렬 스캔은 청크 단위로 워커를 분배하므로  
      청크 수가 적으면 병렬화 기회 자체가 줄어들고 CPU 활용률이 낮아진다.

  - 청크가 너무 커져 인덱스·테이블 크기 비대해짐
    - 인덱스 재구성 및 압축이나 삭제시에도 청크단위로 하다보니 부하와 걸리는 시간이 올라간다.
    - 청크마다 크기가 크다보니 ANALYZE,VACUUM등의 부하가 심해진다.

2. 공간청크가 작을 수록(num_partitions ↑)

- 장점:
  - symb별로 다른 청크에 분산되어 동시 쓰기 병목 완화된다.
    - postgreSQL은 데이터를 디스크에 페이지 단위로 저장하기에 청크가 많을 수록 symb별로 테이블이 분리되며 서로 같은 페이지에 쓰려 할 가능성이 적어 lock충돌이 일어날 가능성이 적어져 동시 쓰기 병목이 완화된다.
  - 병렬 쿼리 및 유지보수 효율 ↑
    - 여러 청크를 병렬로 VACUUM/압축/SELECT 가능하다.
  - 청크 단위 관리 유연성 ↑
    - 오래된 종목 일부만 압축하는 등 청크단위가 많아져 세밀하게 작업이 가능하다.
    - 일부 청크 장애나 데이터 삭제시에 영향 범위가 적다
- 단점:
  - Planner 오버헤드 ↑
    - 청크 수가 많아 쿼리 계획 세우는 시간이 길어진다.
  - 랜덤 I/O 증가
    - 데이터가 여러 청크로 흩어져 연속 읽기 불가하다.
  - 통계·인덱스 관리 비용 ↑
    - 청크별 ANALYZE(쿼리 실행 계획을 위한 통계 정보 수집), 인덱스 메타데이터가 늘어나 관리 오버헤드 발생.

# 8. K6부하테스트 테스트 고정시드 추가

- 테스트의 경우 본 부하 테스트 RPS의 20%의 RPS로 3분간 웜업을 하여 캐시를 채움
  - pg_statio_user_tables기준 buffer hit_ratio 99% 확인
- 성능, 구조등을 변경하며 동일한 조건에서 테스트를 하기 위해 웜업을 제외한 본 부하 테스트의 경우 시드값을 토대로 테스트가 같은 파라미터 순서를 타도록 설정함

## 테스트 결과

| 항목        | RPS | P95      | throughtput  | failRate |
| ----------- | --- | -------- | ------------ | -------- |
| stock_90d_8 | 300 | 331.99ms | 300.01 req/s | 0.00%    |
| stock_90d_4 | 300 | 235.32ms | 300.01 req/s | 0.00%    |

- 같은 시간청크, RPS 300기준 성능 30%향상

# 9. 하이퍼 테이블 적용 전후 테스트 결과

| 항목        | RPS | P95      | throughtput  | failRate |
| ----------- | --- | -------- | ------------ | -------- |
| plain_stock | 300 | 7247.28ms | 213.40 req/s | 0.00%    |
| stock_90d_4 | 300 | 235.32ms | 300.01 req/s | 0.00%    |

- 같은 인덱스를 적용한 테스트 결과 하이퍼테이블 튜닝 후 성능이 p95기준 약 28배 향상

# 10. 하이퍼테이블 최종 선택 결과

1. 시간분할 : 90day
2. 공간분할 : 4

- 단순 종목 조회(90일)가 주 기능이다보니 시간간격은 90일로 설정
- append-only 구조로 업데이트/삭제가 전혀 없기 때문에,
  VACUUM이나 인덱스 락 경합은 발생하지 않는다.
- 쓰기작업이 하루에 한번 배치처리로 되고 약 10000개의 데이터이다 보니 쓰기작업에서 병렬도나 시간은 중요하지 않다고 판단.
- 오히려 읽기 성능의 최적화가 중요하다 생각하여 num_partitions=4로 설정
- 다만 통계, 청크 장애등을 고려하여 공간청크를 두지 않는 것보다 4개로 나눔
- 부하테스트, DB내의 5~6개의 고정된 조회쿼리를 사용한 EXPLAIN결과를 토대로 결정하게 되었음
- 해당 조회 기능은 실시간성이 아니며 요청당 90일치 데이터를 반환하기에 300RPS p95=235.32ms는 만족할만한 성능이라고 판단
- 추후 서비스가 운영되고 트래픽 급증시 Redis캐시 단계적으로 도입 예정

# 11. 전제/한계

본 하이퍼테이블 및 청크 설계는 읽기 비중이 매우 높은 분석형 쿼리에 최적화되어 있다.

종목 수가 급격히 증가하거나, 동시 쓰기·업데이트가 빈번해질 경우 공간 청크 분할 전략은 재검토가 필요하다.

또한 실시간 단일 레코드 조회나 초저지연 트랜잭션 환경에서는 일반 B-Tree 기반 테이블이 더 적합할 수 있다.

본 결론은 현재 서비스의 접근 패턴과 데이터 생명주기를 기준으로 도출되었다

---

# 12. 1D / 1W / 1M / 1Y 단위 조회 전략

본 서비스는 차트 프레임(1D/1W/1M/1Y)에 따라 서로 다른 집계 단위의 OHLCV 데이터를 제공하도록 설계하였다.  
성능과 확장성을 동시에 확보하기 위해 다음과 같은 전략을 정의하였다.

## 1. 데이터 소스 분리 전략

* **1D(일봉)**: 원본 hypertable(`stock`)에서 직접 조회
* **1W/1M/1Y(주·월·연봉)**: TimescaleDB Continuous Aggregate(CAGG) 기반 사전 집계 view 활용

→ 범위 집계 쿼리의 반복 실행 비용을 제거하고, 고부하 환경에서도 안정적인 응답 시간을 확보하도록 설계하였다.

---

## 2. OHLCV 집계 규칙 정의

프레임별 캔들 데이터는 다음 기준으로 집계한다.

* `open`  = first(open, timestamp)
* `close` = last(close, timestamp)
* `high`  = max(high)
* `low`   = min(low)
* `volume` = sum(volume)

→ 집계는 `time_bucket()` 기반으로 수행하며, 프레임별 CAGG로 분리 관리한다.

---

## 3. 배치 기반 Refresh 전략 (수동 제어)

* 일봉 데이터는 영업일 기준 배치로 1일 1회 적재
* 배치 완료 이후 `refresh_continuous_aggregate()` 호출
* 전체가 아닌 **최근 구간만 refresh**

→ 자동 policy 대신 배치 타이밍에 맞춘 수동 제어를 통해  
**DB 부하를 예측 가능하게 유지하도록 설계하였다.**

---

## 4. 조회 최적화 전략

* `(symb, bucket DESC)` 인덱스 구성
* cursor 기반 조회 (`before`)
* offset 제거

→ 대량 데이터 환경에서 일정한 응답 성능을 유지하도록 설계하였다.

---

## 5. 정합성 및 운영 고려

* refresh 완료 이후 데이터 노출
* `lastRefreshedAt` 기준 시각 제공 가능

→ 데이터 신뢰성과 사용자 인지 일관성을 확보하도록 설계하였다.

---

## 6. 확장 전략

* 트래픽 증가 시 Redis 캐시 도입 가능
* 월/연 단위 조회는 별도 CAGG를 생성하지 않고 **주간 CAGG 기반 재집계 방식으로 처리**

→ 현재 구조를 기반으로 성능과 운영 복잡도를 균형 있게 고려한 확장 전략을 수립하였다.

---


## 7. CAGG 전략 도입 검증 결과

본 전략에 대해 실제 데이터 기반 성능 검증을 수행하였다.

timescaleDB의 CAGG(연속집계) Materialized View를 활용하여 주간, 월간 논리적 뷰를 생성하여 <br>
EXPLAIN ANALYZE를 통해 실제 조회 성능을 비교하였다. <br>공정성을 위해 비교시 한 종목당 순서를 바꿔가며 조회하였다.

## 요약

위에서 설계한 확장 전략에 대해 실제 데이터 기반 성능 검증을 수행한 결과,
데이터 소스 분리, 집계 규칙 정의, 조회 최적화 전략은 최종적으로 도입한다.

초기에는 refresh 범위와 운영 비용을 명확히 통제하기 위해
배치 기반 수동 refresh 전략으로 설계하였다.

그러나 해당 방식은 watermark 이전 구간에 대한 backfill 데이터 반영이 어렵고,
refresh 실패 또는 누락 시 데이터 정합성 문제가 발생할 수 있는 한계가 있다.

이후 real-time aggregate를 적용하여 추가 검증을 수행한 결과,

- real-time aggregate는 watermark 이후 최신 구간에 대해 raw 데이터를 병합하여 보완하며
- 90주봉 조회 기준에서 materialized-only와 비교해 성능 차이가 거의 발생하지 않음을 확인하였다.

그러나 동시에 다음과 같은 구조적 특성을 확인하였다.

- CAGG refresh는 refresh window에 완전히 포함된 bucket만 처리된다.
- watermark 이전 구간에 대한 backfill 데이터는 real-time aggregate로 반영되지 않는다.
- 정합성은 refresh 수행 여부에 의존한다.

이에 따라 단일 방식이 아닌,

- 완료된 bucket은 refresh를 통해 materialize하고
- 진행 중 bucket은 real-time aggregate로 최신성을 보완하며
- watermark 이전 구간은 배치 및 검증 전략을 통해 정합성을 확보하는

방식으로 최종 운영 전략을 정리한다.


---

### 7.1 뷰 생성과 CAGG구조

- CAGG는 Materialized View 형태의 논리적 인터페이스를 제공하지만,<br>
실제 데이터는 Backing Hypertable이라는 물리적인 하이퍼테이블에 저장된다.<br>
이를 통해 사전 집계된 결과를 빠르게 조회할 수 있다.

- 아래는 생성된 주간 CAGG 뷰에서 bucket(집계된 시간 그룹 기준 시점)과 원본 timestamp의 관계를 나타낸 예시이다.


![버킷](../../image/raw-bucket-mapping.png)

#### CAGG vs Materialized View 차이

일반 Materialized View는 refresh 시 전체 데이터를 재계산하는 반면,<br>
CAGG는 time_bucket 기반으로 변경된 구간(refresh window)에 대해서만 재계산을 수행하여,
전체 재계산을 수행하는 일반 Materialized View 대비 효율적인 갱신이 가능하다.<br>

CAGG는 backing hypertable에 집계 결과를 저장하여
대용량 시계열 데이터 환경에서 효율적인 성능과 확장성을 제공한다.

CAGG는 refresh 시 refresh window에 완전히 포함된 bucket만 재계산되며<br>  진행 중인 bucket을 강제로 refresh window를 늘려 미래 시점에서 진행하게 된다면 watermark증가로 인해 real-time aggregate를 활용할 수 없으며 동시에 정합성 관리 비용이 증가하게 된다.<br>  
따라서 최신 데이터는 별도의 raw 기반 계산 또는 real-time aggregate를 통해 조회 시점에 보완하는 방식을 공식 문서에서도 권장한다.

### 7.2 주간 CAGG vs Raw 집계 성능

| 구분              | Planning Time (ms) | Execution Time (ms) |
| --------------- | ------------------ | ------------------- |
| Raw Aggregation | 3.471              | 6.212               |
| CAGG 조회         | 2.641              | 0.329               |

→ CAGG 적용을 통해 **약 19배 실행 시간 감소**를 확인하였다.<br>
(집계 연산 제거에 따른 execution cost 감소 효과)

이는 반복적인 집계 연산을 제거하고, 사전 집계된 결과를 조회하는 구조로 전환되었기 때문이다.

---

### 7.3 주간 CAGG기준 Cursor vs OFFSET 조회 성능

| 종목   | 방식     | OFFSET | Planning Time (ms) | Execution Time (ms) |
| ---- | ------ | ------ | ------------------ | ------------------- |
| DIA  | Cursor | -      | 2.319              | **0.418**           |
| DIA  | OFFSET | 50     | 2.134              | **0.879**           |
| TSLA | Cursor | -      | 1.959              | **0.392**           |
| TSLA | OFFSET | 100    | 2.101              | **0.873**           |
| AAPL | Cursor | -      | 4.449              | **0.368**           |
| AAPL | OFFSET | 50     | 4.061              | **0.621**           |

→ OFFSET 대비 cursor 기반 조회는 약 **1.7 ~ 2.2배 빠른 실행 성능**을 보였다.

---

### 7.4 일간 vs 주간 vs 월간 집계 성능

| 종목   | 집계 방식   | Planning Time (ms) | Execution Time (ms) |
| ---- | ------- | ------------------ | ------------------- |
| AAPL | 월간 CAGG | 2.970              | **0.191**           |
| AAPL | 주간 재집계  | 1.922              | **0.543**           |
| AAPL | 일간 재집계  | 3.527              | **1.781**           |
| TSLA | 월간 CAGG | 1.420              | **0.272**           |
| TSLA | 주간 재집계  | 1.536              | **0.765**           |
| TSLA | 일간 재집계  | 3.648              | **6.791**           |
| VID  | 월간 CAGG | 1.447              | **0.264**           |
| VID  | 주간 재집계  | 1.517              | **0.709**           |
| VID  | 일간 재집계  | 3.422              | **5.077**           |

→ 집계 단위가 커질수록 사전 집계 효과가 극대화되며,
raw 기반 재집계 대비 execution cost가 크게 감소하는 것을 확인하였다.

---

### 7.5 성능 차이 요약

| 종목   | 주간 대비 월간   | 일간 대비 월간    |
| ---- | ---------- | ----------- |
| AAPL | 약 **2.8배** | 약 **9.3배**  |
| TSLA | 약 **2.8배** | 약 **25.0배** |
| VID  | 약 **2.7배** | 약 **19.2배** |

---

### 7.6 종합 분석

* CAGG를 통해 집계 연산 비용을 제거하여 성능 개선을 확인하였다.
* Cursor 기반 조회를 통해 OFFSET 대비 일관된 성능 향상(약 2배)을 확인하였다.
* 월간 CAGG는 주간 재집계 대비 약 2.7~2.8배 빠른 성능을 보였으나,
  주간 재집계 역시 execution 시간이 충분히 낮아 실시간 조회 요구사항을 만족하였다.

또한 뒤에 후술할 실제 서비스 요구사항 기준 검증 결과에서는 real-time aggregate 적용 여부와 관계없이  
90주봉 조회 기준 execution time은 약 0.6~0.7ms 수준으로 유사하게 유지되었으며,  
real-time aggregate로 인한 추가 비용은 사실상 무시 가능한 수준임을 확인하였다.

→ 이에 따라 성능과 운영 복잡도를 종합적으로 고려하여  
**주간 CAGG까지만 적용하고, 월/연 단위 조회는 주간 데이터 기반 재집계로 처리하는 전략을 채택하였다.**

----

### 7.7 CAGG 구조적 한계

CAGG는 성능 측면에서는 효율적이지만, 다음과 같은 구조적 제약을 가진다.

- refresh는 refresh window에 완전히 포함된 bucket만 처리된다.
- 진행 중 bucket(incomplete bucket)은 materialized 데이터로 반영되지 않는다.
- real-time aggregate는 watermark 이후 구간에 대해서만 raw 데이터를 병합한다.
- watermark 이전 구간은 materialized 결과를 그대로 사용하며 raw 데이터는 반영되지 않는다.

이러한 구조로 인해 CAGG는 다음과 같이 동작한다.

```
[ materialized ] | watermark | [ real-time aggregate ]
```

즉, CAGG는 모든 raw 데이터를 자동으로 반영하는 구조가 아니라,  
**materialized 영역과 real-time 보완 영역이 분리된 구조**임을 확인하였다.

### 7.8 정합성 관점의 운영 리스크

위 구조로 인해 다음과 같은 정합성 문제가 발생할 수 있다.

- 특정 시점까지 refresh 수행 → watermark 이동
- 이후 해당 bucket 범위에 late data(backfill) 삽입
- refresh 실패 또는 누락

이 경우:

- materialized 데이터는 과거 상태 유지
- real-time aggregate는 watermark 이전 구간을 보지 않음

→ 결과적으로 **조회 결과와 실제 raw 데이터 간 불일치 발생 가능**

즉, real-time aggregate는 최신 구간 보완에는 유효하지만,  
**watermark 이전 구간에 대한 정합성은 보장하지 않는다.**

→ 따라서 CAGG 구조에서는  
**정합성이 refresh 수행 여부에 의존하는 특성을 가진다.**

---

### 7.9 Real-time Aggregate 동작 검증 및 한계 분석

real-time aggregate(`materialized_only = false`) 설정을 적용한 CAGG에 대해  
실제 데이터 삽입 및 refresh 시나리오 기반 검증을 수행하였다.

검증은 다음 흐름으로 진행하였다.

1. 특정 시점까지 refresh 수행 (materialized 상태)
2. watermark 이후 구간에 raw 데이터 추가
3. refresh 없이 조회 → real-time merge 확인
4. 이후 refresh 수행 → materialized 반영 및 watermark 증가 확인
5. watermark 이전 구간(backfill)에 raw 데이터 삽입 → 반영 여부 검증

---

### 7.9.1 성능 비교 (90주봉 조회 기준, 중앙값)

| 구분 | 상태 | Watermark 기준 | Execution Time (ms) | Planning Time (ms) | 특징 |
|------|------|----------------|---------------------|--------------------|------|
| Baseline | materialized-only | 최신까지 반영 | **0.707** | 4.085 | 순수 materialized 조회 |
| RT Aggregate | raw 추가 후 미반영 | watermark 이후 raw 존재 | **0.690** | 4.165 | real-time merge 수행 |
| Refresh 이후 | materialized 재반영 | watermark 증가 | **0.686** | 4.217 | 다시 materialized 상태 |

→ 90주봉 조회 기준에서 **real-time aggregate와 materialized-only 간 성능 차이는 거의 없었다.**  
(약 0.02ms 수준으로 오차 범위)

---

### 7.9.2 Watermark 및 Real-time Aggregate 동작 검증

실험 결과 다음과 같은 특성을 확인하였다.

- raw 데이터 insert만으로는 watermark가 증가하지 않음
- watermark는 `refresh_continuous_aggregate()` 수행 시에만 증가
- real-time aggregate는 watermark 이후 구간에 대해서만 raw 데이터를 병합
- watermark 이전 구간은 materialized 결과를 그대로 사용

즉, CAGG는 다음과 같은 구조로 동작한다.

```
[ materialized ] | watermark | [ real-time aggregate ]
```


---

### 7.9.3 Backfill 데이터 반영 검증

watermark 이전 구간에 대해 raw 데이터를 삽입한 경우:

- real-time aggregate → 적용되지 않음
- materialized view → 기존 값 유지

즉, 다음 조건에서는 데이터가 조회에 반영되지 않는다.

- 이미 refresh된 bucket (watermark 이전)
- 이후 해당 bucket 범위에 raw 데이터 삽입
- 추가 refresh 미수행

→ **backfill 데이터는 반드시 refresh를 통해서만 반영됨을 확인하였다.**

---

### 7.9.4 Real-time Aggregate의 구조적 한계

real-time aggregate는 다음과 같은 구조적 한계를 가진다.

- 최신 구간 보완에는 유효
- 과거 bucket 정합성 보장 불가
- watermark 이전 구간은 raw merge 대상이 아님

특히 다음 시나리오에서 문제가 발생할 수 있다.

- 특정 시점까지 refresh 수행 → watermark 이동
- 이후 해당 bucket에 late data(backfill) 삽입
- refresh 실패 또는 누락

이 경우:

- materialized 결과는 과거 상태 유지
- real-time aggregate는 해당 구간을 보지 않음

→ **조회 결과와 실제 데이터 간 부정합 발생 가능**

---

### 7.9.5 최종 분석

- real-time aggregate는 최신 데이터 보완에는 효과적이며,
  성능 오버헤드 또한 거의 없는 수준으로 확인되었다.

- 그러나 watermark 이전 구간에 대한 데이터 정합성은 보장하지 않으며,
  **정합성은 refresh 수행 여부에 전적으로 의존한다.**

따라서 CAGG 구조는 다음과 같이 역할이 분리된다.

- **real-time aggregate**: 최신성 보완
- **refresh**: 정합성 보장 및 materialization

---

### 7.9.6 운영 관점 결론

본 실험을 통해 다음과 같은 운영 전략 필요성을 확인하였다.

- refresh 작업 실패 시 재시도 및 모니터링 체계 필요
- 최근 구간에 대한 주기적 재-refresh 전략 필요
- watermark를 과도하게 빠르게 이동시키지 않도록 refresh window 설계 필요

즉, real-time aggregate는 보조 수단이며,  
**데이터 정합성은 refresh 정책 설계에 의해 결정된다.**


### 7.9.7 배치 기반 정합성 보장 전략

데이터 적재와 CAGG refresh를 하나의 배치 단위로 관리하여
정합성 누락 가능성을 최소화한다.

배치는 다음과 같은 단계로 구성한다.

1. 원천 API 데이터 수집
2. raw 테이블 적재
3. 적재 건수 검증
4. 최근 완료된 버킷 구간 CAGG refresh 수행
5. 검증 쿼리 수행
6. 성공 시 배치 완료 처리

이때 refresh는 전체 구간이 아닌,
**최근 2개 bucket 범위에 대해서만 수행**하도록 제한한다.

또한, 현재 진행 중인 bucket(예: 이번 주)은 refresh 대상에서 제외한다.

→ 이는 CAGG refresh가 refresh window에 완전히 포함된 bucket만 materialization 하는 특성과,  
진행 중 bucket을 포함할 경우 반복적인 재계산이 발생하는 비효율을 고려한 설계다.

따라서

- **완료된 bucket만 refresh 대상으로 포함하고**
- **진행 중 bucket은 real-time aggregate로 조회 시점에 보완한다**

위 방식으로 역할을 분리한다.

→ 이는 real-time aggregate가 watermark 이후 최신 구간을 보완하는 구조를 활용하여  
불필요한 전체 refresh 비용을 줄이기 위함이다.

---

#### ✔ Late Data 대응 전략

배치 처리 과정에서 데이터 누락 또는 지연 도착(late arrival)이 발생할 수 있으므로,
다음과 같은 보완 전략을 적용한다.

- daily batch에서는 최근 2개 bucket만 refresh 수행한다
- 진행 중 bucket은 refresh 대상에서 제외하고 real-time aggregate로 처리한다
- watermark 이전 구간에 대한 backfill은 real-time aggregate로 반영되지 않는다
- 따라서 해당 구간은 별도의 검증 및 재처리 대상이 된다

---

#### ✔ 주기적 정합성 검증 (Reconciliation)

일 배치만으로는 watermark 이전 구간의 정합성을 보장할 수 없기 때문에,
주기적인 검증 작업을 추가한다.

- 영업일이 아닌 시점(예: 매주 토요일)에 크론 작업을 수행한다
- raw 데이터와 CAGG 결과를 비교하여 누락 데이터를 탐지한다
- 누락이 확인된 bucket 범위에 대해 추가 refresh를 수행한다

이를 통해 다음 문제를 해결한다.

- late data로 인한 backfill 누락
- refresh 실패 또는 일부 누락
- watermark 이전 구간 정합성 붕괴

---

#### ✔ 최종 정합성 모델

본 시스템은 다음과 같은 계층 구조로 정합성을 보장한다.

- **real-time aggregate**: 최신 데이터 보완 (low latency)
- **daily refresh (최근 bucket)**: 단기 정합성 확보
- **weekly reconciliation**: 장기 정합성 보장

즉, 단일 방식이 아닌

- real-time aggregate로 최신 데이터를 보완하고
- refresh와 검증 과정을 통해 과거 구간의 정합성을 확보하는

구조로 설계한다.

### ✔ 최종 설계 결정

본 실험을 통해 real-time aggregate는 watermark 이후 최신 구간을 보완하는 데 있어
성능 오버헤드 없이 효과적으로 동작함을 확인한다.

특히 서비스 요구사항인 90주봉 조회 기준에서는
materialized-only 조회와 비교하여 성능 차이가 거의 발생하지 않으며,
이를 통해 real-time aggregate를 적용하더라도 성능 부담은 사실상 없다고 판단한다.

다만, watermark 이전 구간에 대한 backfill 데이터는 반영되지 않기 때문에
정합성은 refresh 정책에 의존하는 구조적 한계를 가진다.

따라서 본 시스템에서는

- 최신 데이터는 real-time aggregate로 보완하고
- 과거 데이터는 refresh 및 검증 과정을 통해 정합성을 확보하는

방식으로 역할을 분리하여 최종 설계를 구성한다.


[→TimeScaleDB CAGG Reference 바로가기](https://www.tigerdata.com/docs/reference/timescaledb/continuous-aggregates/refresh_continuous_aggregate)