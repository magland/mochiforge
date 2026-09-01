import { ansiLineHtml, stripAnsi } from '../ansi';
import { Html, html, joinHtml, raw } from '../html';
import { IconName, icon } from '../icons';
import { formatSize, timeTag } from '../render';
import { Viewer } from '../session';
import { adminShell } from '../forms';
import { RepoCtx, copyRow, csrfField, encPath, layout, repoHeader, repoOpts, repoUrl, userLink } from '../views';
import { ArtifactInfo } from './artifacts';
import { DispatchableWorkflow } from './engine';
import { isManualJob } from './manual';
import { JobRecord, RunRecord, StepState } from './runs';
import { DEFAULT_JOB_TIMEOUT_MINUTES, MAX_JOB_TIMEOUT_MINUTES } from './runners';

// The Actions pages: the runs list, one run with its jobs and logs, and the
// runner listing under Admin. Same conventions as the rest of the interface:
// the html`` tag, which escapes what it interpolates, and no client
// framework. The one piece of script is the log tailer on a running job.

type Status = 'queued' | 'running' | 'success' | 'failure' | 'cancelled' | 'skipped';

function statusOf(x: { status: string; conclusion?: string }): Status {
  if (x.status !== 'completed') return x.status === 'running' ? 'running' : 'queued';
  const c = x.conclusion;
  if (c === 'success' || c === 'failure' || c === 'cancelled' || c === 'skipped') return c;
  return 'failure';
}

const STATUS_LABEL: Record<Status, string> = {
  queued: 'Queued',
  running: 'Running',
  success: 'Success',
  failure: 'Failure',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

// The status glyphs are the ringed ones from icons.ts: a tick in a ring for
// success, a cross in a ring for failure, a turning arc while a job runs, and
// grey for the states where nothing happened. Ringed rather than filled, so a
// column of them reads at the weight of the text beside it.
const STATUS_ICON: Record<Status, IconName> = {
  queued: 'clock',
  running: 'sync',
  success: 'check-circle',
  failure: 'x-circle',
  cancelled: 'stop',
  skipped: 'skip',
};

function statusIcon(s: Status): Html {
  return html`<span class="run-status ${s}" title="${STATUS_LABEL[s]}" aria-label="${STATUS_LABEL[s]}" role="img">${icon(
    STATUS_ICON[s]
  )}</span>`;
}

function duration(from?: string, to?: string): string {
  if (!from) return '';
  const start = new Date(from).getTime();
  const end = to ? new Date(to).getTime() : Date.now();
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function runTitle(run: RunRecord): string {
  if (run.message) return run.message;
  if (run.event === 'workflow_dispatch') return `${run.workflowName} (manual)`;
  return run.workflowName;
}

// ---- the runs list ----

export function runsPage(
  ctx: RepoCtx,
  runs: RunRecord[],
  workflows: DispatchableWorkflow[],
  selectedWorkflow: string | null,
  flash?: string
): string {
  const base = repoUrl(ctx);
  const actionsBase = `${base}/actions`;

  const rows = runs.map((r) => {
    const s = statusOf(r);
    const when = r.createdAt ? timeTag(r.createdAt) : '';
    const dur = duration(r.startedAt, r.completedAt);
    const sha = r.sha
      ? html` <a class="sha" href="${base}/commit/${r.sha}">${r.sha.slice(0, 7)}</a>`
      : '';
    return html`<tr>
<td class="run-cell">${statusIcon(s)}<span><a href="${actionsBase}/runs/${r.number}"><b>${runTitle(r)}</b></a>
<div class="muted small run-sub">${r.workflowName} #${r.number}: ${r.event} by ${userLink(r.actor, { face: 16 })}${sha}</div></span></td>
<td class="right muted small"><span class="chip">${icon('git-branch')}${r.refName}</span></td>
<td class="right muted small">${when}${dur ? html` &middot; ${dur}` : ''}</td>
</tr>`;
  });

  // GitHub lists the workflows down the side of the runs, which is both the
  // filter and the answer to "what can this repository do".
  const sidebar = workflows.length
    ? html`<aside class="wf-side"><div class="side-block"><h3>${icon(
        'workflow'
      )}Workflows</h3><div class="side-links">${[
        html`<a class="${selectedWorkflow === null ? 'current' : ''}" href="${actionsBase}">${icon(
          'history'
        )}<span>All workflows</span></a>`,
        ...workflows.map(
          (w) =>
            html`<a class="${
              selectedWorkflow === w.path ? 'current' : ''
            }" href="${actionsBase}?workflow=${encodeURIComponent(w.path)}" title="${w.path}">${icon('play')}<span>${
              w.name
            }</span></a>`
        ),
      ]}</div></div></aside>`
    : '';

  const brokenList = workflows.filter((w) => w.error);
  const broken = brokenList.length
    ? html`<div class="form-error">${brokenList.map((w) => html`<div>${w.path}: ${w.error!}</div>`)}</div>`
    : '';

  const dispatchable = workflows.filter((w) => w.dispatch !== null);
  const dispatchForm =
    ctx.canPush && ctx.viewer && dispatchable.length
      ? dispatchBox(ctx, ctx.viewer, dispatchable)
      : '';

  const body = runs.length
    ? html`<table class="listing runs"><tbody>${rows}</tbody></table>`
    : html`<div class="empty-state"><p><b>No workflow runs yet.</b></p><p class="muted">Runs appear here when a push matches a workflow in <code>.github/workflows</code> or <code>.mochi/workflows</code>.</p><p class="muted small">Workflows run without credentials: this vault holds no secrets, and a workflow that references <code>secrets.*</code> is refused with a message saying so.</p></div>`;

  const content = html`${repoHeader(ctx, 'actions')}
${flash ? html`<div class="flash">${flash}</div>` : ''}
${broken}
<div class="page-head"><h2>Workflow runs</h2>${dispatchForm}</div>
<div class="actions-layout">${sidebar}<div class="actions-main">${body}</div></div>`;
  return layout(`Actions - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, actionsBase));
}

function dispatchBox(ctx: RepoCtx, viewer: Viewer, workflows: DispatchableWorkflow[]): Html {
  const base = repoUrl(ctx);
  const panels = workflows.map((w, i) => {
    const inputs = Object.entries(w.dispatch ?? {}).map(([name, def]) => {
      const id = `wf${i}-${name}`;
      const label = html`<label for="${id}">${name}${def.required ? ' *' : ''}</label>`;
      const help = def.description ? html`<p class="muted small">${def.description}</p>` : '';
      if (def.type === 'choice' && def.options?.length) {
        const opts = def.options.map(
          (o) => html`<option value="${o}"${String(def.default ?? '') === o ? raw(' selected') : ''}>${o}</option>`
        );
        return html`<div class="field">${label}<select id="${id}" name="input.${name}">${opts}</select>${help}</div>`;
      }
      if (def.type === 'boolean') {
        return html`<div class="field"><label class="checkbox"><input type="checkbox" id="${id}" name="input.${name}" value="true"${
          def.default === true || def.default === 'true' ? raw(' checked') : ''
        }> ${name}</label>${help}</div>`;
      }
      return html`<div class="field">${label}<input type="text" id="${id}" name="input.${name}" value="${
        def.default ?? ''
      }"${def.required ? raw(' required') : ''}>${help}</div>`;
    });
    const refOptions = ctx.branches.map(
      (b) => html`<option value="${b.name}"${b.name === ctx.defaultBranch ? raw(' selected') : ''}>${b.name}</option>`
    );
    return html`<form method="post" action="${base}/actions/dispatch" class="dispatch-panel" data-wf="${w.path}"${
      i === 0 ? '' : raw(' hidden')
    }>
${csrfField(viewer)}
<input type="hidden" name="workflow" value="${w.path}">
<div class="field"><label>Use branch</label><select name="ref">${refOptions}</select></div>
${inputs}
<button type="submit" class="btn btn-primary">Run workflow</button>
</form>`;
  });
  const picker =
    workflows.length > 1
      ? html`<div class="field"><label>Workflow</label><select data-workflow-picker>${workflows.map(
          (w) => html`<option value="${w.path}">${w.name}</option>`
        )}</select></div>`
      : '';
  return html`<details class="dropdown dispatch">
<summary class="btn">${icon('play')}<span>Run workflow</span>${icon('chevron-down', 'caret')}</summary>
<div class="dropdown-menu dd-right dispatch-body">${picker}${panels}</div>
</details>`;
}

// ---- one run ----

// The runner logs its own setup and cleanup against step index -1, which is
// not a workflow step at all; it gets its own block rather than being
// mistaken for one.
function stepBlocks(job: JobRecord, logLines: { s: number; l: string }[]): Html | '' {
  const byStep = new Map<number, string[]>();
  for (const line of logLines) {
    if (!byStep.has(line.s)) byStep.set(line.s, []);
    byStep.get(line.s)!.push(line.l);
  }
  const states: StepState[] = job.stepStates ?? [];
  const indices = new Set<number>([...byStep.keys(), ...states.map((_, i) => i)]);
  const ordered = [...indices].sort((a, b) => a - b);
  if (ordered.length === 0) return '';
  // ansiLineHtml escapes the log text itself and adds only its own spans, so
  // a rendered line is HTML by the time it lands here.
  const log = (lines: string[]) => raw(lines.map((l) => ansiLineHtml(l)).join('\n'));
  return joinHtml(
    ordered.map((i) => {
      const lines = byStep.get(i) ?? [];
      if (i < 0) {
        return html`<details class="step">
<summary><span class="run-status queued" aria-hidden="true">&middot;</span><span class="step-name">Runner</span></summary>
<pre class="joblog">${log(lines)}</pre>
</details>`;
      }
      const st = states[i];
      const name = st?.name ?? `Step ${i + 1}`;
      const s: Status = st ? statusOf({ status: st.status, conclusion: st.conclusion }) : 'queued';
      const open = s === 'failure' || s === 'running';
      return html`<details class="step"${open ? raw(' open') : ''}>
<summary>${statusIcon(s)}<span class="step-name">${name}</span><span class="muted small">${duration(
        st?.startedAt,
        st?.completedAt
      )}</span></summary>
<pre class="joblog">${log(lines)}</pre>
</details>`;
    })
  );
}

export function runPage(
  ctx: RepoCtx,
  run: RunRecord,
  jobs: JobRecord[],
  selected: JobRecord | null,
  logLines: { s: number; l: string }[],
  logOffset: number,
  artifacts: ArtifactInfo[] = []
): string {
  const base = repoUrl(ctx);
  const actionsBase = `${base}/actions`;
  const runBase = `${actionsBase}/runs/${run.number}`;
  const s = statusOf(run);
  const viewer = ctx.viewer;

  const jobList = jobs.map((j) => {
    const js = statusOf(j);
    const current = selected && j.id === selected.id;
    return html`<a class="job-item${current ? ' current' : ''}" href="${runBase}?job=${encodeURIComponent(
      j.id
    )}">${statusIcon(js)}<span>${j.name}</span><span class="muted small">${duration(
      j.startedAt,
      j.completedAt
    )}</span></a>`;
  });

  let detail: Html;
  if (run.error) {
    detail = html`<div class="form-error"><b>${run.workflowPath}</b> could not be used: ${run.error}</div>`;
  } else if (!selected) {
    detail = html`<div class="empty-state">This run has no jobs.</div>`;
  } else if (selected.error && selected.stepStates.length === 0) {
    detail = html`<div class="form-error">${selected.error}</div>`;
  } else {
    const js = statusOf(selected);
    const live = js === 'running' || js === 'queued';
    const summaries = (selected.summaries ?? []).filter((x) => x.trim() !== '');
    const summaryBox = summaries.length
      ? html`<div class="box"><div class="box-header">Summary</div><div class="box-body"><pre class="joblog">${summaries.join(
          '\n'
        )}</pre></div></div>`
      : '';
    const errorBox = selected.error ? html`<div class="form-error">${selected.error}</div>` : '';
    // The audit line for a job that executed through a pasted command: who
    // authorized it and where it said it ran. The host is what the session
    // reported about itself, so it is presented as a report, not a finding.
    const manualBy = selected.manual
      ? html` <span class="muted small">&middot; run manually by ${selected.manual.user}${
          selected.manual.host ? html` on ${selected.manual.host}` : ''
        }</span>`
      : '';
    if (live) {
      // The tailer appends as textContent, so a live log is stripped of
      // escapes rather than coloured; colour arrives with the step view when
      // the job completes and the page reloads into it.
      const initial = logLines.map((l) => stripAnsi(l.l)).join('\n');
      // The endpoint and the offset ride on the element rather than in a
      // script, which is what lets /assets/page.js stay one cacheable file
      // and this page carry no executable markup; the tailer there picks
      // them up.
      const waitingFor = isManualJob(selected.runsOn)
        ? ctx.canPush
          ? 'waiting for someone to run it (Run it yourself, above)'
          : 'waiting for someone to run it'
        : 'waiting for a runner';
      detail = html`${errorBox}<div class="job-head"><b>${selected.name}</b> ${statusIcon(js)} <span class="muted small">${
        js === 'queued' ? waitingFor : 'running'
      }</span>${manualBy}</div>
<pre class="joblog live" id="livelog" data-log-url="${runBase}/log/${encodeURIComponent(
        selected.id
      )}" data-log-offset="${logOffset}">${initial}</pre>`;
    } else {
      const rawLink = html`<a class="btn raw-log-link" href="${runBase}/log/${encodeURIComponent(
        selected.id
      )}/raw" title="Download the log as the runner wrote it">Raw log</a>`;
      detail = html`${errorBox}<div class="job-head"><b>${selected.name}</b> ${statusIcon(js)} <span class="muted small">${duration(
        selected.startedAt,
        selected.completedAt
      )}</span>${manualBy}${rawLink}</div>
${stepBlocks(selected, logLines)}
${summaryBox}`;
    }
  }

  const canOperate = ctx.canPush && viewer;
  // Offered while a manual job is waiting: the command that runs this run's
  // manual jobs on a machine of the viewer's. Minting is a POST because it
  // issues a credential; the token appears on the page it lands on and
  // nowhere else.
  const manualWaiting = jobs.some((j) => isManualJob(j.runsOn) && j.status === 'queued');
  const execBtn =
    canOperate && run.status !== 'completed' && manualWaiting
      ? html`<form method="post" action="${runBase}/exec-command">${csrfField(
          viewer!
        )}<button type="submit" class="btn btn-primary" title="Get a command that runs this run's manual jobs on a machine of yours">Run it yourself</button></form>`
      : '';
  const cancelBtn =
    canOperate && run.status !== 'completed'
      ? html`<form method="post" action="${runBase}/cancel">${csrfField(
          viewer!
        )}<button type="submit" class="btn btn-danger-outline">Cancel run</button></form>`
      : '';
  const rerunBtn = canOperate
    ? html`<form method="post" action="${runBase}/rerun">${csrfField(
        viewer!
      )}<button type="submit" class="btn">Re-run</button></form>`
    : '';

  const artifactBox = artifacts.length
    ? html`<div class="box artifacts"><div class="box-header">Artifacts</div><div class="box-body">${artifacts.map(
        (a) =>
          html`<a class="artifact" href="${runBase}/artifacts/${encodeURIComponent(a.name)}"><b>${
            a.name
          }</b><span class="muted small">${formatSize(a.size)}</span></a>`
      )}<p class="muted small">Artifacts are tar archives, and are removed when the run is pruned.</p></div></div>`
    : '';

  const content = html`${repoHeader(ctx, 'actions')}
<div class="run-head">
  <div class="run-title">${statusIcon(s)}<h2>${runTitle(run)}</h2></div>
  <div class="right-group">${execBtn}${rerunBtn}${cancelBtn}</div>
</div>
<div class="run-meta muted small">
  <a href="${actionsBase}?workflow=${encodeURIComponent(run.workflowPath)}">${run.workflowName}</a>
  &middot; #${run.number}
  &middot; ${run.event} by <span class="run-actor">${userLink(run.actor, { face: 16 })}</span>
  &middot; <span class="chip">${run.refName}</span>
  ${run.sha ? html`&middot; <a class="sha" href="${base}/commit/${run.sha}">${run.sha.slice(0, 7)}</a>` : ''}
  &middot; <a href="${base}/blob/${encPath(run.refName)}/${encPath(run.workflowPath)}">${run.workflowPath}</a>
  ${run.createdAt ? html`&middot; ${timeTag(run.createdAt, '')}` : ''}
</div>
<div class="run-body">
  <div class="job-list">${jobList}</div>
  <div class="job-detail">${detail}</div>
</div>
${artifactBox}`;
  return layout(`${runTitle(run)} - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, runBase));
}

/**
 * The page a minted exec command lands on, and the only place it appears:
 * only its hash is stored, as with tokens. Everything the person at the other
 * terminal needs is here, because by the time they are pasting they are no
 * longer looking at this page.
 */
export function execCommandPage(
  ctx: RepoCtx,
  runNumber: number,
  command: string,
  expiresInMinutes: number,
  back: string
): string {
  const content = html`${repoHeader(ctx, 'actions')}
<div class="form-box wide">
<h1>Run it yourself</h1>
<p>On a machine with Docker or Podman and Node, paste this. It shows run #${runNumber}'s manual jobs step by step and asks before executing anything; what it runs reports back to this run as any runner would.</p>
${copyRow(command)}
<p class="muted small">The command must be pasted within ${expiresInMinutes} minutes and works once: redeeming it trades the token here for a session that lives only in that process, so a copy left in scrollback or shell history buys nothing afterwards. Reloading this page will not show it again; minting another command is the way to get one.</p>
<p class="muted small">The jobs run as whoever pastes this, on that machine. Read the steps it shows before agreeing to them.</p>
<p><a class="btn" href="${back}">Back to run #${runNumber}</a></p>
</div>`;
  return layout(`Run it yourself - ${ctx.collection}/${ctx.repo}`, content, repoOpts(ctx, back));
}

// ---- runners, under Admin ----

export interface RunnerView {
  name: string;
  labels: string[];
  allow: string[];
  createdBy: string;
  createdAt: string;
  tokenUpdatedAt?: string;
  // The longest a job may run here, and whether that was set for this runner
  // or is the vault's default. Both, because "20 minutes" and "20 minutes,
  // which is simply the default" are different things to an operator.
  jobTimeout: number;
  jobTimeoutSet: boolean;
  // Where the runner is now, as far as the server can tell: when it last
  // spoke, and the job it holds a lease on. Both are in-memory facts, so a
  // runner that has not polled since the server started reads as absent.
  lastSeen: string | null;
  running: { collection: string; repo: string; run: number; job: string } | null;
  // Where the vault sends a request to start this runner, for one that stops
  // when it has nothing to do. Null for the ordinary kind that is left
  // running, which is most of them.
  wakeUrl?: string | null;
}

/** Minutes as an operator reads them: 90 minutes is worth saying as 1h 30m. */
function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hour${h === 1 ? '' : 's'}` : `${h}h ${m}m`;
}

// A runner is either working on something, idle but in touch, or not there at
// all. The third case is the one an operator is usually looking for, so it gets
// a plain word rather than an empty cell.
function runnerStatus(r: RunnerView): Html {
  if (r.running) {
    const at = `/${encodeURIComponent(r.running.collection)}/${encodeURIComponent(
      r.running.repo
    )}/actions/runs/${r.running.run}?job=${encodeURIComponent(r.running.job)}`;
    return html`${statusIcon('running')}<span>running <a href="${at}">${r.running.collection}/${r.running.repo} #${
      r.running.run
    }</a> ${r.running.job}</span>`;
  }
  if (r.lastSeen) {
    return html`${statusIcon('success')}<span>idle, last heard from ${timeTag(r.lastSeen, '')}</span>`;
  }
  // A runner with a wake address is meant to be absent between jobs, so the
  // absence is the arrangement working rather than something to look into.
  if (r.wakeUrl) {
    return html`${statusIcon('queued')}<span class="muted">stopped; the vault starts it when a job is waiting</span>`;
  }
  return html`${statusIcon('queued')}<span class="muted">not seen since the vault restarted</span>`;
}

export function runnersPage(viewer: Viewer, runners: RunnerView[], flash?: string, error?: string): string {
  const rows = runners.map(
    (r) =>
      html`<tr><td class="with-avatar-row">${icon(
        'server',
        'icon'
      )}<span><b><a href="/admin/runners/${encodeURIComponent(r.name)}">${
        r.name
      }</a></b><div class="muted small">registered by ${r.createdBy}${
        r.createdAt ? html` ${timeTag(r.createdAt, '')}` : ''
      }</div></span></td>
<td class="small"><div class="runner-status">${runnerStatus(r)}</div></td>
<td class="small">${joinHtml(
        r.labels.map((l) => html`<span class="chip">${l}</span>`),
        ' '
      )}</td>
<td class="small mono">${r.allow.join(' ')}</td>
<td class="right"><a class="btn" href="/admin/runners/${encodeURIComponent(r.name)}">Details</a></td></tr>`
  );
  const content = html`<div class="page-head"><h1>Runners</h1></div>
${flash ? html`<div class="flash">${flash}</div>` : ''}
${error ? html`<div class="form-error">${error}</div>` : ''}
<p class="muted">A runner is a machine that executes workflow jobs. Jobs never run on the vault's own machine: register a runner, then start it with <code>mochi runner run</code> somewhere with Docker.</p>
${
  runners.length
    ? html`<table class="listing"><tbody>${rows}</tbody></table>`
    : raw('<div class="empty-state">No runners registered.</div>')
}
<div class="form-box wide" style="margin-top:24px">
<h2>Register a runner</h2>
<form method="post" action="/admin/runners">
${csrfField(viewer)}
<div class="field"><label for="name">Name</label><input type="text" id="name" name="name" placeholder="laptop" required>
<p class="muted small">Identifies the machine in job history.</p></div>
<div class="field"><label for="labels">Labels</label><input type="text" id="labels" name="labels" value="ubuntu-latest">
<p class="muted small">Matched against a job's <code>runs-on</code>. Space or comma separated.</p></div>
<div class="field"><label for="allow">Repositories</label><input type="text" id="allow" name="allow" placeholder="mycollection/*" required>
<p class="muted small">Globs over <code>collection/repo</code>. A runner executes whatever those repositories' workflows say, on the machine you start it on, so grant it only what you trust.</p></div>
<div class="field"><label for="minutes">Job timeout</label><input type="number" id="minutes" name="minutes" min="1" max="${String(
    MAX_JOB_TIMEOUT_MINUTES
  )}" step="1" placeholder="${String(DEFAULT_JOB_TIMEOUT_MINUTES)}">
<p class="muted small">Minutes a single job may run here, ${String(
    DEFAULT_JOB_TIMEOUT_MINUTES
  )} by default. A ceiling on what a job's own <code>timeout-minutes</code> may ask for, and changeable afterwards.</p></div>
<button type="submit" class="btn btn-primary">Register runner</button>
</form>
</div>`;
  return adminShell(viewer, 'runners', 'Runners', '/admin/runners', content);
}

// One runner: what it is allowed to do, whether it is there, and the two
// operations an operator comes here for, which are getting the start command
// and replacing a token that was lost or leaked.
export function runnerPage(viewer: Viewer, r: RunnerView, host: string, flash?: string): string {
  const fact = (label: string, value: Html | '') =>
    value === '' ? '' : html`<div class="fact"><span class="k">${label}</span><span class="v">${value}</span></div>`;
  const facts = html`<div class="facts">
${fact('Status', html`<span class="runner-status">${runnerStatus(r)}</span>`)}
${fact(
    'Labels',
    r.labels.length
      ? joinHtml(
          r.labels.map((l) => html`<span class="chip">${l}</span>`),
          ' '
        )
      : raw('<span class="muted">none</span>')
  )}
${fact('Repositories', html`<span class="mono">${r.allow.join(' ')}</span>`)}
${fact('Registered', html`by ${r.createdBy}${r.createdAt ? html` ${timeTag(r.createdAt, '')}` : ''}`)}
${fact(
    'Token',
    r.tokenUpdatedAt ? html`regenerated ${timeTag(r.tokenUpdatedAt, '')}` : html`the one issued at registration`
  )}
${fact(
    'Job timeout',
    html`${minutesLabel(r.jobTimeout)}${r.jobTimeoutSet ? '' : html` <span class="counter">default</span>`}`
  )}
${fact(
    'Wake',
    r.wakeUrl ? html`<span class="mono">${r.wakeUrl}</span>` : raw('<span class="muted">nothing starts this runner</span>')
  )}
</div>`;
  const content = html`<div class="page-head"><h1>${icon('server', 'icon')}${r.name}</h1></div>
${flash ? html`<div class="flash">${flash}</div>` : ''}
<p class="muted"><a href="/admin/runners">Runners</a> &middot; a machine that takes jobs for ${r.allow.join(
    ', '
  )} and runs them under Docker.</p>
${facts}
<div class="form-box wide" style="margin-top:24px">
<h2>Start this runner</h2>
<p class="muted">On the machine that will execute the jobs, with Docker installed and running, and the <code>mochi</code> CLI on the path (<code>npm install -g @magland/mochi</code>):</p>
${copyRow(`mochi runner run --host ${host} --runner-token <token>`)}
<p class="muted small">The token is shown only when it is issued, so if you no longer have it, regenerate it below and the command will be filled in for you. Adding <code>--save</code> writes the host and token to <code>~/.config/mochi/runner.json</code>, after which <code>mochi runner run</code> needs no arguments; <code>MOCHI_RUNNER_TOKEN</code> supplies the token where a command line is the wrong place for it, as in a systemd unit. Leave the process running; it polls for work and exits only when you stop it.</p>
<p class="muted small">Jobs are matched by label, so this runner will be offered jobs whose <code>runs-on</code> names ${
    r.labels.length
      ? joinHtml(
          r.labels.map((l) => html`<code>${l}</code>`),
          ' or '
        )
      : 'nothing yet'
  }.</p>
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Job timeout</h2>
<p class="muted">The longest a single job may run on ${r.name}. It is a ceiling, not a default: a job whose <code>timeout-minutes</code> asks for less keeps what it asked for, and one asking for more, or asking for nothing, is held to this. Reaching it removes the job's container, which fails the step that was running and the job with it.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(r.name)}/job-timeout">
${csrfField(viewer)}
<div class="field"><label for="jobTimeout">Minutes</label><input type="number" id="jobTimeout" name="minutes" min="1" max="${String(
    MAX_JOB_TIMEOUT_MINUTES
  )}" step="1" value="${r.jobTimeoutSet ? String(r.jobTimeout) : ''}" placeholder="${String(
    DEFAULT_JOB_TIMEOUT_MINUTES
  )}">
<p class="muted small">Empty means the vault's default of ${String(
    DEFAULT_JOB_TIMEOUT_MINUTES
  )} minutes. A change applies to the next job this runner takes; one already running keeps the timeout it started with.</p></div>
<button type="submit" class="btn">${icon('clock')}<span>Save job timeout</span></button>
</form>
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Wake address</h2>
<p class="muted">A runner started with <code>--idle</code> stops when it has had no job for that long, which is how a runner on hardware billed by the minute stops costing anything between runs. It cannot be told that work has arrived, though, so the vault sends a request to this address instead, and whatever is in front of the runner (a Fly proxy, a socket unit) starts it. The request carries a secret and nothing else; a new one is generated when you save an address, and the runner has to be started with it.</p>
<p class="muted">Sent at most once a minute per runner, however many jobs are waiting, and only when the runner has not been heard from.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(r.name)}/wake">
${csrfField(viewer)}
<div class="field"><label for="wakeUrl">URL</label><input type="text" id="wakeUrl" name="wakeUrl" value="${
    r.wakeUrl ?? ''
  }" placeholder="https://my-runner.fly.dev/wake">
<p class="muted small">Leave empty to remove the address, after which nothing starts this runner.</p></div>
<button type="submit" class="btn">${icon('sync')}<span>Save wake address</span></button>
</form>
${
  r.wakeUrl
    ? html`<form method="post" action="/admin/runners/${encodeURIComponent(
        r.name
      )}/wake/send" style="margin-top:12px">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('play')}<span>Send a wake request now</span></button>
<p class="muted small">Tests the address without queuing a job. A machine that has to boot may take half a minute to answer.</p>
</form>`
    : ''
}
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Regenerate token</h2>
<p class="muted">Issues a new token for ${r.name} and invalidates the current one. Its labels and repositories are kept, but a runner still running with the old token will start failing to poll and has to be restarted.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(
    r.name
  )}/token" data-confirm="Regenerate the token for ${r.name}? The current token stops working immediately.">
${csrfField(viewer)}
<button type="submit" class="btn">${icon('sync')}<span>Regenerate token</span></button>
</form>
</div>
<div class="form-box wide" style="margin-top:24px">
<h2>Remove runner</h2>
<p class="muted">Removes ${r.name} from the registry. It stops being able to take jobs; a job it is running now will be handed back to the queue when its lease expires.</p>
<form method="post" action="/admin/runners/${encodeURIComponent(
    r.name
  )}/remove" data-confirm="Remove runner ${r.name}? It will stop being able to take jobs.">
${csrfField(viewer)}
<button type="submit" class="btn btn-danger-outline">${icon('trash')}<span>Remove runner</span></button>
</form>
</div>`;
  return adminShell(viewer, 'runners', `Runner ${r.name}`, '/admin/runners', content);
}

export function runnerTokenPage(
  viewer: Viewer,
  name: string,
  token: string,
  host: string,
  regenerated = false
): string {
  const heading = regenerated ? `New token for ${name}` : 'Runner registered';
  const content = html`<div class="form-box wide">
<h1>${heading}</h1>
<p>The token for <b>${name}</b> is shown once; only its hash is stored.${
    regenerated ? ' The previous token no longer works.' : ''
  }</p>
${copyRow(token)}
<h2>Start it</h2>
<p class="muted">On a machine with Docker:</p>
${copyRow(`mochi runner run --host ${host} --runner-token ${token}`)}
<p class="muted small">Adding <code>--save</code> keeps the host and token in <code>~/.config/mochi/runner.json</code>, so <code>mochi runner run</code> needs no arguments afterwards.${
    regenerated ? ' If the runner is already running with the old token, restart it now.' : ''
  }</p>
<p><a class="btn" href="/admin/runners/${encodeURIComponent(
    name
  )}">Back to ${name}</a> <a class="btn" href="/admin/runners">All runners</a></p>
</div>`;
  return layout(heading, content, { viewer, path: '/admin/runners' });
}

// The secret a saved wake address is given, shown once for the same reason a
// token is: the vault keeps it in order to send it, and the runner has to be
// started with the same one, so this page is the only place the two halves
// meet.
export function runnerWakePage(viewer: Viewer, name: string, url: string, secret: string): string {
  const content = html`<div class="form-box wide">
<h1>Wake address saved</h1>
<p>The vault will start <b>${name}</b> by sending a request to <span class="mono">${url}</span> when a job it could take is waiting and it has not been heard from.</p>
<p>The secret that request carries, shown once here because the runner has to be started with it:</p>
${copyRow(secret)}
<h2>Start it</h2>
<p class="muted">With an idle timeout, so that there is something to wake, and a port for the request to arrive on:</p>
${copyRow(`MOCHI_WAKE_SECRET=${secret} mochi runner run --idle 5m --wake-port 3000`)}
<p class="muted small">A runner deployed with <code>mochi deploy fly runner</code> is given all of this already; this page is for a runner you start yourself. Saving an address again issues a new secret, so the runner has to be restarted with it.</p>
<p><a class="btn" href="/admin/runners/${encodeURIComponent(
    name
  )}">Back to ${name}</a> <a class="btn" href="/admin/runners">All runners</a></p>
</div>`;
  return layout('Wake address saved', content, { viewer, path: '/admin/runners' });
}
