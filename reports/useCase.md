### 조합 × 변형 전부 동시 실행

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e DURATION=30s scripts/api.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e DURATION=30s scripts/api.js

### 특정 endpoint만, variants 포함해서

k6 run -e BASE_URL=http://172.30.1.78:8080 -e ENDPOINTS=range scripts/api.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e ENDPOINTS=range -e EXECUTOR=constant-arrival-rate scripts/api.js

### constant-arrival-rate사용

k6 run -e BASE_URL=http://172.30.1.78:8080 -e VARIANTS=light -e CONTROLLERS=GraphController -e EXECUTOR=constant-arrival-rate scripts/api.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e VARIANTS=heavy -e CONTROLLERS=GraphController -e EXECUTOR=constant-arrival-rate scripts/api.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e VARIANTS=heavy -e CONTROLLERS=StockController -e ENDPOINTS=range -e EXECUTOR=constant-arrival-rate scripts/api.js

### 안정임계값 테스트

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=TickerController -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=ContentController -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=PageController -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=GraphController -e VARIANTS=find-limit scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=UserController -e VARIANTS=find-limit scripts/apiAuto.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=light scripts/apiAuto.js

k6 run -e BASE_URL=http://trading-replay.duckdns.org:8080 -e CONTROLLERS=NodeController -e VARIANTS=light scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e ENDPOINTS=list -e VARIANTS=heavy scripts/apiAuto.js

### 웜업

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=warmup scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=warmup scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=GraphController -e VARIANTS=heavy scripts/apiAuto.js

k6 run -e BASE_URL=http://123.143.98.9:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=warmup scripts/apiAuto.js

### 웜업없이

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=light -e NO_WARMUP=1 scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=warmup -e NO_WARMUP=1 scripts/apiAuto.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=heavy -e NO_WARMUP=1 \scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=GraphController -e VARIANTS=heavy -e NO_WARMUP=1 \scripts/apiAuto.js
티커
, "AA", "AD", "AAC"
노트
, "3248", "3255", "3263"
노드
, "400067", "600067", "800067"
엣지
, "53163", "845763", "1199762"
그래프
, "210149", "220149", "290149"
페이지
, "210149", "220149", "290149"
스톡 -스톡
, "MSFT" -엔드
, "2025-03-10T00:00:00"

k6 run -e BASE_URL=http://172.30.1.78:8080 -e DROP_BODIES=0 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=find-limit scripts/api.js
k6 run -e BASE_URL=http://localhost:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=find-limit scripts/api.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=find-limit scripts/api.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=GraphController -e VARIANTS=find-limit scripts/api.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=find-limit -e ENDPOINTS_PARAMS='{"start":["2024-09-01T00:00:00Z"],"end":["2024-10-01T00:00:00Z"],"stock":["TSLA"]}' scripts/api.js

본부하시에 시드 고정해서 비교
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=EdgeController -e DEBUG=1 -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=ContentController -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=DirectoryController -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js
k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=TickerController -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e ENDPOINTS=list -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js

k6 run -e BASE_URL=http://172.30.1.78:8080 -e CONTROLLERS=NodeController -e ENDPOINTS=single -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js

테스트용 리스트 빼둔거
"77": [
{ "id": "200126" },
{ "id": "210126" },
{ "id": "220126" },
{ "id": "230126" },
{ "id": "240126" },
{ "id": "250126" },
{ "id": "260126" },
{ "id": "270126" },
{ "id": "280126" },
{ "id": "290126" },
{ "id": "300126" },
{ "id": "310126" },
{ "id": "320126" },
{ "id": "330126" },
{ "id": "340126" },
{ "id": "350126" },
{ "id": "360126" },
{ "id": "370126" },
{ "id": "380126" },
{ "id": "390126" }
],
"78": [
{ "id": "200127" },
{ "id": "210127" },
{ "id": "220127" },
{ "id": "230127" },
{ "id": "240127" },
{ "id": "250127" },
{ "id": "260127" },
{ "id": "270127" },
{ "id": "280127" },
{ "id": "290127" },
{ "id": "300127" },
{ "id": "310127" },
{ "id": "320127" },
{ "id": "330127" },
{ "id": "340127" },
{ "id": "350127" },
{ "id": "360127" },
{ "id": "370127" },
{ "id": "380127" },
{ "id": "390127" }
],
"79": [
{ "id": "200128" },
{ "id": "210128" },
{ "id": "220128" },
{ "id": "230128" },
{ "id": "240128" },
{ "id": "250128" },
{ "id": "260128" },
{ "id": "270128" },
{ "id": "280128" },
{ "id": "290128" },
{ "id": "300128" },
{ "id": "310128" },
{ "id": "320128" },
{ "id": "330128" },
{ "id": "340128" },
{ "id": "350128" },
{ "id": "360128" },
{ "id": "370128" },
{ "id": "380128" },
{ "id": "390128" }
],
"80": [
{ "id": "200129" },
{ "id": "210129" },
{ "id": "220129" },
{ "id": "230129" },
{ "id": "240129" },
{ "id": "250129" },
{ "id": "260129" },
{ "id": "270129" },
{ "id": "280129" },
{ "id": "290129" },
{ "id": "300129" },
{ "id": "310129" },
{ "id": "320129" },
{ "id": "330129" },
{ "id": "340129" },
{ "id": "350129" },
{ "id": "360129" },
{ "id": "370129" },
{ "id": "380129" },
{ "id": "390129" }
]


k6 run -e BASE_URL=http://192.168.60.49:8080 -e CONTROLLERS=StockController -e ENDPOINTS=range -e VARIANTS=heavy -e MAIN_SEED=777 scripts/apiAuto.js