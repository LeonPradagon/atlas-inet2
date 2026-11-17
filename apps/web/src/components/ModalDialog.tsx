import { useEffect, useRef, type ReactNode } from "react";

export function ModalDialog({
  children,
  labelledBy,
  onClose,
  className = "",
}: {
  children: ReactNode;
  labelledBy: string;
  onClose: () => void;
  className?: string;
}) {
  const element = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = element.current;
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={element}
      aria-labelledby={labelledBy}
      className={`atlas-modal-dialog ${className}`}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const fields = [...event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]'
        )].filter(field => field.getClientRects().length > 0);
        const first = fields[0];
        const last = fields.at(-1);
        if (!first || !last) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close.current();
      }}
    >
      {children}
    </dialog>
  );
}
