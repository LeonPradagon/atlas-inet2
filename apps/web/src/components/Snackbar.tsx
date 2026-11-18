import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import "./snackbar.css";

type Notice = { text: string; kind: "success" | "warning" | "error"; retry?: () => void };
let queue: Notice[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const current = () => queue[0];
function update(next: Notice[]) {
  queue = next;
  listeners.forEach((listener) => listener());
}
export function notify(text: string, kind: Notice["kind"] = "success", retry?: Notice["retry"]) {
  if (!queue.some((notice) => notice.text === text && notice.kind === kind)) {
    update([...queue, { text, kind, retry }]);
  }
}

export async function reloadWithNotice(refetch: () => Promise<{ isError: boolean }>, success: string) {
  const result = await refetch();
  if (result.isError) {
    notify("Data gagal dimuat ulang.", "error", () => void reloadWithNotice(refetch, success));
    return;
  }
  notify(success);
}

const icons = {
  success: "bi-check-circle",
  warning: "bi-exclamation-triangle",
  error: "bi-exclamation-circle",
};

export function Snackbar() {
  const notice = useSyncExternalStore(subscribe, current);
  const [host, setHost] = useState<HTMLElement>(document.body);
  useEffect(() => {
    const sync = () => {
      const dialogs = document.querySelectorAll<HTMLElement>("dialog:modal");
      setHost(dialogs[dialogs.length - 1] ?? document.body);
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open"] });
    sync();
    return () => observer.disconnect();
  }, []);
  return createPortal(notice && <SnackbarMessage key={notice.kind + notice.text} notice={notice} />, host);
}

function SnackbarMessage({ notice }: { notice: Notice }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [clock] = useState(() => ({ remaining: 4000 }));
  const dismiss = () => update(queue.slice(1));
  useEffect(() => {
    if (notice.kind !== "success" || hovered || focused) return;
    const start = performance.now();
    const timer = window.setTimeout(() => update(queue.slice(1)), clock.remaining);
    return () => {
      window.clearTimeout(timer);
      clock.remaining = Math.max(0, clock.remaining - (performance.now() - start));
    };
  }, [notice, hovered, focused, clock]);
  return (
    <aside className="atlas-snackbar" data-kind={notice.kind} aria-label="Notifikasi tindakan"
      onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}>
      <i className={`atlas-snackbar-icon bi ${icons[notice.kind]}`} aria-hidden="true" />
      <p role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>
      {notice.retry && <button type="button" onClick={() => { dismiss(); notice.retry?.(); }}>Coba lagi</button>}
      <button className="atlas-snackbar-close" type="button" aria-label="Tutup notifikasi" onClick={dismiss}>
        <span className="btn-close" aria-hidden="true" />
      </button>
    </aside>
  );
}
