// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A task type's settings (from the OSCA API's task-class list) as form data,
 * with no DOM: which kind of field each setting gets, what the form's values
 * send as the task's Settings, and what to fix first. Kept free of imports
 * that touch the page, so the same code runs in the controlled create test.
 */
import type { TaskClass, TaskSetting } from './api-osca';

export type SettingKind = 'bool' | 'int' | 'list' | 'secret' | 'dir' | 'file' | 'text';

/** Settings that hold a secret are write-only: a password field that is never pre-filled or shown back. */
export const isSecretSetting = (s: Pick<TaskSetting, 'name' | 'type'>): boolean =>
  /pass(word|wd)?$|pass(word)?[A-Z_]|secret|token|credential|apikey|privatekey/i.test(s.name) || /\.Password$/i.test(s.type);

export function settingKind(s: TaskSetting): SettingKind {
  if (isSecretSetting(s)) return 'secret';
  if (/%Library\.Boolean$|%Boolean$/i.test(s.type)) return 'bool';
  if (s.valueList?.length) return 'list';
  if (/%Library\.(Integer|SmallInt|TinyInt|BigInt)$|%Integer$/i.test(s.type)) return 'int';
  if (/(Directory|Dir|Folder)$/.test(s.name)) return 'dir';
  if (/(File|Filename|FileName|Path)$/.test(s.name)) return 'file';
  return 'text';
}

/** The form field that holds a setting ("S_KeepDays"). */
export const settingField = (s: Pick<TaskSetting, 'name'>): string => `S_${s.name}`;

/** "KeepDays" → "Keep days", "SMTPServer" → "SMTP server", "zInfoCPUDetails" → "Info CPU details". */
export function settingLabel(name: string): string {
  const s = name.replace(/^z+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/ ([A-Z][a-z])/g, (m) => m.toLowerCase());
}

/** The value a setting's field starts with: its literal default (never for a secret). */
export function settingInitial(s: TaskSetting): string | boolean {
  const k = settingKind(s);
  if (k === 'secret') return '';
  if (k === 'bool') return String(s.default) === '1' || String(s.default).toLowerCase() === 'true';
  return s.default === undefined || s.default === null ? '' : String(s.default);
}

/**
 * The task's Settings from the form: every setting the type has, typed as
 * IRIS expects (booleans 1/0, integers as numbers). A secret left empty is
 * left out, so nothing is set; an empty optional value is left out too, so
 * the class's own default (including computed ones) applies.
 */
export function settingsFromForm(tc: TaskClass, v: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const s of tc.settings) {
    const raw = v[settingField(s)];
    const k = settingKind(s);
    if (k === 'bool') { out[s.name] = raw ? 1 : 0; continue; }
    const text = String(raw ?? '').trim();
    if (!text) continue;
    out[s.name] = k === 'int' ? Number(text) : text;
  }
  return out;
}

/** What to fix before the task can be created: required values, whole numbers, limits, value lists. */
export function settingProblems(tc: TaskClass, v: Record<string, unknown>): Array<{ field: string; label: string; message: string }> {
  const out: Array<{ field: string; label: string; message: string }> = [];
  for (const s of tc.settings) {
    const k = settingKind(s);
    if (k === 'bool') continue;
    const field = settingField(s);
    const label = settingLabel(s.name);
    const text = String(v[field] ?? '').trim();
    if (!text) {
      if (s.required && !s.defaultExpression) out.push({ field, label, message: 'Required' });
      continue;
    }
    if (k === 'int') {
      if (!/^-?\d+$/.test(text)) { out.push({ field, label, message: 'Enter a whole number' }); continue; }
      const n = Number(text);
      if (s.minval !== undefined && s.minval !== '' && n < Number(s.minval)) out.push({ field, label, message: `${s.minval} or more` });
      else if (s.maxval !== undefined && s.maxval !== '' && n > Number(s.maxval)) out.push({ field, label, message: `${s.maxval} or less` });
    }
    if (k === 'list' && s.valueList && !s.valueList.includes(text)) out.push({ field, label, message: 'Choose one of the listed values' });
    if (s.maxlen && text.length > Number(s.maxlen)) out.push({ field, label, message: `${s.maxlen} characters at most` });
  }
  return out;
}

/** The types a new task can be: hidden ones left out, IRIS's own first, then by name. */
export function taskTypes(items: TaskClass[]): TaskClass[] {
  return items.filter((t) => !t.hidden).sort((a, b) => Number(b.system) - Number(a.system) || a.taskName.localeCompare(b.taskName));
}
