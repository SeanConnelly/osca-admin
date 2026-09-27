// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tasks › Upcoming: New task — a four-step wizard in the detail drawer.
 *   1. What: the kind of task (IRIS's own task classes, or a class of your own),
 *      its name, namespace and description.
 *   2. When: the same schedule fields as Tasks › Schedule, with the next three
 *      runs worked out as you type.
 *   3. Options: who it runs as, what happens on an error, who is e-mailed.
 *   4. Review: everything in one list before it's created.
 * Creating goes through POST /v2/task (every field sent; exercised live on
 * osca_test_task_c… tasks, deleted afterwards). "After another task" isn't
 * offered: the API has no way to name the task it would follow.
 */
import '@evolution-ui/core/components/ev-wizard/ev-wizard.js';
import { createTask, type NewTaskBody } from '../api-web';
import { apiAvailable, getTaskClasses, type TaskClass, type TaskSetting } from '../api-osca';
import { settingKind, settingField, settingLabel, settingInitial, settingsFromForm, settingProblems, taskTypes, isSecretSetting } from '../task-settings';
import { getNamespaces } from '../api';
import { getUserList } from '../api-security';
import { esc } from '../ui';
import {
  editorShell, panelWidth, section, textField, pathField, passwordField, textareaField, selectField, checkField, readForm, fieldError, focusField, toast, errorText,
  type EditorHandle, type FieldProblem, type FormValues,
} from '../crud';
import { whenSections, whenBody, whenProblems, whenNext, whenSentence, runLabel, settleStart, syncWhen, NEW_WHEN } from './schedule';

/** IRIS's own task classes that make sense to schedule again, in plain words. */
const KINDS: Array<{ value: string; label: string; ns: string }> = [
  { value: '%SYS.Task.BackupAllDatabases', label: 'Back up every database', ns: '%SYS' },
  { value: '%SYS.Task.BackupFullDatabaseList', label: 'Full backup of the backup list', ns: '%SYS' },
  { value: '%SYS.Task.BackupIncrementDatabaseList', label: 'Incremental backup', ns: '%SYS' },
  { value: '%SYS.Task.BackupCumulativeDatabaseList', label: 'Cumulative backup', ns: '%SYS' },
  { value: '%SYS.Task.IntegrityCheck', label: 'Check database integrity', ns: '%SYS' },
  { value: '%SYS.Task.SwitchJournal', label: 'Switch the journal file', ns: '%SYS' },
  { value: '%SYS.Task.PurgeJournal', label: 'Purge old journal files', ns: '%SYS' },
  { value: '%SYS.Task.PurgeAudit', label: 'Purge old audit records', ns: '%SYS' },
  { value: '%SYS.Task.PurgeTaskHistory', label: 'Purge old task history', ns: '%SYS' },
  { value: '%SYS.Task.PurgeErrorsAndLogs', label: 'Purge the error log', ns: '%SYS' },
  { value: '%SYS.Task.PurgeBackupLog', label: 'Purge the backup log', ns: '%SYS' },
  { value: '%SYS.Task.CheckLogging', label: 'Check for logging left on', ns: '%SYS' },
  { value: '%SYS.Task.InventoryScan', label: 'Scan the system inventory', ns: '%SYS' },
  { value: '%SYS.Task.AutoStatsCollection', label: 'Collect SQL table statistics', ns: '%SYS' },
];
const CUSTOM = 'custom';
const STEPS = ['What', 'When', 'Options', 'Review'];
/** Which step each field lives on, so a problem can take the user to it. */
const STEP_OF: Record<string, number> = { Kind: 0, TaskClass: 0, Name: 0, NameSpace: 0, Description: 0, EmailDone: 2, EmailError: 2, RunAs: 2, OutputDir: 2, OutputFile: 2 };
const stepOf = (field: string): number => STEP_OF[field] ?? (field.startsWith('S_') ? 2 : 1);
const CLASS_NAME = /^%?[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)+$/;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const emails = (s: unknown): string[] => String(s ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

type WizardEl = HTMLElement & { active: number; next(): void; back(): void; goTo(i: number): void };

export interface NewTaskOptions {
  /** The detail drawer's <aside>. */
  host: HTMLElement;
  /** Its ev-detail-panel, widened while the wizard is open. */
  panel: HTMLElement & { open: boolean };
  /** Names already used, so a second task of the same name is caught before it's sent. */
  existingNames: string[];
  /** The signed-in user: the default "Runs as". */
  me: string;
  /** After IRIS has created it: select the row and open its detail. */
  onCreated: (id: number, name: string) => Promise<void>;
  /** Left without creating (after the discard guard). */
  onCancel: () => void;
}
export interface NewTaskHandle { editor: EditorHandle; dispose(): void }

export async function openNewTaskWizard(o: NewTaskOptions): Promise<NewTaskHandle | null> {
  let namespaces: string[];
  let users: string[];
  /**
   * With the OSCA API: every task type IRIS can run (TaskName, description,
   * namespace), system types first, hidden ones left out, each with its own
   * settings. Without it: the fixed list below plus "a class of your own".
   */
  let types: TaskClass[] | null = null;
  try {
    const typesP = apiAvailable().then((up) => (up ? getTaskClasses('all').then((l) => taskTypes(l.items)) : null)).catch(() => null);
    const [ns, us, ty] = await Promise.all([getNamespaces(), getUserList().catch(() => []), typesP]);
    types = ty && ty.length ? ty : null;
    namespaces = ns.map((n) => n.Name).sort((a, b) => (a === '%SYS' ? -1 : b === '%SYS' ? 1 : a.localeCompare(b)));
    users = us.map((u) => u.Name).sort((a, b) => a.localeCompare(b));
  } catch (err) { toast(errorText(err), 'danger'); return null; }
  if (o.me && !users.includes(o.me)) users.unshift(o.me);

  const restoreWidth = panelWidth(o.panel, 560);
  o.panel.open = true;
  const events = new AbortController();
  const sig = { signal: events.signal };
  const host = o.host;

  const typeOf = (cls: unknown): TaskClass | undefined => types?.find((t) => t.class === String(cls ?? ''));
  // Task types with a real name ("Purge Journal") come first, alphabetically; ones whose name is just their
  // class name ("%ZHSLIB.Services.…") follow, so the form never opens on an internal type.
  const plainName = (l: string): boolean => !/^%|^\S+\.\S+/.test(l);
  const kindOptions = types
    ? types.map((t) => ({ value: t.class, label: t.system ? t.taskName : `${t.taskName} · ${t.namespaces.join(', ')}` }))
      .sort((a, b) => Number(plainName(b.label)) - Number(plainName(a.label)) || a.label.localeCompare(b.label))
    : [...KINDS.map((k) => ({ value: k.value, label: k.label })), { value: CUSTOM, label: 'A task class of your own' }];
  const what = section('The task',
    selectField('Kind', types ? 'Task type' : 'What it does', kindOptions, kindOptions[0].value, { searchable: true }) +
    '<p class="web-preview" id="tw-kind-desc" aria-live="polite"></p>' +
    `<div data-tw-custom hidden>${textField('TaskClass', 'Task class', '', { mono: true, placeholder: 'e.g. MyApp.Tasks.Nightly', hint: 'A class that extends %SYS.Task.Definition, in the namespace below.' })}</div>` +
    textField('Name', 'Name', '', { required: true, maxlength: 128, hint: 'How it appears in Upcoming, Schedule and History.' }) +
    selectField('NameSpace', 'Namespace', namespaces.map((n) => ({ value: n, label: n })), '%SYS', { searchable: namespaces.length > 8, hint: 'Where it runs. IRIS’s own tasks run in %SYS.' }) +
    textareaField('Description', 'Description', '', { rows: 2, maxlength: 256 }));
  const options = '<div id="tw-settings"></div>' + section('Runs as',
      selectField('RunAs', 'User', users.map((u) => ({ value: u, label: u === o.me ? `${u} (you)` : u })), o.me || users[0] || '', { searchable: users.length > 8, hint: 'The task runs with this user’s roles.' })) +
    section('If something goes wrong',
      checkField('SuspendOnError', 'Suspend the task if a run fails', false, { hint: 'It stays suspended until someone resumes it.' }) +
      checkField('Reschedule', 'Run when IRIS starts if a run was missed while it was down', false)) +
    section('Output',
      `<div class="crud-row">${pathField('OutputDir', 'Save output in', '', { mode: 'dir', title: 'Choose the folder for the task’s output', placeholder: 'Not saved', hint: 'Optional. A folder on the server.' })}${
        textField('OutputFile', 'File name', '', { mono: true, placeholder: 'e.g. nightly.log', hint: 'In that folder.' })}</div>`) +
    section('E-mail',
      textField('EmailDone', 'When it finishes', '', { placeholder: 'name@example.com', hint: 'Separate several addresses with commas.' }) +
      textField('EmailError', 'When it fails', '', { placeholder: 'name@example.com', hint: 'Needs the Task Manager’s e-mail settings to be set up.' }));

  const editor = editorShell(host, {
    title: 'New task',
    name: 'the new task',
    submitLabel: 'Next',
    submitAlways: true,
    sections: `<ev-wizard class="tw" id="tw" linear label="New task">
        ${STEPS.map((label, i) => `<ev-wizard-step label="${label}">${
          i === 0 ? what : i === 1 ? whenSections(NEW_WHEN) : i === 2 ? options : '<div class="tw-review" id="tw-review"></div>'}</ev-wizard-step>`).join('')}
      </ev-wizard>`,
    check: () => problems(readForm(host)),
    onSubmit: async (v) => {
      const body = bodyOf(v);
      const id = await createTask(body);
      done();
      await o.onCreated(id, body.Name);
      toast(body.TimePeriod === 'On Demand' ? `${body.Name} created. It runs when someone starts it.`
        : `${body.Name} created.${firstRun(v) ? ` First run ${firstRun(v)}.` : ''}`);
    },
    onCancel: () => { done(); o.onCancel(); },
  });
  const form = editor.form;
  const wizard = host.querySelector('#tw') as WizardEl;
  const submit = form.querySelector('.crud-submit') as HTMLButtonElement;
  const submitText = submit.querySelector('span') as HTMLElement;
  const back = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: 'Back' });
  back.id = 'tw-back';
  submit.before(back);

  const done = (): void => { events.abort(); restoreWidth(); };

  /** The chosen output folder, with a trailing separator as IRIS stores it. */
  const outDir = (v: FormValues): string => {
    const d = String(v.OutputDir ?? '').trim();
    const sep = d.includes('\\') && !d.includes('/') ? '\\' : '/';
    return !d || /[\\/]$/.test(d) ? d : `${d}${sep}`;
  };
  const taskClass = (v: FormValues): string => (String(v.Kind) === CUSTOM ? String(v.TaskClass ?? '').trim() : String(v.Kind ?? ''));

  /** One field per setting of the chosen type: its type, default, required flag and value list decide the control. */
  const settingHtml = (s: TaskSetting): string => {
    const f = settingField(s);
    const label = settingLabel(s.name);
    const hint = s.description.length > 160 ? `${s.description.slice(0, 157)}…` : s.description;
    const init = settingInitial(s);
    switch (settingKind(s)) {
      case 'bool': return checkField(f, label, !!init, { hint: hint || undefined });
      case 'list': return selectField(f, label, (s.valueList ?? []).map((val, i) => ({ value: val, label: s.displayList?.[i] || val || '—' })), String(init), { hint: hint || undefined, required: s.required });
      case 'secret': return passwordField(f, label, { hint: `${hint ? `${hint} ` : ''}Write-only: it’s sent once and never shown again.`, required: s.required });
      case 'dir': return pathField(f, label, String(init), { mode: 'dir', title: `Choose ${label.toLowerCase()}`, hint: hint || undefined, required: s.required });
      case 'file': return pathField(f, label, String(init), { mode: 'file', title: `Choose ${label.toLowerCase()}`, hint: hint || undefined, required: s.required });
      case 'int': return textField(f, label, String(init), { width: 'sm', hint: hint || undefined, required: s.required });
      default: return textField(f, label, String(init), { hint: hint || (s.defaultExpression ? 'Leave empty for the default.' : undefined), required: s.required, mono: /code|class|routine/i.test(s.name) });
    }
  };
  let settingsFor = '';
  /** Re-render the Options step's settings when the type changes (and describe the type under its select). */
  const renderType = (): void => {
    const v = readForm(host);
    const t = typeOf(v.Kind);
    const desc = host.querySelector('#tw-kind-desc') as HTMLElement | null;
    if (desc) desc.textContent = t ? [t.description, t.system ? '' : `Only in ${t.namespaces.join(', ')}.`, t.permitted ? '' : `Needs ${t.resource}, which you don’t hold.`].filter(Boolean).join(' ') : '';
    const key = t ? t.class : '';
    if (key === settingsFor) return;
    settingsFor = key;
    const box = host.querySelector('#tw-settings') as HTMLElement | null;
    if (!box) return;
    box.innerHTML = t && t.settings.length ? section(`${t.taskName} settings`, t.settings.map(settingHtml).join('')) : '';
    editor.refresh();
  };
  const firstRun = (v: FormValues): string => { const n = whenNext(v, NEW_WHEN, 1)[0]; return n ? runLabel(n) : ''; };

  function problems(v: FormValues): FieldProblem[] {
    const out: FieldProblem[] = [];
    const name = String(v.Name ?? '').trim();
    if (String(v.Kind) === CUSTOM) {
      const c = String(v.TaskClass ?? '').trim();
      if (!c) out.push({ field: 'TaskClass', label: 'Task class', message: 'Enter the class name' });
      else if (!CLASS_NAME.test(c)) out.push({ field: 'TaskClass', label: 'Task class', message: 'Give the full class name, e.g. MyApp.Tasks.Nightly' });
    }
    if (!name) out.push({ field: 'Name', label: 'Name', message: 'Enter a name' });
    else if (o.existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) out.push({ field: 'Name', label: 'Name', message: 'A task with this name already exists' });
    if (!String(v.NameSpace ?? '')) out.push({ field: 'NameSpace', label: 'Namespace', message: 'Choose a namespace' });
    const ty = typeOf(v.Kind);
    if (ty && !ty.permitted) out.push({ field: 'Kind', label: 'Task type', message: `Needs ${ty.resource}, which you don’t hold` });
    if (ty && !ty.system && !ty.namespaces.includes(String(v.NameSpace ?? ''))) out.push({ field: 'NameSpace', label: 'Namespace', message: `This task type is only in ${ty.namespaces.join(', ')}` });
    if (ty) out.push(...settingProblems(ty, v));
    out.push(...whenProblems(v));
    const file = String(v.OutputFile ?? '').trim();
    if (file && /[\\/]/.test(file)) out.push({ field: 'OutputFile', label: 'File name', message: 'Just the file name; choose the folder above' });
    else if (file && !String(v.OutputDir ?? '').trim()) out.push({ field: 'OutputDir', label: 'Save output in', message: 'Choose a folder for the file' });
    for (const f of ['EmailDone', 'EmailError'] as const) {
      const bad = emails(v[f]).find((e) => !EMAIL.test(e));
      if (bad) out.push({ field: f, label: f === 'EmailDone' ? 'E-mail when it finishes' : 'E-mail when it fails', message: `“${bad}” isn’t an e-mail address` });
    }
    return out;
  }

  function bodyOf(v: FormValues): NewTaskBody {
    const when = settleStart(whenBody(v), NEW_WHEN);
    return {
      Name: String(v.Name ?? '').trim(), Description: String(v.Description ?? '').trim(),
      TaskClass: taskClass(v), NameSpace: String(v.NameSpace ?? '%SYS'), RunAsUser: String(v.RunAs ?? ''), Priority: 'Normal',
      ...when,
      TimePeriodDay: when.TimePeriod === 'Daily' || when.TimePeriod === 'On Demand' ? '' : when.TimePeriodDay,
      StartDate: when.TimePeriod === 'On Demand' ? '' : when.StartDate,
      RunAfterGUID: '', MirrorStatus: 'Any',
      EmailOnCompletion: emails(v.EmailDone), EmailOnError: emails(v.EmailError), EmailOnExpiration: [], EmailOutput: false,
      Expires: false, ExpiresDays: '', ExpiresHours: '', ExpiresMinutes: '',
      // Output goes to a file only when a folder is chosen; without a file name IRIS names it itself.
      OpenOutputFile: !!outDir(v), OutputDirectory: outDir(v), OutputFilename: outDir(v) ? String(v.OutputFile ?? '').trim() : '', OutputFileIsBinary: false,
      SuspendOnError: !!v.SuspendOnError, SuspendTerminated: false, IsBatch: false, RescheduleOnStart: !!v.Reschedule,
      ...(typeOf(v.Kind)?.settings.length ? { Settings: settingsFromForm(typeOf(v.Kind) as TaskClass, v) } : {}),
    };
  }

  // ── Steps: Next checks the step it leaves; the last step's button creates the task ──
  let shown = new Set<string>();
  const showStep = (step: number, v = readForm(host)): FieldProblem[] => {
    const list = problems(v).filter((p) => stepOf(p.field) === step);
    for (const f of shown) if (!list.some((p) => p.field === f)) fieldError(host, f, null);
    for (const p of list) fieldError(host, p.field, p.message);
    shown = new Set([...[...shown].filter((f) => stepOf(f) !== step), ...list.map((p) => p.field)]);
    return list;
  };
  const renderReview = (): void => {
    const v = readForm(host);
    const row = (k: string, val: string): string => `<div class="kv"><dt>${esc(k)}</dt><dd>${val || '<span class="dim">—</span>'}</dd></div>`;
    const ty = typeOf(v.Kind);
    const kind = ty ? esc(ty.taskName) : String(v.Kind) === CUSTOM ? `<span class="mono">${esc(taskClass(v))}</span>` : esc(KINDS.find((k) => k.value === v.Kind)?.label ?? '');
    // Settings as they'll be saved; a secret only says whether it's set.
    const settingRows = ty ? ty.settings.map((s) => {
      const val = v[settingField(s)];
      const shownVal = isSecretSetting(s) ? (String(val ?? '') ? 'Set · hidden' : 'Not set')
        : settingKind(s) === 'bool' ? (val ? 'Yes' : 'No') : String(val ?? '').trim() || '—';
      return row(settingLabel(s.name), esc(shownVal));
    }).join('') : '';
    const next = whenNext(v, NEW_WHEN, 3);
    const done2 = emails(v.EmailDone), fail = emails(v.EmailError);
    (host.querySelector('#tw-review') as HTMLElement).innerHTML = `
      <dl class="kv-list tw-review-list">
        ${row('Name', esc(String(v.Name ?? '').trim()))}
        ${row('What it does', kind)}
        ${row('Namespace', `<span class="mono">${esc(String(v.NameSpace ?? ''))}</span>`)}
        ${row('When', esc(whenSentence(v, NEW_WHEN)))}
        ${row('Next runs', next.map((x) => esc(runLabel(x))).join('<br>'))}
        ${row('Runs as', esc(String(v.RunAs ?? '')))}
        ${settingRows}
        ${row('If a run fails', v.SuspendOnError ? 'Suspend the task' : 'Keep the schedule')}
        ${row('Missed while IRIS was down', v.Reschedule ? 'Run when IRIS starts' : 'Wait for the next time')}
        ${row('Output', outDir(v) ? `<span class="mono">${esc(outDir(v) + String(v.OutputFile ?? '').trim())}</span>` : '<span class="dim">Not saved</span>')}
        ${row('E-mail when it finishes', done2.map(esc).join('<br>'))}
        ${row('E-mail when it fails', fail.map(esc).join('<br>'))}
        ${String(v.Description ?? '').trim() ? row('Description', esc(String(v.Description).trim())) : ''}
      </dl>
      <p class="tw-review-note">The task starts ${String(v.Period) === 'On Demand' ? 'only when someone runs it' : 'at its first run'}. Change it later from Upcoming or Schedule.</p>`;
  };
  const syncFooter = (): void => {
    const i = wizard.active ?? 0;
    back.hidden = i === 0;
    submitText.textContent = i === STEPS.length - 1 ? 'Create task' : 'Next';
    if (i === STEPS.length - 1) renderReview();
  };

  // Next and Create both arrive as the form's submit. Only Create reaches editorShell's own handler.
  form.addEventListener('submit', (e) => {
    const i = wizard.active ?? 0;
    const all = problems(readForm(host));
    const last = i === STEPS.length - 1;
    if (last && !all.length) return; // editorShell creates it
    e.preventDefault();
    e.stopImmediatePropagation();
    if (last) {
      const s = stepOf(all[0].field);
      wizard.goTo(s);
      requestAnimationFrame(() => { showStep(s); focusField(host, all[0].field); });
      return;
    }
    const here = showStep(i);
    if (here.length) { focusField(host, here[0].field); return; }
    wizard.next();
  }, { capture: true, signal: events.signal });
  back.addEventListener('click', () => wizard.back(), sig);
  // Clicking a step in the indicator: moving on is checked like Next; going back is always allowed.
  wizard.addEventListener('ev-wizard-before-change', (e) => {
    const { from, to } = (e as CustomEvent<{ from: number; to: number }>).detail;
    if (to <= from) return;
    const here = showStep(from);
    if (here.length) { e.preventDefault(); focusField(host, here[0].field); }
  }, sig);
  wizard.addEventListener('ev-wizard-step-change', () => { syncFooter(); requestAnimationFrame(() => editor.refresh()); }, sig);

  const sync = (): void => {
    const v = readForm(host);
    const custom = String(v.Kind) === CUSTOM;
    (host.querySelector('[data-tw-custom]') as HTMLElement).hidden = !custom;
    renderType();
    syncWhen(host, NEW_WHEN, 3);
    // Problems already shown clear as they're fixed.
    if (shown.size) showStep(wizard.active ?? 0, v);
  };
  // A kind's namespace follows it until the user picks one.
  let nsTouched = false;
  host.addEventListener('ev-select-change', (e) => {
    const t = e.target as HTMLElement;
    // Setting the value from code raises no change event, so any change seen here is the user's.
    if (t.getAttribute('name') === 'NameSpace') nsTouched = true;
    if (t.getAttribute('name') === 'Kind') {
      const value = (t as HTMLElement & { value: string }).value;
      const ty = typeOf(value);
      const ns = host.querySelector<HTMLElement & { value: string }>('ev-select[name="NameSpace"]');
      // A type found only in some namespaces always moves the namespace there; otherwise it follows until the user picks one.
      if (ns && ty && !ty.system && !ty.namespaces.includes(ns.value)) ns.value = ty.namespaces[0] ?? ns.value;
      else if (ns && !nsTouched) {
        const k = KINDS.find((x) => x.value === value);
        ns.value = ty ? '%SYS' : k ? k.ns : namespaces.includes('USER') ? 'USER' : ns.value;
      }
    }
  }, sig);
  for (const ev of ['ev-select-change', 'ev-input-input', 'ev-date-picker-change', 'ev-checkbox-change', 'change', 'input']) host.addEventListener(ev, sync, sig);
  customElements.whenDefined('ev-wizard').then(() => { syncFooter(); sync(); }).catch(() => { /* the wizard renders on its own */ });
  syncFooter();
  sync();
  return { editor, dispose: done };
}
