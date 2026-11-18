import type { Msg } from './ui';

export interface CallResult { status: number; json: any }
/** 연동된 사용자로 게임 API를 부르는 함수 */
export type Caller = (method: string, path: string, body?: unknown) => Promise<CallResult>;
/** 전체 공개로 올릴 결과 (key 로 한 번만 올린다) */
export interface Publish { key: string; build: (call: Caller) => Promise<Msg> }
export type Result<T = Msg> = { msg: T; publish?: Publish } | { error: CallResult };
