import type { LoadoutSlot, SlotOption } from '../../api/types';
import { ItemCard } from './ItemCard';

/** 2-column grid of compatible items for the selected port. */
export function ItemGrid({
  options,
  port,
  stockUuid,
  candidateUuid,
  onSelect,
}: {
  options: SlotOption[];
  port: LoadoutSlot;
  stockUuid: string | null;
  candidateUuid: string | null;
  onSelect(option: SlotOption): void;
}) {
  if (options.length === 0) return <p className="t-empty">No compatible items found for this port.</p>;
  return (
    <ul className="t-grid" aria-label="Compatible items">
      {options.map((o) => (
        <ItemCard
          key={o.uuid}
          option={o}
          port={port}
          stockUuid={stockUuid}
          selected={o.uuid === candidateUuid}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}
