# 📄 Thread / Hikari 설정에 따른 Context Switching 및 Latency 분석


## 1. 실험 목적

본 실험은 다음을 검증하기 위해 수행하였다.

* Thread 수 증가가 CPU scheduling 및 context switching에 미치는 영향
* Hikari connection pool 크기 변화의 실질적 효과
* Context switching 증가가 실제 latency(p95)에 미치는 영향
* 자원 부족 상황에서 발생하는 saturation 지점 확인

---

## 2. 실험 환경

* App Server: AWS EC2 (c6i.large/ 2 vCPU / 4GB)
* DB Server: PostgreSQL (c6i.large/ 2 vCPU / 4GB 분리된 프라이빗 서버)
* 부하 도구: k6 (constant-arrival-rate)
* 측정 도구:

  * `pidstat -wt` → context switching
  * `vmstat` → system 상태
* 주요 지표:

  * `pid_nvcswch` (involuntary context switching)
  * `pid_cswch` (voluntary context switching)
  * p95 latency

---

## 3. 실험 시나리오

### 기본 부하

* Warm-up: 40 RPS / 45s
* Main: 150 RPS / 90s

### 스트레스 부하(thread saturation측정용)

* Warm-up: 60 RPS / 45s
* Main: 300 RPS / 90s

### 비교 케이스

* Thread 변화: 16 / 30 / 60 / 120
* Hikari 변화: 4 / 8 / 12 / 16
* Stress: T2/H2, T4/H4

---

## 4. Thread vs Involuntary Context Switching

![Image](../image/context-switching/01_thread_vs_nvcswch_all.png)


### 분석

* Thread 30 구간에서 **가장 안정적인 nvcswch 수준**
* Thread 16:

  * 처리 여유 부족 → context switching 증가
* Thread 60 이상:

  * 처리량 증가 없음
  * scheduling overhead 증가

👉 결론:

> Thread 수는 많을수록 좋은 것이 아니라 **적정 수준(≈30)이 존재**

---

## 5. Thread vs Voluntary Context Switching

![Image](../image/context-switching/02_thread_vs_cswch_all.png)


### 분석

* Thread 증가 시 cswch 증가 경향
* 특히 60 이상에서 증가폭 확대

👉 의미:

> 불필요한 thread 증가 → **context switching 비용 증가**

---

## 6. Thread vs p95 Latency

![Image](../image/context-switching/07_thread_vs_p95.png)


### 분석

* Thread 30 → 가장 낮은 latency
* Thread 60 → latency 상승 시작
* Thread 2 → **p95 190ms 이상 급증**

👉 핵심 관계:

> Context Switching 증가 → Latency 증가

---

## 7. Stress Test (Saturation 구간)

![Image](../image/context-switching/06_stress_nvcswch.png)


### 분석

* 2/2 설정:

  * nvcswch 급증 (≈276)
  * latency 급증
* 4/4 설정:

  * 상대적으로 안정

👉 해석:

> Thread 부족 → runnable queue 경쟁 → **강제 context switching 증가 → 성능 붕괴**

---

## 8. 종합 분석

### 1️⃣ Thread

* 최적 구간: **≈30**
* 16 → 부족
* 60+ → 과잉

---

### 2️⃣ Hikari

* active connection: 1~2 수준
* pool 확장 효과 없음

👉 결론:

> Hikari는 현재 워크로드에서 **병목이 아님**

---

### 3️⃣ Context Switching

* 성능 저하의 핵심 원인
* 특히 `nvcswch` 증가가 치명적

---

### 4️⃣ Latency 관계

```text
Thread 부족 → nvcswch 증가 → CPU 경쟁 → p95 증가
Thread 과다 → cswch 증가 → 오버헤드 증가 → p95 증가
```

---

## 9. 최종 결론

> 본 실험을 통해 단순한 thread/connection 증가가 성능 향상으로 이어지지 않으며,
> 오히려 context switching 비용 증가로 인해 latency 악화가 발생할 수 있음을 확인하였다.

### 핵심 요약

* Thread 최적값 존재 (≈30)
* Hikari pool 확장은 효과 제한적
* nvcswch 증가가 latency 상승의 주요 원인
* saturation 구간에서는 성능 급격히 붕괴

