import type { ReactNode } from 'react';

// Our own simple 24x24 stroke icons (no game assets).
const PATHS: Record<string, ReactNode> = {
  all: (
    <>
      <rect x="4" y="4" width="6" height="6" />
      <rect x="14" y="4" width="6" height="6" />
      <rect x="4" y="14" width="6" height="6" />
      <rect x="14" y="14" width="6" height="6" />
    </>
  ),
  WeaponGun: (
    <>
      <path d="M3 10h13l3 2-3 2H3z" />
      <path d="M7 14v5M12 14v3" />
    </>
  ),
  Turret: (
    <>
      <circle cx="12" cy="13" r="5" />
      <path d="M12 8V3M9 3h6" />
    </>
  ),
  MissileLauncher: (
    <>
      <path d="M4 15 15 4l5 0 0 5L9 20z" />
      <path d="M7 12l5 5" />
    </>
  ),
  Shield: <path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z" />,
  PowerPlant: <path d="M13 2 5 13h6l-1 9 8-11h-6z" />,
  Cooler: (
    <>
      <path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />
      <path d="M10 4l2 2 2-2M10 20l2-2 2 2" />
    </>
  ),
  QuantumDrive: (
    <>
      <circle cx="12" cy="12" r="3" />
      <ellipse cx="12" cy="12" rx="9" ry="4" />
      <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(60 12 12)" />
    </>
  ),
  Radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="M12 12 19 6" />
    </>
  ),
  WeaponMining: (
    <>
      <path d="M5 19 14 10" />
      <path d="M12 4c4 0 8 3 8 7M12 4l-2 3M20 11l-3 1" />
    </>
  ),
  TractorBeam: (
    <>
      <path d="M12 3v6" />
      <path d="M8 21 10 9h4l2 12z" />
    </>
  ),
};

export function TypeIcon({ type, className }: { type: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="type-icon"
      data-type={type}
    >
      {PATHS[type] ?? PATHS.all}
    </svg>
  );
}
