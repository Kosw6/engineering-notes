
k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e USERS_CSV=../data/users_200.csv `
  -e MODE=cursor `
  -e VUS=200 -e TEST_DURATION_S=60 -e HOLD_MS=60000 `
  -e TEAM_ID=1 -e GRAPH_ID=1 `
  -e SENDER_RATIO=0.1 -e RATE=20 -e DURATION_S=30 `
  -e PAD=200 `
  -e LAT_OK_MS=200 -e LAT_WARN_MS=1000 `
  -e RT_OK_200_MIN=0.90 -e RT_OK_1S_MIN=0.99 `
  -e RT_OK_200_SEND_MIN=0.90 -e RT_OK_200_AFTER_MIN=0.90 `
  -e SUMMARY=outputs/raw_cursor.json `
  scripts/ws_raw_cursor.js

=== RAW Summary (MODE=cursor) ===
duration: 61.93s
open: 200 / close: 200 / errors: 0
sent: 12000 / received: 9004
sent/s: 193.78 / recv/s: 145.40
connect(ms) count=0 avg=211.8 p50=215.0 p95=373.6 p99=491.0
latency buckets(ms): <=200=2507 (27.84%) / <=1000=6497 (72.16%) / >1000=0 (0.00%)
realtime rates: ok<=200=27.84% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=27.84% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)


=== RAW Summary (MODE=cursor) ===
duration: 64.45s
open: 200 / close: 200 / errors: 0
sent: 12000 / received: 5134
sent/s: 186.19 / recv/s: 79.66
connect(ms) count=0 avg=221.5 p50=230.0 p95=304.0 p99=311.0
latency buckets(ms): <=200=13 (0.25%) / <=1000=5121 (99.75%) / >1000=0 (0.00%)
realtime rates: ok<=200=0.25% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.25% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)

k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e USERS_CSV=../data/users_200.csv `
  -e MODE=cursor `
  -e VUS=200 -e TEST_DURATION_S=60 -e HOLD_MS=60000 `
  -e TEAM_ID=1 -e GRAPH_ID=1 `
  -e SENDER_RATIO=0.1 -e RATE=20 -e DURATION_S=30 `
  -e PAD=200 `
  -e LAT_OK_MS=200 -e LAT_WARN_MS=1000 `
  -e RT_OK_200_MIN=0.90 -e RT_OK_1S_MIN=0.99 `
  -e RT_OK_200_SEND_MIN=0.90 -e RT_OK_200_AFTER_MIN=0.90 `
  -e SUMMARY=outputs/stomp_cursor.json `
  scripts/ws_stomp_cursor.js

  
=== STOMP Summary (MODE=cursor) ===
duration: 62.53s
open: 200 / close: 200 / errors: 0
sent: 11970 / received: 1948286
sent/s: 191.42 / recv/s: 31156.87
CONNECTED frames: 200
ws-open(ms) count=0 avg=163.1 p50=158.0 p95=296.1 p99=425.1
ready(ms)   count=0 avg=330.4 p50=344.5 p95=539.6 p99=629.3
latency buckets(ms): <=200=168 (0.01%) / <=1000=8749 (0.45%) / >1000=1939369 (99.54%)
realtime rates: ok<=200=0.01% (min 90.00%) / ok<=1000=0.46% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.02% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)

=== STOMP Summary (MODE=cursor) ===
duration: 62.66s
open: 200 / close: 200 / errors: 0
sent: 11991 / received: 1799164
sent/s: 191.37 / recv/s: 28713.92
CONNECTED frames: 200
ws-open(ms) count=0 avg=137.1 p50=118.0 p95=253.3 p99=385.1
ready(ms)   count=0 avg=195.0 p50=188.0 p95=326.3 p99=448.1
latency buckets(ms): <=200=5454 (0.30%) / <=1000=15973 (0.89%) / >1000=1777737 (98.81%)
realtime rates: ok<=200=0.30% (min 90.00%) / ok<=1000=1.19% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.63% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)



=== RAW Summary (MODE=cursor) ===
duration: 64.61s
open: 200 / close: 200 / errors: 0
sent: 11999 / received: 2399800
sent/s: 185.70 / recv/s: 37140.33
connect(ms) count=0 avg=334.5 p50=326.0 p95=430.0 p99=447.0
latency buckets(ms): <=200=75 (0.00%) / <=1000=9230 (0.38%) / >1000=2390495 (99.61%)
realtime rates: ok<=200=0.00% (min 90.00%) / ok<=1000=0.39% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.00% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)


=== RAW Summary (MODE=cursor) ===
duration: 62.90s
open: 200 / close: 200 / errors: 0
sent: 12000 / received: 2396399
sent/s: 190.79 / recv/s: 38100.29
connect(ms) count=0 avg=251.2 p50=258.5 p95=507.7 p99=670.3
latency buckets(ms): <=200=8999 (0.38%) / <=1000=41563 (1.73%) / >1000=2345837 (97.89%)
realtime rates: ok<=200=0.38% (min 90.00%) / ok<=1000=2.11% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.55% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)




# 2차
- raw
PS C:\Users\USER\kosw006\trader\trader\trader-backend\k6> k6 run `
>>   -e BASE_URL=http://localhost:8080 `
>>   -e USERS_CSV=../data/users_200.csv `
>>   -e MODE=cursor `
>>   -e VUS=200 -e TEST_DURATION_S=60 -e HOLD_MS=60000 `
>>   -e TEAM_ID=1 -e GRAPH_ID=1 `
>>   -e SENDER_RATIO=0.1 -e RATE=20 -e DURATION_S=30 `
>>   -e PAD=200 `
>>   -e LAT_OK_MS=200 -e LAT_WARN_MS=1000 `
>>   -e RT_OK_200_MIN=0.90 -e RT_OK_1S_MIN=0.99 `
>>   -e RT_OK_200_SEND_MIN=0.90 -e RT_OK_200_AFTER_MIN=0.90 `
>>   -e SUMMARY=outputs/raw_cursor.json `
>>   scripts/ws_raw_batch.js

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 

     execution: local
        script: scripts/ws_raw_batch.js
        output: -

     scenarios: (100.00%) 1 scenario, 200 max VUs, 1m35s max duration (incl. graceful stop):
              * one_conn_per_vu: 1 iterations for each of 200 VUs (maxDuration: 1m30s, gracefulStop: 5s)

=== RAW Summary (MODE=cursor) ===
duration: 64.24s
open: 200 / close: 200 / errors: 0
sent: 11995 / received(events): 1958600 / received(frames): 119200
sent/s: 186.71 / recv_events/s: 30487.20 / recv_frames/s: 1855.44
connect(ms) count=0 avg=244.7 p50=235.0 p95=377.1 p99=386.0
latency buckets(ms): <=200=1958110 (99.97%) / <=1000=490 (0.03%) / >1000=0 (0.00%)
phase samples: during=1958416 / after=184
realtime rates: ok<=200=99.97% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=99.97% (min 90.00%), after-send ok<=200=100.00% (min 90.00%)


- stomp

PS C:\Users\USER\kosw006\trader\trader\trader-backend\k6> k6 run `
>>   -e BASE_URL=http://localhost:8080 `
>>   -e USERS_CSV=../data/users_200.csv `
>>   -e MODE=cursor `
>>   -e VUS=200 -e TEST_DURATION_S=60 -e HOLD_MS=60000 `
>>   -e TEAM_ID=1 -e GRAPH_ID=1 `
>>   -e SENDER_RATIO=0.1 -e RATE=20 -e DURATION_S=30 `
>>   -e PAD=200 `
>>   -e LAT_OK_MS=200 -e LAT_WARN_MS=1000 `
>>   -e RT_OK_200_MIN=0.90 -e RT_OK_1S_MIN=0.99 `
>>   -e RT_OK_200_SEND_MIN=0.90 -e RT_OK_200_AFTER_MIN=0.90 `
>>   -e SUMMARY=outputs/stomp_cursor.json `
>>   scripts/ws_stomp_batch.js

         /\      Grafana   /‾‾/  
    /\  /  \     |\  __   /  /   
   /  \/    \    | |/ /  /   ‾‾\ 
  /          \   |   (  |  (‾)  |
 / __________ \  |_|\_\  \_____/ 

     execution: local
        script: scripts/ws_stomp_batch.js
        output: -

     scenarios: (100.00%) 1 scenario, 200 max VUs, 1m35s max duration (incl. graceful stop):
              * one_conn_per_vu: 1 iterations for each of 200 VUs (maxDuration: 1m30s, gracefulStop: 5s)

=== STOMP Summary (MODE=cursor) ===
duration: 64.67s
open: 200 / close: 200 / errors: 0
sent: 12000 / received(events): 2028600 / received(frames): 119200
sent/s: 185.54 / recv_events/s: 31366.34 / recv_frames/s: 1843.08
CONNECTED frames: 200
ws-open(ms) count=0 avg=338.8 p50=334.5 p95=429.0 p99=436.0
ready(ms)   count=0 avg=791.6 p50=785.0 p95=884.0 p99=891.0
latency buckets(ms): <=200=2001970 (98.69%) / <=1000=26630 (1.31%) / >1000=0 (0.00%)
phase samples: during=2028420 / after=180
realtime rates: ok<=200=98.69% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=98.69% (min 90.00%), after-send ok<=200=100.00% (min 90.00%)


# 2차-2(룸200,센더40-rate20)
- stomp
=== STOMP Summary (MODE=cursor) ===
duration: 61.43s
open: 200 / close: 200 / errors: 0
sent: 23931 / received(events): 2443877 / received(frames): 120537
sent/s: 389.59 / recv_events/s: 39785.70 / recv_frames/s: 1962.31
CONNECTED frames: 200
ws-open(ms) count=0 avg=93.4 p50=75.5 p95=208.0 p99=230.1
ready(ms)   count=0 avg=152.6 p50=134.0 p95=268.5 p99=323.3
latency buckets(ms): <=200=1907277 (78.04%) / <=1000=535236 (21.90%) / >1000=1364 (0.06%)
phase samples: during=2438463 / after=5414
realtime rates: ok<=200=78.04% (min 90.00%) / ok<=1000=99.94% (min 99.00%)
realtime rates by phase: during-send ok<=200=78.01% (min 90.00%), after-send ok<=200=91.95% (min 90.00%)

- raw
=== RAW Summary (MODE=cursor) ===
duration: 62.03s
open: 200 / close: 200 / errors: 0
sent: 23949 / received(events): 2713236 / received(frames): 120718
sent/s: 386.12 / recv_events/s: 43744.17 / recv_frames/s: 1946.28
connect(ms) count=0 avg=94.9 p50=95.5 p95=178.0 p99=188.2
latency buckets(ms): <=200=2438969 (89.89%) / <=1000=274267 (10.11%) / >1000=0 (0.00%)
phase samples: during=2708297 / after=4939
realtime rates: ok<=200=89.89% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=89.88% (min 90.00%), after-send ok<=200=98.72% (min 90.00%)

- raw사용 이유 확실해짐
- 이후 여러 방에서 20rate,센더 40으로 테스트 후 개선 3차

jfr리코딩 한것
ws_2st_batch_stomp_20rate_40sender

=== STOMP Summary (MODE=cursor) ===
duration: 64.13s
open: 200 / close: 200 / errors: 0
sent: 21065 / received(events): 2100600 / received(frames): 119400
sent/s: 328.47 / recv_events/s: 32755.47 / recv_frames/s: 1861.85
CONNECTED frames: 200
ws-open(ms) count=0 avg=274.4 p50=257.0 p95=404.1 p99=421.0
ready(ms)   count=0 avg=524.6 p50=505.5 p95=658.1 p99=677.0
latency buckets(ms): <=200=837586 (39.87%) / <=1000=1073561 (51.11%) / >1000=189453 (9.02%)
phase samples: during=2098505 / after=2095
realtime rates: ok<=200=39.87% (min 90.00%) / ok<=1000=90.98% (min 99.00%)
realtime rates by phase: during-send ok<=200=39.86% (min 90.00%), after-send ok<=200=57.57% (min 90.00%)

- ws_2st_batch_raw_20rate_40sender

=== RAW Summary (MODE=cursor) ===
duration: 64.21s
open: 200 / close: 200 / errors: 0
sent: 23816 / received(events): 2503600 / received(frames): 119800
sent/s: 370.89 / recv_events/s: 38989.25 / recv_frames/s: 1865.68
connect(ms) count=0 avg=291.8 p50=292.0 p95=357.0 p99=368.0
latency buckets(ms): <=200=1904646 (76.08%) / <=1000=590212 (23.57%) / >1000=8742 (0.35%)
phase samples: during=2501695 / after=1905
realtime rates: ok<=200=76.08% (min 90.00%) / ok<=1000=99.65% (min 99.00%)
realtime rates by phase: during-send ok<=200=76.07% (min 90.00%), after-send ok<=200=78.74% (min 90.00%)




배포raw

룸200 센더 20, 20HZ
=== RAW Summary (MODE=cursor) ===
duration: 63.07s
open: 200 / close: 200 / errors: 0
sent: 12000 / received(events): 662390 / received(frames): 41989
sent/s: 190.26 / recv_events/s: 10502.08 / recv_frames/s: 665.73
connect(ms) count=0 avg=190.0 p50=177.0 p95=356.0 p99=368.1
latency buckets(ms): <=200=7602 (1.15%) / <=1000=46689 (7.05%) / >1000=608099 (91.80%)
phase samples: during=596874 / after=65516
realtime rates: ok<=200=1.15% (min 90.00%) / ok<=1000=8.20% (min 99.00%)
realtime rates by phase: during-send ok<=200=1.27% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)


룸100 센더 10 rate 20
=== RAW Summary (MODE=cursor) ===
duration: 63.37s
open: 100 / close: 100 / errors: 0
sent: 6000 / received(events): 582042 / received(frames): 60180
sent/s: 94.69 / recv_events/s: 9185.26 / recv_frames/s: 949.71
connect(ms) count=0 avg=116.5 p50=127.0 p95=200.1 p99=208.0
latency buckets(ms): <=200=582038 (100.00%) / <=1000=4 (0.00%) / >1000=0 (0.00%)
phase samples: during=581747 / after=295
realtime rates: ok<=200=100.00% (min 90.00%) / ok<=1000=100.00% (min 99.00%)
realtime rates by phase: during-send ok<=200=100.00% (min 90.00%), after-send ok<=200=100.00% (min 90.00%)



룸100 센더 20 rate20

=== RAW Summary (MODE=cursor) ===
duration: 63.70s
open: 100 / close: 100 / errors: 0
sent: 12000 / received(events): 563318 / received(frames): 34790
sent/s: 188.37 / recv_events/s: 8842.84 / recv_frames/s: 546.13
connect(ms) count=0 avg=103.2 p50=105.5 p95=157.0 p99=160.0
latency buckets(ms): <=200=17724 (3.15%) / <=1000=149764 (26.59%) / >1000=395830 (70.27%)
phase samples: during=545043 / after=18275
realtime rates: ok<=200=3.15% (min 90.00%) / ok<=1000=29.73% (min 99.00%)
realtime rates by phase: during-send ok<=200=3.25% (min 90.00%), after-send ok<=200=0.01% (min 90.00%)

150 센더 15 late20
=== RAW Summary (MODE=cursor) ===
duration: 66.33s
open: 150 / close: 150 / errors: 0
sent: 9000 / received(events): 573397 / received(frames): 48483
sent/s: 135.69 / recv_events/s: 8645.21 / recv_frames/s: 730.99
connect(ms) count=0 avg=97.7 p50=87.0 p95=200.5 p99=222.2
latency buckets(ms): <=200=4187 (0.73%) / <=1000=40625 (7.08%) / >1000=528585 (92.18%)
phase samples: during=538570 / after=34827
realtime rates: ok<=200=0.73% (min 90.00%) / ok<=1000=7.82% (min 99.00%)
realtime rates by phase: during-send ok<=200=0.78% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)



125

=== RAW Summary (MODE=cursor) ===
duration: 62.71s
open: 125 / close: 125 / errors: 0
sent: 7800 / received(events): 606285 / received(frames): 55195
sent/s: 124.37 / recv_events/s: 9667.51 / recv_frames/s: 880.11
connect(ms) count=0 avg=74.7 p50=78.0 p95=101.8 p99=108.0
latency buckets(ms): <=200=137259 (22.64%) / <=1000=50425 (8.32%) / >1000=418601 (69.04%)
phase samples: during=577804 / after=28481
realtime rates: ok<=200=22.64% (min 90.00%) / ok<=1000=30.96% (min 99.00%)
realtime rates by phase: during-send ok<=200=23.76% (min 90.00%), after-send ok<=200=0.00% (min 90.00%)

110명 센더 11, 레이트 20

=== RAW Summary (MODE=cursor) ===
duration: 62.33s
open: 110 / close: 110 / errors: 0
sent: 6600 / received(events): 559643 / received(frames): 61122
sent/s: 105.88 / recv_events/s: 8978.21 / recv_frames/s: 980.56
connect(ms) count=0 avg=56.6 p50=54.0 p95=95.6 p99=101.9
latency buckets(ms): <=200=322596 (57.64%) / <=1000=210997 (37.70%) / >1000=26050 (4.65%)
phase samples: during=557866 / after=1777
realtime rates: ok<=200=57.64% (min 90.00%) / ok<=1000=95.35% (min 99.00%)
realtime rates by phase: during-send ok<=200=57.51% (min 90.00%), after-send ok<=200=99.49% (min 90.00%)

100명 센더 10명 레이트 20

  === RAW Summary (MODE=cursor) ===
duration: 64.04s
open: 100 / close: 100 / errors: 0
sent: 6000 / received(events): 547592 / received(frames): 59264
sent/s: 93.70 / recv_events/s: 8551.36 / recv_frames/s: 925.48
connect(ms) count=0 avg=113.1 p50=101.0 p95=190.3 p99=206.2
latency buckets(ms): <=200=539199 (98.47%) / <=1000=8362 (1.53%) / >1000=31 (0.01%)
phase samples: during=547526 / after=66
realtime rates: ok<=200=98.47% (min 90.00%) / ok<=1000=99.99% (min 99.00%)
realtime rates by phase: during-send ok<=200=98.47% (min 90.00%), after-send ok<=200=100.00% (min 90.00%)