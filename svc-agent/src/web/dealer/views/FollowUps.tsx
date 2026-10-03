import { useEffect, useState } from 'react';
import { api, type FollowUp, type FollowUpFilter, type FollowUpPage, type Me, type Outcome, type Team } from '../api.ts';
import { CopyButton, dur, phone, Plate, TEAM_ORDER, TeamDot, TEAMS, when } from '../ui.tsx';

const OUTCOME_ORDER: Outcome[] = ['booked', 'will_call_back', 'no_answer', 'not_interested', 'wrong_number'];
const WHEN = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', all: 'All time' } as const;

/** Who is closing: a name typed once and remembered on this device. */
function rememberedName(): string {
  try {
    return localStorage.getItem('svc.closer') ?? '';
  } catch {
    return '';
  }
}
function remember(name: string) {
  try {
    localStorage.setItem('svc.closer', name);
  } catch {
    /* private window: just not remembered */
  }
}

/**
 * Every lead as a piece of work for one team. Built to stay usable at a few
 * hundred: filters narrow it, paging keeps the page short, and the oldest
 * waiting comes first so nothing sits forgotten at the bottom.
 */
export function FollowUps({
  me,
  version,
  changed,
  go,
  say,
}: {
  me: Me;
  version: number;
  changed: () => void;
  go: (page: 'conversations', arg?: string) => void;
  say: (t: string) => void;
}) {
  const [f, setF] = useState<FollowUpFilter>({ status: 'open', when: '7d', teams: [], q: '', sort: 'oldest' });
  const [shown, setShown] = useState(10);
  const [page, setPage] = useState<FollowUpPage>();
  const [sel, setSel] = useState<number[]>([]);
  const [closing, setClosing] = useState<number>();
  const [outcome, setOutcome] = useState<Outcome>();
  const [note, setNote] = useState('');
  const [by, setBy] = useState(rememberedName);
  const [expand, setExpand] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () =>
        api.followUps(f, 0, shown).then(
          (p) => live && setPage(p),
          (e: Error) => live && setError(e.message),
        ),
      f.q ? 150 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [f, shown, version]);

  const patch = (next: Partial<FollowUpFilter>) => {
    setF((x) => ({ ...x, ...next }));
    setShown(10);
    setSel([]);
  };

  async function change(ids: number[], body: Record<string, unknown>, msg: string) {
    try {
      const r = ids.length === 1 ? await api.changeFollowUp(ids[0]!, body) : await api.bulkFollowUps(ids, body);
      say(msg.replace('{n}', String(r.changed)));
      changed();
    } catch (e) {
      say((e as Error).message);
    }
  }

  function close(id: number) {
    if (!outcome) return;
    if (by.trim()) remember(by.trim());
    change([id], { close: { outcome, note }, by: by.trim() || undefined }, `Closed as “${page?.outcomes[outcome]}”.`);
    setClosing(undefined);
    setOutcome(undefined);
    setNote('');
  }

  const rows = page?.rows ?? [];
  const filterText = [
    f.status === 'all' ? 'Open and done' : f.status === 'open' ? 'Open' : 'Done',
    f.teams.length ? f.teams.map((t) => TEAMS[t].name).join(', ') : 'All teams',
    WHEN[f.when],
  ].join(' · ');
  const week = page?.week;

  const seg = <K extends 'status' | 'when'>(key: K, opts: [FollowUpFilter[K], string][]) => (
    <span className="segc" role="group" aria-label={key === 'status' ? 'Status' : 'When'}>
      {opts.map(([v, label]) => (
        <button type="button" key={String(v)} aria-pressed={f[key] === v} onClick={() => patch({ [key]: v } as Partial<FollowUpFilter>)}>
          {label}
        </button>
      ))}
    </span>
  );

  return (
    <>
      <div className="dayline">
        <h2>Follow-ups</h2>
        {week && (
          <span className="small muted nums">
            Last 7 days: {week.total} follow-ups · {week.closed} closed · {week.booked} turned into bookings
            {week.medianWaitMin != null ? ` · median time to close ${dur(week.medianWaitMin)}` : ''}
          </span>
        )}
      </div>

      <div className="tiles">
        {[...(page?.teams ?? [])].sort((a, b) => TEAM_ORDER.indexOf(a.team) - TEAM_ORDER.indexOf(b.team)).map((t) => (
          <button
            type="button"
            key={t.team}
            className="tile"
            aria-pressed={f.teams.length === 1 && f.teams[0] === t.team}
            onClick={() => patch({ teams: f.teams.length === 1 && f.teams[0] === t.team ? [] : [t.team], status: 'open', when: 'all' })}
          >
            <span className="tname">
              <TeamDot team={t.team} />
              {TEAMS[t.team].name}
            </span>
            <b className="nums">{t.open}</b>
            <span className="small muted">open</span>
            <span className={`small nums ${(t.oldestWaitingMin ?? 0) >= 1440 ? 'old' : ''}`}>
              {t.oldestWaitingMin != null ? `oldest ${dur(t.oldestWaitingMin)}` : 'nothing waiting'}
            </span>
            <span className="small muted nums">{t.doneToday} done today</span>
          </button>
        ))}
      </div>

      <section className="panel queue">
        <div className="filters">
          {seg('status', [
            ['open', `Open ${page?.openTotal ?? ''}`],
            ['done', 'Done'],
            ['all', 'All'],
          ])}
          {seg('when', [
            ['today', 'Today'],
            ['yesterday', 'Yesterday'],
            ['7d', 'Last 7 days'],
            ['all', 'All'],
          ])}
          <input
            className="field"
            type="search"
            placeholder="Name, phone or plate"
            aria-label="Search follow-ups"
            value={f.q}
            onChange={(e) => patch({ q: e.target.value })}
          />
          <label className="small">
            Sort{' '}
            <select value={f.sort} onChange={(e) => patch({ sort: e.target.value as FollowUpFilter['sort'] })}>
              <option value="oldest">Oldest first</option>
              <option value="newest">Newest first</option>
            </select>
          </label>
          <a className="btn sm" href={api.csvUrl(f)} download>
            Export CSV
          </a>
        </div>
        <div className="chips2">
          {TEAM_ORDER.map((t) => {
            const open = page?.teams.find((x) => x.team === t)?.open;
            return (
              <button
                type="button"
                key={t}
                className="chip"
                aria-pressed={f.teams.includes(t)}
                onClick={() => patch({ teams: f.teams.includes(t) ? f.teams.filter((x) => x !== t) : [...f.teams, t] })}
              >
                <TeamDot team={t} />
                {TEAMS[t].name}
                {f.status === 'open' && open != null && <span className="nums muted"> {open}</span>}
              </button>
            );
          })}
          {f.teams.length > 0 && (
            <button type="button" className="linklike small" onClick={() => patch({ teams: [] })}>
              All teams
            </button>
          )}
        </div>

        {sel.length > 0 && (
          <div className="bulk">
            <b className="nums">{sel.length} selected</b>
            <label className="small">
              Reassign to{' '}
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  change(sel, { team: e.target.value }, 'Moved {n} to ' + TEAMS[e.target.value as Team].name + '.');
                  setSel([]);
                }}
              >
                <option value="">Choose team</option>
                {TEAM_ORDER.map((t) => (
                  <option key={t} value={t}>
                    {TEAMS[t].name}
                  </option>
                ))}
              </select>
            </label>
            <label className="small">
              Close as{' '}
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const o = e.target.value as Outcome;
                  change(sel, { close: { outcome: o }, by: by.trim() || undefined }, `Closed {n} as “${page?.outcomes[o]}”.`);
                  setSel([]);
                }}
              >
                <option value="">Choose outcome</option>
                {OUTCOME_ORDER.map((o) => (
                  <option key={o} value={o}>
                    {page?.outcomes[o]}
                  </option>
                ))}
              </select>
            </label>
            <a className="btn sm" href={api.csvUrl({ ...f, status: 'all', when: 'all', teams: [], q: '' }, sel)} download>
              Export selected
            </a>
            <button type="button" className="btn sm" onClick={() => setSel([])}>
              Clear
            </button>
          </div>
        )}

        <div className="qhead">
          <span />
          <span>Waiting</span>
          <span>Customer</span>
          <span>Reason and what they said</span>
          <span>Team</span>
          <span />
        </div>
        {error && <p className="err" style={{ padding: '10px 14px' }}>{error}</p>}
        {rows.map((l) => (
          <Row
            key={l.id}
            l={l}
            me={me}
            selected={sel.includes(l.id)}
            onSelect={(on) => setSel((s) => (on ? [...s, l.id] : s.filter((x) => x !== l.id)))}
            expanded={expand === l.id}
            onExpand={() => setExpand((x) => (x === l.id ? undefined : l.id))}
            closing={closing === l.id}
            onClosing={(on) => {
              setClosing(on ? l.id : undefined);
              setOutcome(undefined);
              setNote('');
            }}
            outcome={outcome}
            setOutcome={setOutcome}
            note={note}
            setNote={setNote}
            by={by}
            setBy={setBy}
            outcomes={page?.outcomes}
            onClose={() => close(l.id)}
            onReopen={() => change([l.id], { reopen: true }, 'Reopened.')}
            onTeam={(t) => change([l.id], { team: t }, `Moved to ${TEAMS[t].name}.`)}
            onHear={() => l.session_id && go('conversations', l.session_id)}
          />
        ))}
        {page && rows.length === 0 && (
          <div className="empty" style={{ margin: 14 }}>
            Nothing matches {filterText}. {f.status === 'open' ? 'All caught up.' : ''}
          </div>
        )}
        <div className="qfoot">
          <span className="small muted nums">
            Showing {rows.length ? 1 : 0}–{rows.length} of {page?.total ?? 0} · {filterText}
          </span>
          {page && page.total > rows.length && (
            <button type="button" className="btn sm" onClick={() => setShown((n) => n + 10)}>
              Load {Math.min(10, page.total - rows.length)} more
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function Row({
  l,
  me,
  selected,
  onSelect,
  expanded,
  onExpand,
  closing,
  onClosing,
  outcome,
  setOutcome,
  note,
  setNote,
  by,
  setBy,
  outcomes,
  onClose,
  onReopen,
  onTeam,
  onHear,
}: {
  l: FollowUp;
  me: Me;
  selected: boolean;
  onSelect: (on: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  closing: boolean;
  onClosing: (on: boolean) => void;
  outcome?: Outcome;
  setOutcome: (o: Outcome) => void;
  note: string;
  setNote: (s: string) => void;
  by: string;
  setBy: (s: string) => void;
  outcomes?: Record<Outcome, string>;
  onClose: () => void;
  onReopen: () => void;
  onTeam: (t: Team) => void;
  onHear: () => void;
}) {
  const done = l.status === 'done';
  const name = l.customer_name ?? 'Not registered';
  return (
    <div className={`qrow ${done ? 'done' : ''} ${closing ? 'closing' : ''}`}>
      <input type="checkbox" className="tick" checked={selected} onChange={(e) => onSelect(e.target.checked)} aria-label={`Select ${name}`} />
      <span className={`age nums ${!done && l.waited_min >= 1440 ? 'old' : ''}`}>
        <b>{done ? `took ${dur(l.waited_min)}` : dur(l.waited_min)}</b>
        <small>{when(l.created_at, me.today)}</small>
      </span>
      <span className="cust">
        <b>{name}</b>
        {l.vehicle_registration && <Plate reg={l.vehicle_registration} />}
        <small className="nums muted">{phone(l.mobile_number)}</small>
      </span>
      <span className="reason">
        <span>{l.reason_label}</span>
        {l.caller_words && (
          <button type="button" className={`quote clip ${expanded ? 'full' : ''}`} title="Show all" onClick={onExpand}>
            “{l.caller_words}”
          </button>
        )}
        {l.note && <small className="muted">Note: {l.note}</small>}
      </span>
      <span className="team">
        <TeamDot team={l.team} />
        <select value={l.team} aria-label={`Team for ${name}`} onChange={(e) => onTeam(e.target.value as Team)}>
          {TEAM_ORDER.map((t) => (
            <option key={t} value={t}>
              {TEAMS[t].name}
            </option>
          ))}
        </select>
      </span>
      <span className="acts">
        {done ? (
          <>
            <span className={`outcome ${l.outcome === 'booked' ? 'booked' : 'info'}`}>{l.outcome_label}</span>
            <span className="small muted nums">
              {l.closed_by}, {l.closed_at ? when(l.closed_at, me.today) : ''}
            </span>
            <button type="button" className="linklike small" onClick={onReopen}>
              Reopen
            </button>
          </>
        ) : (
          <>
            <CopyButton text={l.mobile_number} />
            {l.session_id && (
              <button type="button" className="btn sm" onClick={onHear}>
                Hear call
              </button>
            )}
            <button type="button" className="btn sm ok" onClick={() => onClosing(!closing)}>
              Close…
            </button>
          </>
        )}
      </span>
      {closing && (
        <div className="closer">
          <span className="small" style={{ fontWeight: 600 }}>
            Outcome
          </span>
          <span className="outs">
            {OUTCOME_ORDER.map((o) => (
              <button type="button" key={o} className="chip" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>
                {outcomes?.[o] ?? o}
              </button>
            ))}
          </span>
          <input className="field" placeholder="Note (optional), e.g. booked Tue 8:30" value={note} onChange={(e) => setNote(e.target.value)} />
          <span className="who">
            <label htmlFor={`by-${l.id}`}>Closed by</label>
            <input id={`by-${l.id}`} className="field" placeholder={me.userId} value={by} onChange={(e) => setBy(e.target.value)} />
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn sm primary" disabled={!outcome} onClick={onClose}>
              Close follow-up
            </button>
            <button type="button" className="btn sm" onClick={() => onClosing(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
