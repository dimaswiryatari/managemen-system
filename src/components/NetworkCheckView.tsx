import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  ExternalLink,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Router,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { apiRequest } from '../api';
import type { AuthUser, BranchStatus, OltLink, PingResult } from '../types';
import { formatConnectionMode } from '../utils/format';

interface NetworkCheckViewProps {
  user: AuthUser;
}

function extractHostFromUrl(httpUrl: string): string {
  try {
    return new URL(httpUrl).hostname;
  } catch {
    return httpUrl.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0] || '';
  }
}

export function NetworkCheckView({ user }: NetworkCheckViewProps) {
  const [branches, setBranches] = useState<BranchStatus[]>([]);
  const [olts, setOlts] = useState<OltLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [selectedBranchId, setSelectedBranchId] = useState<number | null>(user.branch_id);
  const [target, setTarget] = useState('8.8.8.8');
  const [count, setCount] = useState(4);
  const [pinging, setPinging] = useState(false);
  const [pingError, setPingError] = useState<string | null>(null);
  const [pingResult, setPingResult] = useState<PingResult | null>(null);
  const pingSectionRef = useRef<HTMLElement | null>(null);

  // Modal Tambah / Edit OLT
  const [showOltModal, setShowOltModal] = useState(false);
  const [editingOlt, setEditingOlt] = useState<OltLink | null>(null);
  const [oltBranchId, setOltBranchId] = useState<number | ''>('');
  const [oltName, setOltName] = useState('');
  const [oltHttpUrl, setOltHttpUrl] = useState('');
  const [oltNotes, setOltNotes] = useState('');
  const [savingOlt, setSavingOlt] = useState(false);
  const [oltError, setOltError] = useState<string | null>(null);

  // Modal Hapus OLT
  const [deleteOltTarget, setDeleteOltTarget] = useState<OltLink | null>(null);
  const [deletingOlt, setDeletingOlt] = useState(false);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const [networkRes, oltRes] = await Promise.all([
        apiRequest<{ branches: BranchStatus[] }>('/api/network-check'),
        apiRequest<{ olts: OltLink[] }>('/api/olt-links'),
      ]);
      setBranches(networkRes.branches);
      setOlts(oltRes.olts);
      if (user.role === 'staff') {
        setSelectedBranchId(user.branch_id);
      } else if (networkRes.branches.length > 0) {
        setSelectedBranchId((prev) => prev ?? networkRes.branches[0].branchId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal memeriksa status jaringan.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function handleRunPing(e: FormEvent) {
    e.preventDefault();
    if (!selectedBranchId || !target.trim()) return;
    setPinging(true);
    setPingError(null);
    try {
      const res = await apiRequest<{ result: PingResult }>(
        `/api/branches/${selectedBranchId}/ping`,
        {
          method: 'POST',
          body: JSON.stringify({ target: target.trim(), count }),
        }
      );
      setPingResult(res.result);
    } catch (err) {
      setPingError(err instanceof Error ? err.message : 'Gagal menjalankan ping dari MikroTik.');
      setPingResult(null);
    } finally {
      setPinging(false);
    }
  }

  function openAddOltModal() {
    setEditingOlt(null);
    setOltBranchId(selectedBranchId ?? branches[0]?.branchId ?? '');
    setOltName('');
    setOltHttpUrl('http://');
    setOltNotes('');
    setOltError(null);
    setShowOltModal(true);
  }

  function openEditOltModal(olt: OltLink) {
    setEditingOlt(olt);
    setOltBranchId(olt.branch_id);
    setOltName(olt.name);
    setOltHttpUrl(olt.http_url);
    setOltNotes(olt.notes || '');
    setOltError(null);
    setShowOltModal(true);
  }

  async function handleSaveOlt(e: FormEvent) {
    e.preventDefault();
    if (!oltBranchId) {
      setOltError('Pilih cabang terlebih dahulu.');
      return;
    }
    setSavingOlt(true);
    setOltError(null);
    setNotice(null);
    try {
      const payload = {
        branch_id: Number(oltBranchId),
        name: oltName.trim(),
        http_url: oltHttpUrl.trim(),
        notes: oltNotes.trim(),
      };
      if (editingOlt) {
        await apiRequest(`/api/olt-links/${editingOlt.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        setNotice(`Link OLT "${payload.name}" berhasil diperbarui.`);
      } else {
        await apiRequest('/api/olt-links', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        setNotice(`Link OLT "${payload.name}" berhasil ditambahkan.`);
      }
      setShowOltModal(false);
      await loadStatus();
    } catch (err) {
      setOltError(err instanceof Error ? err.message : 'Gagal menyimpan link OLT.');
    } finally {
      setSavingOlt(false);
    }
  }

  async function handleConfirmDeleteOlt() {
    if (!deleteOltTarget) return;
    setDeletingOlt(true);
    setNotice(null);
    try {
      await apiRequest(`/api/olt-links/${deleteOltTarget.id}`, {
        method: 'DELETE',
      });
      setNotice(`Link OLT "${deleteOltTarget.name}" berhasil dihapus.`);
      setDeleteOltTarget(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Gagal menghapus link OLT.');
      setDeleteOltTarget(null);
    } finally {
      setDeletingOlt(false);
    }
  }

  function handleQuickPingOlt(olt: OltLink) {
    const host = extractHostFromUrl(olt.http_url);
    if (!host) return;
    if (user.role === 'admin') {
      setSelectedBranchId(olt.branch_id);
    }
    setTarget(host);
    pingSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-slate-900">
            Cek Jaringan, OLT &amp; Uji Ping
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            {user.role === 'admin'
              ? 'Pantau status MikroTik, akses web HTTP perangkat OLT, dan jalankan uji ping ke tujuan per cabang.'
              : 'Pantau status MikroTik cabang Anda, buka halaman web HTTP OLT, dan uji ping ke tujuan tertentu.'}
          </p>
        </div>

        <button
          type="button"
          onClick={loadStatus}
          disabled={loading}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-sm font-medium text-slate-700 whitespace-nowrap cursor-pointer disabled:opacity-60"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          <span>Perbarui Status</span>
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-emerald-700 hover:text-emerald-900 cursor-pointer"
            aria-label="Tutup pemberitahuan"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Status per cabang */}
      <section className="bg-white border border-slate-200/85 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200/80">
          <h3 className="font-display text-base font-semibold text-slate-900">Status MikroTik &amp; PPPoE</h3>
        </div>
        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        ) : branches.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Belum ada cabang yang dapat diperiksa.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 px-6">Cabang</th>
                  <th className="py-3 px-4">Alamat Router</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Uptime / CPU</th>
                  <th className="py-3 px-4 text-right">PPPoE Aktif</th>
                  <th className="py-3 px-6 text-right">PPPoE Nonaktif</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {branches.map((b) => (
                  <tr key={b.branchId} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-6 font-medium text-slate-900">{b.branchName}</td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600 tabular-nums">
                      {b.host}:{b.port} · {formatConnectionMode(b.connectionMode)}
                    </td>
                    <td className="py-3.5 px-4">
                      {b.online ? (
                        <span className="inline-flex items-center gap-1.5 font-medium text-emerald-700">
                          <Wifi className="w-4 h-4 shrink-0" />
                          <span>Online</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 font-medium text-red-600">
                          <WifiOff className="w-4 h-4 shrink-0" />
                          <span>Offline</span>
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-xs text-slate-600 tabular-nums">
                      {b.online ? `${b.uptime || '-'} · CPU ${b.cpuLoad || '-'}` : b.error || 'Tidak terjangkau'}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-medium text-emerald-700 tabular-nums">
                      {b.activeCount}
                    </td>
                    <td className="py-3.5 px-6 text-right font-mono font-medium text-amber-700 tabular-nums">
                      {b.inactiveCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bagian OLT — Link HTTP menuju OLT */}
      <section className="bg-white border border-slate-200/85 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">Perangkat OLT (Link HTTP)</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Akses cepat halaman web manajemen HTTP perangkat OLT per cabang atau uji koneksi ping ke IP OLT.
            </p>
          </div>

          {user.role === 'admin' && branches.length > 0 && (
            <button
              type="button"
              onClick={openAddOltModal}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Tambah Link OLT</span>
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
            <div className="h-10 bg-slate-100 rounded-lg animate-pulse" />
          </div>
        ) : olts.length === 0 ? (
          <div className="p-8 text-center">
            <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center mx-auto mb-3">
              <Router className="w-5 h-5" />
            </div>
            <p className="text-sm font-medium text-slate-900">Belum ada link HTTP OLT tersimpan</p>
            <p className="text-xs text-slate-500 mt-1 max-w-md mx-auto">
              {user.role === 'admin'
                ? 'Tambahkan alamat HTTP manajemen OLT (misalnya http://192.168.10.2 atau http://10.10.1.2:8080) agar teknisi dapat langsung membukanya dari menu ini.'
                : 'Belum ada perangkat OLT yang didaftarkan oleh administrator untuk cabang Anda.'}
            </p>
            {user.role === 'admin' && branches.length > 0 && (
              <button
                type="button"
                onClick={openAddOltModal}
                className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah Link OLT Pertama</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-xs font-medium text-slate-500">
                  <th className="py-3 px-6">Nama OLT</th>
                  <th className="py-3 px-4">Cabang</th>
                  <th className="py-3 px-4">Link HTTP OLT</th>
                  <th className="py-3 px-4">Keterangan</th>
                  <th className="py-3 px-6 text-right">Aksi</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {olts.map((olt) => (
                  <tr key={olt.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="py-3.5 px-6 font-medium text-slate-900 whitespace-nowrap">
                      {olt.name}
                    </td>
                    <td className="py-3.5 px-4 text-slate-600 whitespace-nowrap">
                      {olt.branch_name}
                    </td>
                    <td className="py-3.5 px-4">
                      <a
                        href={olt.http_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-mono text-xs text-blue-600 hover:text-blue-700 hover:underline whitespace-nowrap"
                      >
                        <Globe className="w-3.5 h-3.5 shrink-0" />
                        <span>{olt.http_url}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    </td>
                    <td className="py-3.5 px-4 text-xs text-slate-500">
                      {olt.notes || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="py-3.5 px-6 text-right">
                      <div className="inline-flex items-center justify-end gap-2">
                        <a
                          href={olt.http_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium whitespace-nowrap"
                        >
                          <span>Buka OLT</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                        <button
                          type="button"
                          onClick={() => handleQuickPingOlt(olt)}
                          title={`Isi target ping dengan IP/Host ${extractHostFromUrl(olt.http_url)}`}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 text-xs font-medium whitespace-nowrap cursor-pointer"
                        >
                          <Activity className="w-3.5 h-3.5" />
                          <span>Ping IP</span>
                        </button>
                        {user.role === 'admin' && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEditOltModal(olt)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 text-xs font-medium whitespace-nowrap cursor-pointer"
                              aria-label={`Edit OLT ${olt.name}`}
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteOltTarget(olt)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs font-medium whitespace-nowrap cursor-pointer"
                              aria-label={`Hapus OLT ${olt.name}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tool Cek Ping dari MikroTik */}
      {branches.length > 0 && (
        <section
          ref={pingSectionRef}
          className="bg-white border border-slate-200/85 rounded-xl shadow-[0_1px_2px_rgba(15,23,42,0.03)] p-6 space-y-5"
        >
          <div>
            <h3 className="font-display text-base font-semibold text-slate-900">Uji Ping dari Router MikroTik</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Mengirim paket ICMP Ping langsung dari router MikroTik cabang menuju IP atau host tujuan.
            </p>
          </div>

          <form onSubmit={handleRunPing} className="grid grid-cols-1 md:grid-cols-12 gap-4 items-end">
            {user.role === 'admin' ? (
              <div className="md:col-span-4">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Cabang Router</label>
                <select
                  value={selectedBranchId ?? ''}
                  onChange={(e) => setSelectedBranchId(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>
                      {b.branchName} ({b.online ? 'Online' : 'Offline'})
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="md:col-span-4">
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Cabang Router</label>
                <input
                  type="text"
                  readOnly
                  value={branches[0]?.branchName || user.branch_name || '-'}
                  className="w-full h-10 px-3 rounded-lg border border-slate-200 bg-slate-50 text-sm text-slate-700"
                />
              </div>
            )}

            <div className="md:col-span-4">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Alamat Tujuan (IP / Domain)</label>
              <input
                type="text"
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="8.8.8.8 atau 172.16.10.1"
                className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Jumlah Paket</label>
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value))}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-blue-600"
              >
                <option value={4}>4 paket</option>
                <option value={6}>6 paket</option>
                <option value={10}>10 paket</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={pinging}
                className="w-full h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap cursor-pointer"
              >
                <Activity className="w-4 h-4" />
                <span>{pinging ? 'Menguji...' : 'Jalankan Ping'}</span>
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>Tujuan cepat:</span>
            {['8.8.8.8', '1.1.1.1', 'google.com', '192.168.1.1'].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setTarget(preset)}
                className="px-2.5 py-1 rounded-md border border-slate-200 hover:bg-slate-50 font-mono text-slate-700 cursor-pointer"
              >
                {preset}
              </button>
            ))}
          </div>

          {pingError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {pingError}
            </div>
          )}

          {pingResult && (
            <div className="border-t border-slate-200 pt-5 space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/50">
                  <p className="text-xs text-slate-500">Terkirim / Diterima</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-slate-900 mt-1">
                    {pingResult.received} / {pingResult.sent}
                  </p>
                </div>
                <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/50">
                  <p className="text-xs text-slate-500">Packet Loss</p>
                  <p
                    className={`text-lg font-bold font-mono tabular-nums mt-1 ${
                      pingResult.packetLossPct === 0 ? 'text-emerald-700' : 'text-red-600'
                    }`}
                  >
                    {pingResult.packetLossPct}%
                  </p>
                </div>
                <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/50">
                  <p className="text-xs text-slate-500">Rata-rata RTT</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-slate-900 mt-1">
                    {pingResult.avgRttMs !== null ? `${pingResult.avgRttMs} ms` : '—'}
                  </p>
                </div>
                <div className="p-3.5 rounded-lg border border-slate-200 bg-slate-50/50">
                  <p className="text-xs text-slate-500">Min / Max RTT</p>
                  <p className="text-lg font-bold font-mono tabular-nums text-slate-900 mt-1">
                    {pingResult.minRttMs !== null && pingResult.maxRttMs !== null
                      ? `${pingResult.minRttMs} / ${pingResult.maxRttMs} ms`
                      : '—'}
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                      <th className="py-2.5 px-4">Seq</th>
                      <th className="py-2.5 px-4">Host</th>
                      <th className="py-2.5 px-4 text-right">Size</th>
                      <th className="py-2.5 px-4 text-right">TTL</th>
                      <th className="py-2.5 px-4 text-right">Waktu</th>
                      <th className="py-2.5 px-4">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 font-mono text-xs tabular-nums">
                    {pingResult.packets.map((pkt) => (
                      <tr key={pkt.seq}>
                        <td className="py-2.5 px-4 text-slate-500">{pkt.seq}</td>
                        <td className="py-2.5 px-4 text-slate-900">{pkt.host}</td>
                        <td className="py-2.5 px-4 text-right text-slate-600">{pkt.size ?? '—'}</td>
                        <td className="py-2.5 px-4 text-right text-slate-600">{pkt.ttl ?? '—'}</td>
                        <td className="py-2.5 px-4 text-right text-slate-900 font-medium">
                          {pkt.timeMs !== null ? `${pkt.timeMs} ms` : '—'}
                        </td>
                        <td className="py-2.5 px-4">
                          <span
                            className={
                              pkt.timeMs !== null ? 'text-emerald-700 font-medium' : 'text-red-600 font-medium'
                            }
                          >
                            {pkt.timeMs !== null ? 'Diterima' : pkt.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}

      {/* MODAL TAMBAH / EDIT LINK OLT */}
      {showOltModal && user.role === 'admin' && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                {editingOlt ? 'Edit Link HTTP OLT' : 'Tambah Link HTTP OLT'}
              </h3>
              <button
                type="button"
                onClick={() => setShowOltModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg cursor-pointer"
                aria-label="Tutup modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveOlt} className="p-6 space-y-4">
              {oltError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
                  {oltError}
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Cabang</label>
                <select
                  required
                  value={oltBranchId}
                  onChange={(e) => setOltBranchId(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="" disabled>
                    Pilih cabang...
                  </option>
                  {branches.map((b) => (
                    <option key={b.branchId} value={b.branchId}>
                      {b.branchName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nama OLT</label>
                <input
                  type="text"
                  required
                  value={oltName}
                  onChange={(e) => setOltName(e.target.value)}
                  placeholder="Contoh: OLT Pusat - ZTE C320"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Link HTTP Menuju OLT
                </label>
                <input
                  type="text"
                  required
                  value={oltHttpUrl}
                  onChange={(e) => setOltHttpUrl(e.target.value)}
                  placeholder="http://192.168.10.2 atau http://10.10.1.2:8080"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Masukkan alamat IP/domain atau URL HTTP OLT (otomatis diawali <span className="font-mono">http://</span> bila belum diisi).
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Keterangan (Opsional)
                </label>
                <input
                  type="text"
                  value={oltNotes}
                  onChange={(e) => setOltNotes(e.target.value)}
                  placeholder="Contoh: EPON 8 Port · Rak Server Blok A"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowOltModal(false)}
                  className="h-10 px-4 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 text-sm font-medium cursor-pointer"
                >
                  Batal
                </button>
                <button
                  type="submit"
                  disabled={savingOlt}
                  className="h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium cursor-pointer disabled:opacity-60"
                >
                  {savingOlt ? 'Menyimpan...' : editingOlt ? 'Simpan Perubahan' : 'Simpan OLT'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL HAPUS OLT */}
      {deleteOltTarget && user.role === 'admin' && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">Hapus Link OLT</h3>
            <p className="text-sm text-slate-600">
              Link OLT <span className="font-semibold text-slate-900">{deleteOltTarget.name}</span>{' '}
              (<span className="font-mono text-xs">{deleteOltTarget.http_url}</span>) dari cabang{' '}
              <span className="font-medium text-slate-800">{deleteOltTarget.branch_name}</span> akan
              dihapus.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setDeleteOltTarget(null)}
                className="h-10 px-4 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 text-sm font-medium cursor-pointer"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteOlt}
                disabled={deletingOlt}
                className="h-10 px-4 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer disabled:opacity-60"
              >
                {deletingOlt ? 'Menghapus...' : 'Ya, Hapus'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
