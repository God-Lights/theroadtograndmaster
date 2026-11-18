import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth';

/**
 * 관리자는 GL Account 사용자 ID(UUID)로 정한다. 환경 변수 ADMIN_USER_IDS 에 쉼표로 구분해 넣는다.
 * (GitHub 변수 ADMIN_USER_IDS → 배포 때 Worker 변수로 전달된다.) 닉네임·아이디는 바뀔 수 있어서 쓰지 않는다.
 */
export function adminIds(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export const isAdmin = (raw: string | undefined, userId: string): boolean => adminIds(raw).has(userId.toLowerCase());

/** 관리자가 아니면 존재 자체를 숨기기 위해 404 를 돌려준다. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAdmin(c.env.ADMIN_USER_IDS, c.get('user').id)) return c.json({ error: 'not_found' }, 404);
  await next();
};
