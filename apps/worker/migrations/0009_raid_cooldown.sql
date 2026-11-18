-- 레이드 재입장 대기시간 (보스별, 끝난 시점부터)
CREATE TABLE raid_cooldowns (
  user_id TEXT NOT NULL,
  boss_id TEXT NOT NULL,
  until   INTEGER NOT NULL,
  PRIMARY KEY (user_id, boss_id)
);
