import Swal from 'sweetalert2'
import 'sweetalert2/dist/sweetalert2.min.css'

const dialog = Swal.mixin({
  background: 'var(--bs-body-bg, #fff)',
  color: 'var(--bs-body-color, #202b3c)',
  buttonsStyling: false,
  customClass: { confirmButton: 'btn btn-primary mx-1', cancelButton: 'btn btn-outline-secondary mx-1' },
})

export async function confirmAction(text: string) {
  const result = await dialog.fire({ title: 'Konfirmasi', text, icon: 'question', showCancelButton: true, confirmButtonText: 'Ya, lanjutkan', cancelButtonText: 'Batal', focusCancel: true })
  return result.isConfirmed
}

export async function showError(text: string) {
  await dialog.fire({ title: 'Proses gagal', text, icon: 'error', confirmButtonText: 'Tutup' })
}
