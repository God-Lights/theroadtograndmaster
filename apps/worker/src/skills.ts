import { Hono } from 'hono';
import { SKILLS, SKILL_SLOTS, ULTIMATE_SLOTS, skillById, type SkillData } from '@rtgm/data';
import type { SkillDef } from '@rtgm/engine';
import type { AppEnv } from './auth';
import { getCharacter } from './character';

export const skills = new Hono<AppEnv>();

export async function loadoutOf(db: D1Database, userId: string): Promise<string[]> {
  const res = await db.prepare('SELECT skill_id FROM skill_loadout WHERE user_id = ?').bind(userId).all<{ skill_id: string }>();
  return res.results.map((r) => r.skill_id);
}

/** 전투에 들고 갈 스킬 정의: 장착했고 숙련도가 충분한 것만 (엔진 SkillDef 필드만 담는다) */
export async function battleSkills(db: D1Database, userId: string, proficiency: number): Promise<Record<string, SkillDef>> {
  const out: Record<string, SkillDef> = {};
  for (const id of await loadoutOf(db, userId)) {
    const s = skillById(id);
    if (!s || proficiency < s.unlockProficiency) continue;
    out[s.id] = {
      id: s.id, name: s.name, ultimate: s.ultimate, apCost: s.apCost, cooldown: s.cooldown,
      priority: s.priority, target: s.target, effects: s.effects,
    };
  }
  return out;
}

async function view(db: D1Database, userId: string) {
  const [{ proficiency }, equipped] = await Promise.all([getCharacter(db, userId), loadoutOf(db, userId)]);
  const set = new Set(equipped);
  return {
    slots: SKILL_SLOTS,
    ultimateSlots: ULTIMATE_SLOTS,
    proficiency,
    skills: SKILLS.map((s: SkillData) => ({ ...s, unlocked: proficiency >= s.unlockProficiency, equipped: set.has(s.id) })),
  };
}

skills.get('/skills', async (c) => c.json(await view(c.env.DB, c.get('user').id)));

skills.post('/skills/equip', async (c) => {
  const userId = c.get('user').id;
  const { skillId } = await c.req.json<{ skillId?: string }>();
  const skill = skillId ? skillById(skillId) : undefined;
  if (!skill) return c.json({ error: 'unknown_skill' }, 400);
  const { proficiency } = await getCharacter(c.env.DB, userId);
  if (proficiency < skill.unlockProficiency) {
    return c.json({ error: 'skill_locked', required: skill.unlockProficiency }, 403);
  }

  const db = c.env.DB;
  if (skill.ultimate) {
    // 궁극기는 1개: 기존 궁극기를 빼고 새로 장착한다
    const ultIds = SKILLS.filter((s) => s.ultimate).map((s) => s.id);
    await db.batch([
      db.prepare(`DELETE FROM skill_loadout WHERE user_id = ? AND skill_id IN (${ultIds.map(() => '?').join(',')})`).bind(userId, ...ultIds),
      db.prepare('INSERT INTO skill_loadout (user_id, skill_id) VALUES (?, ?)').bind(userId, skill.id),
    ]);
  } else {
    // 슬롯이 남았을 때만 들어간다 (동시 요청에도 4개를 넘지 않게 조건부 INSERT)
    const normalIds = SKILLS.filter((s) => !s.ultimate).map((s) => s.id);
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO skill_loadout (user_id, skill_id)
         SELECT ?, ? WHERE (SELECT COUNT(*) FROM skill_loadout WHERE user_id = ? AND skill_id IN (${normalIds.map(() => '?').join(',')})) < ?`,
      )
      .bind(userId, skill.id, userId, ...normalIds, SKILL_SLOTS)
      .run();
    const already = (await loadoutOf(db, userId)).includes(skill.id);
    if (res.meta.changes === 0 && !already) return c.json({ error: 'slots_full', slots: SKILL_SLOTS }, 400);
  }
  return c.json(await view(db, userId));
});

skills.post('/skills/unequip', async (c) => {
  const userId = c.get('user').id;
  const { skillId } = await c.req.json<{ skillId?: string }>();
  if (!skillId || !skillById(skillId)) return c.json({ error: 'unknown_skill' }, 400);
  await c.env.DB.prepare('DELETE FROM skill_loadout WHERE user_id = ? AND skill_id = ?').bind(userId, skillId).run();
  return c.json(await view(c.env.DB, userId));
});
