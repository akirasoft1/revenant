import { useEffect, useState } from 'react';
import { reportImageError } from '../../api/client';
import { TypeIcon } from './icons';

/** Lazy `<img>` that falls back to a type icon and reports a failed URL once per page load. */
export function SafeImage({
  src,
  alt,
  type,
  context,
  className,
}: {
  src?: string;
  alt: string;
  type: string;
  context: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <TypeIcon type={type} className={className} />;
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        setFailed(true);
        reportImageError(src, context);
      }}
    />
  );
}
