import { useRef, useState } from 'react';

/** Paste into the browser console on spviewer.eu: downloads every saved loadout. */
export const SPVIEWER_EXPORT_SNIPPET = `const r = indexedDB.open('SCSPVDatabase');
r.onsuccess = () => {
  const q = r.result.transaction('vehiclesLoadout', 'readonly').objectStore('vehiclesLoadout').getAll();
  q.onsuccess = () => {
    const blob = new Blob([JSON.stringify(q.result, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'spviewer-loadouts.json' });
    document.body.appendChild(a); a.click(); a.remove();
  };
};`;

export function ExportSnippet() {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const pre = useRef<HTMLPreElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SPVIEWER_EXPORT_SNIPPET);
      setCopied('ok');
    } catch {
      // Clipboard API blocked: select the text so Ctrl/Cmd+C works.
      const sel = window.getSelection();
      if (sel && pre.current) {
        const range = document.createRange();
        range.selectNodeContents(pre.current);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      setCopied('fail');
    }
    setTimeout(() => setCopied('idle'), 2500);
  }

  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="muted small">JavaScript</span>
        <button className="btn btn-small" onClick={() => void copy()}>
          {copied === 'ok' ? 'Copied!' : copied === 'fail' ? 'Press Ctrl+C' : 'Copy'}
        </button>
      </div>
      <pre ref={pre} aria-label="spviewer export snippet">
        <code>{SPVIEWER_EXPORT_SNIPPET}</code>
      </pre>
    </div>
  );
}
