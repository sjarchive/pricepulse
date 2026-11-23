import { useEffect, useState } from 'react';
import { Package } from 'lucide-react';
import { sanitizeExternalUrl } from '../lib/priceUtils';

interface ProductThumbnailProps {
  src: string | null;
  alt: string;
  platformLabel: string;
  size?: 'sm' | 'md' | 'lg';
}

export function ProductThumbnail({
  src,
  alt,
  platformLabel,
  size = 'md',
}: ProductThumbnailProps) {
  const [failed, setFailed] = useState(false);
  const safeSrc = sanitizeExternalUrl(src);

  useEffect(() => {
    setFailed(false);
  }, [safeSrc]);

  const dims =
    size === 'sm'
      ? 'w-10 h-10 rounded-md'
      : size === 'lg'
        ? 'w-20 h-20 rounded-lg'
        : 'w-12 h-12 rounded-lg';

  if (!safeSrc || failed) {
    return (
      <div
        className={`${dims} shrink-0 bg-slate-100 border border-slate-200 flex flex-col items-center justify-center text-slate-500 select-none`}
        aria-label={`${platformLabel} product placeholder`}
      >
        <Package className={size === 'lg' ? 'w-6 h-6 text-slate-400' : 'w-4 h-4 text-slate-400'} />
      </div>
    );
  }

  return (
    <img
      src={safeSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`${dims} shrink-0 object-cover border border-slate-200 bg-slate-50`}
    />
  );
}
