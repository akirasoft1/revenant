import { useEffect, useState, type ReactNode } from 'react';
import { reportImageError } from '../../api/client';
import { TypeIcon } from './icons';

/**
 * Lazy `<img>` that falls back to a type icon (or `fallback`, when given) and
 * reports a failed URL once per page load.
 */
export function SafeImage({
  src,
  alt,
  type,
  context,
  className,
  fallback,
  onFail,
}: {
  src?: string;
  alt: string;
  type: string;
  context: string;
  className?: string;
  fallback?: ReactNode;
  /** Called once when the image fails to load (after the report). */
  onFail?: () => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return fallback !== undefined ? <>{fallback}</> : <TypeIcon type={type} className={className} />;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        setFailed(true);
        reportImageError(src, context);
        onFail?.();
      }}
    />
  );
}
