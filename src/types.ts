export type UserRole = 'admin' | 'staff';
export type ConnectionMode = 'api' | 'api-ssl' | 'rest-http' | 'rest-https' | 'sandbox';

export interface AuthUser {
  id: number;
  username: string;
  full_name: string;
  role: UserRole;
  branch_id: number | null;
  branch_name: string | null;
  is_active: boolean;
}

export interface Branch {
  id: number;
  name: string;
  location: string;
  connection_mode: ConnectionMode;
  host: string;
  port: number;
  username: string;
  created_at: string;
}

export interface BranchStatus {
  branchId: number;
  branchName: string;
  location: string;
  connectionMode: ConnectionMode;
  host: string;
  port: number;
  online: boolean;
  error: string | null;
  identity: string | null;
  version: string | null;
  uptime: string | null;
  cpuLoad: string | null;
  activeCount: number;
  inactiveCount: number;
  totalSecrets: number;
  checkedAt: string;
}

export interface PppoeCustomer {
  id: string;
  name: string;
  password: string;
  service: string;
  profile: string;
  wifiName: string;
  wifiPassword: string;
  whatsappNumber?: string;
  disabled: boolean;
  status: 'aktif' | 'tidak_aktif';
  activeAddress: string | null;
  activeUptime: string | null;
  callerId: string | null;
}

export interface PppoeProfile {
  id: string;
  name: string;
  localAddress: string;
  remoteAddress: string;
  rateLimit: string;
  dnsServer: string;
  onlyOne: string;
  parentQueue: string;
  isDefault: boolean;
  allowed: boolean;
}

export interface PingPacketResult {
  seq: number;
  host: string;
  size: number | null;
  ttl: number | null;
  timeMs: number | null;
  status: string;
}

export interface PingResult {
  branchId: number;
  branchName: string;
  target: string;
  sent: number;
  received: number;
  packetLossPct: number;
  minRttMs: number | null;
  avgRttMs: number | null;
  maxRttMs: number | null;
  packets: PingPacketResult[];
  checkedAt: string;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  username: string;
  user_full_name: string;
  user_role: UserRole;
  branch_id: number | null;
  branch_name: string | null;
  action: string;
  target: string;
  details: string;
  created_at: string;
}

export interface StaffAccount {
  id: number;
  username: string;
  full_name: string;
  role: 'staff';
  branch_id: number | null;
  branch_name: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface FinanceSummary {
  totalPaidInvoices: number;
  totalOtherIncome: number;
  totalIncome: number;
  totalExpense: number;
  netProfit: number;
  unpaidAmount: number;
  paidCount: number;
  unpaidCount: number;
}

export interface MonthlyFinanceTrend {
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

export interface CustomerInvoice {
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
  is_isolated?: number;
  whatsapp_number?: string;
  created_at: string;
  updated_at: string;
}

export interface BillingAutomationSettings {
  auto_invoice_enabled: boolean;
  auto_isolir_enabled: boolean;
  isolir_cutoff_day: number;
  isolir_profile_name: string;
  wa_template_unpaid?: string;
  wa_template_paid?: string;
  updated_at: string;
}

export interface FinanceTransaction {
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
}

export interface PackageTariff {
  profileName: string;
  rateLimit: string;
  isDefault: boolean;
  priceIdr: number;
}

export interface OltLink {
  id: number;
  branch_id: number;
  branch_name: string;
  name: string;
  http_url: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export type OltPonType = 'GPON' | 'EPON';
export type OltConnectionMode = 'telnet' | 'ssh' | 'snmp' | 'web-http' | 'sandbox';
export type OltOnuStatus = 'online' | 'los' | 'dying_gasp' | 'offline' | 'unconfigured';

export interface OltDevice {
  id: number;
  branch_id: number;
  branch_name: string;
  name: string;
  vendor: string;
  model: string;
  pon_type: OltPonType;
  connection_mode: OltConnectionMode;
  host: string;
  port: number;
  username: string;
  snmp_community: string;
  total_pon_ports: number;
  uplink_info: string;
  notes: string;
  online: boolean;
  error: string | null;
  latencyMs: number | null;
  uptime: string | null;
  cpuLoad: string | null;
  temperatureC: number | null;
  systemDescr: string | null;
  syncNote: string | null;
  totalOnus: number;
  configuredOnus: number;
  onlineOnus: number;
  losOnus: number;
  dyingGaspOnus: number;
  offlineOnus: number;
  unconfiguredOnus: number;
  weakSignalOnus: number;
  checkedAt: string;
  created_at: string;
  updated_at: string;
}

export interface OltOnu {
  id: number;
  olt_id: number;
  pon_port: string;
  onu_index: number;
  onu_name: string;
  customer_name: string;
  sn_mac: string;
  onu_type: string;
  status: OltOnuStatus;
  rx_power_dbm: number | null;
  tx_power_dbm: number | null;
  olt_rx_power_dbm: number | null;
  temperature_c: number | null;
  distance_m: number | null;
  vlan_id: number;
  uptime: string;
  last_down_reason: string;
  updated_at: string;
}

export interface OltPonPortSummary {
  ponPort: string;
  sfpStatus: 'up' | 'down';
  sfpTxDbm: number | null;
  totalOnus: number;
  onlineCount: number;
  losCount: number;
  offlineCount: number;
  unconfiguredCount: number;
  avgRxDbm: number | null;
}
