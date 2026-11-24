import { useEffect, useRef, type ReactNode } from "react";

function isOutsideDialog(dialog: HTMLDialogElement, x: number, y: number) {
  const rect = dialog.getBoundingClientRect();
  return x < rect.left || x > rect.right || y < rect.top || y > rect.bottom;
}

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
  const backdropPointer = useRef<number | null>(null);
  const backdropClick = useRef(false);
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
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], details > summary:first-child, [tabindex="0"]'
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
      onPointerDownCapture={(event) => {
        if (!event.isPrimary) return;
        backdropClick.current = false;
        backdropPointer.current = event.button === 0 && event.target === event.currentTarget &&
          isOutsideDialog(event.currentTarget, event.clientX, event.clientY)
          ? event.pointerId
          : null;
      }}
      onPointerUpCapture={(event) => {
        if (!event.isPrimary) return;
        backdropClick.current = backdropPointer.current === event.pointerId &&
          event.target === event.currentTarget &&
          isOutsideDialog(event.currentTarget, event.clientX, event.clientY);
        backdropPointer.current = null;
      }}
      onPointerCancelCapture={() => {
        backdropPointer.current = null;
        backdropClick.current = false;
      }}
      onClick={(event) => {
        const shouldClose = backdropClick.current && event.detail > 0 &&
          event.target === event.currentTarget &&
          isOutsideDialog(event.currentTarget, event.clientX, event.clientY);
        backdropClick.current = false;
        if (shouldClose) close.current();
      }}
    >
      {children}
    </dialog>
  );
}
