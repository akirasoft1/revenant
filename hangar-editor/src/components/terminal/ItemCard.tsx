import type { LoadoutSlot, SlotOption } from '../../api/types';
import { formatPrice, formatStat } from '../../lib/picker';
import { badges } from '../../lib/terminal';
import { SafeImage } from './SafeImage';

/** One compatible item: image, name, IN USE / STOCK and SIZE badges; price on hover/focus. */
export function ItemCard({
  option,
  port,
  stockUuid,
  selected,
  onSelect,
}: {
  option: SlotOption;
  port: LoadoutSlot;
  stockUuid: string | null;
  selected: boolean;
  onSelect(option: SlotOption): void;
}) {
  const marks = badges(option, port, stockUuid);
  const inUse = marks.includes('IN USE');
  const price = option.cheapestPrice;
  const sub = [option.manufacturer, option.grade && `Grade ${option.grade}`, option.class].filter(Boolean).join(' · ');
  return (
    <li className="t-card-cell">
      <button
        type="button"
        data-testid="item-card"
        className={`t-card t-frame${selected ? ' is-selected' : ''}${inUse ? ' is-in-use' : ''}`}
        aria-pressed={selected}
        title={price ? `Cheapest: ${formatPrice(price.price)} at ${price.shop}, ${price.location}` : undefined}
        onClick={() => onSelect(option)}
      >
        <span className="t-card-badges">
          <span className="t-card-badges-left">
            {marks.map((m) => (
              <span key={m} className={`t-badge ${m === 'IN USE' ? 't-badge-inuse' : 't-badge-stock'}`}>
                {m}
              </span>
            ))}
          </span>
          {option.size != null && <span className="t-badge t-badge-size">SIZE {option.size}</span>}
        </span>
        <span className="t-card-img">
          <SafeImage src={option.image} alt="" type={option.type} context="card" />
        </span>
        <span className="t-card-name">{option.name}</span>
        {sub && <span className="t-card-sub">{sub}</span>}
        {option.keyStat?.value != null && (
          <span className="t-card-stat">
            {option.keyStat.name} <b>{formatStat(option.keyStat.value)}</b>
          </span>
        )}
        {price && <span className="t-card-price">{formatPrice(price.price)}</span>}
      </button>
    </li>
  );
}
