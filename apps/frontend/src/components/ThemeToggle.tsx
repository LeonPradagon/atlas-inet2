import { useState } from 'react'

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.bsTheme === 'dark')
  const label = dark ? 'Aktifkan mode terang' : 'Aktifkan mode gelap'

  function toggle() {
    const theme = dark ? 'light' : 'dark'
    document.documentElement.dataset.bsTheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101827' : '#f4f6f9')
    try { localStorage.setItem('atlas-theme', theme) } catch { /* Theme still works when browser storage is unavailable. */ }
    setDark(!dark)
  }

  return <button type="button" className="btn btn-light theme-toggle" onClick={toggle} aria-label={label} aria-pressed={dark} title={label}>
    <i className={`bi ${dark ? 'bi-sun' : 'bi-moon-stars'}`} aria-hidden="true" />
  </button>
}
