export type WorkspaceId =
  | 'overview'
  | 'simulator'
  | 'walker'
  | 'traps'
  | 'browser'
  | 'mibs'
  | 'settings';

export interface AppMeta {
  name: string;
  version: string;
  author: string;
  description: string;
}

export interface AuthCheckResponse {
  status: string;
  user: string;
}

export interface LoginResponse {
  status?: string;
  token: string;
  username: string;
  expires_in?: number;
}

export interface AppSettings {
  auto_start_simulator: boolean;
  auto_start_trap_receiver: boolean;
  session_timeout: number;
  mib_auto_fetch: boolean;
  mib_remote_sources: string[];
  restart_required?: boolean;
}

export interface SimulatorStatus {
  running: boolean;
  port: number;
  community: string;
  pid: number | null;
  uptime_seconds: number | null;
  requests: number;
  last_activity: string | null;
  restart_required: boolean;
}

export interface SimulatorActionResponse {
  status: string;
  message?: string;
  port?: number;
  community?: string;
  custom_data_warnings?: string[];
}

export interface SaveSimulatorDataResponse {
  status: string;
  message?: string;
}

export interface SimulatorLogEntry {
  time: string;
  timestamp?: string;
  last_event_timestamp?: string;
  level: 'info' | 'success' | 'warning' | 'error' | string;
  message: string;
  request_type?: string;
  request_count?: number;
  oid_count?: number;
  first_requested_oid?: string;
  first_returned_oid?: string;
}

export interface TrapReceiverStatus {
  running: boolean;
  port: number;
  community: string;
  resolve_mibs: boolean;
  uptime_seconds: number | null;
}

export interface TrapActionResponse {
  status: string;
  port?: number;
  community?: string;
  resolve_mibs?: boolean;
  message?: string;
}

export interface SendNotificationResponse {
  status: string;
  operation?: string;
  target?: string;
  port?: number;
  request_id?: string | number;
  message?: string;
  response?: {
    error_status_code?: number;
    error_status?: string;
    error_index?: number;
    varbinds?: unknown[];
  } | null;
}

export interface DecodedTrapEvent {
  source_address?: { host?: string; port?: number } | null;
  notification_name?: string | null;
  notification_oid?: string | null;
  pdu_type?: string | null;
  community?: string | null;
  uptime?: string | number | null;
  varbinds?: Array<{
    oid?: string;
    symbolic?: string;
    value?: unknown;
    display_value?: string;
    enum_label?: string | null;
    units?: string | null;
  }>;
}

export interface DecodeTrapResponse {
  active_bundle?: unknown;
  event?: DecodedTrapEvent | null;
}

export interface MibBundleSummaryResponse {
  active_bundle_id: number | null;
  producer_version?: string | null;
  missing_capabilities?: string[];
  recompile_recommended: boolean;
}

export interface MibSummary {
  loaded?: number;
  failed?: number;
  traps_available?: number;
  total?: number;
  source_files?: number;
  active_bundle_id?: number | null;
  active_bundle_key?: string | null;
  total_objects?: number;
  producer_version?: string | null;
  missing_capabilities?: string[];
  recompile_recommended?: boolean;
  needs_recompile?: boolean;
}

export interface StatsSnapshot {
  simulator: {
    snmp_requests_served: number;
    oids_loaded: number;
  };
  traps: {
    traps_received_total: number;
    traps_sent_total: number;
  };
  walker: {
    walks_executed: number;
    oids_returned: number;
  };
  mibs: {
    upload_count: number;
    reload_count: number;
  };
}

export interface WalkRow {
  oid: string;
  symbolic?: string;
  numeric_oid?: string;
  symbol?: string;
  module?: string;
  name?: string;
  index?: string;
  type: string;
  value: string | number;
  enum_label?: string | null;
  units?: string | null;
}

export interface GroupedWalkMetricRow {
  metric_name: string;
  value: string | number;
  mib_module?: string;
  metric_category?: string;
  agent_host?: string;
  timestamp?: string;
  labels?: Record<string, string | number>;
  enum_label?: string | null;
  units?: string | null;
  numeric_oid?: string;
}

export interface WalkExecuteRequest {
  target: string;
  port: number;
  community: string;
  oid: string;
  parse: boolean;
  use_mibs: boolean;
  json_format: 'flat' | 'grouped';
  timeout_ms: number;
  retries: number;
}

export interface WalkExecuteResponse {
  status?: string;
  mode?: 'parsed' | 'raw' | 'label' | string;
  target?: string;
  port?: number;
  oid?: string;
  parse?: boolean;
  use_mibs?: boolean;
  json_format: string;
  count: number;
  duration_ms?: number;
  raw?: string;
  rawLines?: string[];
  data?: WalkRow[] | GroupedWalkMetricRow[] | string[] | Record<string, unknown>[];
}

export interface WalkHistoryEntry {
  id: string;
  timestamp: string;
  target: string;
  port: number;
  community: string;
  oid: string;
  parse: boolean;
  use_mibs: boolean;
  json_format: 'flat' | 'grouped';
  timeout_ms: number;
  retries: number;
  count: number;
}

export interface EnumValue {
  label: string;
  value: number;
}

export interface TrapObjectSpec {
  name: string;
  full_name: string;
  module: string;
  oid: string;
  syntax: string;
  input_type: string;
  enum_values?: EnumValue[];
  constraint?: unknown;
}

export interface TrapCatalogItem {
  name: string;
  full_name: string;
  oid: string;
  module: string;
  description: string;
  objects: TrapObjectSpec[];
}

export interface TrapVarbind {
  oid: string;
  numeric_oid?: string;
  name?: string;
  module?: string;
  type?: string;
  value: string | number | boolean | null;
  display_value?: string;
  resolved?: boolean;
  enum_label?: string | null;
  units?: string | null;
}

export interface ReceivedTrapEvent {
  id: number | null;
  timestamp: string;
  time_str?: string;
  source_ip?: string;
  source_port?: number;
  source?: string;
  community?: string | null;
  version?: string;
  pdu_type?: string;
  trap_type?: string;
  trap_oid?: string;
  trap_name?: string;
  trap_module?: string;
  resolved?: boolean;
  resolve_mibs?: boolean;
  varbinds: TrapVarbind[];
  raw_hex?: string;
}

export interface MibNodeRecord {
  entry_type: 'object' | 'notification';
  name: string;
  full_name: string;
  module: string;
  oid: string;
  oid_tuple?: number[];
  type: string;
  syntax: string | null;
  access: string | null;
  status: string | null;
  description: string;
  indexes?: string[];
  members?: Array<{ module: string; name: string }>;
  constraints?: unknown;
  enums?: Record<string, number> | EnumValue[];
  units?: string | null;
  has_children?: boolean;
}

export interface MibModuleTreeGroup {
  name: string;
  module?: string;
  oid?: string;
  type?: string;
  object_count?: number;
  children: MibNodeRecord[];
}

export interface MibSourceGroupSummary {
  name: string;
  file_count: number;
  mib_count: number;
  active_module_count: number;
}

export interface MibSourceFile {
  name: string;
  file: string;
  relative_path: string;
  objects: number;
  traps: number;
  imports: string[];
  builtin: boolean;
  deletable: boolean;
  source_kind: 'bundled' | 'uploaded';
  source_group: string;
  status: string;
  missing_deps?: string[];
  error?: string | null;
  module_metadata?: {
    lastupdated?: string;
    last_updated?: string;
    organization?: string;
    contactinfo?: string;
    contact_info?: string;
    description?: string;
    revisions?: Array<{ date: string; description: string }>;
  } | null;
}

export interface MibStatusResponse {
  loaded: number;
  failed: number;
  traps_available?: number;
  mibs: MibSourceFile[];
  active_modules: MibSourceFile[];
  errors: MibSourceFile[];
  failed_modules: MibSourceFile[];
  source_inventory: MibSourceFile[];
  source_groups: MibSourceGroupSummary[];
  producer_version?: string;
  recompile_recommended?: boolean;
  needs_recompile?: boolean;
  active_bundle_id?: number | null;
  active_bundle_label?: string | null;
}

export interface DependencyFetchSummary {
  enabled?: boolean;
  auto_enabled?: boolean;
  using_default_sources?: boolean;
  sources?: string[];
  attempted?: string[];
  resolved?: string[];
  downloaded?: string[];
  cached?: string[];
  failed?: Array<{ module?: string; error?: string; reason?: string } | string>;
}

export interface DuplicateResolutionInfo {
  resolution_status?: string;
  predicted_active_relative_path?: string;
  predicted_active_source_group?: string;
  duplicate_sources?: Array<string | { relative_path?: string; source_group?: string }>;
  warnings?: string[];
}

export interface ValidateBatchFileItem {
  filename: string;
  safe_name?: string;
  storage_name?: string;
  mib_name?: string | null;
  valid: boolean;
  imports?: string[];
  missing_deps?: string[];
  partial_blockers?: string[];
  ready_for_partial?: boolean;
  source_group?: string;
  target_relative_path?: string;
  will_replace?: boolean;
  duplicate_resolution?: DuplicateResolutionInfo | null;
  errors?: string[];
}

export interface DuplicateModuleWarning {
  mib_name: string;
  target_relative_path?: string;
  source_group?: string;
  resolution_status?: string;
  predicted_active_relative_path?: string;
  predicted_active_source_group?: string;
  duplicate_sources?: Array<string | { relative_path?: string; source_group?: string }>;
  warnings?: string[];
}

export interface PartialCompileSummary {
  can_partial_compile: boolean;
  ready_count: number;
  blocked_count?: number;
  ready_mibs: string[];
  blocked_mibs?: string[];
}

export interface ValidateBatchResponse {
  source_group: string;
  files: ValidateBatchFileItem[];
  duplicate_modules?: DuplicateModuleWarning[];
  global_missing_deps?: string[];
  can_upload?: boolean;
  upload_blocked_reason?: string | null;
  partial_compile?: PartialCompileSummary;
  dependency_fetch?: DependencyFetchSummary;
}

export interface UploadMibResultItem {
  filename: string;
  mib_name?: string | null;
  status: 'loaded' | 'failed' | 'skipped' | 'error' | string;
  error?: string | null;
  missing_deps?: string[];
}

export interface UploadMibsResponse {
  results: UploadMibResultItem[];
  compile_mode?: string;
  compiled_mibs?: string[];
  dependency_fetch?: DependencyFetchSummary;
  source_group?: string;
}

export interface ReloadMibsResponse {
  loaded?: number | string[];
  failed?: number | Array<{ name?: string; file?: string; error?: string; missing_deps?: string[] }> | Record<string, string>;
  dependency_fetch?: DependencyFetchSummary;
}

export interface DeleteMibBatchResponse {
  status: string;
  deleted_count: number;
  deleted_files: string[];
  reload_applied?: boolean;
  reload?: ReloadMibsResponse | null;
  loaded?: number;
  failed?: number;
  dependency_fetch?: DependencyFetchSummary;
  promoted_sources?: string[];
}

export interface BundleRecord {
  id: number;
  bundle_key: string;
  label: string;
  status: string;
  is_active: boolean;
  created_at: string;
  producer_version?: string;
  content_hash: string;
  module_count: number;
}

export interface BundleDiffChangeSection {
  left_total?: number;
  right_total?: number;
  added?: string[];
  removed?: string[];
  changed?: string[];
}

export interface BundleDiffResponse {
  identical: boolean;
  hash?: string;
  left_bundle: BundleRecord;
  right_bundle: BundleRecord;
  summary?: {
    modules: {
      left_total: number;
      right_total: number;
      added: number;
      removed: number;
      changed: number;
    };
  };
  modules_added?: Array<{ module_name: string; object_count?: number; notification_count?: number }>;
  modules_removed?: Array<{ module_name: string; object_count?: number; notification_count?: number }>;
  modules_changed?: Array<{
    module_name: string;
    left?: { object_count?: number; notification_count?: number };
    right?: { object_count?: number; notification_count?: number };
    objects?: BundleDiffChangeSection;
    notifications?: BundleDiffChangeSection;
    imports?: BundleDiffChangeSection;
  }>;
}

export interface MibConstraint {
  type?: 'range' | 'size' | string;
  kind?: 'range' | 'size' | string;
  ranges?: Array<[number, number]>;
  data?: Array<[number, number]>;
}

export interface MibObjectSearchItem {
  name: string;
  full_name: string;
  module: string;
  oid: string;
  syntax?: string;
  type?: string;
  input_type?: string;
  constraint?: MibConstraint | null;
  enum_values?: EnumValue[];
}

export interface WorkbenchHandoff {
  walkOid?: string;
  trapOid?: string;
  trapFullName?: string;
  browseOid?: string;
  browseModule?: string;
}
