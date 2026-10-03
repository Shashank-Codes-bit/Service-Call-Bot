import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type AskResult, type Essentials, type KbCategory, type KnowledgeEntry, type KnowledgeView, type Me } from '../api.ts';
import { shortDay } from '../ui.tsx';

const SECTIONS: [KbCategory, string][] = [
  ['cars', 'Cars we service'],
  ['services', 'Services and packages'],
  ['offers', 'Offers'],
  ['essentials', 'Centre essentials'],
];
const PLACEHOLDER: Record<Exclude<KbCategory, 'essentials'>, { title: string; say: string; words: string }> = {
  cars: {
    title: 'e.g. Tata Nexon EV',
    say: 'Yes, we service the Nexon EV. The first service is at 15,000 km or 12 months.',
    words: 'nexon ev, electric nexon, ev',
  },
  services: {
    title: 'e.g. Ceramic coating',
    say: 'Ceramic coating takes a full day and comes with a two-year guarantee.',
    words: 'ceramic, coating, paint protection',
  },
  offers: {
    title: 'e.g. Diwali service offer',
    say: 'Until Diwali, a paid service comes with a free car wash and AC check.',
    words: 'diwali, offer, discount',
  },
};

type Draft = { id?: number; category: Exclude<KbCategory, 'essentials'>; title: string; answer: string; phrases: string; validUntil: string };

/**
 * What the agent can answer. A save here is live on the agent's next turn:
 * it reads this table every time, through an index the database keeps in
 * step with each edit — there is nothing to publish or refresh.
 */
export function Knowledge({ me, version, changed, say }: { me: Me; version: number; changed: () => void; say: (t: string) => void }) {
  const [view, setView] = useState<KnowledgeView>();
  const [section, setSection] = useState<KbCategory>('cars');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [removing, setRemoving] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () => api.knowledge().then(setView, (e: Error) => setError(e.message));
  useEffect(() => {
    load();
  }, [version]);

  const live = (c: KbCategory) => (view?.entries ?? []).filter((e) => e.category === c && !e.expired);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (view?.entries ?? []).filter(
      (e) => e.category === section && (!term || `${e.title} ${e.answer} ${e.phrases.join(' ')}`.toLowerCase().includes(term)),
    );
  }, [view, section, q]);

  const open = (category: Exclude<KbCategory, 'essentials'>) => {
    setSection(category);
    setQ('');
    setError(undefined);
    setDraft({ category, title: '', answer: '', phrases: '', validUntil: '' });
  };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    const body = { category: draft.category, title: draft.title, answer: draft.answer, phrases: draft.phrases, validUntil: draft.validUntil || null };
    try {
      if (draft.id) await api.editKnowledge(draft.id, body);
      else await api.addKnowledge(body);
      say(`${draft.id ? 'Saved' : 'Added'} “${draft.title.trim()}”. The agent can answer it from the next call.`);
      setSection(draft.category);
      setDraft(undefined);
      await load();
      changed();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry: KnowledgeEntry) {
    try {
      await api.removeKnowledge(entry.id);
      say(`Removed “${entry.title}”. The agent no longer mentions it.`);
      setRemoving(undefined);
      await load();
    } catch (err) {
      say((err as Error).message);
    }
  }

  const sectionName = SECTIONS.find(([id]) => id === section)![1];
  const livePart = list.filter((e) => !e.expired);
  const gone = list.filter((e) => e.expired);

  return (
    <>
      <div className="dayline">
        <h2>Knowledge</h2>
        <span className="small muted">What your agent can answer. Changes reach it straight away; there is nothing to publish.</span>
        <button
          type="button"
          className="btn primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => open(section === 'essentials' ? 'cars' : section)}
        >
          + Add to knowledge
        </button>
      </div>
      {error && !draft && <p className="err">{error}</p>}
      <div className="kgrid">
        <nav className="kcats" aria-label="Knowledge sections">
          {SECTIONS.map(([id, label]) => (
            <button
              type="button"
              key={id}
              aria-current={section === id}
              onClick={() => {
                setSection(id);
                setQ('');
                if (draft && id !== draft.category) setDraft(undefined);
              }}
            >
              {label}
              <span className="nums muted">{id === 'essentials' ? (view?.saved ? '✓' : '!') : live(id).length}</span>
            </button>
          ))}
        </nav>

        <section className="kmain">
          {section === 'essentials' ? (
            view && (
              <EssentialsForm
                key={view.updated_at ?? 'draft'}
                view={view}
                onSaved={async () => {
                  await load();
                  changed();
                  say('Saved. The agent answers with this from the next call.');
                }}
              />
            )
          ) : (
            <>
              {draft && (
                <form className="form topicform" onSubmit={save}>
                  <h3 style={{ fontSize: 'var(--step-1)' }}>{draft.id ? `Edit “${draft.title}”` : 'Add to knowledge'}</h3>
                  <div className="two">
                    <div className="pair">
                      <label htmlFor="kf-cat">Section</label>
                      <select
                        className="field"
                        id="kf-cat"
                        value={draft.category}
                        onChange={(e) => setDraft({ ...draft, category: e.target.value as Draft['category'] })}
                      >
                        {SECTIONS.filter(([id]) => id !== 'essentials').map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="pair">
                      <label htmlFor="kf-until">Valid until (optional)</label>
                      <input
                        className="field nums"
                        id="kf-until"
                        type="date"
                        value={draft.validUntil}
                        min={draft.id ? undefined : me.today}
                        onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="pair">
                    <label htmlFor="kf-title">Name</label>
                    <input
                      className="field"
                      id="kf-title"
                      data-autofocus
                      autoFocus
                      placeholder={PLACEHOLDER[draft.category].title}
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </div>
                  <div className="pair">
                    <label htmlFor="kf-say">What the agent should say</label>
                    <textarea
                      id="kf-say"
                      placeholder={PLACEHOLDER[draft.category].say}
                      value={draft.answer}
                      onChange={(e) => setDraft({ ...draft, answer: e.target.value })}
                    />
                    <span className="muted small">Write it the way you’d say it on the phone. Short sentences, no lists.</span>
                  </div>
                  <div className="pair">
                    <label htmlFor="kf-phr">Words customers might use, separated by commas</label>
                    <input
                      className="field"
                      id="kf-phr"
                      placeholder={PLACEHOLDER[draft.category].words}
                      value={draft.phrases}
                      onChange={(e) => setDraft({ ...draft, phrases: e.target.value })}
                    />
                    <span className="muted small">They help the agent find this entry. Include the way people say the name.</span>
                  </div>
                  {draft.answer.trim() && (
                    <div className="answer">
                      <b>The agent will say</b>
                      <br />“{draft.answer.trim()}”
                    </div>
                  )}
                  {error && <p className="err" role="alert">{error}</p>}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="submit" className="btn primary sm" disabled={busy}>
                      {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add to knowledge'}
                    </button>
                    <button type="button" className="btn sm" onClick={() => { setDraft(undefined); setError(undefined); }}>
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              <input
                className="field"
                type="search"
                placeholder={`Search ${sectionName.toLowerCase()}`}
                aria-label={`Search ${sectionName.toLowerCase()}`}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {!view && <p className="loading">Loading…</p>}
              {livePart.map((e) => (
                <Entry
                  key={e.id}
                  e={e}
                  today={me.today}
                  removing={removing === e.id}
                  onEdit={() => {
                    setError(undefined);
                    setDraft({
                      id: e.id,
                      category: e.category as Draft['category'],
                      title: e.title,
                      answer: e.answer,
                      phrases: e.phrases.join(', '),
                      validUntil: e.valid_until ?? '',
                    });
                    window.scrollTo({ top: 0 });
                  }}
                  onRemove={() => setRemoving(e.id)}
                  onKeep={() => setRemoving(undefined)}
                  onConfirm={() => remove(e)}
                />
              ))}
              {view && livePart.length === 0 && (
                <div className="empty">
                  {q ? 'Nothing matches that search. ' : 'Nothing here yet. '}
                  <button type="button" className="linklike" onClick={() => open(section as Draft['category'])}>
                    Add the first one
                  </button>
                </div>
              )}
              {gone.length > 0 && (
                <>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    Ended, hidden from the agent
                  </p>
                  {gone.map((e) => (
                    <Entry
                      key={e.id}
                      e={e}
                      today={me.today}
                      removing={removing === e.id}
                      onEdit={() => {
                        setDraft({ id: e.id, category: e.category as Draft['category'], title: e.title, answer: e.answer, phrases: e.phrases.join(', '), validUntil: e.valid_until ?? '' });
                        window.scrollTo({ top: 0 });
                      }}
                      onRemove={() => setRemoving(e.id)}
                      onKeep={() => setRemoving(undefined)}
                      onConfirm={() => remove(e)}
                    />
                  ))}
                </>
              )}
            </>
          )}
        </section>

        <TestPanel />
      </div>
    </>
  );
}

function Entry({
  e,
  today,
  removing,
  onEdit,
  onRemove,
  onKeep,
  onConfirm,
}: {
  e: KnowledgeEntry;
  today: string;
  removing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}) {
  const until = e.valid_until;
  return (
    <article className={`topic ${e.expired ? 'gone' : ''}`}>
      <div className="head">
        <h4>{e.title}</h4>
        <span className="acts">
          <button type="button" className="btn sm" onClick={onEdit}>
            Edit
          </button>
          <button type="button" className="btn sm danger" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <p className="small">{e.answer}</p>
      {e.phrases.length > 0 && (
        <div className="phr">
          {e.phrases.map((p) => (
            <span key={p}>{p}</span>
          ))}
        </div>
      )}
      <span className="small muted nums">
        {until ? (e.expired ? `Ended ${shortDay(until)} · the agent no longer mentions it · ` : `Valid until ${shortDay(until)} · `) : ''}
        {e.updated_at ? `Updated ${e.updated_at.slice(0, 10) === today ? 'today' : shortDay(e.updated_at.slice(0, 10))}` : ''}
      </span>
      {removing && (
        <div className="confirmrow">
          Remove “{e.title}”? The agent stops mentioning it straight away.
          <button type="button" className="btn sm" onClick={onKeep}>
            Keep it
          </button>
          <button type="button" className="btn sm danger" onClick={onConfirm}>
            Remove
          </button>
        </div>
      )}
    </article>
  );
}

/** Ask the way a caller would, and see exactly what the agent would answer from. */
function TestPanel() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<{ q: string; r: AskResult }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (question.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      setResult({ q: question.trim(), r: await api.ask(question.trim()) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const r = result?.r;
  return (
    <aside className="panel ktest" aria-label="Test a question">
      <h3>Test a question</h3>
      <form onSubmit={ask} style={{ display: 'grid', gap: 8 }}>
        <input
          className="field"
          placeholder="e.g. do you service the Curvv EV?"
          aria-label="A question a customer might ask"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn sm" style={{ justifySelf: 'start' }} disabled={busy || question.trim().length < 3}>
          {busy ? 'Asking…' : 'Ask the agent'}
        </button>
      </form>
      {error && <p className="err">{error}</p>}
      {!r && !error && (
        <p className="small muted">Type what a customer might ask. You’ll see exactly what the agent would answer from: the same check a call runs.</p>
      )}
      {r?.kind === 'answer' && (
        <div className="answer">
          <b>From “{r.title}”</b>
          <br />“{r.answer}”
        </div>
      )}
      {r?.kind === 'passed' && (
        <div className="answer miss">
          <b>Nothing fits.</b> The agent says it has passed the question to the team, files a customer-care follow-up, and carries on
          with the booking. Add an entry to answer it.
        </div>
      )}
      {r?.kind === 'cost' && (
        <div className="answer">
          <b>A price question.</b> The agent explains the advisor gives an estimate once they’ve seen the car; it never quotes a figure.
        </div>
      )}
      {r?.kind === 'not_a_question' && (
        <div className="answer miss">
          <b>That reads as part of a booking</b>, not a question about the centre. Try phrasing it as a customer would ask.
        </div>
      )}
      {r && r.shortlisted.length > 0 && (
        <p className="small muted">Checked against: {r.shortlisted.slice(0, 10).join(', ')}{r.shortlisted.length > 10 ? '…' : ''}</p>
      )}
    </aside>
  );
}

function EssentialsForm({ view, onSaved }: { view: KnowledgeView; onSaved: () => void }) {
  const [e, setE] = useState<Essentials>(view.essentials);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const set = (patch: Partial<Essentials>) => {
    setE((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  const toggle = (k: 'payment' | 'services' | 'languages', v: string, on: boolean) =>
    set({ [k]: on ? [...e[k], v] : e[k].filter((x) => x !== v) } as Partial<Essentials>);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.saveEssentials(e);
      setDirty(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const checks = (k: 'payment' | 'services' | 'languages', opts: string[]) => (
    <div className="chips">
      {opts.map((o) => (
        <label key={o}>
          <input type="checkbox" checked={e[k].includes(o)} onChange={(x) => toggle(k, o, x.target.checked)} />
          {o}
        </label>
      ))}
    </div>
  );
  const current = view.entries.filter((x) => x.category === 'essentials');

  return (
    <form className="form" onSubmit={save}>
      {view.saved ? (
        <div className="ready">✓ Complete. The agent answers these questions from this form.</div>
      ) : (
        <div className="notice alert">
          Not filled in yet. Until you save, the agent answers from the {current.length} essentials it already has:{' '}
          {current.map((x) => x.title).join(', ')}.
        </div>
      )}
      <p className="muted small">
        Hours, location and how things work at the centre. Saving rewrites the agent’s answers to these and the desk number in every SMS, from the next call.
      </p>
      <div className="pair">
        <label htmlFor="ess-name">Centre name</label>
        <input className="field" id="ess-name" value={e.name} onChange={(x) => set({ name: x.target.value })} />
      </div>
      <div className="two">
        <div className="pair">
          <label htmlFor="ess-addr">Address</label>
          <input className="field" id="ess-addr" value={e.address} onChange={(x) => set({ address: x.target.value })} />
        </div>
        <div className="pair">
          <label htmlFor="ess-land">Landmark</label>
          <input className="field" id="ess-land" placeholder="e.g. behind the metro station" value={e.landmark} onChange={(x) => set({ landmark: x.target.value })} />
        </div>
      </div>
      <div className="two">
        <div className="pair">
          <label htmlFor="ess-days">Open</label>
          <input className="field" id="ess-days" placeholder="Every day" value={e.days} onChange={(x) => set({ days: x.target.value })} />
        </div>
        <div className="two">
          <div className="pair">
            <label htmlFor="ess-o">From</label>
            <input className="field nums" id="ess-o" type="time" value={e.opens} onChange={(x) => set({ opens: x.target.value })} />
          </div>
          <div className="pair">
            <label htmlFor="ess-c">To</label>
            <input className="field nums" id="ess-c" type="time" value={e.closes} onChange={(x) => set({ closes: x.target.value })} />
          </div>
        </div>
      </div>
      <div className="pair">
        <label htmlFor="ess-desk">Workshop desk number (sent in every SMS)</label>
        <input className="field nums" id="ess-desk" inputMode="tel" value={e.desk} onChange={(x) => set({ desk: x.target.value })} />
      </div>
      <div className="pair">
        <label htmlFor="ess-park">Parking</label>
        <input className="field" id="ess-park" placeholder="e.g. Customer parking on site, left of the entrance" value={e.parking} onChange={(x) => set({ parking: x.target.value })} />
      </div>
      <div className="pair">
        <label htmlFor="ess-wait">Waiting area</label>
        <input className="field" id="ess-wait" placeholder="e.g. Lounge upstairs with tea, coffee and wifi" value={e.waiting} onChange={(x) => set({ waiting: x.target.value })} />
      </div>
      <div className="pair">
        <span className="lbl">Payment</span>
        {checks('payment', view.options.payment)}
      </div>
      <div className="two">
        <div className="pair">
          <span className="lbl">Pickup and drop</span>
          <label className="check" style={{ fontWeight: 400 }}>
            <input type="checkbox" checked={e.pickup} onChange={(x) => set({ pickup: x.target.checked })} /> Offered
          </label>
        </div>
        <div className="pair">
          <label htmlFor="ess-pn">Terms</label>
          <input className="field" id="ess-pn" placeholder="e.g. within 10 km, at a charge" disabled={!e.pickup} value={e.pickupTerms} onChange={(x) => set({ pickupTerms: x.target.value })} />
        </div>
      </div>
      <div className="pair">
        <span className="lbl">Services offered</span>
        {checks('services', view.options.services)}
      </div>
      <div className="pair">
        <span className="lbl">Languages the agent speaks</span>
        {checks('languages', view.options.languages)}
        <span className="muted small">Hindi is next on the build list.</span>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="submit" className="btn primary sm" disabled={busy || (!dirty && view.saved)}>
          {busy ? 'Saving…' : 'Save essentials'}
        </button>
        {view.updated_at && <span className="small muted">Last saved {shortDay(view.updated_at.slice(0, 10))}</span>}
      </div>
    </form>
  );
}
