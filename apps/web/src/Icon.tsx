import { ICON_PATHS, type IconName } from './icon-paths';

/** EDRPG와 같은 24x24 stroke 아이콘. 경로 문자열은 icon-paths.ts의 정적 값만 쓴다. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`ico${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}
