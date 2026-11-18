import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, errorText, type InventorySnapshot, type Me } from './api';

type ToastType = 'ok' | 'error' | 'warn';

export interface ModalSpec {
  title: ReactNode;
  body: ReactNode;
  buttons: { text: string; cls: string; onClick: () => void }[];
}

interface GameContextValue {
  me?: Me;
  inv?: InventorySnapshot;
  refresh: () => Promise<void>;
  toast: (msg: string, type?: ToastType) => void;
  modal: (spec: ModalSpec | null) => void;
  fail: (e: unknown) => void;
}

const Ctx = createContext<GameContextValue | null>(null);
export const useGame = (): GameContextValue => {
  const v = useContext(Ctx);
  if (!v) throw new Error('GameProvider 밖에서 사용할 수 없습니다');
  return v;
};

export function GameProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>();
  const [inv, setInv] = useState<InventorySnapshot>();
  const [toastState, setToastState] = useState<{ msg: string; type: ToastType }>();
  const [modalSpec, setModalSpec] = useState<ModalSpec | null>(null);
  const timer = useRef<number>();

  const refresh = useCallback(async () => {
    const [m, i] = await Promise.all([api.me(), api.inventory()]);
    setMe(m);
    setInv(i);
  }, []);

  const toast = useCallback((msg: string, type: ToastType = 'ok') => {
    setToastState({ msg, type });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastState(undefined), 2500);
  }, []);

  const fail = useCallback((e: unknown) => toast(errorText(e), 'error'), [toast]);

  useEffect(() => {
    refresh().catch(fail);
  }, [refresh, fail]);

  return (
    <Ctx.Provider value={{ me, inv, refresh, toast, modal: setModalSpec, fail }}>
      {children}
      {toastState && <div className={`toast ${toastState.type}`}>{toastState.msg}</div>}
      {modalSpec && (
        <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setModalSpec(null)}>
          <div className="modal" role="dialog" aria-modal="true">
            <h3>{modalSpec.title}</h3>
            <div>{modalSpec.body}</div>
            <div className="modal-btns">
              {modalSpec.buttons.map((b) => (
                <button key={b.text} className={`btn ${b.cls}`} onClick={b.onClick}>{b.text}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
