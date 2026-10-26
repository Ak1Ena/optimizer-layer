import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseEvent, parseMeasurement } from './schema.ts';
import type { Event, EventPayload, Measurement, SessionState } from './types.ts';

export function reduceEvent(state: SessionState | null, event: Event): SessionState {
  const payload = event.payload;
  if (payload.kind === 'session.started') return payload.state;
  if (state === null) throw new Error('Session must start before observations');
  switch (payload.kind) {
    case 'conversation.imported': {
      const decisions = new Map(state.decisions.map((item) => [item.id, item]));
      for (const item of payload.decisions) {
        const previous = decisions.get(item.id);
        // Appended conversation rows refresh the transcript hash, not earlier decisions.
        if (previous && JSON.stringify({ ...previous, digest: item.digest }) !== JSON.stringify(item)) {
          throw new Error('Decision identity conflict');
        }
        decisions.set(item.id, item);
      }
      return { ...state, goal: { ...state.goal, version: state.goal.version + 1 }, review: { kind: 'pending' }, decisions: [...decisions.values()], context: null, assessment: null, evidence: [] };
    }
    case 'context.retrieved': return { ...state, context: payload.context, assessment: null };
    case 'context.assessed': return { ...state, assessment: payload.assessment };
    case 'contract.reviewed': {
      if (payload.review.goalVersion !== state.goal.version) throw new Error('Review references a stale goal version');
      if (payload.review.kind === 'accepted') return { ...state, review: payload.review };
      const review = payload.review;
      if (!state.goal.requirements.some(item => item.id === review.requirementId)) throw new Error('Challenge references unknown requirement');
      if (state.goal.uncertainties.some(item => item.id === review.uncertaintyId)) throw new Error('Duplicate review uncertainty');
      return {
        ...state, review, assessment: null, evidence: [], completionClaimed: false,
        goal: { ...state.goal, version: state.goal.version + 1, uncertainties: [...state.goal.uncertainties, {
          id: review.uncertaintyId, question: `${review.requirementId}: ${review.rationale}`, owner: review.owner, critical: true, resolution: { kind: 'open' },
        }] },
      };
    }
    case 'contract.escalated': return { ...state, control: { kind: 'escalated', rounds: state.control.rounds, reason: payload.reason } };
    case 'uncertainty.resolved': return {
      ...state,
      goal: {
        ...state.goal,
        version: state.goal.version + 1,
        requirements: state.goal.requirements.map((item) => payload.uncertaintyId === `acceptance:${item.id}` ? { ...item, acceptance: payload.answer } : item),
        uncertainties: state.goal.uncertainties.map((item) => item.id === payload.uncertaintyId ? { ...item, resolution: { kind: 'resolved', answer: payload.answer, source: payload.source } } : item),
      },
      review: { kind: 'pending' }, assessment: null, evidence: [], completionClaimed: false,
    };
    case 'command.observed': return { ...state, evidence: [...state.evidence, payload.evidence], control: payload.control, failureStreak: payload.failureStreak };
    case 'strategy.resolved': return { ...state, control: payload.control, failureStreak: { signature: '', count: 0 }, completionClaimed: false };
    case 'completion.claimed': return { ...state, completionClaimed: true };
    default: { const exhaustive: never = payload; return exhaustive; }
  }
}

export class Store {
  readonly projectRoot: string;
  readonly #db: DatabaseSync;
  readonly #readOnly: boolean;

  constructor(projectRoot: string, options: { readOnly?: boolean } = {}) {
    this.projectRoot = realpathSync(projectRoot);
    this.#readOnly = options.readOnly ?? false;
    const directory = join(this.projectRoot, '.optimizer');
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error('Runtime directory must not be a symlink');
    if (!this.#readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'runtime.sqlite');
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Runtime database must not be a symlink');
    if (this.#readOnly && !existsSync(path)) throw new Error('Project runtime is not initialized');
    this.#db = new DatabaseSync(path, { readOnly: this.#readOnly });
    try {
      this.#db.exec('PRAGMA busy_timeout=2000');
      if (this.#readOnly) {
        if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new Error('Unsupported database schema version');
        if (this.#db.prepare('SELECT project_root FROM metadata').get()?.project_root !== this.projectRoot) throw new Error('Database belongs to another project');
        return;
      }
      this.#transaction(() => {
        const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
        if (version !== 0 && version !== 1) throw new Error('Unsupported database schema version');
        if (version === 0) {
          this.#db.exec(`
            CREATE TABLE metadata (project_root TEXT NOT NULL);
            CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, producer TEXT NOT NULL, event_id TEXT NOT NULL, digest TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(session_id, producer, event_id));
            CREATE INDEX events_session ON events(session_id, sequence);
            CREATE TABLE measurements (session_id TEXT NOT NULL, body TEXT NOT NULL);
            PRAGMA user_version=1;
          `);
          this.#db.prepare('INSERT INTO metadata VALUES (?)').run(this.projectRoot);
        }
        if (this.#db.prepare('SELECT project_root FROM metadata').get()?.project_root !== this.projectRoot) throw new Error('Database belongs to another project');
      });
      this.#db.exec('PRAGMA journal_mode=WAL');
      chmodSync(path, 0o600);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  #transaction<T>(operation: () => T): T {
    if (this.#readOnly) throw new Error('Runtime is read-only');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = operation();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #append(event: Event): 'accepted' | 'duplicate' {
    const body = JSON.stringify(event);
    const digest = createHash('sha256').update(body).digest('hex');
    const previous = this.#db.prepare('SELECT digest, body FROM events WHERE session_id=? AND producer=? AND event_id=?').get(event.sessionId, event.producer, event.id);
    if (previous) {
      if (previous.digest !== digest) {
        if (typeof previous.body !== 'string') throw new Error('Corrupt event row');
        // Schema defaults can change serialization without changing an older event.
        const input: unknown = JSON.parse(previous.body);
        if (JSON.stringify(parseEvent(input)) !== body) throw new Error('Event identity conflict');
      }
      return 'duplicate';
    }
    const existing = this.#db.prepare('SELECT 1 FROM events WHERE session_id=? LIMIT 1').get(event.sessionId);
    if (event.payload.kind === 'session.started') {
      if (event.payload.state.id !== event.sessionId) throw new Error('Session identity mismatch');
      if (existing) throw new Error('Session already started');
    } else if (!existing) throw new Error('Unknown session');
    reduceEvent(existing ? this.get(event.sessionId) : null, event);
    this.#db.prepare('INSERT INTO events(session_id, producer, event_id, digest, body) VALUES(?,?,?,?,?)').run(event.sessionId, event.producer, event.id, digest, body);
    return 'accepted';
  }

  append(input: unknown): 'accepted' | 'duplicate' {
    const event = parseEvent(input);
    return this.#transaction(() => this.#append(event));
  }

  update(sessionId: string, operation: (state: SessionState) => EventPayload): SessionState {
    return this.commit(sessionId, state => ({ payload: operation(state), value: undefined })).state;
  }

  commit<T>(sessionId: string, operation: (state: SessionState) => { payload: EventPayload; value: T }): { state: SessionState; value: T } {
    return this.#transaction(() => {
      const state = this.get(sessionId);
      const change = operation(state);
      const event = parseEvent({ version: 1, id: randomUUID(), sessionId, producer: 'runtime', at: new Date().toISOString(), payload: change.payload });
      this.#append(event);
      return { state: reduceEvent(state, event), value: change.value };
    });
  }

  get(sessionId: string): SessionState {
    let state: SessionState | null = null;
    for (const { event } of this.events(sessionId)) state = reduceEvent(state, event);
    if (state === null) throw new Error('Unknown session');
    return state;
  }

  events(sessionId: string): { sequence: number; event: Event }[] {
    return this.#db.prepare('SELECT sequence, body FROM events WHERE session_id=? ORDER BY sequence').all(sessionId).map((row) => {
      if (typeof row.body !== 'string' || typeof row.sequence !== 'number') throw new Error('Corrupt event row');
      const input: unknown = JSON.parse(row.body);
      return { sequence: row.sequence, event: parseEvent(input) };
    });
  }

  measure(sessionId: string, measurement: Measurement): void {
    if (this.#readOnly) throw new Error('Runtime is read-only');
    this.#db.prepare('INSERT INTO measurements VALUES (?,?)').run(sessionId, JSON.stringify(measurement));
  }

  measurements(sessionId: string): Measurement[] {
    this.get(sessionId);
    return this.#db.prepare('SELECT body FROM measurements WHERE session_id=?').all(sessionId).map((row) => {
      if (typeof row.body !== 'string') throw new Error('Corrupt measurement row');
      const input: unknown = JSON.parse(row.body);
      return parseMeasurement(input);
    });
  }

  close(): void { this.#db.close(); }
}
