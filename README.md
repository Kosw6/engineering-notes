# Engineering Notes

측정 기반으로 병목을 분석하고, 수치로 개선 여부를 검증한 백엔드 엔지니어링 기록입니다.

Spring Boot, JPA, PostgreSQL/TimescaleDB, Redis, Kafka, WebSocket 환경에서의  
성능 최적화, 실시간 처리, 장애 복구 설계를 다룹니다.

---

## Highlights

- **TimescaleDB 튜닝**
  - P95 7,247ms → 235ms (28× 개선)

- **WebSocket 전송 구조 개선**
  - 수신 성공률 0.38% → 99.97% (≤200ms)

- **JFR/JMC 기반 Hot Path 분석**
  - JWT 중복 검증 제거
  - Fetch 구조 PoC → GC 증가 및 P95 악화로 미채택

- **WebSocket 확장 PoC**
  - 샤딩 → Fallback → Failback(Kafka Replay) 설계 및 검증

---

## Key Approach

- Measure First (k6, JFR, JMC 기반 실측)
- Compare Before / After (P95, GC, RPS)
- Record Trade-offs (미채택 포함)
- Design for Failure (확장 + 복구)

---

## Portfolio

https://kosw6.github.io/
## 📘 Detailed Notes

[Engineering Notes (Detailed)](./reports/engineering-notes.md)