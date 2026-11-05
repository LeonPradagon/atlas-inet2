import type { ReactNode } from "react";

type AtlasTagProps = {
  children: ReactNode;
  className?: string;
};

export function AtlasTag({ children, className = "" }: AtlasTagProps) {
  return <span className={`atlas-tag ${className}`.trim()}>{children}</span>;
}
