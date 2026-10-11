import { useEffect, useRef } from 'react';
import { decodeBundle } from '../../lib/swf';
import { prefersReducedMotion } from '../../lib/wireframe';
import type { WireMarker } from './markers';
import { WireframeStage } from './stage';

export interface WireframeViewerProps {
  /** The `.swf.gz` bytes exactly as served (decoded here). */
  bundle: ArrayBuffer;
  markers: WireMarker[];
  selected: string | null;
  onSelect(id: string): void;
  /** Decode failure, no WebGL context, or a lost context: the parent should show something else. */
  onError?(error: unknown): void;
  /** Accessible name, e.g. "Harbinger wireframe". */
  label?: string;
}

/**
 * Rotatable wireframe with hardpoint markers. Fills its positioned parent.
 * Loaded lazily (default export for `React.lazy`): this module and `stage.ts`
 * are the only importers of three.js.
 */
export default function WireframeViewer({ bundle, markers, selected, onSelect, onError, label }: WireframeViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const stage = useRef<WireframeStage | null>(null);
  // Latest props for the stage, which is built once per bundle.
  const latest = useRef({ markers, selected, onSelect, onError });
  latest.current = { markers, selected, onSelect, onError };

  useEffect(() => {
    let cancelled = false;
    let built: WireframeStage | null = null;
    const fail = (e: unknown) => {
      if (!cancelled) latest.current.onError?.(e);
    };
    const showTip = (text: string | null, x: number, y: number) => {
      const el = tip.current;
      const box = host.current;
      if (!el || !box) return;
      if (text == null) {
        el.hidden = true;
        return;
      }
      el.textContent = text;
      el.hidden = false;
      // Keep the tooltip inside the panel: flip to the other side of the pointer near an edge.
      const flipX = x + 14 + el.offsetWidth > box.clientWidth;
      const flipY = y + 14 + el.offsetHeight > box.clientHeight;
      el.style.left = `${Math.max(0, flipX ? x - 10 - el.offsetWidth : x + 14)}px`;
      el.style.top = `${Math.max(0, flipY ? y - 10 - el.offsetHeight : y + 14)}px`;
    };
    decodeBundle(bundle)
      .then((decoded) => {
        if (cancelled || !host.current) return;
        built = new WireframeStage(host.current, decoded, {
          reducedMotion: prefersReducedMotion(),
          onSelect: (id) => latest.current.onSelect(id),
          onHover: showTip,
          onContextLost: () => fail(new Error('WebGL context lost')),
        });
        stage.current = built;
        built.setMarkers(latest.current.markers);
        // The port already selected when the ship opens is highlighted, not zoomed to.
        built.setSelected(latest.current.selected, false);
      })
      .catch(fail);
    return () => {
      cancelled = true;
      built?.dispose();
      if (stage.current === built) stage.current = null;
      if (tip.current) tip.current.hidden = true;
    };
  }, [bundle]);

  useEffect(() => {
    stage.current?.setMarkers(markers);
  }, [markers]);

  useEffect(() => {
    stage.current?.setSelected(selected, true);
  }, [selected]);

  return (
    <div
      ref={host}
      className="t-wire"
      data-testid="wireframe-viewer"
      role="img"
      aria-label={label ?? 'Ship wireframe'}
    >
      <div ref={tip} className="t-wire-tip" hidden />
    </div>
  );
}
