import { useEffect, useRef } from 'react';

export interface ActionHandlers {
  prev(): void;
  next(): void;
  resetPort?: () => void;
  resetShip?: () => void;
  exit(): void;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.closest('[contenteditable=""],[contenteditable="true"]') != null;
}

/**
 * Bottom key-cap action bar plus window shortcuts: A/D prev/next port, R reset
 * port, Esc back to Classic. Ignored while typing or with Ctrl/Meta/Alt held.
 */
export function ActionBar({
  handlers,
  resetPortEnabled,
  resetShipEnabled,
  disabled,
}: {
  handlers: ActionHandlers;
  resetPortEnabled: boolean;
  resetShipEnabled: boolean;
  disabled: boolean;
}) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      const h = ref.current;
      switch (e.key) {
        case 'a':
        case 'A':
          h.prev();
          break;
        case 'd':
        case 'D':
          h.next();
          break;
        case 'r':
        case 'R':
          if (!h.resetPort) return;
          h.resetPort();
          break;
        case 'Escape':
          h.exit();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <nav className="t-actions" aria-label="Terminal actions">
      <button type="button" className="t-key" aria-keyshortcuts="A" onClick={() => handlers.prev()}>
        <kbd>A</kbd> ◀ Prev port
      </button>
      <button type="button" className="t-key" aria-keyshortcuts="D" onClick={() => handlers.next()}>
        <kbd>D</kbd> Next port ▶
      </button>
      {handlers.resetPort && (
        <button type="button" className="t-key" aria-keyshortcuts="R" disabled={disabled || !resetPortEnabled} onClick={() => handlers.resetPort?.()}>
          <kbd>R</kbd> Reset port
        </button>
      )}
      {handlers.resetShip && (
        <button type="button" className="t-key t-key-warn" disabled={disabled || !resetShipEnabled} onClick={() => handlers.resetShip?.()}>
          Reset ship
        </button>
      )}
      <span className="t-actions-spacer" />
      <button type="button" className="t-key" aria-keyshortcuts="Escape" onClick={() => handlers.exit()}>
        <kbd>Esc</kbd> Classic view
      </button>
    </nav>
  );
}
