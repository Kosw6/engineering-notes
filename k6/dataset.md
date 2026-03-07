# 테스트에 사용할 데이터 셋

### <스키마 구조>

1. 유저
2. 주식
3. 노트
4. 디렉토리
5. 페이지
6. 노드
7. 엣지

### <연관관계>

유저 1:N 노트

디렉토리 1:1 디렉토리(하위 디렉토리)

디렉토리 1:N 페이지

페이지 1:N 노드

페이지 1:N 엣지

노드 1:N 엣지

## 데이터 셋 준비방법 및 기준

PostgreSql의 SQL로 배치 생성하여 각 테이블마다 동시 접속자 100명을 가정하여 데이터를 삽입한다.

1. 유저 - 1만 레코드
2. 주식 - 5천만 레코드(프로젝트 목표인 나스닥, 아멕스, 다우존스의 한국에서 거래되는 모든 상장주식의 데이터 수)
3. 노트의 경우 인당 100개씩의 노트로 가정 - 100만 레코드
4. 디렉토리의 경우 인당 10개의 디렉토리로 가정 - 10만 레코드
5. 페이지의 경우 인당 20개의 페이지로 가정 - 20만 레코드
6. 노드의 경우 페이지당 10개로 가정 - 200만 레코드
7. 엣지의 경우 노드당 2개로 가정 - 400만 레코드

## 데이터 셋 생성 스크립트

```sql
BEGIN;

-- 0) 현재 데이터가 있을 수 있으니 id 범위 확보용으로 min/max를 항상 조회해서 씁니다.
--    (신규 DB면 전부 NULL/0으로 처리되어 1부터 시작하게 됨)

-- 1) USERS 10,000
WITH u_bounds AS (
  SELECT COALESCE(MAX(id), 0) AS base FROM users
),
ins AS (
  INSERT INTO users (username, email, created_at)
  SELECT
    'user_' || (u_bounds.base + g) AS username,
    'user' || (u_bounds.base + g) || '@example.com' AS email,
    now() - (random() * interval '365 days')
  FROM u_bounds, generate_series(1, 10000) AS g
  RETURNING id
)
SELECT COUNT(*) AS inserted_users FROM ins;


-- 2) DIRECTORY 100,000 (user당 10개, parent_id는 NULL 또는 같은 user의 다른 디렉토리 중 일부에 연결)
WITH u AS (
  SELECT id AS user_id
  FROM users
  ORDER BY id
  LIMIT 10000   -- 방금 넣은 1만 사용자만 대상으로 가정
),
d_bounds AS ( SELECT COALESCE(MAX(id),0) AS base FROM directory ),
ins AS (
  INSERT INTO directory (user_id, name, parent_id)
  SELECT
    u.user_id,
    'dir_' || (d_bounds.base + row_number() OVER ()) AS name,
    CASE
      WHEN random() < 0.20 THEN NULL  -- 20%는 루트 디렉토리
      ELSE NULL                       -- 간단화를 위해 전부 루트로 생성(필요시 하위 연결 로직 추가)
    END AS parent_id
  FROM d_bounds, (
    SELECT u.user_id
    FROM u
    JOIN generate_series(1,10) g ON true  -- user당 10개
  ) u
  RETURNING id, user_id
)
SELECT COUNT(*) AS inserted_directories FROM ins;


-- 3) PAGE 200,000 (user당 20개, 해당 user의 디렉토리 중 하나에 랜덤 매핑)
WITH d AS (
  SELECT d.id, d.user_id
  FROM directory d
),
p_bounds AS ( SELECT COALESCE(MAX(id),0) AS base FROM page ),
ins AS (
  INSERT INTO page (user_id, directory_id, title, created_at)
  SELECT
    u.user_id,
    -- 해당 user의 directory 중 하나 랜덤 선택
    (SELECT d2.id FROM directory d2 WHERE d2.user_id = u.user_id
     ORDER BY random() LIMIT 1) AS directory_id,
    'page_' || (p_bounds.base + row_number() OVER ()) AS title,
    now() - (random() * interval '180 days') AS created_at
  FROM p_bounds, (
    SELECT u.id AS user_id
    FROM users u
    ORDER BY u.id
    LIMIT 10000
  ) u
  JOIN generate_series(1,20) g ON true  -- user당 20개
  RETURNING id, user_id, directory_id
)
SELECT COUNT(*) AS inserted_pages FROM ins;


-- 4) NOTE 1,000,000 (user당 100개)
WITH n_bounds AS ( SELECT COALESCE(MAX(id),0) AS base FROM note ),
ins AS (
  INSERT INTO note (user_id, title, content, created_at)
  SELECT
    u.id AS user_id,
    'note_' || (n_bounds.base + row_number() OVER ()) AS title,
    md5(random()::text) AS content,
    now() - (random() * interval '180 days')
  FROM n_bounds, (
    SELECT u.id
    FROM users u
    ORDER BY u.id
    LIMIT 10000
  ) u
  JOIN generate_series(1,100) g ON true   -- user당 100개
  RETURNING id, user_id
)
SELECT COUNT(*) AS inserted_notes FROM ins;


-- 5) NODE 2,000,000 (page당 10개)
WITH node_bounds AS ( SELECT COALESCE(MAX(id),0) AS base FROM node ),
ins AS (
  INSERT INTO node (page_id, idx, title)
  SELECT
    p.id AS page_id,
    gs.i AS idx,
    'node_' || (node_bounds.base + row_number() OVER ()) AS title
  FROM node_bounds,
       (SELECT id FROM page ORDER BY id LIMIT 200000) p
       JOIN LATERAL generate_series(1,10) gs(i) ON true  -- page당 10개
  RETURNING id, page_id
)
SELECT COUNT(*) AS inserted_nodes FROM ins;


-- 6) EDGE 4,000,000 (node당 2개, 자기 자신으로 연결 금지 / 중복 최소화)
--    간단한 랜덤 연결: 전체 노드 id 범위에서 dst를 뽑되 self-loop 방지.
WITH b AS (
  SELECT COALESCE(MIN(id),1) AS min_id, COALESCE(MAX(id),1) AS max_id FROM node
),
ins AS (
  INSERT INTO edge (src_node_id, dst_node_id)
  SELECT
    n.id AS src_node_id,
    dst_id
  FROM (
    SELECT id
    FROM node
    ORDER BY id
    LIMIT 2000000
  ) n
  JOIN LATERAL (
    SELECT
      CASE
        -- self-loop 방지: 같으면 +1 보정(상한 넘어가면 min으로)
        WHEN rnd = n.id THEN
          CASE WHEN n.id = b.max_id THEN b.min_id ELSE n.id + 1 END
        ELSE rnd
      END AS dst_id
    FROM (
      SELECT
        ((random() * (b.max_id - b.min_id))::bigint + b.min_id) AS rnd
      FROM generate_series(1,2) g -- node당 2개
    ) r
  ) pick ON true
  CROSS JOIN b
)
SELECT COUNT(*) AS inserted_edges FROM ins;


-- 7) NODE_NOTE_LINK 2,000,000 (노드당 평균 1개 연결)
--    노드 2,000,000개와 노트 1,000,000개를 랜덤 매핑(중복 가능성 조금 있음)
WITH nnn AS (
  SELECT COALESCE(MAX(id),0) AS max_note_id, COALESCE(MIN(id),1) AS min_note_id FROM note
),
ins AS (
  INSERT INTO node_note_link (node_id, note_id)
  SELECT
    n.id AS node_id,
    ((random() * (nnn.max_note_id - nnn.min_note_id))::bigint + nnn.min_note_id) AS note_id
  FROM (SELECT id FROM node ORDER BY id LIMIT 2000000) n
  CROSS JOIN nnn
)
SELECT COUNT(*) AS inserted_node_note_links FROM ins;

COMMIT;
```
