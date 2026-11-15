import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  clearSessionCookie,
  createSessionToken,
  loadUserById,
  requireAdmin,
  requireAuth,
  setSessionCookie,
  type AuthedRequest,
} from './server/auth.ts';
import {
  currentPeriod,
  db,
  deleteCustomerContact,
  getAllowedPackageMap,
  getBillingSettings,
  getBranchWhatsAppMap,
  getPackagePriceMap,
  hashPassword,
  isPackageAllowed,
  normalizeOltHttpUrl,
  nowIso,
  recordAuditLog,
  seedSandboxEnvironment,
  setCustomerWhatsApp,
  setPackagePrices,
  setPackagesAllowed,
  syncPaidInvoicesToTransactions,
  updateBillingSettings,
  verifyPassword,
  type ConnectionMode,
  type DbAuditLog,
  type DbBranch,
  type DbOlt,
  type DbOltOnu,
  type DbUser,
  type OltConnectionMode,
  type OltOnuStatus,
  type OltPonType,
} from './server/db.ts';
import {
  generateInvoicesForBranch,
  restoreCustomerProfileIfEligible,
  runBillingAutomationCycle,
} from './server/billingAutomation.ts';
import {
  addBranchCustomer,
  addBranchProfile,
  deleteBranchCustomer,
  deleteBranchProfile,
  getBranchCustomers,
  getBranchProfiles,
  getBranchStatus,
  pingFromBranch,
  updateBranchCustomer,
  updateBranchProfile,
} from './server/mikrotik.ts';
import {
  buildPonPortSummaries,
  checkOltStatus,
  getOltOnus,
  probeOltConnectivity,
  rebootOltOnu,
  syncOltTelemetry,
} from './server/olt.ts';

const PORT = 3000;
const VALID_MODES = new Set<ConnectionMode>(['api', 'api-ssl', 'rest-http', 'rest-https', 'sandbox']);
const VALID_OLT_MODES = new Set<OltConnectionMode>(['telnet', 'ssh', 'snmp', 'web-http', 'sandbox']);
const VALID_PON_TYPES = new Set<OltPonType>(['GPON', 'EPON']);
const VALID_ONU_STATUSES = new Set<OltOnuStatus>([
  'online',
  'los',
  'dying_gasp',
  'offline',
  'unconfigured',
]);

function sanitizeBranch(b: DbBranch) {
  return {
    id: b.id,
    name: b.name,
    location: b.location,
    connection_mode: b.connection_mode,
    host: b.host,
    port: b.port,
    username: b.username,
    created_at: b.created_at,
  };
}

function getBranchForUser(req: AuthedRequest, branchId: number): DbBranch | null {
  const user = req.authUser;
  if (!user) return null;
  if (user.role === 'staff' && user.branch_id !== branchId) {
    return null;
  }
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) as DbBranch | undefined;
  return branch ?? null;
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // --- Auth Routes ---

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      res.status(400).json({ error: 'Username dan password wajib diisi.' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)')
      .get(username.trim()) as DbUser | undefined;

    if (!row || !verifyPassword(password, row.password_hash)) {
      res.status(401).json({ error: 'Username atau password salah.' });
      return;
    }
    if (row.is_active !== 1) {
      res.status(403).json({ error: 'Akun ini sedang dinonaktifkan oleh Admin.' });
      return;
    }

    const user = loadUserById(row.id);
    if (!user) {
      res.status(401).json({ error: 'Akun tidak valid.' });
      return;
    }

    const token = createSessionToken(user.id, user.role);
    setSessionCookie(req, res, token);
    res.json({ token, user });
  });

  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.authUser });
  });

  // --- Dashboard ---

  app.get('/api/dashboard', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    let branches: DbBranch[] = [];
    let logs: DbAuditLog[] = [];

    if (user.role === 'admin') {
      branches = db.prepare('SELECT * FROM branches ORDER BY id ASC').all() as DbBranch[];
      logs = db
        .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50')
        .all() as DbAuditLog[];
    } else {
      if (user.branch_id) {
        const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(user.branch_id) as
          | DbBranch
          | undefined;
        if (b) branches = [b];
        logs = db
          .prepare(
            "SELECT * FROM audit_logs WHERE user_role = 'staff' AND branch_id = ? ORDER BY id DESC LIMIT 50"
          )
          .all(user.branch_id) as DbAuditLog[];
      }
    }

    const branchStatuses = await Promise.all(branches.map((b) => getBranchStatus(b)));

    res.json({
      branches: branchStatuses,
      logs,
    });
  });

  // --- Branches (Cabang) ---

  app.get('/api/branches', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'admin') {
      const rows = db.prepare('SELECT * FROM branches ORDER BY id ASC').all() as DbBranch[];
      res.json({ branches: rows.map(sanitizeBranch) });
      return;
    }
    if (!user.branch_id) {
      res.json({ branches: [] });
      return;
    }
    const row = db.prepare('SELECT * FROM branches WHERE id = ?').get(user.branch_id) as
      | DbBranch
      | undefined;
    res.json({ branches: row ? [sanitizeBranch(row)] : [] });
  });

  app.post('/api/branches/test', requireAuth, requireAdmin, async (req, res) => {
    const { connection_mode, host, port, username, password } = req.body as {
      connection_mode?: ConnectionMode;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
    };

    if (!connection_mode || !VALID_MODES.has(connection_mode) || !host) {
      res.status(400).json({ error: 'Host dan metode koneksi wajib diisi.' });
      return;
    }

    const tempBranch: DbBranch = {
      id: 0,
      name: 'Uji Koneksi',
      location: '-',
      connection_mode,
      host: host.trim(),
      port: Number(port) || 8728,
      username: (username || '').trim(),
      password: password || '',
      created_at: nowIso(),
    };

    const status = await getBranchStatus(tempBranch);
    res.json(status);
  });

  app.post('/api/branches/seed-sandbox', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const result = seedSandboxEnvironment(req.authUser!);
    res.json(result);
  });

  app.post('/api/branches', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { name, location, connection_mode, host, port, username, password } = req.body as {
      name?: string;
      location?: string;
      connection_mode?: ConnectionMode;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
    };

    if (!name?.trim() || !location?.trim() || !host?.trim()) {
      res.status(400).json({ error: 'Nama cabang, lokasi, dan host MikroTik wajib diisi.' });
      return;
    }
    const mode: ConnectionMode =
      connection_mode && VALID_MODES.has(connection_mode) ? connection_mode : 'api';

    if (mode !== 'sandbox' && !username?.trim()) {
      res.status(400).json({ error: 'Username API MikroTik wajib diisi.' });
      return;
    }

    const defaultPort =
      mode === 'api-ssl'
        ? 8729
        : mode === 'rest-http'
          ? 80
          : mode === 'rest-https'
            ? 443
            : 8728;

    const resolvedPort = Number(port) > 0 ? Number(port) : defaultPort;

    const info = db
      .prepare(
        `INSERT INTO branches (name, location, connection_mode, host, port, username, password, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        name.trim(),
        location.trim(),
        mode,
        host.trim(),
        resolvedPort,
        (username || 'sandbox').trim(),
        password || '',
        nowIso()
      );

    const newId = Number(info.lastInsertRowid);
    if (mode === 'sandbox') {
      const insertProf = db.prepare('INSERT INTO sandbox_profiles (branch_id, name) VALUES (?, ?)');
      for (const p of ['10Mbps-Rumahan', '20Mbps-Keluarga', '35Mbps-Bisnis', 'default']) {
        insertProf.run(newId, p);
      }
    }

    const created = db.prepare('SELECT * FROM branches WHERE id = ?').get(newId) as DbBranch;

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: newId,
      branchName: created.name,
      action: 'TAMBAH_CABANG',
      target: created.name,
      details: `Menambahkan cabang ${created.name} (${created.host}:${created.port} · ${created.connection_mode}).`,
    });

    res.status(201).json({ branch: sanitizeBranch(created) });
  });

  app.delete('/api/branches/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(id) as DbBranch | undefined;
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    db.prepare('DELETE FROM branches WHERE id = ?').run(id);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: null,
      branchName: branch.name,
      action: 'HAPUS_CABANG',
      target: branch.name,
      details: `Menghapus cabang ${branch.name} (${branch.host}).`,
    });

    res.json({ ok: true });
  });

  // --- Pelanggan (PPPoE Secrets) ---

  app.get('/api/branches/:id/customers', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const data = await getBranchCustomers(branch);
    const allowedMap = getAllowedPackageMap(branch.id);
    const waMap = getBranchWhatsAppMap(branch.id);
    const allowedProfiles = data.profiles.filter((name) =>
      allowedMap.has(name) ? allowedMap.get(name)! : true
    );
    const customersWithContacts = data.customers.map((c) => ({
      ...c,
      whatsappNumber: waMap.get(c.name) || '',
    }));

    res.json({
      branch: sanitizeBranch(branch),
      ...data,
      customers: customersWithContacts,
      profiles: allowedProfiles,
    });
  });

  app.post('/api/branches/:id/customers', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { name, service, profile, wifiName, wifiPassword, whatsappNumber } = req.body as {
      name?: string;
      service?: string;
      profile?: string;
      wifiName?: string;
      wifiPassword?: string;
      whatsappNumber?: string;
    };

    if (!name?.trim() || !profile?.trim()) {
      res.status(400).json({ error: 'Nama user PPPoE dan profile wajib diisi.' });
      return;
    }

    if (!isPackageAllowed(branch.id, profile.trim())) {
      res.status(400).json({
        error: `Paket "${profile.trim()}" tidak diizinkan untuk digunakan pada cabang ini.`,
      });
      return;
    }

    // Sesuai catatan user: PASSWORD di buat fix menjadi Infinix1, service pppoe
    const fixedPassword = 'Infinix1';
    const fixedService = service?.trim() || 'pppoe';

    try {
      await addBranchCustomer(branch, {
        name: name.trim(),
        password: fixedPassword,
        service: fixedService,
        profile: profile.trim(),
        wifiName: (wifiName || '').trim(),
        wifiPassword: (wifiPassword || '').trim(),
      });

      const savedWa = whatsappNumber?.trim()
        ? setCustomerWhatsApp(branch.id, name.trim(), whatsappNumber)
        : '';

      const wifiNote = wifiName?.trim() ? `, WiFi: ${wifiName.trim()}` : '';
      const waNote = savedWa ? `, WA: ${savedWa}` : '';

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
        branchId: branch.id,
        branchName: branch.name,
        action: 'TAMBAH_PELANGGAN',
        target: name.trim(),
        details: `Menambah PPPoE secret "${name.trim()}" (service: ${fixedService}, profile: ${profile.trim()}, password: Infinix1${wifiNote}${waNote}).`,
      });

      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal menambah secret PPPoE ke MikroTik.',
      });
    }
  });

  app.put('/api/branches/:id/customers/:secretId', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const secretId = decodeURIComponent(req.params.secretId);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { name, oldName, password, service, profile, wifiName, wifiPassword, whatsappNumber } =
      req.body as {
        name?: string;
        oldName?: string;
        password?: string;
        service?: string;
        profile?: string;
        wifiName?: string;
        wifiPassword?: string;
        whatsappNumber?: string;
      };

    if (!name?.trim() || !password?.trim() || !service?.trim() || !profile?.trim()) {
      res.status(400).json({ error: 'Keempat kolom (Name, Password, Service, Profile) wajib diisi.' });
      return;
    }

    if (!isPackageAllowed(branch.id, profile.trim())) {
      res.status(400).json({
        error: `Paket "${profile.trim()}" tidak diizinkan untuk digunakan. Pilih paket yang diizinkan.`,
      });
      return;
    }

    try {
      const { removedActiveCount } = await updateBranchCustomer(branch, secretId, {
        name: name.trim(),
        password: password.trim(),
        service: service.trim(),
        profile: profile.trim(),
        wifiName: (wifiName || '').trim(),
        wifiPassword: (wifiPassword || '').trim(),
      });

      if (whatsappNumber !== undefined) {
        setCustomerWhatsApp(branch.id, name.trim(), whatsappNumber, oldName);
      }

      const activeNote =
        removedActiveCount > 0
          ? ` (${removedActiveCount} active connection di-remove)`
          : '';
      const wifiNote = wifiName?.trim() ? `, WiFi: ${wifiName.trim()}` : '';

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
        branchId: branch.id,
        branchName: branch.name,
        action: 'EDIT_PELANGGAN',
        target: name.trim(),
        details: `Mengubah PPPoE secret "${name.trim()}" (service: ${service.trim()}, profile: ${profile.trim()}${wifiNote})${activeNote}.`,
      });

      res.json({ ok: true, removedActiveCount });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal mengubah secret PPPoE di MikroTik.',
      });
    }
  });

  app.put('/api/branches/:id/customers-whatsapp', requireAuth, (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { customerName, whatsappNumber } = req.body as {
      customerName?: string;
      whatsappNumber?: string;
    };

    if (!customerName?.trim()) {
      res.status(400).json({ error: 'Nama pelanggan wajib diisi.' });
      return;
    }

    const saved = setCustomerWhatsApp(branch.id, customerName.trim(), whatsappNumber || '');

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'ATUR_WA_PELANGGAN',
      target: customerName.trim(),
      details: saved
        ? `Memperbarui nomor WhatsApp pelanggan "${customerName.trim()}" (${saved}).`
        : `Menghapus nomor WhatsApp pelanggan "${customerName.trim()}".`,
    });

    res.json({ ok: true, whatsappNumber: saved });
  });

  app.delete(
    '/api/branches/:id/customers/:secretId',
    requireAuth,
    requireAdmin,
    async (req: AuthedRequest, res) => {
      const branchId = Number(req.params.id);
      const secretId = decodeURIComponent(req.params.secretId);
      const branch = getBranchForUser(req, branchId);
      if (!branch) {
        res.status(404).json({ error: 'Cabang tidak ditemukan.' });
        return;
      }

      const targetName = (req.query.name as string) || secretId;

      try {
        await deleteBranchCustomer(branch, secretId);
        deleteCustomerContact(branch.id, targetName);

        recordAuditLog({
          userId: req.authUser!.id,
          username: req.authUser!.username,
          userFullName: req.authUser!.full_name,
          userRole: req.authUser!.role,
          branchId: branch.id,
          branchName: branch.name,
          action: 'HAPUS_PELANGGAN',
          target: targetName,
          details: `Menghapus PPPoE secret "${targetName}" dari cabang ${branch.name}.`,
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Gagal menghapus secret PPPoE dari MikroTik.',
        });
      }
    }
  );

  // Sandbox connection state toggle for easy testing of active/inactive status
  app.post('/api/branches/:id/sandbox/toggle-active', requireAuth, (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch || branch.connection_mode !== 'sandbox') {
      res.status(400).json({ error: 'Fitur ini hanya berlaku untuk cabang mode Sandbox.' });
      return;
    }
    const { secretId } = req.body as { secretId?: string };
    const row = db
      .prepare('SELECT * FROM sandbox_secrets WHERE id = ? AND branch_id = ?')
      .get(Number(secretId), branchId) as { id: number; is_online: number } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Pelanggan tidak ditemukan.' });
      return;
    }
    const nextOnline = row.is_online === 1 ? 0 : 1;
    db.prepare(
      `UPDATE sandbox_secrets
       SET is_online = ?,
           active_address = CASE WHEN ? = 1 THEN COALESCE(active_address, '172.16.' || branch_id || '.' || (10 + (id % 200))) ELSE NULL END,
           uptime = CASE WHEN ? = 1 THEN COALESCE(uptime, '00:05:12') ELSE NULL END
       WHERE id = ?`
    ).run(nextOnline, nextOnline, nextOnline, row.id);
    res.json({ ok: true, is_online: nextOnline === 1 });
  });

  // --- Paket Internet (PPPoE Profiles) ---

  app.get('/api/branches/:id/packages', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const data = await getBranchProfiles(branch);
    const allowedMap = getAllowedPackageMap(branch.id);
    const packages = data.packages.map((pkg) => ({
      ...pkg,
      allowed: allowedMap.has(pkg.name) ? allowedMap.get(pkg.name)! : true,
    }));

    res.json({
      branch: sanitizeBranch(branch),
      ...data,
      packages,
    });
  });

  app.put(
    '/api/branches/:id/packages/allowed',
    requireAuth,
    requireAdmin,
    (req: AuthedRequest, res) => {
      const branchId = Number(req.params.id);
      const branch = getBranchForUser(req, branchId);
      if (!branch) {
        res.status(404).json({ error: 'Cabang tidak ditemukan.' });
        return;
      }

      const body = req.body as {
        profileName?: string;
        allowed?: boolean;
        items?: Array<{ profileName: string; allowed: boolean }>;
      };

      const items: Array<{ profileName: string; allowed: boolean }> = Array.isArray(body.items)
        ? body.items
            .filter((i) => typeof i.profileName === 'string' && i.profileName.trim().length > 0)
            .map((i) => ({ profileName: i.profileName.trim(), allowed: Boolean(i.allowed) }))
        : body.profileName?.trim()
          ? [{ profileName: body.profileName.trim(), allowed: Boolean(body.allowed) }]
          : [];

      if (items.length === 0) {
        res.status(400).json({ error: 'Daftar pilihan paket wajib diisi.' });
        return;
      }

      setPackagesAllowed(branch.id, items);

      const summaryTarget =
        items.length === 1 ? items[0].profileName : `${items.length} paket internet`;
      const summaryDetail =
        items.length === 1
          ? `Mengatur paket "${items[0].profileName}" menjadi ${items[0].allowed ? 'boleh digunakan' : 'tidak diizinkan'}.`
          : `Memperbarui izin penggunaan untuk ${items.length} paket internet di cabang ${branch.name}.`;

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
        branchId: branch.id,
        branchName: branch.name,
        action: 'ATUR_PAKET_DIIZINKAN',
        target: summaryTarget,
        details: summaryDetail,
      });

      res.json({ ok: true });
    }
  );

  app.post('/api/branches/:id/packages', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    const { name, localAddress, remoteAddress, rateLimit, dnsServer, onlyOne, parentQueue } = req.body as {
      name?: string;
      localAddress?: string;
      remoteAddress?: string;
      rateLimit?: string;
      dnsServer?: string;
      onlyOne?: string;
      parentQueue?: string;
    };

    if (!name?.trim()) {
      res.status(400).json({ error: 'Nama paket internet wajib diisi.' });
      return;
    }

    try {
      await addBranchProfile(branch, {
        name: name.trim(),
        localAddress: (localAddress || '').trim(),
        remoteAddress: (remoteAddress || '').trim(),
        rateLimit: (rateLimit || '').trim(),
        dnsServer: (dnsServer || '').trim(),
        onlyOne: (onlyOne || 'yes').trim(),
        parentQueue: (parentQueue || '').trim(),
      });

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
        branchId: branch.id,
        branchName: branch.name,
        action: 'TAMBAH_PAKET',
        target: name.trim(),
        details: `Menambah paket internet "${name.trim()}" (rate-limit: ${rateLimit?.trim() || 'unlimited'}).`,
      });

      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal menambah paket internet ke MikroTik.',
      });
    }
  });

  app.put(
    '/api/branches/:id/packages/:profileId',
    requireAuth,
    requireAdmin,
    async (req: AuthedRequest, res) => {
      const branchId = Number(req.params.id);
      const profileId = decodeURIComponent(req.params.profileId);
      const branch = getBranchForUser(req, branchId);
      if (!branch) {
        res.status(404).json({ error: 'Cabang tidak ditemukan.' });
        return;
      }

      const { name, localAddress, remoteAddress, rateLimit, dnsServer, onlyOne, parentQueue } = req.body as {
        name?: string;
        localAddress?: string;
        remoteAddress?: string;
        rateLimit?: string;
        dnsServer?: string;
        onlyOne?: string;
        parentQueue?: string;
      };

      if (!name?.trim()) {
        res.status(400).json({ error: 'Nama paket internet wajib diisi.' });
        return;
      }

      try {
        await updateBranchProfile(branch, profileId, {
          name: name.trim(),
          localAddress: (localAddress || '').trim(),
          remoteAddress: (remoteAddress || '').trim(),
          rateLimit: (rateLimit || '').trim(),
          dnsServer: (dnsServer || '').trim(),
          onlyOne: (onlyOne || 'default').trim(),
          parentQueue: (parentQueue || '').trim(),
        });

        recordAuditLog({
          userId: req.authUser!.id,
          username: req.authUser!.username,
          userFullName: req.authUser!.full_name,
          userRole: req.authUser!.role,
          branchId: branch.id,
          branchName: branch.name,
          action: 'EDIT_PAKET',
          target: name.trim(),
          details: `Mengubah paket internet "${name.trim()}" (rate-limit: ${rateLimit?.trim() || 'unlimited'}).`,
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Gagal mengubah paket internet di MikroTik.',
        });
      }
    }
  );

  app.delete(
    '/api/branches/:id/packages/:profileId',
    requireAuth,
    requireAdmin,
    async (req: AuthedRequest, res) => {
      const branchId = Number(req.params.id);
      const profileId = decodeURIComponent(req.params.profileId);
      const branch = getBranchForUser(req, branchId);
      if (!branch) {
        res.status(404).json({ error: 'Cabang tidak ditemukan.' });
        return;
      }

      const targetName = (req.query.name as string) || profileId;

      try {
        await deleteBranchProfile(branch, profileId);

        recordAuditLog({
          userId: req.authUser!.id,
          username: req.authUser!.username,
          userFullName: req.authUser!.full_name,
          userRole: req.authUser!.role,
          branchId: branch.id,
          branchName: branch.name,
          action: 'HAPUS_PAKET',
          target: targetName,
          details: `Menghapus paket internet "${targetName}" dari cabang ${branch.name}.`,
        });

        res.json({ ok: true });
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Gagal menghapus paket internet dari MikroTik.',
        });
      }
    }
  );

  // --- Cek Jaringan & Ping ---

  app.get('/api/network-check', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    let branches: DbBranch[] = [];
    if (user.role === 'admin') {
      branches = db.prepare('SELECT * FROM branches ORDER BY id ASC').all() as DbBranch[];
    } else if (user.branch_id) {
      const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(user.branch_id) as
        | DbBranch
        | undefined;
      if (b) branches = [b];
    }

    const statuses = await Promise.all(branches.map((b) => getBranchStatus(b)));
    res.json({ branches: statuses });
  });

  app.post('/api/branches/:id/ping', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { target, count } = req.body as { target?: string; count?: number };
    if (!target?.trim()) {
      res.status(400).json({ error: 'Alamat tujuan ping (IP/domain) wajib diisi.' });
      return;
    }

    try {
      const result = await pingFromBranch(branch, target.trim(), Number(count) || 4);
      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
        branchId: branch.id,
        branchName: branch.name,
        action: 'CEK_PING',
        target: target.trim(),
        details: `Cek ping ke ${target.trim()} (${result.received}/${result.sent} diterima, avg ${result.avgRttMs ?? '-'} ms).`,
      });
      res.json({ result });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal menjalankan ping pada MikroTik.',
      });
    }
  });

  // --- Link HTTP OLT per Cabang ---

  app.get('/api/olt-links', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'admin') {
      const rows = db
        .prepare(
          `SELECT o.*, b.name AS branch_name
           FROM olt_links o
           JOIN branches b ON b.id = o.branch_id
           ORDER BY b.id ASC, o.id ASC`
        )
        .all();
      res.json({ olts: rows });
      return;
    }

    if (!user.branch_id) {
      res.json({ olts: [] });
      return;
    }

    const rows = db
      .prepare(
        `SELECT o.*, b.name AS branch_name
         FROM olt_links o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.branch_id = ?
         ORDER BY o.id ASC`
      )
      .all(user.branch_id);
    res.json({ olts: rows });
  });

  app.post('/api/olt-links', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { branch_id, name, http_url, notes } = req.body as {
      branch_id?: number;
      name?: string;
      http_url?: string;
      notes?: string;
    };

    const branchId = Number(branch_id);
    if (!branchId) {
      res.status(400).json({ error: 'Cabang wajib dipilih.' });
      return;
    }
    const branch = db
      .prepare('SELECT id, name FROM branches WHERE id = ?')
      .get(branchId) as { id: number; name: string } | undefined;
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Nama OLT wajib diisi.' });
      return;
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeOltHttpUrl(http_url || '');
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Format link HTTP OLT tidak valid.',
      });
      return;
    }

    const now = nowIso();
    const result = db
      .prepare(
        `INSERT INTO olt_links (branch_id, name, http_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(branch.id, name.trim(), normalizedUrl, (notes || '').trim(), now, now);

    const created = db
      .prepare(
        `SELECT o.*, b.name AS branch_name
         FROM olt_links o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ?`
      )
      .get(Number(result.lastInsertRowid));

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'TAMBAH_OLT',
      target: name.trim(),
      details: `Menambahkan link OLT ${name.trim()} (${normalizedUrl}) di ${branch.name}.`,
    });

    res.status(201).json({ olt: created });
  });

  app.put('/api/olt-links/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const existing = db
      .prepare('SELECT * FROM olt_links WHERE id = ?')
      .get(oltId) as
      | { id: number; branch_id: number; name: string; http_url: string; notes: string }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Data OLT tidak ditemukan.' });
      return;
    }

    const { branch_id, name, http_url, notes } = req.body as {
      branch_id?: number;
      name?: string;
      http_url?: string;
      notes?: string;
    };

    const branchId = Number(branch_id) || existing.branch_id;
    const branch = db
      .prepare('SELECT id, name FROM branches WHERE id = ?')
      .get(branchId) as { id: number; name: string } | undefined;
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Nama OLT wajib diisi.' });
      return;
    }

    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeOltHttpUrl(http_url || '');
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Format link HTTP OLT tidak valid.',
      });
      return;
    }

    db.prepare(
      `UPDATE olt_links
       SET branch_id = ?, name = ?, http_url = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(branch.id, name.trim(), normalizedUrl, (notes || '').trim(), nowIso(), oltId);

    const updated = db
      .prepare(
        `SELECT o.*, b.name AS branch_name
         FROM olt_links o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ?`
      )
      .get(oltId);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'EDIT_OLT',
      target: name.trim(),
      details: `Memperbarui link OLT ${name.trim()} (${normalizedUrl}) di ${branch.name}.`,
    });

    res.json({ olt: updated });
  });

  app.delete('/api/olt-links/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const existing = db
      .prepare(
        `SELECT o.id, o.branch_id, o.name, o.http_url, b.name AS branch_name
         FROM olt_links o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ?`
      )
      .get(oltId) as
      | { id: number; branch_id: number; name: string; http_url: string; branch_name: string }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Data OLT tidak ditemukan.' });
      return;
    }

    db.prepare('DELETE FROM olt_links WHERE id = ?').run(oltId);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: existing.branch_id,
      branchName: existing.branch_name,
      action: 'HAPUS_OLT',
      target: existing.name,
      details: `Menghapus link OLT ${existing.name} (${existing.http_url}) dari ${existing.branch_name}.`,
    });

    res.json({ ok: true });
  });

  // --- Manajemen OLT & ONU ---

  const DEFAULT_OLT_PORT_BY_MODE: Record<OltConnectionMode, number> = {
    telnet: 23,
    ssh: 22,
    snmp: 161,
    'web-http': 80,
    sandbox: 23,
  };

  app.get('/api/olts', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const branchIdParam = String(req.query.branchId || 'all');

    let rows: (DbOlt & { branch_name: string })[] = [];
    if (user.role === 'staff') {
      if (!user.branch_id) {
        res.json({ olts: [] });
        return;
      }
      rows = db
        .prepare(
          `SELECT o.*, b.name AS branch_name
           FROM olts o
           JOIN branches b ON b.id = o.branch_id
           WHERE o.branch_id = ?
           ORDER BY o.id ASC`
        )
        .all(user.branch_id) as (DbOlt & { branch_name: string })[];
    } else if (branchIdParam !== 'all' && Number(branchIdParam) > 0) {
      rows = db
        .prepare(
          `SELECT o.*, b.name AS branch_name
           FROM olts o
           JOIN branches b ON b.id = o.branch_id
           WHERE o.branch_id = ?
           ORDER BY o.id ASC`
        )
        .all(Number(branchIdParam)) as (DbOlt & { branch_name: string })[];
    } else {
      rows = db
        .prepare(
          `SELECT o.*, b.name AS branch_name
           FROM olts o
           JOIN branches b ON b.id = o.branch_id
           ORDER BY o.id ASC`
        )
        .all() as (DbOlt & { branch_name: string })[];
    }

    const olts = await Promise.all(rows.map((row) => checkOltStatus(row)));
    res.json({ olts });
  });

  app.post('/api/olts/seed-sandbox', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const branches = db.prepare('SELECT * FROM branches ORDER BY id ASC').all() as DbBranch[];
    if (branches.length === 0) {
      res.json({ oltsCreated: 0, onusCreated: 0 });
      return;
    }

    const now = nowIso();
    let oltsCreated = 0;
    let onusCreated = 0;

    for (const branch of branches) {
      const existingOlt = db
        .prepare('SELECT id FROM olts WHERE branch_id = ? LIMIT 1')
        .get(branch.id) as { id: number } | undefined;
      if (existingOlt) continue;

      const isGpon = branch.id % 2 === 1;
      const ponType: OltPonType = isGpon ? 'GPON' : 'EPON';
      const vendor = isGpon ? 'ZTE' : 'HSGQ';
      const model = isGpon ? 'ZXA10 C320' : 'E08-8PON';
      const host = `10.10.${branch.id}.250`;

      const oltRes = db
        .prepare(
          `INSERT INTO olts
            (branch_id, name, vendor, model, pon_type, connection_mode, host, port, username, password, snmp_community, total_pon_ports, uplink_info, notes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'sandbox', ?, 23, 'admin', 'admin', 'public', 8, '10G-SFP+1', ?, ?, ?)`
        )
        .run(
          branch.id,
          `OLT ${branch.name}`,
          vendor,
          model,
          ponType,
          host,
          'OLT Lab Sandbox untuk simulasi redaman optik dan manajemen ONU.',
          now,
          now
        );

      const oltId = Number(oltRes.lastInsertRowid);
      oltsCreated += 1;

      let customerNames: string[] = [];
      try {
        const custRes = await getBranchCustomers(branch);
        customerNames = custRes.customers.map((c) => c.name);
      } catch {
        customerNames = [];
      }

      const samplePorts = isGpon ? ['1/1/1', '1/1/1', '1/1/2', '1/1/2', '1/1/3'] : ['0/1', '0/1', '0/2', '0/2', '0/3'];
      const sampleStatuses: OltOnuStatus[] = ['online', 'online', 'online', 'los', 'unconfigured'];
      const sampleRx: (number | null)[] = [-18.4, -21.2, -26.8, null, null];
      const sampleDist: (number | null)[] = [420, 980, 2450, 1320, null];

      const insertOnu = db.prepare(
        `INSERT INTO olt_onus
          (olt_id, pon_port, onu_index, onu_name, customer_name, sn_mac, onu_type, status, rx_power_dbm, tx_power_dbm, olt_rx_power_dbm, temperature_c, distance_m, vlan_id, uptime, last_down_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2.1, -20.5, 41.2, ?, 100, ?, ?, ?)`
      );

      for (let idx = 0; idx < sampleStatuses.length; idx++) {
        const status = sampleStatuses[idx];
        const ponPort = samplePorts[idx];
        const onuIndex = status === 'unconfigured' ? 0 : (idx % 2) + 1;
        const linkedCustomer = status === 'unconfigured' ? '' : customerNames[idx] || '';
        const snMac = isGpon
          ? `ZTEG${String(branch.id).padStart(2, '0')}A1${String(idx + 1).padStart(4, '0')}`
          : `48:A9:8A:${String(branch.id).padStart(2, '0')}:10:${String(idx + 11).padStart(2, '0')}`;

        insertOnu.run(
          oltId,
          ponPort,
          onuIndex,
          status === 'unconfigured'
            ? `ONU Baru (${ponPort})`
            : linkedCustomer
              ? `ONT-${linkedCustomer}`
              : `Pelanggan-${branch.id}-${idx + 1}`,
          linkedCustomer,
          snMac,
          isGpon ? 'ZTE F609' : 'HSGQ X110',
          status,
          sampleRx[idx],
          sampleDist[idx],
          status === 'online' ? '12d 04:18:10' : '-',
          status === 'los' ? 'LOS (Kabel Putus)' : status === 'unconfigured' ? 'Menunggu Otorisasi' : '',
          now
        );
        onusCreated += 1;
      }
    }

    if (oltsCreated > 0) {
      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
        branchId: null,
        branchName: null,
        action: 'SEED_OLT_SANDBOX',
        target: `${oltsCreated} OLT`,
        details: `Memuat ${oltsCreated} OLT Lab Sandbox dan ${onusCreated} ONU contoh.`,
      });
    }

    res.json({ oltsCreated, onusCreated });
  });

  app.post('/api/olts/test', requireAuth, requireAdmin, async (req, res) => {
    const { connection_mode, host, port, snmp_community } = req.body as {
      connection_mode?: OltConnectionMode;
      host?: string;
      port?: number;
      snmp_community?: string;
    };

    const mode: OltConnectionMode =
      connection_mode && VALID_OLT_MODES.has(connection_mode) ? connection_mode : 'telnet';
    const trimmedHost = (host || '').trim() || (mode === 'sandbox' ? '10.10.1.250' : '');
    if (mode !== 'sandbox' && !trimmedHost) {
      res.status(400).json({ error: 'IP atau Host OLT wajib diisi.' });
      return;
    }

    const result = await probeOltConnectivity({
      connection_mode: mode,
      host: trimmedHost,
      port: Number(port) || DEFAULT_OLT_PORT_BY_MODE[mode],
      snmp_community: (snmp_community || 'public').trim() || 'public',
    });

    res.json({
      ok: result.ok,
      latencyMs: result.latencyMs,
      error: result.error,
      uptime: result.uptime ?? null,
      systemDescr: result.systemDescr ?? null,
    });
  });

  app.post('/api/olts', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const {
      branch_id,
      name,
      vendor,
      model,
      pon_type,
      connection_mode,
      host,
      port,
      username,
      password,
      snmp_community,
      total_pon_ports,
      uplink_info,
      notes,
    } = req.body as {
      branch_id?: number;
      name?: string;
      vendor?: string;
      model?: string;
      pon_type?: OltPonType;
      connection_mode?: OltConnectionMode;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      snmp_community?: string;
      total_pon_ports?: number;
      uplink_info?: string;
      notes?: string;
    };

    const branchId = Number(branch_id);
    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) as
      | DbBranch
      | undefined;
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Nama OLT wajib diisi.' });
      return;
    }

    const mode: OltConnectionMode =
      connection_mode && VALID_OLT_MODES.has(connection_mode) ? connection_mode : 'telnet';
    const resolvedPonType: OltPonType =
      pon_type && VALID_PON_TYPES.has(pon_type) ? pon_type : 'GPON';
    const resolvedHost = (host || '').trim() || (mode === 'sandbox' ? '10.10.1.250' : '');
    if (mode !== 'sandbox' && !resolvedHost) {
      res.status(400).json({ error: 'IP / Host OLT wajib diisi.' });
      return;
    }

    const resolvedPort = Number(port) || DEFAULT_OLT_PORT_BY_MODE[mode];
    const resolvedTotalPorts = Math.max(1, Math.min(32, Number(total_pon_ports) || 8));
    const now = nowIso();

    const insertRes = db
      .prepare(
        `INSERT INTO olts
          (branch_id, name, vendor, model, pon_type, connection_mode, host, port, username, password, snmp_community, total_pon_ports, uplink_info, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        branch.id,
        name.trim(),
        (vendor || 'ZTE').trim(),
        (model || '').trim(),
        resolvedPonType,
        mode,
        resolvedHost,
        resolvedPort,
        (username || '').trim(),
        password || '',
        (snmp_community || 'public').trim() || 'public',
        resolvedTotalPorts,
        (uplink_info || '').trim(),
        (notes || '').trim(),
        now,
        now
      );

    const created = db
      .prepare('SELECT * FROM olts WHERE id = ?')
      .get(insertRes.lastInsertRowid) as DbOlt;

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'TAMBAH_OLT',
      target: created.name,
      details: `Menambahkan perangkat OLT ${created.name} (${created.vendor} ${created.model || created.pon_type}) mode ${created.connection_mode} di ${branch.name}.`,
    });

    const status = await checkOltStatus({ ...created, branch_name: branch.name });
    res.status(201).json({ olt: status });
  });

  app.put('/api/olts/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as
      | DbOlt
      | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const {
      branch_id,
      name,
      vendor,
      model,
      pon_type,
      connection_mode,
      host,
      port,
      username,
      password,
      snmp_community,
      total_pon_ports,
      uplink_info,
      notes,
    } = req.body as {
      branch_id?: number;
      name?: string;
      vendor?: string;
      model?: string;
      pon_type?: OltPonType;
      connection_mode?: OltConnectionMode;
      host?: string;
      port?: number;
      username?: string;
      password?: string;
      snmp_community?: string;
      total_pon_ports?: number;
      uplink_info?: string;
      notes?: string;
    };

    const branchId = Number(branch_id) || existing.branch_id;
    const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(branchId) as
      | DbBranch
      | undefined;
    if (!branch) {
      res.status(404).json({ error: 'Cabang tidak ditemukan.' });
      return;
    }

    if (!name?.trim()) {
      res.status(400).json({ error: 'Nama OLT wajib diisi.' });
      return;
    }

    const mode: OltConnectionMode =
      connection_mode && VALID_OLT_MODES.has(connection_mode)
        ? connection_mode
        : existing.connection_mode;
    const resolvedPonType: OltPonType =
      pon_type && VALID_PON_TYPES.has(pon_type) ? pon_type : existing.pon_type;
    const resolvedHost = (host || '').trim() || (mode === 'sandbox' ? '10.10.1.250' : '');
    if (mode !== 'sandbox' && !resolvedHost) {
      res.status(400).json({ error: 'IP / Host OLT wajib diisi.' });
      return;
    }

    const resolvedPort = Number(port) || DEFAULT_OLT_PORT_BY_MODE[mode];
    const resolvedTotalPorts = Math.max(
      1,
      Math.min(32, Number(total_pon_ports) || existing.total_pon_ports || 8)
    );
    const resolvedPassword = password && password.length > 0 ? password : existing.password;

    db.prepare(
      `UPDATE olts
       SET branch_id = ?, name = ?, vendor = ?, model = ?, pon_type = ?, connection_mode = ?,
           host = ?, port = ?, username = ?, password = ?, snmp_community = ?,
           total_pon_ports = ?, uplink_info = ?, notes = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      branch.id,
      name.trim(),
      (vendor || existing.vendor).trim(),
      (model ?? existing.model).trim(),
      resolvedPonType,
      mode,
      resolvedHost,
      resolvedPort,
      (username ?? existing.username).trim(),
      resolvedPassword,
      (snmp_community || existing.snmp_community || 'public').trim() || 'public',
      resolvedTotalPorts,
      (uplink_info ?? existing.uplink_info).trim(),
      (notes ?? existing.notes).trim(),
      nowIso(),
      oltId
    );

    const updated = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt;

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'EDIT_OLT',
      target: updated.name,
      details: `Memperbarui konfigurasi OLT ${updated.name} (${updated.host}:${updated.port}) di ${branch.name}.`,
    });

    const status = await checkOltStatus({ ...updated, branch_name: branch.name });
    res.json({ olt: status });
  });

  app.delete('/api/olts/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const existing = db
      .prepare(
        `SELECT o.*, b.name AS branch_name
         FROM olts o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ?`
      )
      .get(oltId) as (DbOlt & { branch_name: string }) | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    db.prepare('DELETE FROM olt_onus WHERE olt_id = ?').run(oltId);
    db.prepare('DELETE FROM olts WHERE id = ?').run(oltId);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: existing.branch_id,
      branchName: existing.branch_name,
      action: 'HAPUS_OLT',
      target: existing.name,
      details: `Menghapus perangkat OLT ${existing.name} (${existing.host}) dari ${existing.branch_name}.`,
    });

    res.json({ ok: true });
  });

  app.get('/api/olts/:id/detail', requireAuth, async (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const olt = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, olt.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const status = await checkOltStatus({ ...olt, branch_name: branch.name });
    const onus = getOltOnus(olt.id);
    const ponPorts = buildPonPortSummaries(status, onus);

    let branchCustomers: string[] = [];
    try {
      const custRes = await getBranchCustomers(branch);
      branchCustomers = custRes.customers.map((c) => c.name).sort((a, b) => a.localeCompare(b));
    } catch {
      branchCustomers = [];
    }

    res.json({
      olt: status,
      onus,
      ponPorts,
      branchCustomers,
    });
  });

  app.post('/api/olts/:id/sync', requireAuth, async (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const olt = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, olt.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const synced = await syncOltTelemetry(olt);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'SINKRON_OLT',
      target: olt.name,
      details: `Sinkronisasi OLT ${olt.name}: ${synced.onus.length} ONU (${synced.status.onlineOnus} online).`,
    });

    res.json({
      olt: synced.status,
      onus: synced.onus,
      ponPorts: synced.ponPorts,
    });
  });

  app.post('/api/olts/:id/onus', requireAuth, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const olt = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, olt.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const {
      pon_port,
      onu_index,
      onu_name,
      customer_name,
      sn_mac,
      onu_type,
      vlan_id,
      status,
      rx_power_dbm,
      distance_m,
      last_down_reason,
    } = req.body as {
      pon_port?: string;
      onu_index?: number;
      onu_name?: string;
      customer_name?: string;
      sn_mac?: string;
      onu_type?: string;
      vlan_id?: number;
      status?: OltOnuStatus;
      rx_power_dbm?: number;
      distance_m?: number;
      last_down_reason?: string;
    };

    const resolvedPonPort = (pon_port || '').trim() || (olt.pon_type === 'GPON' ? '1/1/1' : '0/1');
    const resolvedSnMac = (sn_mac || '').trim().toUpperCase();
    if (!resolvedSnMac) {
      res.status(400).json({ error: 'Serial Number / MAC Address ONU wajib diisi.' });
      return;
    }

    const duplicate = db
      .prepare('SELECT id FROM olt_onus WHERE olt_id = ? AND UPPER(sn_mac) = ?')
      .get(olt.id, resolvedSnMac) as { id: number } | undefined;
    if (duplicate) {
      res.status(409).json({ error: `SN/MAC ${resolvedSnMac} sudah terdaftar pada OLT ini.` });
      return;
    }

    let resolvedIndex = Number(onu_index);
    if (!Number.isFinite(resolvedIndex) || resolvedIndex <= 0) {
      const maxRow = db
        .prepare('SELECT COALESCE(MAX(onu_index), 0) AS max_idx FROM olt_onus WHERE olt_id = ? AND pon_port = ?')
        .get(olt.id, resolvedPonPort) as { max_idx: number };
      resolvedIndex = (maxRow?.max_idx || 0) + 1;
    }

    const resolvedStatus: OltOnuStatus =
      status && VALID_ONU_STATUSES.has(status) ? status : 'online';
    const resolvedRx =
      rx_power_dbm !== undefined && rx_power_dbm !== null && Number.isFinite(Number(rx_power_dbm))
        ? Number(Number(rx_power_dbm).toFixed(2))
        : resolvedStatus === 'online' && olt.connection_mode === 'sandbox'
          ? -19.5
          : null;
    const resolvedDist =
      distance_m !== undefined && distance_m !== null && Number.isFinite(Number(distance_m))
        ? Math.max(0, Math.round(Number(distance_m)))
        : null;
    const resolvedName = (onu_name || '').trim() || `ONU-${resolvedPonPort}-${resolvedIndex}`;
    const now = nowIso();

    const insertRes = db
      .prepare(
        `INSERT INTO olt_onus
          (olt_id, pon_port, onu_index, onu_name, customer_name, sn_mac, onu_type, status, rx_power_dbm, tx_power_dbm, olt_rx_power_dbm, temperature_c, distance_m, vlan_id, uptime, last_down_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        olt.id,
        resolvedPonPort,
        resolvedIndex,
        resolvedName,
        (customer_name || '').trim(),
        resolvedSnMac,
        (onu_type || olt.pon_type).trim(),
        resolvedStatus,
        resolvedRx,
        resolvedDist,
        Number(vlan_id) || 100,
        resolvedStatus === 'online' ? '00:01:00' : '-',
        (last_down_reason || '').trim(),
        now
      );

    const created = db
      .prepare('SELECT * FROM olt_onus WHERE id = ?')
      .get(insertRes.lastInsertRowid) as DbOltOnu;

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'TAMBAH_ONU',
      target: `${created.onu_name} (${created.sn_mac})`,
      details: `Menambahkan ONU ${created.onu_name} di port ${created.pon_port}:${created.onu_index} pada ${olt.name}.`,
    });

    res.status(201).json({ onu: created });
  });

  app.put('/api/olts/:id/onus/:onuId', requireAuth, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const onuId = Number(req.params.onuId);

    const olt = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, olt.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const existing = db
      .prepare('SELECT * FROM olt_onus WHERE id = ? AND olt_id = ?')
      .get(onuId, oltId) as DbOltOnu | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Data ONU tidak ditemukan.' });
      return;
    }

    const {
      pon_port,
      onu_index,
      onu_name,
      customer_name,
      sn_mac,
      onu_type,
      vlan_id,
      status,
      rx_power_dbm,
      distance_m,
      last_down_reason,
    } = req.body as {
      pon_port?: string;
      onu_index?: number;
      onu_name?: string;
      customer_name?: string;
      sn_mac?: string;
      onu_type?: string;
      vlan_id?: number;
      status?: OltOnuStatus;
      rx_power_dbm?: number | null;
      distance_m?: number | null;
      last_down_reason?: string;
    };

    const resolvedPonPort = (pon_port || existing.pon_port).trim();
    const resolvedSnMac = (sn_mac || existing.sn_mac).trim().toUpperCase();
    if (!resolvedSnMac) {
      res.status(400).json({ error: 'Serial Number / MAC Address ONU wajib diisi.' });
      return;
    }

    const duplicate = db
      .prepare('SELECT id FROM olt_onus WHERE olt_id = ? AND UPPER(sn_mac) = ? AND id != ?')
      .get(oltId, resolvedSnMac, onuId) as { id: number } | undefined;
    if (duplicate) {
      res.status(409).json({ error: `SN/MAC ${resolvedSnMac} sudah digunakan ONU lain.` });
      return;
    }

    let resolvedIndex = Number(onu_index);
    if (!Number.isFinite(resolvedIndex) || resolvedIndex <= 0) {
      if (existing.onu_index > 0) {
        resolvedIndex = existing.onu_index;
      } else {
        const maxRow = db
          .prepare('SELECT COALESCE(MAX(onu_index), 0) AS max_idx FROM olt_onus WHERE olt_id = ? AND pon_port = ?')
          .get(oltId, resolvedPonPort) as { max_idx: number };
        resolvedIndex = (maxRow?.max_idx || 0) + 1;
      }
    }

    const resolvedStatus: OltOnuStatus =
      status && VALID_ONU_STATUSES.has(status) ? status : existing.status;
    const resolvedRx =
      rx_power_dbm !== undefined
        ? rx_power_dbm === null
          ? null
          : Number.isFinite(Number(rx_power_dbm))
            ? Number(Number(rx_power_dbm).toFixed(2))
            : existing.rx_power_dbm
        : resolvedStatus === 'online' && existing.rx_power_dbm === null && olt.connection_mode === 'sandbox'
          ? -19.5
          : existing.rx_power_dbm;
    const resolvedDist =
      distance_m !== undefined
        ? distance_m === null
          ? null
          : Number.isFinite(Number(distance_m))
            ? Math.max(0, Math.round(Number(distance_m)))
            : existing.distance_m
        : existing.distance_m;
    const resolvedName = (onu_name || existing.onu_name).trim() || `ONU-${resolvedPonPort}-${resolvedIndex}`;

    db.prepare(
      `UPDATE olt_onus
       SET pon_port = ?, onu_index = ?, onu_name = ?, customer_name = ?, sn_mac = ?,
           onu_type = ?, vlan_id = ?, status = ?, rx_power_dbm = ?, distance_m = ?,
           uptime = ?, last_down_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      resolvedPonPort,
      resolvedIndex,
      resolvedName,
      (customer_name ?? existing.customer_name).trim(),
      resolvedSnMac,
      (onu_type || existing.onu_type).trim(),
      Number(vlan_id) || existing.vlan_id || 100,
      resolvedStatus,
      resolvedRx,
      resolvedDist,
      resolvedStatus === 'online' ? (existing.uptime === '-' ? 'Aktif' : existing.uptime) : '-',
      (last_down_reason ?? (resolvedStatus === 'online' ? '' : existing.last_down_reason)).trim(),
      nowIso(),
      onuId
    );

    const updated = db.prepare('SELECT * FROM olt_onus WHERE id = ?').get(onuId) as DbOltOnu;

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'EDIT_ONU',
      target: `${updated.onu_name} (${updated.sn_mac})`,
      details: `Memperbarui ONU ${updated.onu_name} (${updated.pon_port}:${updated.onu_index}) pada ${olt.name}.`,
    });

    res.json({ onu: updated });
  });

  app.post('/api/olts/:id/onus/:onuId/reboot', requireAuth, async (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const onuId = Number(req.params.onuId);

    const olt = db.prepare('SELECT * FROM olts WHERE id = ?').get(oltId) as DbOlt | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, olt.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const onu = db
      .prepare('SELECT * FROM olt_onus WHERE id = ? AND olt_id = ?')
      .get(onuId, oltId) as DbOltOnu | undefined;
    if (!onu) {
      res.status(404).json({ error: 'Data ONU tidak ditemukan.' });
      return;
    }

    const outcome = await rebootOltOnu(olt, onu);
    if (!outcome.ok) {
      res.status(400).json({ error: outcome.error || 'Gagal mengirim perintah reboot ONU.' });
      return;
    }

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'REBOOT_ONU',
      target: `${onu.onu_name} (${onu.pon_port}:${onu.onu_index})`,
      details: `Mengirim perintah reboot ONU ${onu.onu_name} pada ${olt.name}.`,
    });

    res.json({ ok: true });
  });

  app.delete('/api/olts/:id/onus/:onuId', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const oltId = Number(req.params.id);
    const onuId = Number(req.params.onuId);

    const olt = db
      .prepare(
        `SELECT o.*, b.name AS branch_name
         FROM olts o
         JOIN branches b ON b.id = o.branch_id
         WHERE o.id = ?`
      )
      .get(oltId) as (DbOlt & { branch_name: string }) | undefined;
    if (!olt) {
      res.status(404).json({ error: 'Perangkat OLT tidak ditemukan.' });
      return;
    }

    const existing = db
      .prepare('SELECT * FROM olt_onus WHERE id = ? AND olt_id = ?')
      .get(onuId, oltId) as DbOltOnu | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Data ONU tidak ditemukan.' });
      return;
    }

    db.prepare('DELETE FROM olt_onus WHERE id = ?').run(onuId);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: olt.branch_id,
      branchName: olt.branch_name,
      action: 'HAPUS_ONU',
      target: `${existing.onu_name} (${existing.sn_mac})`,
      details: `Menghapus ONU ${existing.onu_name} (${existing.sn_mac}) dari ${olt.name}.`,
    });

    res.json({ ok: true });
  });

  // --- Akun Staf (Admin Only) ---

  app.get('/api/staff', requireAuth, requireAdmin, (_req, res) => {
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.full_name, u.role, u.branch_id, u.is_active, u.created_at, u.updated_at,
                b.name AS branch_name
         FROM users u
         LEFT JOIN branches b ON b.id = u.branch_id
         WHERE u.role = 'staff'
         ORDER BY u.id DESC`
      )
      .all();
    res.json({ staff: rows });
  });

  app.post('/api/staff', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { username, password, full_name, branch_id, is_active } = req.body as {
      username?: string;
      password?: string;
      full_name?: string;
      branch_id?: number | null;
      is_active?: boolean;
    };

    if (!username?.trim() || !password?.trim() || !full_name?.trim() || !branch_id) {
      res.status(400).json({ error: 'Nama lengkap, username, password, dan cabang staf wajib diisi.' });
      return;
    }

    const branch = db.prepare('SELECT id, name FROM branches WHERE id = ?').get(Number(branch_id)) as
      | { id: number; name: string }
      | undefined;
    if (!branch) {
      res.status(400).json({ error: 'Cabang yang dipilih tidak ditemukan.' });
      return;
    }

    const existing = db
      .prepare('SELECT id FROM users WHERE username = ?')
      .get(username.trim());
    if (existing) {
      res.status(409).json({ error: `Username "${username.trim()}" sudah digunakan.` });
      return;
    }

    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, role, branch_id, is_active, created_at, updated_at)
         VALUES (?, ?, ?, 'staff', ?, ?, ?, ?)`
      )
      .run(
        username.trim(),
        hashPassword(password),
        full_name.trim(),
        branch.id,
        is_active === false ? 0 : 1,
        now,
        now
      );

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'BUAT_STAF',
      target: username.trim(),
      details: `Membuat akun staf "${full_name.trim()}" (${username.trim()}) untuk cabang ${branch.name}.`,
    });

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  app.put('/api/staff/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const staffId = Number(req.params.id);
    const existing = db
      .prepare("SELECT * FROM users WHERE id = ? AND role = 'staff'")
      .get(staffId) as DbUser | undefined;
    if (!existing) {
      res.status(404).json({ error: 'Akun staf tidak ditemukan.' });
      return;
    }

    const { username, password, full_name, branch_id, is_active } = req.body as {
      username?: string;
      password?: string;
      full_name?: string;
      branch_id?: number | null;
      is_active?: boolean;
    };

    if (!username?.trim() || !full_name?.trim() || !branch_id) {
      res.status(400).json({ error: 'Nama lengkap, username, dan cabang staf wajib diisi.' });
      return;
    }

    const branch = db.prepare('SELECT id, name FROM branches WHERE id = ?').get(Number(branch_id)) as
      | { id: number; name: string }
      | undefined;
    if (!branch) {
      res.status(400).json({ error: 'Cabang yang dipilih tidak ditemukan.' });
      return;
    }

    const dup = db
      .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .get(username.trim(), staffId);
    if (dup) {
      res.status(409).json({ error: `Username "${username.trim()}" sudah digunakan akun lain.` });
      return;
    }

    const nextHash = password?.trim() ? hashPassword(password) : existing.password_hash;
    const nextActive = is_active === undefined ? existing.is_active : is_active ? 1 : 0;

    db.prepare(
      `UPDATE users SET username = ?, password_hash = ?, full_name = ?, branch_id = ?, is_active = ?, updated_at = ? WHERE id = ?`
    ).run(username.trim(), nextHash, full_name.trim(), branch.id, nextActive, nowIso(), staffId);

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: branch.id,
      branchName: branch.name,
      action: 'EDIT_STAF',
      target: username.trim(),
      details: `Memperbarui akun staf "${full_name.trim()}" (${username.trim()}) · Cabang ${branch.name} · ${nextActive === 1 ? 'Aktif' : 'Nonaktif'}.`,
    });

    res.json({ ok: true });
  });

  // --- Akun Admin (Admin Only) ---

  app.put('/api/account/admin', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const adminId = req.authUser!.id;
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId) as DbUser | undefined;
    if (!current) {
      res.status(404).json({ error: 'Akun admin tidak ditemukan.' });
      return;
    }

    const { username, full_name, current_password, new_password } = req.body as {
      username?: string;
      full_name?: string;
      current_password?: string;
      new_password?: string;
    };

    if (!username?.trim() || !full_name?.trim()) {
      res.status(400).json({ error: 'Nama lengkap dan username wajib diisi.' });
      return;
    }

    const dup = db
      .prepare('SELECT id FROM users WHERE username = ? AND id != ?')
      .get(username.trim(), adminId);
    if (dup) {
      res.status(409).json({ error: `Username "${username.trim()}" sudah digunakan.` });
      return;
    }

    let nextHash = current.password_hash;
    if (new_password && new_password.trim().length > 0) {
      if (!current_password || !verifyPassword(current_password, current.password_hash)) {
        res.status(400).json({ error: 'Password saat ini tidak cocok.' });
        return;
      }
      if (new_password.trim().length < 5) {
        res.status(400).json({ error: 'Password baru minimal 5 karakter.' });
        return;
      }
      nextHash = hashPassword(new_password.trim());
    }

    db.prepare('UPDATE users SET username = ?, full_name = ?, password_hash = ?, updated_at = ? WHERE id = ?').run(
      username.trim(),
      full_name.trim(),
      nextHash,
      nowIso(),
      adminId
    );

    const updatedUser = loadUserById(adminId);

    recordAuditLog({
      userId: adminId,
      username: username.trim(),
      userFullName: full_name.trim(),
      userRole: 'admin',
      branchId: null,
      branchName: null,
      action: 'EDIT_ADMIN',
      target: username.trim(),
      details: `Memperbarui profil akun administrator (${username.trim()}).`,
    });

    res.json({ user: updatedUser });
  });

  // --- Keuangan (Tagihan, Tarif Paket, & Arus Kas) ---

  app.get('/api/finance/summary', requireAuth, (req: AuthedRequest, res) => {
    const user = req.authUser!;
    const rawPeriod = typeof req.query.period === 'string' ? req.query.period.trim() : '';
    const isAllPeriods = rawPeriod === 'all';
    const periodParam = isAllPeriods
      ? 'all'
      : /^\d{4}-\d{2}$/.test(rawPeriod)
        ? rawPeriod
        : currentPeriod();

    const branchParam =
      typeof req.query.branchId === 'string' && req.query.branchId !== '' && req.query.branchId !== 'all'
        ? Number(req.query.branchId)
        : null;

    let accessibleBranchIds: number[] = [];
    if (user.role === 'admin') {
      if (branchParam && !Number.isNaN(branchParam)) {
        const exists = db.prepare('SELECT id FROM branches WHERE id = ?').get(branchParam) as
          | { id: number }
          | undefined;
        accessibleBranchIds = exists ? [exists.id] : [];
      } else {
        const rows = db.prepare('SELECT id FROM branches ORDER BY id ASC').all() as Array<{ id: number }>;
        accessibleBranchIds = rows.map((r) => r.id);
      }
    } else {
      accessibleBranchIds = user.branch_id ? [user.branch_id] : [];
    }

    const automationSettings = getBillingSettings();

    if (accessibleBranchIds.length === 0) {
      res.json({
        period: periodParam,
        automationSettings,
        summary: {
          totalPaidInvoices: 0,
          totalOtherIncome: 0,
          totalIncome: 0,
          totalExpense: 0,
          netProfit: 0,
          unpaidAmount: 0,
          paidCount: 0,
          unpaidCount: 0,
        },
        invoices: [],
        transactions: [],
        monthlyTrend: [],
      });
      return;
    }

    syncPaidInvoicesToTransactions();

    const placeholders = accessibleBranchIds.map(() => '?').join(',');

    type InvoiceRow = {
      id: number;
      branch_id: number;
      branch_name: string;
      customer_name: string;
      profile_name: string;
      period: string;
      amount_idr: number;
      status: 'belum_bayar' | 'lunas';
      payment_method: string | null;
      paid_at: string | null;
      paid_by_name: string | null;
      notes: string;
      is_isolated: number;
      whatsapp_number: string;
      created_at: string;
      updated_at: string;
    };

    const invoices = (
      isAllPeriods
        ? db
            .prepare(
              `SELECT ci.*, b.name AS branch_name, COALESCE(cbp.is_isolated, 0) AS is_isolated,
                      COALESCE(cc.whatsapp_number, '') AS whatsapp_number
               FROM customer_invoices ci
               JOIN branches b ON b.id = ci.branch_id
               LEFT JOIN customer_billing_profiles cbp
                 ON cbp.branch_id = ci.branch_id AND cbp.customer_name = ci.customer_name
               LEFT JOIN customer_contacts cc
                 ON cc.branch_id = ci.branch_id AND cc.customer_name = ci.customer_name
               WHERE ci.branch_id IN (${placeholders})
               ORDER BY ci.period DESC, CASE WHEN ci.status = 'belum_bayar' THEN 0 ELSE 1 END, ci.customer_name ASC`
            )
            .all(...accessibleBranchIds)
        : db
            .prepare(
              `SELECT ci.*, b.name AS branch_name, COALESCE(cbp.is_isolated, 0) AS is_isolated,
                      COALESCE(cc.whatsapp_number, '') AS whatsapp_number
               FROM customer_invoices ci
               JOIN branches b ON b.id = ci.branch_id
               LEFT JOIN customer_billing_profiles cbp
                 ON cbp.branch_id = ci.branch_id AND cbp.customer_name = ci.customer_name
               LEFT JOIN customer_contacts cc
                 ON cc.branch_id = ci.branch_id AND cc.customer_name = ci.customer_name
               WHERE ci.period = ? AND ci.branch_id IN (${placeholders})
               ORDER BY CASE WHEN ci.status = 'belum_bayar' THEN 0 ELSE 1 END, ci.customer_name ASC`
            )
            .all(periodParam, ...accessibleBranchIds)
    ) as InvoiceRow[];

    type TransactionRow = {
      id: number;
      branch_id: number;
      branch_name: string;
      type: 'pemasukan' | 'pengeluaran';
      category: string;
      description: string;
      amount_idr: number;
      transaction_date: string;
      payment_method: string;
      invoice_id: number | null;
      created_by_id: number | null;
      created_by_name: string;
      created_at: string;
    };

    const transactions = (
      isAllPeriods
        ? db
            .prepare(
              `SELECT ft.*, b.name AS branch_name
               FROM finance_transactions ft
               JOIN branches b ON b.id = ft.branch_id
               WHERE ft.branch_id IN (${placeholders})
               ORDER BY ft.transaction_date DESC, ft.id DESC`
            )
            .all(...accessibleBranchIds)
        : db
            .prepare(
              `SELECT ft.*, b.name AS branch_name
               FROM finance_transactions ft
               JOIN branches b ON b.id = ft.branch_id
               LEFT JOIN customer_invoices ci ON ci.id = ft.invoice_id
               WHERE ft.branch_id IN (${placeholders})
                 AND (
                   (ft.invoice_id IS NOT NULL AND ci.period = ?)
                   OR (ft.invoice_id IS NULL AND ft.transaction_date LIKE ?)
                 )
               ORDER BY ft.transaction_date DESC, ft.id DESC`
            )
            .all(...accessibleBranchIds, periodParam, `${periodParam}-%`)
    ) as TransactionRow[];

    // Hitung perkembangan bulanan untuk seluruh periode cabang terpilih
    const invoiceStatsRows = db
      .prepare(
        `SELECT ci.period AS period,
                SUM(CASE WHEN ci.status = 'lunas' THEN 1 ELSE 0 END) AS paid_count,
                SUM(CASE WHEN ci.status = 'belum_bayar' THEN 1 ELSE 0 END) AS unpaid_count,
                SUM(CASE WHEN ci.status = 'belum_bayar' THEN ci.amount_idr ELSE 0 END) AS unpaid_amount
         FROM customer_invoices ci
         WHERE ci.branch_id IN (${placeholders})
         GROUP BY ci.period`
      )
      .all(...accessibleBranchIds) as Array<{
      period: string;
      paid_count: number;
      unpaid_count: number;
      unpaid_amount: number;
    }>;

    const txStatsRows = db
      .prepare(
        `SELECT CASE
                  WHEN ft.invoice_id IS NOT NULL AND ci.period IS NOT NULL THEN ci.period
                  ELSE substr(ft.transaction_date, 1, 7)
                END AS effective_period,
                SUM(CASE WHEN ft.type = 'pemasukan' AND ft.invoice_id IS NOT NULL THEN ft.amount_idr ELSE 0 END) AS paid_invoices_amount,
                SUM(CASE WHEN ft.type = 'pemasukan' AND ft.invoice_id IS NULL THEN ft.amount_idr ELSE 0 END) AS other_income_amount,
                SUM(CASE WHEN ft.type = 'pengeluaran' THEN ft.amount_idr ELSE 0 END) AS total_expense
         FROM finance_transactions ft
         LEFT JOIN customer_invoices ci ON ci.id = ft.invoice_id
         WHERE ft.branch_id IN (${placeholders})
         GROUP BY effective_period`
      )
      .all(...accessibleBranchIds) as Array<{
      effective_period: string;
      paid_invoices_amount: number;
      other_income_amount: number;
      total_expense: number;
    }>;

    const trendMap = new Map<
      string,
      {
        period: string;
        paidInvoicesAmount: number;
        otherIncomeAmount: number;
        totalIncome: number;
        totalExpense: number;
        netProfit: number;
        paidCount: number;
        unpaidCount: number;
        unpaidAmount: number;
      }
    >();

    for (const row of invoiceStatsRows) {
      if (!/^\d{4}-\d{2}$/.test(row.period)) continue;
      const existing = trendMap.get(row.period) || {
        period: row.period,
        paidInvoicesAmount: 0,
        otherIncomeAmount: 0,
        totalIncome: 0,
        totalExpense: 0,
        netProfit: 0,
        paidCount: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
      };
      existing.paidCount += Number(row.paid_count) || 0;
      existing.unpaidCount += Number(row.unpaid_count) || 0;
      existing.unpaidAmount += Number(row.unpaid_amount) || 0;
      trendMap.set(row.period, existing);
    }

    for (const row of txStatsRows) {
      const p = row.effective_period;
      if (!/^\d{4}-\d{2}$/.test(p)) continue;
      const existing = trendMap.get(p) || {
        period: p,
        paidInvoicesAmount: 0,
        otherIncomeAmount: 0,
        totalIncome: 0,
        totalExpense: 0,
        netProfit: 0,
        paidCount: 0,
        unpaidCount: 0,
        unpaidAmount: 0,
      };
      existing.paidInvoicesAmount += Number(row.paid_invoices_amount) || 0;
      existing.otherIncomeAmount += Number(row.other_income_amount) || 0;
      existing.totalIncome = existing.paidInvoicesAmount + existing.otherIncomeAmount;
      existing.totalExpense += Number(row.total_expense) || 0;
      existing.netProfit = existing.totalIncome - existing.totalExpense;
      trendMap.set(p, existing);
    }

    const monthlyTrend = Array.from(trendMap.values()).sort((a, b) =>
      a.period.localeCompare(b.period)
    );

    let totalPaidInvoices = 0;
    let totalOtherIncome = 0;
    let totalExpense = 0;
    let unpaidAmount = 0;
    let paidCount = 0;
    let unpaidCount = 0;

    for (const inv of invoices) {
      if (inv.status === 'lunas') {
        paidCount += 1;
      } else {
        unpaidCount += 1;
        unpaidAmount += inv.amount_idr;
      }
    }

    for (const tx of transactions) {
      if (tx.type === 'pemasukan') {
        if (tx.invoice_id) {
          totalPaidInvoices += tx.amount_idr;
        } else {
          totalOtherIncome += tx.amount_idr;
        }
      } else {
        totalExpense += tx.amount_idr;
      }
    }

    const totalIncome = totalPaidInvoices + totalOtherIncome;
    const netProfit = totalIncome - totalExpense;

    res.json({
      period: periodParam,
      automationSettings,
      summary: {
        totalPaidInvoices,
        totalOtherIncome,
        totalIncome,
        totalExpense,
        netProfit,
        unpaidAmount,
        paidCount,
        unpaidCount,
      },
      invoices,
      transactions,
      monthlyTrend,
    });
  });

  app.get('/api/branches/:id/finance/tariffs', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const profileData = await getBranchProfiles(branch);
    const priceMap = getPackagePriceMap(branch.id);

    const seen = new Set<string>();
    const tariffs = profileData.packages.map((pkg) => {
      seen.add(pkg.name);
      return {
        profileName: pkg.name,
        rateLimit: pkg.rateLimit,
        isDefault: pkg.isDefault,
        priceIdr: priceMap.get(pkg.name) ?? 0,
      };
    });

    for (const [profileName, priceIdr] of priceMap.entries()) {
      if (!seen.has(profileName)) {
        tariffs.push({
          profileName,
          rateLimit: '',
          isDefault: false,
          priceIdr,
        });
      }
    }

    res.json({
      branch: sanitizeBranch(branch),
      online: profileData.online,
      error: profileData.error,
      tariffs,
    });
  });

  app.put(
    '/api/branches/:id/finance/tariffs',
    requireAuth,
    requireAdmin,
    (req: AuthedRequest, res) => {
      const branchId = Number(req.params.id);
      const branch = getBranchForUser(req, branchId);
      if (!branch) {
        res.status(404).json({ error: 'Cabang tidak ditemukan.' });
        return;
      }

      const { items } = req.body as {
        items?: Array<{ profileName: string; priceIdr: number }>;
      };

      if (!Array.isArray(items) || items.length === 0) {
        res.status(400).json({ error: 'Daftar tarif paket wajib diisi.' });
        return;
      }

      const validItems = items
        .filter((i) => typeof i.profileName === 'string' && i.profileName.trim().length > 0)
        .map((i) => ({
          profileName: i.profileName.trim(),
          priceIdr: Math.max(0, Math.round(Number(i.priceIdr) || 0)),
        }));

      setPackagePrices(branch.id, validItems);

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
        branchId: branch.id,
        branchName: branch.name,
        action: 'ATUR_TARIF_PAKET',
        target: `${validItems.length} paket`,
        details: `Memperbarui tarif bulanan untuk ${validItems.length} paket internet pada cabang ${branch.name}.`,
      });

      res.json({ ok: true });
    }
  );

  app.post('/api/branches/:id/finance/invoices/generate', requireAuth, async (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { period } = req.body as { period?: string };
    const resolvedPeriod =
      typeof period === 'string' && /^\d{4}-\d{2}$/.test(period) ? period : currentPeriod();

    try {
      const { createdCount, skippedCount } = await generateInvoicesForBranch(
        branch,
        resolvedPeriod,
        {
          userId: req.authUser!.id,
          username: req.authUser!.username,
          userFullName: req.authUser!.full_name,
          userRole: req.authUser!.role,
        }
      );

      res.json({ ok: true, createdCount, skippedCount, period: resolvedPeriod });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Gagal membuat tagihan otomatis.',
      });
    }
  });

  app.post('/api/branches/:id/finance/invoices', requireAuth, (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { customerName, profileName, period, amountIdr, notes } = req.body as {
      customerName?: string;
      profileName?: string;
      period?: string;
      amountIdr?: number;
      notes?: string;
    };

    if (!customerName?.trim() || !profileName?.trim()) {
      res.status(400).json({ error: 'Nama pelanggan dan paket wajib diisi.' });
      return;
    }

    const resolvedPeriod =
      typeof period === 'string' && /^\d{4}-\d{2}$/.test(period) ? period : currentPeriod();
    const cleanAmount = Math.max(0, Math.round(Number(amountIdr) || 0));

    const existing = db
      .prepare('SELECT id FROM customer_invoices WHERE branch_id = ? AND customer_name = ? AND period = ?')
      .get(branch.id, customerName.trim(), resolvedPeriod);
    if (existing) {
      res.status(409).json({
        error: `Tagihan untuk "${customerName.trim()}" pada periode ${resolvedPeriod} sudah ada.`,
      });
      return;
    }

    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO customer_invoices
          (branch_id, customer_name, profile_name, period, amount_idr, status, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'belum_bayar', ?, ?, ?)`
      )
      .run(
        branch.id,
        customerName.trim(),
        profileName.trim(),
        resolvedPeriod,
        cleanAmount,
        (notes || '').trim(),
        now,
        now
      );

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'BUAT_TAGIHAN',
      target: customerName.trim(),
      details: `Membuat tagihan manual "${customerName.trim()}" (${profileName.trim()}) periode ${resolvedPeriod} sebesar Rp ${cleanAmount.toLocaleString('id-ID')}.`,
    });

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  app.put('/api/finance/invoices/:invoiceId/pay', requireAuth, async (req: AuthedRequest, res) => {
    const invoiceId = Number(req.params.invoiceId);
    const invoice = db
      .prepare(
        `SELECT ci.*, b.name AS branch_name
         FROM customer_invoices ci
         JOIN branches b ON b.id = ci.branch_id
         WHERE ci.id = ?`
      )
      .get(invoiceId) as
      | {
          id: number;
          branch_id: number;
          branch_name: string;
          customer_name: string;
          profile_name: string;
          period: string;
          amount_idr: number;
          status: 'belum_bayar' | 'lunas';
        }
      | undefined;

    if (!invoice) {
      res.status(404).json({ error: 'Tagihan tidak ditemukan.' });
      return;
    }

    const branch = getBranchForUser(req, invoice.branch_id);
    if (!branch) {
      res.status(403).json({ error: 'Akses cabang ditolak.' });
      return;
    }

    const { paymentMethod, paidDate, amountIdr, notes } = req.body as {
      paymentMethod?: string;
      paidDate?: string;
      amountIdr?: number;
      notes?: string;
    };

    const resolvedMethod = paymentMethod?.trim() || 'Tunai';
    const resolvedDate =
      typeof paidDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(paidDate)
        ? paidDate
        : nowIso().slice(0, 10);
    const resolvedAmount =
      amountIdr !== undefined && !Number.isNaN(Number(amountIdr))
        ? Math.max(0, Math.round(Number(amountIdr)))
        : invoice.amount_idr;
    const now = nowIso();

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE customer_invoices
         SET status = 'lunas', amount_idr = ?, payment_method = ?, paid_at = ?, paid_by_name = ?, notes = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        resolvedAmount,
        resolvedMethod,
        `${resolvedDate}T12:00:00.000Z`,
        req.authUser!.full_name,
        (notes || '').trim(),
        now,
        invoice.id
      );

      db.prepare('DELETE FROM finance_transactions WHERE invoice_id = ?').run(invoice.id);
      db.prepare(
        `INSERT INTO finance_transactions
          (branch_id, type, category, description, amount_idr, transaction_date, payment_method, invoice_id, created_by_id, created_by_name, created_at)
         VALUES (?, 'pemasukan', 'Iuran Bulanan PPPoE', ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        invoice.branch_id,
        `Pembayaran ${invoice.customer_name} (${invoice.profile_name} · ${invoice.period})`,
        resolvedAmount,
        resolvedDate,
        resolvedMethod,
        invoice.id,
        req.authUser!.id,
        req.authUser!.full_name,
        now
      );
    });
    tx();

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: invoice.branch_id,
      branchName: invoice.branch_name,
      action: 'BAYAR_TAGIHAN',
      target: invoice.customer_name,
      details: `Mencatat pembayaran lunas "${invoice.customer_name}" periode ${invoice.period} sebesar Rp ${resolvedAmount.toLocaleString('id-ID')} (${resolvedMethod}).`,
    });

    const restoreResult = await restoreCustomerProfileIfEligible(
      branch,
      invoice.customer_name,
      invoice.profile_name,
      {
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: req.authUser!.role,
      }
    );

    res.json({
      ok: true,
      restored: restoreResult.restored,
      restoredProfile: restoreResult.restoredProfile,
      restoreWarning: restoreResult.warning,
    });
  });

  app.put(
    '/api/finance/invoices/:invoiceId/unpay',
    requireAuth,
    requireAdmin,
    (req: AuthedRequest, res) => {
      const invoiceId = Number(req.params.invoiceId);
      const invoice = db
        .prepare(
          `SELECT ci.*, b.name AS branch_name
           FROM customer_invoices ci
           JOIN branches b ON b.id = ci.branch_id
           WHERE ci.id = ?`
        )
        .get(invoiceId) as
        | {
            id: number;
            branch_id: number;
            branch_name: string;
            customer_name: string;
            period: string;
          }
        | undefined;

      if (!invoice) {
        res.status(404).json({ error: 'Tagihan tidak ditemukan.' });
        return;
      }

      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE customer_invoices
           SET status = 'belum_bayar', payment_method = NULL, paid_at = NULL, paid_by_name = NULL, updated_at = ?
           WHERE id = ?`
        ).run(nowIso(), invoice.id);
        db.prepare('DELETE FROM finance_transactions WHERE invoice_id = ?').run(invoice.id);
      });
      tx();

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
        branchId: invoice.branch_id,
        branchName: invoice.branch_name,
        action: 'BATAL_BAYAR_TAGIHAN',
        target: invoice.customer_name,
        details: `Membatalkan status lunas tagihan "${invoice.customer_name}" periode ${invoice.period}.`,
      });

      res.json({ ok: true });
    }
  );

  app.delete(
    '/api/finance/invoices/:invoiceId',
    requireAuth,
    requireAdmin,
    (req: AuthedRequest, res) => {
      const invoiceId = Number(req.params.invoiceId);
      const invoice = db
        .prepare(
          `SELECT ci.*, b.name AS branch_name
           FROM customer_invoices ci
           JOIN branches b ON b.id = ci.branch_id
           WHERE ci.id = ?`
        )
        .get(invoiceId) as
        | {
            id: number;
            branch_id: number;
            branch_name: string;
            customer_name: string;
            period: string;
          }
        | undefined;

      if (!invoice) {
        res.status(404).json({ error: 'Tagihan tidak ditemukan.' });
        return;
      }

      db.prepare('DELETE FROM customer_invoices WHERE id = ?').run(invoice.id);

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
        branchId: invoice.branch_id,
        branchName: invoice.branch_name,
        action: 'HAPUS_TAGIHAN',
        target: invoice.customer_name,
        details: `Menghapus tagihan "${invoice.customer_name}" periode ${invoice.period}.`,
      });

      res.json({ ok: true });
    }
  );

  app.post('/api/branches/:id/finance/transactions', requireAuth, (req: AuthedRequest, res) => {
    const branchId = Number(req.params.id);
    const branch = getBranchForUser(req, branchId);
    if (!branch) {
      res.status(403).json({ error: 'Cabang tidak ditemukan atau akses ditolak.' });
      return;
    }

    const { type, category, description, amountIdr, transactionDate, paymentMethod } = req.body as {
      type?: 'pemasukan' | 'pengeluaran';
      category?: string;
      description?: string;
      amountIdr?: number;
      transactionDate?: string;
      paymentMethod?: string;
    };

    if (type !== 'pemasukan' && type !== 'pengeluaran') {
      res.status(400).json({ error: 'Tipe transaksi harus pemasukan atau pengeluaran.' });
      return;
    }
    if (!category?.trim() || !description?.trim()) {
      res.status(400).json({ error: 'Kategori dan keterangan transaksi wajib diisi.' });
      return;
    }

    const cleanAmount = Math.round(Number(amountIdr) || 0);
    if (cleanAmount <= 0) {
      res.status(400).json({ error: 'Nominal transaksi harus lebih dari Rp 0.' });
      return;
    }

    const resolvedDate =
      typeof transactionDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(transactionDate)
        ? transactionDate
        : nowIso().slice(0, 10);
    const resolvedMethod = paymentMethod?.trim() || 'Tunai';

    const info = db
      .prepare(
        `INSERT INTO finance_transactions
          (branch_id, type, category, description, amount_idr, transaction_date, payment_method, invoice_id, created_by_id, created_by_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        branch.id,
        type,
        category.trim(),
        description.trim(),
        cleanAmount,
        resolvedDate,
        resolvedMethod,
        req.authUser!.id,
        req.authUser!.full_name,
        nowIso()
      );

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: req.authUser!.role,
      branchId: branch.id,
      branchName: branch.name,
      action: 'TAMBAH_TRANSAKSI',
      target: category.trim(),
      details: `Mencatat ${type} (${category.trim()}) sebesar Rp ${cleanAmount.toLocaleString('id-ID')}: ${description.trim()}.`,
    });

    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  app.delete(
    '/api/finance/transactions/:txId',
    requireAuth,
    requireAdmin,
    (req: AuthedRequest, res) => {
      const txId = Number(req.params.txId);
      const row = db
        .prepare(
          `SELECT ft.*, b.name AS branch_name
           FROM finance_transactions ft
           JOIN branches b ON b.id = ft.branch_id
           WHERE ft.id = ?`
        )
        .get(txId) as
        | {
            id: number;
            branch_id: number;
            branch_name: string;
            type: string;
            category: string;
            amount_idr: number;
            invoice_id: number | null;
          }
        | undefined;

      if (!row) {
        res.status(404).json({ error: 'Transaksi tidak ditemukan.' });
        return;
      }

      if (row.invoice_id) {
        res.status(400).json({
          error: 'Transaksi ini terhubung dengan tagihan pelanggan. Batalkan status lunas pada tab Tagihan Pelanggan.',
        });
        return;
      }

      db.prepare('DELETE FROM finance_transactions WHERE id = ?').run(row.id);

      recordAuditLog({
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
        branchId: row.branch_id,
        branchName: row.branch_name,
        action: 'HAPUS_TRANSAKSI',
        target: row.category,
        details: `Menghapus transaksi ${row.type} (${row.category}) sebesar Rp ${row.amount_idr.toLocaleString('id-ID')}.`,
      });

      res.json({ ok: true });
    }
  );

  // --- Otomatisasi Tagihan Tanggal 1 & Isolir Setelah Tanggal 5 ---

  app.get('/api/finance/automation', requireAuth, (_req, res) => {
    res.json({ settings: getBillingSettings() });
  });

  app.put('/api/finance/automation', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const body = req.body as {
      auto_invoice_enabled?: boolean;
      auto_isolir_enabled?: boolean;
      isolir_cutoff_day?: number;
      isolir_profile_name?: string;
      wa_template_unpaid?: string;
      wa_template_paid?: string;
    };

    const current = getBillingSettings();
    const hasTemplateUpdate =
      body.wa_template_unpaid !== undefined || body.wa_template_paid !== undefined;

    const updated = updateBillingSettings({
      auto_invoice_enabled:
        body.auto_invoice_enabled !== undefined
          ? Boolean(body.auto_invoice_enabled)
          : current.auto_invoice_enabled,
      auto_isolir_enabled:
        body.auto_isolir_enabled !== undefined
          ? Boolean(body.auto_isolir_enabled)
          : current.auto_isolir_enabled,
      isolir_cutoff_day:
        body.isolir_cutoff_day !== undefined
          ? Number(body.isolir_cutoff_day)
          : current.isolir_cutoff_day,
      isolir_profile_name:
        body.isolir_profile_name !== undefined
          ? String(body.isolir_profile_name)
          : current.isolir_profile_name,
      wa_template_unpaid:
        body.wa_template_unpaid !== undefined
          ? String(body.wa_template_unpaid)
          : undefined,
      wa_template_paid:
        body.wa_template_paid !== undefined
          ? String(body.wa_template_paid)
          : undefined,
    });

    recordAuditLog({
      userId: req.authUser!.id,
      username: req.authUser!.username,
      userFullName: req.authUser!.full_name,
      userRole: 'admin',
      branchId: null,
      branchName: null,
      action: 'ATUR_OTOMATISASI_TAGIHAN',
      target: hasTemplateUpdate ? 'Template WA & Otomatisasi' : updated.isolir_profile_name,
      details: hasTemplateUpdate
        ? `Memperbarui template teks penagihan WhatsApp (Belum Bayar / Lunas).`
        : `Tagihan otomatis tgl 1: ${updated.auto_invoice_enabled ? 'Aktif' : 'Nonaktif'} · Isolir otomatis > tgl ${updated.isolir_cutoff_day} (${updated.isolir_profile_name}): ${updated.auto_isolir_enabled ? 'Aktif' : 'Nonaktif'}.`,
    });

    res.json({ settings: updated });
  });

  app.post('/api/finance/automation/run', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const { forceInvoice, forceIsolir } = (req.body || {}) as {
      forceInvoice?: boolean;
      forceIsolir?: boolean;
    };

    const result = await runBillingAutomationCycle({
      forceInvoice: Boolean(forceInvoice),
      forceIsolir: Boolean(forceIsolir),
      actor: {
        userId: req.authUser!.id,
        username: req.authUser!.username,
        userFullName: req.authUser!.full_name,
        userRole: 'admin',
      },
    });

    res.json(result);
  });

  // --- Vite / Static Frontend Serving ---

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NetOps MikroTik server running on http://0.0.0.0:${PORT}`);

    // Jalankan otomatisasi tagihan tanggal 1 & isolir setelah tanggal 5 saat startup dan berkala setiap 15 menit
    setTimeout(() => {
      runBillingAutomationCycle().catch((err) => {
        console.error('Billing automation startup cycle failed:', err);
      });
    }, 3000);

    setInterval(() => {
      runBillingAutomationCycle().catch((err) => {
        console.error('Billing automation periodic cycle failed:', err);
      });
    }, 15 * 60 * 1000);
  });
}

startServer();
