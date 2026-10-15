import { Link, useRouterState } from "@tanstack/react-router";
import type { MouseEventHandler, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AuthGate } from "../components/AuthGate";
import { AccountMenu } from "../components/AccountMenu";
import { api } from "../lib/api";

type User = { id: string; name: string; email: string; role: string };
type Notification = { id: number; title: string; message: string; readAt: string | null };

const navSections = [
  { label: "UTAMA", items: [{ to: "/", label: "Dashboard", icon: "bi-grid-1x2-fill" }] },
  { label: "JARINGAN", items: [{ to: "/peta-jaringan", label: "Peta Jaringan", icon: "bi-map" }] },
  {
    label: "ANALISIS",
    items: [
      { to: "/analisis-alamat", label: "Analisis Alamat", icon: "bi-geo-alt" },
      { to: "/analisis-massal", label: "Analisis Massal", icon: "bi-file-earmark-spreadsheet" },
      { to: "/riwayat-analisis", label: "Riwayat Analisis", icon: "bi-clock-history" },
    ],
  },
  { label: "KAPASITAS", items: [{ to: "/booking-core", label: "Booking Core", icon: "bi-diagram-3" }] },
] as const;

const navLink = (item: { to: string; label: string; icon: string }, pathname: string, onClick?: MouseEventHandler<HTMLAnchorElement>) => (
  <Link key={item.to} to={item.to} onClick={onClick} className={`nav-link ${pathname === item.to ? "active" : ""}`}>
    <i className={`nav-icon bi ${item.icon}`} />
    <span>{item.label}</span>
  </Link>
);

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <AuthenticatedShell>{children}</AuthenticatedShell>
    </AuthGate>
  );
}

function AuthenticatedShell({ children }: { children: ReactNode }) {
  const [sidebarHidden, setSidebarHidden] = useState(false);
  const mobileAnalysisMenu = useRef<HTMLDetailsElement>(null);
  const notificationMenu = useRef<HTMLDetailsElement>(null);
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const analysisPath = pathname.startsWith("/analisis") || pathname === "/riwayat-analisis";
  useEffect(() => {
    mobileAnalysisMenu.current?.removeAttribute("open");
  }, [pathname]);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !notificationMenu.current?.contains(event.target)) notificationMenu.current?.removeAttribute("open");
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick, true);
  }, []);
  const { data: user } = useQuery({ queryKey: ["me"], queryFn: () => api<User>("/me") });
  const isAdmin = user?.role === "ADMIN";
  const { data: notifications = [] } = useQuery({ queryKey: ["notifications"], queryFn: () => api<Notification[]>("/notifications"), refetchInterval: 60_000 });
  const markRead = useMutation({ mutationFn: (id: number) => api(`/notifications/${id}/read`, { method: "PATCH" }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }) });
  const unread = notifications.filter((item) => !item.readAt);
  return (
    <div className={`app-wrapper ${sidebarHidden ? "atlas-sidebar-hidden" : ""}`}>
      <nav className="app-header navbar navbar-expand bg-white border-bottom">
        <div className="container-fluid px-4">
          <button type="button" className="btn btn-light sidebar-toggle" aria-label={sidebarHidden ? "Tampilkan sidebar" : "Sembunyikan sidebar"} aria-expanded={!sidebarHidden} aria-controls="atlas-sidebar" onClick={() => setSidebarHidden((hidden) => !hidden)}>
            <i className="bi bi-list" aria-hidden="true" />
          </button>
          <Link to="/" className="navbar-brand header-brand d-flex align-items-center gap-2 mb-0">
            <span className="brand-mark">
              <i className="bi bi-broadcast-pin" />
            </span>
            <span>
              ATLAS <small>NETWORK INTELLIGENCE</small>
            </span>
          </Link>
          <div className="d-flex align-items-center gap-3">
            <details ref={notificationMenu} className="notification-menu">
              <summary className="btn btn-light position-relative" aria-label="Notifikasi">
                <i className="bi bi-bell" />
                {unread.length > 0 && <span className="notification-count">{unread.length}</span>}
              </summary>
              <div className="notification-popover">
                <b>Notifikasi</b>
                {notifications.length ? (
                  notifications.slice(0, 8).map((item) => (
                    <button key={item.id} className={`notification-item ${item.readAt ? "" : "unread"}`} onClick={() => !item.readAt && markRead.mutate(item.id)}>
                      <strong>{item.title}</strong>
                      <span>{item.message}</span>
                    </button>
                  ))
                ) : (
                  <small>Belum ada notifikasi.</small>
                )}
              </div>
            </details>
            <AccountMenu user={user} />
          </div>
        </div>
      </nav>
      <aside id="atlas-sidebar" className="app-sidebar">
        <Link to="/" className="atlas-sidebar-brand">
          <span className="brand-mark"><i className="bi bi-broadcast-pin" /></span>
          <span>ATLAS<small>NETWORK INTELLIGENCE</small></span>
        </Link>
        <nav className="sidebar-menu-groups" aria-label="Navigasi utama">
          <div className="sidebar-menu-group-label">MAIN MENU</div>
          <ul className="nav-sidebar">
            <li>{navLink(navSections[0].items[0], pathname)}</li>
            <li>{navLink(navSections[1].items[0], pathname)}</li>
            <li className="desktop-analysis-menu">
              <details open={analysisPath || undefined}>
                <summary className={`nav-link ${analysisPath ? "active" : ""}`}>
                  <i className="nav-icon bi bi-graph-up-arrow" />
                  <span>Analisis</span>
                  <i className="bi bi-chevron-down desktop-menu-chevron" />
                </summary>
                <ul className="desktop-submenu">
                  {navSections[2].items.map((item) => (
                    <li key={item.to}>{navLink(item, pathname)}</li>
                  ))}
                </ul>
              </details>
            </li>
            <li>{navLink(navSections[3].items[0], pathname)}</li>
            {isAdmin && <li>{navLink({ to: "/audit-trails", label: "Audit Trails", icon: "bi-journal-text" }, pathname)}</li>}
            {isAdmin && <li>{navLink({ to: "/pengaturan", label: "Pengaturan", icon: "bi-gear" }, pathname)}</li>}
          </ul>
        </nav>
        <nav className="mobile-nav" aria-label="Navigasi utama">
          <ul className="nav-sidebar">
            <li>{navLink(navSections[0].items[0], pathname)}</li>
            <li>{navLink(navSections[1].items[0], pathname)}</li>
            <li className="mobile-analysis-menu">
              <details ref={mobileAnalysisMenu} className={analysisPath ? "active" : ""}>
                <summary className={`nav-link ${analysisPath ? "active" : ""}`}>
                  <i className="nav-icon bi bi-graph-up-arrow" />
                  <span>Analisis</span>
                  <i className="bi bi-chevron-down mobile-menu-chevron" />
                </summary>
                <div className="mobile-analysis-popover">{navSections[2].items.map((item) => navLink(item, pathname, (event) => event.currentTarget.closest("details")?.removeAttribute("open")))}</div>
              </details>
            </li>
            <li>{navLink(navSections[3].items[0], pathname)}</li>
            {isAdmin && <li>{navLink({ to: "/audit-trails", label: "Audit Trails", icon: "bi-journal-text" }, pathname)}</li>}
            {isAdmin && <li>{navLink({ to: "/pengaturan", label: "Pengaturan", icon: "bi-gear" }, pathname)}</li>}
          </ul>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" /> ATLAS · Workspace jaringan
        </div>
      </aside>
      <main className="app-main">
        <div className="content-wrapper">
          <div className="content px-4 py-4">{children}</div>
        </div>
        <footer className="main-footer">
          ATLAS <span>Asset Tracking, Location Analytics &amp; Sales Intelligence Tools</span>
          <span className="float-end">Phase 2 · v0.1.0</span>
        </footer>
      </main>
    </div>
  );
}
