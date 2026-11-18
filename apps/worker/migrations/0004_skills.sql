-- 장착한 스킬. 일반 스킬 4개 + 궁극기 1개까지는 애플리케이션 코드가 지킨다.
CREATE TABLE skill_loadout (
  user_id  TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (user_id, skill_id)
);

-- 이미 있는 캐릭터에게도 기본 스킬을 한 번만 넣기 위한 표시 (0 = 아직 안 넣음)
ALTER TABLE characters ADD COLUMN skills_initialized INTEGER NOT NULL DEFAULT 0;
