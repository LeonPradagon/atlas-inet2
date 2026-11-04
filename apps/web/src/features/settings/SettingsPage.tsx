import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { PageHeader } from "../../components/PageHeader";
import { api } from "../../lib/api";

function CreateAccountForm() {
  const form = useRef<HTMLFormElement>(null);
  const [validation, setValidation] = useState("");
  const create = useMutation({
    mutationFn: (data: {
      name: string;
      email: string;
      password: string;
      role: string;
    }) =>
      api<{ name: string; email: string; role: string }>("/users", {
        method: "POST",
        data,
      }),
    onSuccess: () => form.current?.reset(),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setValidation("");
    create.reset();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== String(data.get("confirmPassword"))) {
      setValidation("Konfirmasi kata sandi harus sama.");
      return;
    }
    create.mutate({
      name: String(data.get("name")).trim(),
      email: String(data.get("email")).trim(),
      password,
      role: String(data.get("role")),
    });
  }
  return (
    <section className="card panel-card mt-4">
      <div className="card-header">
        <div>
          <h3>Buat akun pengguna</h3>
          <p>Siapkan akun untuk anggota organisasi.</p>
        </div>
      </div>
      <div className="card-body">
        <form onSubmit={submit} ref={form}>
          <fieldset className="m-0 border-0 p-0" disabled={create.isPending}>
            <div className="row g-3">
              <div className="col-md-6">
                <label className="form-label" htmlFor="account-name">
                  Nama lengkap
                </label>
                <input
                  autoComplete="off"
                  className="form-control"
                  id="account-name"
                  name="name"
                  required
                />
              </div>
              <div className="col-md-6">
                <label className="form-label" htmlFor="account-email">
                  Email
                </label>
                <input
                  autoComplete="off"
                  className="form-control"
                  id="account-email"
                  name="email"
                  required
                  type="email"
                />
              </div>
              <div className="col-12">
                <label className="form-label" htmlFor="account-role">
                  Peran
                </label>
                <select
                  className="form-select"
                  defaultValue="PRESALES"
                  id="account-role"
                  name="role"
                >
                  <option value="PRESALES">PRESALES</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
                <div className="form-text">
                  ADMIN dapat mengelola pengguna dan pengaturan organisasi.
                </div>
              </div>
              <div className="col-md-6">
                <label className="form-label" htmlFor="account-password">
                  Kata sandi
                </label>
                <input
                  autoComplete="new-password"
                  className="form-control"
                  id="account-password"
                  minLength={12}
                  name="password"
                  required
                  type="password"
                />
                <div className="form-text">Minimal 12 karakter.</div>
              </div>
              <div className="col-md-6">
                <label
                  className="form-label"
                  htmlFor="account-confirm-password"
                >
                  Konfirmasi kata sandi
                </label>
                <input
                  autoComplete="new-password"
                  className="form-control"
                  id="account-confirm-password"
                  minLength={12}
                  name="confirmPassword"
                  required
                  type="password"
                />
              </div>
            </div>
            <button className="btn btn-primary mt-3" type="submit">
              {create.isPending ? "Membuat akun..." : "Buat akun"}
            </button>
          </fieldset>
          {(validation || create.isError) && (
            <div className="alert alert-danger mt-3 mb-0" role="alert">
              {validation ||
                (create.error instanceof Error
                  ? create.error.message
                  : "Akun tidak dapat dibuat.")}
            </div>
          )}
          {create.isSuccess && (
            <div className="alert alert-success mt-3 mb-0" role="status">
              Akun {create.data.email} berhasil dibuat dengan peran{" "}
              {create.data.role}.
            </div>
          )}
        </form>
      </div>
    </section>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [pattern, setPattern] = useState("");
  const { data: user } = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ role: string }>("/me"),
  });
  const settings = useQuery({
    queryKey: ["cable-name-pattern"],
    queryFn: () => api<{ pattern: string }>("/settings/cable-name-pattern"),
  });
  useEffect(() => {
    if (settings.data) {
      setPattern(settings.data.pattern);
    }
  }, [settings.data]);
  const save = useMutation({
    mutationFn: () =>
      api("/settings/cable-name-pattern", {
        method: "PATCH",
        data: { pattern },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["cable-name-pattern"] });
      await queryClient.invalidateQueries({ queryKey: ["segments"] });
    },
  });

  return (
    <>
      <PageHeader
        subtitle="Kelola akun pengguna, validasi, dan preferensi jaringan."
        title="Pengaturan"
      />
      <section className="card panel-card">
        <div className="card-header">
          <h3>Pola nama kabel</h3>
          <p>Validasi nama segmen jaringan menggunakan regular expression.</p>
        </div>
        <div className="card-body">
          {settings.isPending ? (
            <p role="status">Memuat pengaturan...</p>
          ) : settings.isError ? (
            <div className="alert alert-danger">
              Pola nama kabel tidak dapat dimuat.
            </div>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <label className="form-label" htmlFor="cable-pattern">
                Pola nama kabel (RegExp)
              </label>
              <input
                className="form-control"
                id="cable-pattern"
                onChange={(event) => setPattern(event.target.value)}
                required
                value={pattern}
              />
              <div className="d-flex align-items-center mt-3 gap-3">
                <button
                  className="btn btn-primary"
                  disabled={save.isPending}
                  type="submit"
                >
                  {save.isPending ? "Menyimpan..." : "Simpan pola"}
                </button>
                {save.isSuccess && (
                  <span className="text-success" role="status">
                    Pola tersimpan.
                  </span>
                )}
                {save.isError && (
                  <span className="text-danger" role="alert">
                    {save.error instanceof Error
                      ? save.error.message
                      : "Pola tidak dapat disimpan."}
                  </span>
                )}
              </div>
            </form>
          )}
        </div>
      </section>
      {user?.role === "ADMIN" && <CreateAccountForm />}
    </>
  );
}
