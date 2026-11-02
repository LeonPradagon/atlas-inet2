import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import type { MouseEventHandler, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { AccountMenu } from "../components/AccountMenu";
import { AuthGate } from "../components/AuthGate";
import { ThemeToggle } from "../components/ThemeToggle";
import { api } from "../lib/api";

type User = { id: string; name: string; email: string; role: string };
type Notification = {
  id: number;
  title: string;
  message: string;
  readAt: string | null;
  bookingId: string | null;
};

const navSections = [
  {
    label: "UTAMA",
    items: [{ to: "/", label: "Dashboard", icon: "bi-grid-1x2-fill" }],
  },
  {
    label: "JARINGAN",
    items: [{ to: "/peta-jaringan", label: "Peta Jaringan", icon: "bi-map" }],
  },
  {
    label: "ANALISIS",
    items: [
      { to: "/analisis-alamat", label: "Analisis Alamat", icon: "bi-geo-alt" },
      {
        to: "/analisis-massal",
        label: "Analisis Massal",
        icon: "bi-file-earmark-spreadsheet",
      },
      {
        to: "/riwayat-analisis",
        label: "Riwayat Analisis",
        icon: "bi-clock-history",
      },
      {
        to: "/survei-verifikasi",
        label: "Survei & Verifikasi",
        icon: "bi-clipboard-check",
      },
    ],
  },
  {
    label: "KAPASITAS",
    items: [
      { to: "/booking-core", label: "Booking Core", icon: "bi-diagram-3" },
    ],
  },
] as const;

const navLink = (
  item: { to: string; label: string; icon: string },
  pathname: string,
  onClick?: MouseEventHandler<HTMLAnchorElement>
) => (
  <Link
    className={`nav-link ${pathname === item.to ? "active" : ""}`}
    key={item.to}
    onClick={onClick}
    to={item.to}
  >
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
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const previousPathname = useRef(pathname);
  const analysisPath =
    pathname.startsWith("/analisis") || pathname === "/riwayat-analisis";
  useEffect(() => {
    mobileAnalysisMenu.current?.removeAttribute("open");
  }, [pathname]);
  useEffect(() => {
    if (
      previousPathname.current === "/analisis-massal" &&
      pathname !== "/analisis-massal"
    ) {
      localStorage.removeItem("atlas-bulk-job");
    }
    previousPathname.current = pathname;
  }, [pathname]);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !notificationMenu.current?.contains(event.target)
      ) {
        notificationMenu.current?.removeAttribute("open");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick, true);
    return () =>
      document.removeEventListener("pointerdown", closeOnOutsideClick, true);
  }, []);
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<User>("/me"),
  });
  const isAdmin = user?.role === "ADMIN";
  const { data: notifications = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<Notification[]>("/notifications"),
    refetchInterval: 60_000,
  });
  const markRead = useMutation({
    mutationFn: (id: number) =>
      api(`/notifications/${id}/read`, { method: "PATCH" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const openNotification = (item: Notification) => {
    if (!item.readAt) {
      markRead.mutate(item.id);
    }
    notificationMenu.current?.removeAttribute("open");
    void navigate({
      to: "/booking-core",
      search: { bookingId: item.bookingId ?? undefined },
    });
  };
  const unread = notifications.filter((item) => !item.readAt);
  return (
    <div
      className={`app-wrapper ${sidebarHidden ? "atlas-sidebar-hidden" : ""}`}
    >
      <nav className="app-header navbar navbar-expand border-bottom bg-white">
        <div className="container-fluid px-4">
          <button
            aria-controls="atlas-sidebar"
            aria-expanded={!sidebarHidden}
            aria-label={
              sidebarHidden ? "Tampilkan sidebar" : "Sembunyikan sidebar"
            }
            className="btn btn-light sidebar-toggle"
            onClick={() => setSidebarHidden((hidden) => !hidden)}
            type="button"
          >
            <i aria-hidden="true" className="bi bi-list" />
          </button>
          <Link
            className="navbar-brand header-brand d-flex align-items-center mb-0 gap-2"
            to="/"
          >
            <img
              alt="Sinergy Networks"
              className="corporate-logo"
              height="42"
              src="/sinergy-networks-brd.png"
              width="160"
            />
            <span>
              ATLAS <small>NETWORK INTELLIGENCE</small>
            </span>
          </Link>
          <div className="d-flex align-items-center gap-3">
            <ThemeToggle />
            <details className="notification-menu" ref={notificationMenu}>
              <summary
                aria-label="Notifikasi"
                className="btn btn-light position-relative"
              >
                <i className="bi bi-bell" />
                {unread.length > 0 && (
                  <span className="notification-count">{unread.length}</span>
                )}
              </summary>
              <div className="notification-popover">
                <b>Notifikasi</b>
                {notifications.length ? (
                  notifications.slice(0, 8).map((item) => (
                    <button
                      className={`notification-item ${item.readAt ? "" : "unread"}`}
                      key={item.id}
                      onClick={() => openNotification(item)}
                    >
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
      <aside className="app-sidebar" id="atlas-sidebar">
        <Link className="atlas-sidebar-brand" to="/">
          <span className="sidebar-corporate-logo">
            <img
              alt="Sinergy Networks — Borderless Connectivity"
              className="corporate-logo"
              height="50"
              src="/sinergy-networks-brd.png"
              width="190"
            />
            <img
              alt=""
              aria-hidden="true"
              className="sidebar-logo-wordmark"
              height="50"
              src="/sinergy-networks-brd.png"
              width="190"
            />
          </span>
          <span className="corporate-product-name">
            ATLAS · NETWORK INTELLIGENCE
          </span>
        </Link>
        <nav aria-label="Navigasi utama" className="sidebar-menu-groups">
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
            {isAdmin && (
              <li>
                {navLink(
                  {
                    to: "/audit-trails",
                    label: "Audit Trails",
                    icon: "bi-journal-text",
                  },
                  pathname
                )}
              </li>
            )}
            {isAdmin && (
              <li>
                {navLink(
                  { to: "/pengaturan", label: "Pengaturan", icon: "bi-gear" },
                  pathname
                )}
              </li>
            )}
          </ul>
        </nav>
        <nav aria-label="Navigasi utama" className="mobile-nav">
          <ul className="nav-sidebar">
            <li>{navLink(navSections[0].items[0], pathname)}</li>
            <li>{navLink(navSections[1].items[0], pathname)}</li>
            <li className="mobile-analysis-menu">
              <details
                className={analysisPath ? "active" : ""}
                ref={mobileAnalysisMenu}
              >
                <summary className={`nav-link ${analysisPath ? "active" : ""}`}>
                  <i className="nav-icon bi bi-graph-up-arrow" />
                  <span>Analisis</span>
                  <i className="bi bi-chevron-down mobile-menu-chevron" />
                </summary>
                <div className="mobile-analysis-popover">
                  {navSections[2].items.map((item) =>
                    navLink(item, pathname, (event) =>
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open")
                    )
                  )}
                </div>
              </details>
            </li>
            <li>{navLink(navSections[3].items[0], pathname)}</li>
            {isAdmin && (
              <li>
                {navLink(
                  {
                    to: "/audit-trails",
                    label: "Audit Trails",
                    icon: "bi-journal-text",
                  },
                  pathname
                )}
              </li>
            )}
            {isAdmin && (
              <li>
                {navLink(
                  { to: "/pengaturan", label: "Pengaturan", icon: "bi-gear" },
                  pathname
                )}
              </li>
            )}
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
          ATLAS{" "}
          <span>
            Asset Tracking, Location Analytics &amp; Sales Intelligence Tools
          </span>
          <span className="float-end">Phase 2 · v0.1.0</span>
        </footer>
      </main>
    </div>
  );
}
