-- 전투 보상은 한 번만 지급한다.
ALTER TABLE battles ADD COLUMN rewarded INTEGER NOT NULL DEFAULT 0;
