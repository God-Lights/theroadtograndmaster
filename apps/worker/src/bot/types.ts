export interface CallResult { status: number; json: any }
/** 연동된 사용자로 게임 API를 부르는 함수 */
export type Caller = (method: string, path: string, body?: unknown) => Promise<CallResult>;
export type Result<T = import('./ui').Msg> = { msg: T } | { error: CallResult };
