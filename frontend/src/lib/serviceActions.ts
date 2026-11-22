import { api } from './api';
import type {
  SimulatorActionResponse,
  SimulatorStatus,
  TrapActionResponse,
  TrapReceiverStatus,
} from '../types/api';

type NotifyFn = (message: string, tone?: 'success' | 'error' | 'warning' | 'info') => void;

export async function toggleSimulatorService(params: {
  simulatorStatus: SimulatorStatus | null;
  port?: number;
  community?: string;
  notify: NotifyFn;
  refreshLiveState: () => Promise<void>;
}): Promise<SimulatorActionResponse> {
  const { simulatorStatus, notify, refreshLiveState } = params;
  const targetPort = params.port ?? simulatorStatus?.port ?? 1161;
  const targetCommunity = params.community ?? simulatorStatus?.community ?? 'public';

  if (simulatorStatus?.running) {
    const res = await api.stopSimulator();
    notify(res.message || 'Simulator stopped', 'info');
    await refreshLiveState();
    return res;
  }

  const res = await api.startSimulator(targetPort, targetCommunity);
  notify(res.message || `Simulator listening on UDP :${res.port ?? targetPort}`, 'success');
  if (Array.isArray(res.custom_data_warnings) && res.custom_data_warnings.length > 0) {
    notify(`Custom SNMP data warnings: ${res.custom_data_warnings.length} issue(s)`, 'warning');
  }
  await refreshLiveState();
  return res;
}

export async function toggleTrapReceiverService(params: {
  trapStatus: TrapReceiverStatus | null;
  port?: number;
  community?: string;
  resolveMibs?: boolean;
  notify: NotifyFn;
  refreshLiveState: () => Promise<void>;
}): Promise<TrapActionResponse> {
  const { trapStatus, notify, refreshLiveState } = params;
  const targetPort = params.port ?? trapStatus?.port ?? 1162;
  const targetCommunity = params.community ?? trapStatus?.community ?? 'public';
  const targetResolve = params.resolveMibs ?? trapStatus?.resolve_mibs ?? true;

  if (trapStatus?.running) {
    const res = await api.stopTrapReceiver();
    notify(res.message || 'Trap receiver stopped', 'info');
    await refreshLiveState();
    return res;
  }

  const res = await api.startTrapReceiver(targetPort, targetCommunity, targetResolve);
  notify(res.message || `Trap receiver listening on UDP :${res.port ?? targetPort}`, 'success');
  await refreshLiveState();
  return res;
}
