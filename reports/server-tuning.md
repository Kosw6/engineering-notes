# Node / Stock API 성능 및 커넥션 최적화 & 다운사이징 실험 보고서

---

## 1. 실험 목적

* Node / Stock API의 성능을 측정한다.
* AWS 환경에서 SLO(p95 ≤ 300ms) 충족 여부를 검증한다.
* 현재 인프라 사양의 적정성을 판단한다.
* 성능 튜닝 이후, 비용 효율적인 인프라 구성을 도출한다.

---

## 2. 실험 환경

### 로컬 환경

* App + DB Server : 4 vCPU / 16GB
* CPU: Intel N100 (저전력 아키텍처, E-core 기반)
* Memory: LPDDR4x / LPDDR5 (온보드 메모리)
* Storage: M.2 2242 SSD (SATA 인터페이스, /dev/sda)
* DB: PostgreSQL

---

### 기존 환경 (Baseline)

* App Server: AWS EC2 m6i.xlarge (4 vCPU / 16GB, Intel Xeon Ice Lake)
* DB Server: AWS EC2 m6i.xlarge (4 vCPU / 16GB)
* Storage: AWS EBS gp3
* DB: PostgreSQL
* 네트워크: 동일 VPC 내부

---

### 다운사이징 환경

* App Server: AWS EC2 m6i.large (2 vCPU / 8GB)
* DB Server: 기존 유지 (이후 다운사이징 예정)

---

### 애플리케이션

* Spring Boot + JPA
* HikariCP
* JWT 인증 (검증 경로 최적화 적용)

---

### 설정

```yaml
Tomcat max threads: 150
HikariCP:
  maximumPoolSize: 8
  minimumIdle: 4
PostgreSQL:
  max_connections: 30
```

---

## 3. 성능 기준

* 부하 도구: k6

```text
SLO: p95 ≤ 300ms
```

---

## 4. 로컬 환경 성능 결과

### Node API (App + DB 단일 서버)

| RPS | p95(ms) | avg(ms) | 결과        |
| --- | ------- | ------- | --------- |
| 130 | 239     | -       | ⚠️ SLO 경계 |

---

### 분석

* 동일 코드 및 설정에서도 로컬 환경에서는 p95가 크게 증가
* App과 DB가 동일 서버에서 CPU, 메모리, 디스크 I/O를 공유
* PostgreSQL의 WAL write 및 fsync 과정이 디스크 I/O와 직접적으로 연결됨

#### 하드웨어 관점 분석

* Intel N100은 저전력 CPU로 단일 코어 성능이 제한적
* PostgreSQL 쿼리 처리 및 일부 연산은 단일 코어 성능에 크게 의존
* LPDDR 메모리는 대역폭 및 지연 측면에서 서버용 메모리 대비 제한 존재

#### 스토리지 관점 분석

* 로컬 SSD는 SATA 기반 (/dev/sda)
* random I/O 및 write latency에서 변동성이 존재
* WAL fsync 시 순간적인 I/O 지연 발생 가능

#### 구조 관점 분석

* App + DB 단일 서버 구조
* CPU, 메모리, 디스크 I/O 자원 경쟁 발생
* 요청 처리 중 일부가 DB I/O 지연에 의해 영향을 받으며 tail latency 증가

---

결론:

> 단일 서버 구조(App + DB)와 저전력 CPU 및 SATA 기반 스토리지 환경에서는
> CPU 및 I/O 리소스 경쟁과 I/O latency 변동으로 인해 tail latency(p95)가 크게 증가한다.

---

## 5. 4core / 16GB AWS 환경 성능 결과

### Node API

| RPS | p95(ms) | avg(ms) | 결과       |
| --- | ------- | ------- | -------- |
| 130 | 14.45   | 9.23    | ✅ SLO 만족 |
| 130 | 20.11   | 11.19   | ✅ SLO 만족 |

---

### Stock API

| RPS | p95(ms) | avg(ms) | 결과       |
| --- | ------- | ------- | -------- |
| 300 | 62.72   | 16.80   | ✅ SLO 만족 |
| 300 | 13.31   | 8.65    | ✅ SLO 만족 |

---

## 6. AWS 환경 분석

* CPU 사용률: 약 6~10%
* Tomcat thread 여유 충분
* Hikari connection 사용량 낮음
* 모든 테스트에서 p95 매우 낮은 수준 유지
* 병목 구간 확인되지 않음

---

### 환경 차이 핵심

* 서버급 CPU (Xeon Ice Lake) → 높은 단일 코어 성능
* EBS gp3 → 안정적인 I/O latency 및 일관된 성능
* App / DB 분리 구조 → 리소스 경쟁 제거

---

결론:

> 동일한 워크로드 기준에서 AWS 환경은 CPU, 메모리, I/O 모두 안정적인 처리 환경을 제공한다.

---

## 7. 다운사이징 실험 (2core / 8GB)

### 설정

```yaml
Tomcat: 100
Hikari: 8 / 4
PostgreSQL: 30
```

---

### Node API 결과 (Downsized)

| RPS | p95(ms) | avg(ms) | 결과       |
| --- | ------- | ------- | -------- |
| 130 | 13.30   | 10.00   | ✅ SLO 만족 |

---

### Stock API 결과 (Downsized)

| RPS | p95(ms) | avg(ms) | 결과       |
| --- | ------- | ------- | -------- |
| 300 | 11.64   | 7.90    | ✅ SLO 만족 |

---

## 8. 다운사이징 분석

* App 서버를 2core / 8GB로 축소한 이후에도
  Node 및 Stock API 모두에서 p95 latency가 약 10ms 수준으로 유지되었다.

* Stock API는 DB 의존도가 높은 API임에도 불구하고
  300 RPS 환경에서도 성능 저하 없이 안정적인 응답을 유지하였다.

---

결론:

> 성능은 단순 인프라 사양이 아니라
> 애플리케이션 구조, 리소스 분리, I/O 안정성에 의해 결정된다.

---

## 9. 핵심 인사이트

1. 동일한 코드와 설정에서도 인프라 구조에 따라 성능이 크게 달라질 수 있다
2. App-DB 분리 여부는 tail latency에 매우 큰 영향을 준다
3. CPU 아키텍처 및 단일 코어 성능 차이가 DB 기반 API 성능에 영향을 준다
4. 스토리지의 I/O 안정성은 p95 latency에 직접적인 영향을 준다
5. 커넥션 수는 많다고 좋은 것이 아니라 적절한 수준이 중요하다
6. 최적화 이후의 핵심 과제는 성능 향상이 아니라 비용 효율성이다

---

## 10. 결론

동일한 코드와 설정에서도
로컬 환경(App + DB 단일 서버, 저전력 CPU, SATA SSD)에서는 p95 약 239ms,
AWS 환경(App-DB 분리, 서버급 CPU, EBS)에서는 p95 약 13ms로 측정되었다.

이는 단순 성능 차이가 아니라

* CPU 아키텍처 및 단일 코어 성능
* 스토리지 I/O 특성
* App-DB 분리 여부

가 복합적으로 작용한 결과이다.

---

따라서 이후 실험은
**DB 서버 다운사이징 및 커넥션 최적화를 통해 최소 비용 구성에서의 SLO 만족 경계를 탐색하는 방향으로 진행한다.**

---

## 11. 다음 단계

* DB 서버 다운사이징
* PostgreSQL max_connections 재조정 (20~50)
* HikariCP 최적화 (8~12)
* Node 130 / Stock 300 기준 재측정
* SLO 경계 지점 탐색

---

## 12. 한 줄 결론

> 본 실험은 단순 성능 향상이 아닌,
> “필요한 성능을 유지하면서 불필요한 자원을 제거하는 비용 최적화”를 목표로 수행되었다.
