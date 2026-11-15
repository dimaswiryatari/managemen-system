import { useEffect, useState } from 'react';
import {
  Activity,
  FlaskConical,
  Plus,
  RefreshCw,
  Router,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiRequest } from '../api';
import type { AuditLog, AuthUser, BranchStatus } from '../types';
import { formatActionLabel, formatConnectionMode, formatDateTime } from '../utils/format';

interface DashboardViewProps {
  user: AuthUser;
  onNavigate: (tab: string) => void;
}

export function DashboardView({ user, onNavigate }: DashboardViewProps) {
  const [branches, setBranches] = useState<BranchStatus[]>([]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFilter, setLogFilter] = useState<'all' | 'admin' | 'staff'>('all');

  async function loadDashboard() {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<{ branches: BranchStatus[]; logs: AuditLog[] }>('/api/dashboard');
      setBranches(data.branches);
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memuat dashboard.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSeedSandbox() {
    setSeeding(true);
    setError(null);
    try {
      await apiRequest('/api/branches/seed-sandbox', { method: 'POST' });
      await loadDashboard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal membuat cabang sandbox.');
    } finally {
      setSeeding(false);
    }
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  const totalOnline = branches.filter((b) => b.online).length;
  const totalOffline = branches.length - totalOnline;
  const totalActivePppoe = branches.reduce((acc, b) => acc + b.activeCount, 0);
  const totalInactivePppoe = branches.reduce((acc, b) => acc + b.inactiveCount, 0);

  const visibleLogs =
    user.role === 'admin'
      ? logs.filter((l) => (logFilter === 'all' ? true : l.user_role === logFilter))
      : logs;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            {user.role === 'admin' ? 'Ringkasan Semua Cabang' : `Ringkasan ${user.branch_name || 'Cabang Staf'}`}
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {user.role === 'admin'
              ? 'Status konektivitas MikroTik, total PPPoE aktif/nonaktif, dan riwayat perubahan admin serta staf.'
              : 'Status router MikroTik, jumlah PPPoE aktif/nonaktif, dan log aktivitas staf pada cabang Anda.'}
          </p>
        </div>

        <button
          type="button"
          onClick={loadDashboard}
          disabled={loading}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-200/90 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Muat Ulang Status</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Ringkasan KPI */}
      {user.role === 'staff' ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">Status MikroTik</p>
                {loading ? (
                  <p className="font-display text-2xl font-bold text-slate-900 mt-2">—</p>
                ) : branches.length === 0 ? (
                  <p className="font-display text-2xl font-bold text-slate-400 mt-2">Belum Terhubung</p>
                ) : branches[0].online ? (
                  <div className="mt-2 inline-flex items-center gap-2 font-display text-2xl font-bold text-emerald-700">
                    <Wifi className="w-5 h-5 shrink-0" />
                    <span>Online</span>
                  </div>
                ) : (
                  <div className="mt-2 inline-flex items-center gap-2 font-display text-2xl font-bold text-red-600">
                    <WifiOff className="w-5 h-5 shrink-0" />
                    <span>Offline</span>
                  </div>
                )}
              </div>
              <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <Router className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              {branches[0]?.branchName || user.branch_name || 'Cabang belum ditugaskan'}
            </p>
          </div>

          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">PPPoE Aktif</p>
                <p className="font-display text-[28px] leading-tight font-bold text-emerald-700 tabular-nums mt-2">
                  {loading ? '—' : totalActivePppoe}
                </p>
              </div>
              <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">Sesi aktif di MikroTik</p>
          </div>

          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">PPPoE Nonaktif</p>
                <p className="font-display text-[28px] leading-tight font-bold text-amber-700 tabular-nums mt-2">
                  {loading ? '—' : totalInactivePppoe}
                </p>
              </div>
              <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                <Activity className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">Secret belum terhubung</p>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">MikroTik Online</p>
                <p className="font-display text-[28px] leading-tight font-bold text-slate-900 tabular-nums mt-2">
                  {loading ? '—' : totalOnline}
                </p>
              </div>
              <div className="w-9 h-9 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <Wifi className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2 tabular-nums">
              Dari {branches.length} cabang terdaftar
            </p>
          </div>

          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">MikroTik Offline</p>
                <p className={`font-display text-[28px] leading-tight font-bold tabular-nums mt-2 ${totalOffline > 0 ? 'text-red-600' : 'text-slate-900'}`}>
                  {loading ? '—' : totalOffline}
                </p>
              </div>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${totalOffline > 0 ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-500'}`}>
                <WifiOff className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">
              {totalOffline > 0 ? 'Perlu pengecekan router' : 'Semua router terjangkau'}
            </p>
          </div>

          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">PPPoE Aktif</p>
                <p className="font-display text-[28px] leading-tight font-bold text-emerald-700 tabular-nums mt-2">
                  {loading ? '—' : totalActivePppoe}
                </p>
              </div>
              <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                <Users className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">Sesi aktif di MikroTik</p>
          </div>

          <div className="bg-white border border-slate-200/85 rounded-xl p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-slate-500">PPPoE Nonaktif</p>
                <p className="font-display text-[28px] leading-tight font-bold text-amber-700 tabular-nums mt-2">
                  {loading ? '—' : totalInactivePppoe}
                </p>
              </div>
              <div className="w-9 h-9 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center shrink-0">
                <Activity className="w-4 h-4" />
              </div>
            </div>
            <p className="text-xs text-slate-500 mt-2">Secret belum terhubung</p>
          </div>
        </div>
      )}

      {/* Status MikroTik Per Cabang */}
      <section className="bg-white border border-slate-200/85 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">
              Status MikroTik &amp; PPPoE Cabang
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Pemeriksaan langsung ke perangkat MikroTik setiap cabang
            </p>
          </div>
          {user.role === 'admin' && branches.length > 0 && (
            <button
              type="button"
              onClick={() => onNavigate('branches')}
              className="text-sm font-medium text-blue-600 hover:text-blue-700 whitespace-nowrap cursor-pointer"
            >
              Kelola Cabang
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        ) : branches.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              {user.role === 'admin'
                ? 'Belum ada cabang RT/RW Net yang terdaftar'
                : 'Akun Anda belum ditugaskan ke cabang manapun'}
            </p>
            <p className="text-sm text-slate-500 mt-1 max-w-lg mx-auto">
              {user.role === 'admin'
                ? 'Tambahkan cabang baru dengan IP/Host MikroTik Anda, atau muat cabang Lab Sandbox untuk langsung menguji fitur PPPoE dan cek ping.'
                : 'Hubungi Administrator untuk menugaskan cabang MikroTik pada akun staf Anda.'}
            </p>
            {user.role === 'admin' && (
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => onNavigate('branches')}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Tambah Cabang MikroTik</span>
                </button>
                <button
                  type="button"
                  onClick={handleSeedSandbox}
                  disabled={seeding}
                  className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-sm font-medium transition-colors whitespace-nowrap cursor-pointer disabled:opacity-60"
                >
                  <FlaskConical className="w-4 h-4" />
                  <span>{seeding ? 'Menyiapkan...' : 'Muat Cabang Lab Sandbox'}</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="py-3 px-6">Cabang</th>
                  <th className="py-3 px-4">Router &amp; Metode</th>
                  <th className="py-3 px-4">Status MikroTik</th>
                  <th className="py-3 px-4 text-right">PPPoE Aktif</th>
                  <th className="py-3 px-4 text-right">PPPoE Nonaktif</th>
                  <th className="py-3 px-6 text-right">Total Secret</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 text-sm">
                {branches.map((b) => (
                  <tr key={b.branchId} className="hover:bg-slate-50/90 transition-colors">
                    <td className="py-3.5 px-6">
                      <p className="font-medium text-slate-900">{b.branchName}</p>
                      <p className="text-xs text-slate-500">{b.location}</p>
                    </td>
                    <td className="py-3.5 px-4">
                      <p className="font-mono text-xs text-slate-800 tabular-nums">
                        {b.host}:{b.port}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {formatConnectionMode(b.connectionMode)}
                        {b.version ? ` · v${b.version}` : ''}
                      </p>
                    </td>
                    <td className="py-3.5 px-4">
                      {b.online ? (
                        <div className="inline-flex items-center gap-1.5 text-emerald-700 font-medium">
                          <Wifi className="w-4 h-4 shrink-0" />
                          <span>Online</span>
                        </div>
                      ) : (
                        <div>
                          <div className="inline-flex items-center gap-1.5 text-red-600 font-medium">
                            <WifiOff className="w-4 h-4 shrink-0" />
                            <span>Offline</span>
                          </div>
                          {b.error && <p className="text-xs text-red-500 mt-0.5 max-w-xs truncate">{b.error}</p>}
                        </div>
                      )}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-medium text-emerald-700 tabular-nums">
                      {b.activeCount}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-medium text-amber-700 tabular-nums">
                      {b.inactiveCount}
                    </td>
                    <td className="py-3.5 px-6 text-right font-mono font-medium text-slate-900 tabular-nums">
                      {b.totalSecrets}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Log Perubahan */}
      <section className="bg-white border border-slate-200/85 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">
              {user.role === 'admin' ? 'Log Perubahan Admin & Staf' : 'Log Perubahan Staf Cabang'}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {user.role === 'admin'
                ? 'Catatan audit seluruh aktivitas konfigurasi dari semua cabang'
                : 'Catatan perubahan yang dilakukan staf pada cabang Anda'}
            </p>
          </div>

          {user.role === 'admin' && (
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['all', 'admin', 'staff'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setLogFilter(f)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                    logFilter === f
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {f === 'all' ? 'Semua' : f === 'admin' ? 'Admin' : 'Staf'}
                </button>
              ))}
            </div>
          )}
        </div>

        {visibleLogs.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Belum ada catatan perubahan yang terekam.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-xs font-medium text-slate-500">
                  <th className="py-3 px-6">Waktu</th>
                  <th className="py-3 px-4">Pelaku</th>
                  <th className="py-3 px-4">Cabang</th>
                  <th className="py-3 px-4">Aksi</th>
                  <th className="py-3 px-6">Keterangan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 text-sm">
                {visibleLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50/90 transition-colors">
                    <td className="py-3 px-6 font-mono text-xs text-slate-500 tabular-nums whitespace-nowrap">
                      {formatDateTime(log.created_at)}
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      <span className="font-medium text-slate-900">{log.user_full_name}</span>
                      <span className="text-slate-400 mx-1.5">·</span>
                      <span className="text-xs text-slate-500">
                        {log.user_role === 'admin' ? 'Admin' : 'Staf'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                      {log.branch_name || 'Global'}
                    </td>
                    <td className="py-3 px-4 font-medium text-slate-800 whitespace-nowrap">
                      {formatActionLabel(log.action)}
                    </td>
                    <td className="py-3 px-6 text-slate-600 max-w-md">{log.details}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
