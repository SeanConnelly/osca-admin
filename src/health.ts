// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Overall health: the worst of IRIS's own state and the things an admin would
 * call unhealthy even when IRIS says "OK" — recent alerts, licences running
 * out, CPU and memory. The status bar and Home both use this, so they never
 * disagree with the figures shown next to them.
 */
import { value, systemState, type Snapshot } from './metrics';

export type HealthTone = 'success' | 'warning' | 'danger' | 'neutral';
export interface Reason { tone: 'warning' | 'danger'; text: string; go: string }
export interface Health { tone: HealthTone; label: string; reasons: Reason[] }

const rank: Record<HealthTone, number> = { neutral: 0, success: 1, warning: 2, danger: 3 };
/** One word per tone, everywhere (status bar, Home). Neutral means no reading yet. */
export const HEALTH_LABEL: Record<HealthTone, string> = { success: 'Healthy', warning: 'Needs attention', danger: 'Critical', neutral: '' };

export function overallHealth(snap: Snapshot, recentAlerts: number): Health {
  const state = systemState(value(snap, 'iris_system_state'));
  const reasons: Reason[] = [];
  if (state.tone === 'warning' || state.tone === 'danger') reasons.push({ tone: state.tone, text: `IRIS reports ${state.label.toLowerCase()}`, go: 'logs/alerts' });
  if (recentAlerts > 0) reasons.push({ tone: 'warning', text: `${recentAlerts} alert${recentAlerts === 1 ? '' : 's'} in the last 24 hours`, go: 'logs/alerts' });
  const used = value(snap, 'iris_license_consumed');
  const free = value(snap, 'iris_license_available');
  const total = used + free;
  if (Number.isFinite(total) && total > 0) {
    const pct = (used / total) * 100;
    if (free <= 0) reasons.push({ tone: 'danger', text: 'Every license unit is in use — new connections may be refused', go: 'home/overview' });
    else if (pct >= 80) reasons.push({ tone: 'warning', text: `License units ${Math.round(pct)}% used`, go: 'home/overview' });
  }
  const cpu = value(snap, 'iris_cpu_usage');
  if (cpu >= 95) reasons.push({ tone: 'danger', text: `Machine CPU at ${Math.round(cpu)}%`, go: 'operations/overview' });
  else if (cpu >= 80) reasons.push({ tone: 'warning', text: `Machine CPU at ${Math.round(cpu)}%`, go: 'operations/overview' });
  const mem = value(snap, 'iris_phys_mem_percent_used');
  if (mem >= 95) reasons.push({ tone: 'danger', text: `Memory at ${Math.round(mem)}%`, go: 'operations/overview' });
  else if (mem >= 85) reasons.push({ tone: 'warning', text: `Memory at ${Math.round(mem)}%`, go: 'operations/overview' });

  let tone: HealthTone = state.tone === 'neutral' ? 'neutral' : 'success';
  for (const r of reasons) if (rank[r.tone] > rank[tone]) tone = r.tone;
  // The label comes from the final tone only, so the same state always reads the same;
  // IRIS's own wording ("IRIS reports warning") is the first reason in the tooltip and on Home.
  const label = HEALTH_LABEL[tone] || state.label || 'Unknown';
  return { tone, label, reasons };
}
