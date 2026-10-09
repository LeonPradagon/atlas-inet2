import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet } from '@tanstack/react-router'
import { AppShell } from './AppShell'

const rootRoute = createRootRoute({ component: () => <AppShell><Outlet /></AppShell> })
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: lazyRouteComponent(() => import('../features/dashboard/DashboardPage'), 'DashboardPage') })
const mapRoute = createRoute({ getParentRoute: () => rootRoute, path: '/peta-jaringan', component: lazyRouteComponent(() => import('../features/map/MapPage'), 'MapPage') })
const addressRoute = createRoute({ getParentRoute: () => rootRoute, path: '/analisis-alamat', component: lazyRouteComponent(() => import('../features/analysis/AddressAnalysisPage'), 'AddressAnalysisPage') })
const bulkRoute = createRoute({ getParentRoute: () => rootRoute, path: '/analisis-massal', component: lazyRouteComponent(() => import('../features/analysis/BulkAnalysisPage'), 'BulkAnalysisPage') })
const bookingRoute = createRoute({ getParentRoute: () => rootRoute, path: '/booking-core', component: lazyRouteComponent(() => import('../features/core-booking/CoreBookingPage'), 'CoreBookingPage') })
const auditRoute = createRoute({ getParentRoute: () => rootRoute, path: '/audit-trails', component: lazyRouteComponent(() => import('../features/audit/AuditTrailsPage'), 'AuditTrailsPage') })
const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: '/profil', component: lazyRouteComponent(() => import('../features/profile/ProfilePage'), 'ProfilePage') })

const routeTree = rootRoute.addChildren([dashboardRoute, mapRoute, addressRoute, bulkRoute, bookingRoute, auditRoute, profileRoute])
export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}
