'use strict';

/**
 * Streaming plumbing shared by the companion and the agent.
 *
 *   readSSE(res, onEvent)        parse an OpenAI-compatible SSE body
 *   readNDJSON(res, onObject)    parse an Ollama-style NDJSON body
 *   accumulateOpenAI()           fold chat.completion.chunk deltas into one
 *                                message { content, tool_calls }
 *   SentenceGate                 release model text to the user a sentence at
 *                                a time, each sentence checked by the same
 *                                fabrication guard that used to run on the
 *                                whole reply; a ```visual block is held until
 *                                complete and checked as one unit
 *   visualText(block)            a visual block's numbers as guard-readable
 *                                sentences
 *
 * Why sentence-gated: the output guard (companion_src.containsStatedFigure)
 * already judges a reply sentence by sentence, splitting on exactly the same
 * boundaries used here. Releasing only whole, already-checked sentences means
 * streaming shows the user nothing the non-streamed path would have blocked:
 * a sentence that would fail is never sent, and the reply is replaced with
 * the fixed redirect instead.
 */

/** Read a fetch Response body as text chunks. Works with web streams and Node streams. */
async function* chunks(res) {
  const body = res.body;
  if (!body) return;
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        yield dec.decode(value, { stream: true });
      }
    } finally {
      try { reader.releaseLock(); } catch (_) { /* ignore */ }
    }
    return;
  }
  for await (const c of body) yield typeof c === 'string' ? c : Buffer.from(c).toString('utf8');
}

/** Server-sent events: calls onEvent(parsedJson) for each `data:` payload until [DONE]. */
async function readSSE(res, onEvent) {
  let buf = '';
  for await (const piece of chunks(res)) {
    buf += piece;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line || line.charAt(0) === ':') continue;          // keep-alive comments
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch (_) { continue; }
      if (obj && obj.error) {
        const e = new Error('stream error: ' + String(obj.error.message || JSON.stringify(obj.error)).slice(0, 200));
        e.httpStatus = obj.error.code;
        throw e;
      }
      onEvent(obj);
    }
  }
}

/** Newline-delimited JSON (Ollama /api/chat with stream: true). */
async function readNDJSON(res, onObject) {
  let buf = '';
  for await (const piece of chunks(res)) {
    buf += piece;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { continue; }
      if (obj && obj.error) throw new Error('stream error: ' + String(obj.error).slice(0, 200));
      if (onObject(obj) === false) return;
      if (obj && obj.done) return;
    }
  }
  if (buf.trim()) { try { onObject(JSON.parse(buf)); } catch (_) { /* ignore */ } }
}

/** Fold streamed chunk deltas into a single assistant message. */
function accumulateOpenAI() {
  const msg = { role: 'assistant', content: '', tool_calls: [] };
  return {
    msg,
    push(chunk, onContent) {
      const choice = chunk && chunk.choices && chunk.choices[0];
      if (!choice) return;
      const d = choice.delta || choice.message || {};
      if (typeof d.content === 'string' && d.content) {
        msg.content += d.content;
        if (onContent) onContent(d.content);
      }
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : msg.tool_calls.length;
          const slot = msg.tool_calls[i] || (msg.tool_calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function) {
            if (tc.function.name) slot.function.name += tc.function.name;
            if (tc.function.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
      if (choice.finish_reason) msg.finish_reason = choice.finish_reason;
    },
    result() {
      const out = { role: 'assistant', content: msg.content };
      const calls = msg.tool_calls.filter(Boolean).filter((c) => c.function && c.function.name);
      calls.forEach((c, i) => { if (!c.id) c.id = 'call_' + i; });
      if (calls.length) out.tool_calls = calls;
      return out;
    },
  };
}

// Same boundaries the guard splits on: whitespace after . ! ? — or a newline.
const BOUNDARY_RE = /[.!?]\s+|\n+/g;
const CHART_START_RE = /(^|\n)[ \t]*CHART\b/;
const VISUAL_OPEN_RE = /(^|\n)([ \t]*```[ \t]*visual[ \t]*)(?=\n|$)/i;
const FENCE_CLOSE_END_G = /\n[ \t]*```[ \t]*(?=\n|$)/g;
const FENCE_CLOSE_LINE_G = /\n[ \t]*```[ \t]*(?=\n)/g;

/** The first ```visual block in `buf`: { start, end } (end -1 while it is still open), or null. */
function findVisual(buf, final) {
  const m = VISUAL_OPEN_RE.exec(buf);
  if (!m) return null;
  const start = m.index + m[1].length;
  // Mid-stream a fence only counts as closed once its line has ended.
  const close = final ? FENCE_CLOSE_END_G : FENCE_CLOSE_LINE_G;
  close.lastIndex = start + m[2].length;
  const c = close.exec(buf);
  if (!c) return { start, end: -1 };
  let end = c.index + c[0].length;
  if (buf.charAt(end) === '\n') end += 1;
  return { start, end };
}

/** A whole reply as the guard should read it: each visual block turned into visualText. */
function guardable(text) {
  return String(text || '').replace(/(^|\n)([ \t]*```[ \t]*visual[ \t]*\n[\s\S]*?(?:\n[ \t]*```[ \t]*(?=\n|$)|$))/gi,
    function (all, pre, block) { return pre + visualText(block); });
}

/**
 * A visual block's content as plain sentences for the fabrication guard:
 * every number beside its unit and the names around it ("Aurora Trader ·
 * Fuel · Jan 41.2 MT."), one per line. A figure hidden in JSON is judged
 * exactly like one written in prose. Unparseable JSON is judged as it is.
 */
function visualText(block) {
  const json = String(block || '').replace(/^\s*```[ \t]*visual[ \t]*\n?/i, '').replace(/\n?[ \t]*```[ \t]*\n?$/, '');
  let spec;
  try { spec = JSON.parse(json); } catch (_) { return json; }
  const lines = [];
  const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  const visit = (o, ctx, unit, labels) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach((x) => visit(x, ctx, unit, labels)); return; }
    const u = typeof o.unit === 'string' ? o.unit : unit;
    const here = [ctx, str(o.title), str(o.name), str(o.label), str(o.when)].filter(Boolean).join(' ');
    const labs = Array.isArray(o.labels) ? o.labels : labels;
    if (o.value != null) lines.push(here + ' ' + str(o.value) + ' ' + (u || ''));
    if (o.target != null) lines.push(here + ' ' + str(o.target) + ' ' + (u || ''));
    if (Array.isArray(o.values)) o.values.forEach((v, i) => lines.push(here + ' ' + str(labs && labs[i]) + ' ' + str(v) + ' ' + (u || '')));
    ['detail', 'note', 'verdict', 'delta', 'subtitle'].forEach((k) => { if (typeof o[k] === 'string') lines.push(here + ' ' + o[k]); });
    if (Array.isArray(o.points)) o.points.forEach((p) => lines.push(here + ' ' + str(p)));
    ['items', 'series', 'steps', 'events', 'blocks', 'bands'].forEach((k) => visit(o[k], here, u, labs));
  };
  visit(spec, '', '', null);
  return lines.map((l) => l.replace(/\s+/g, ' ').trim() + '.').join('\n');
}

/**
 * Releases text a sentence at a time.
 *
 *   const gate = new SentenceGate({ check, emit });
 *   gate.push(delta) ...   gate.end()
 *
 * check(sentenceText) -> true when the text must NOT be shown (the guard).
 * emit(text)          -> called with each released, already-checked piece.
 * After a failed check the gate is `blocked` and releases nothing more.
 *
 * A trailing `CHART {...}` line (the companion's chart convention) is never
 * released; it stays in the buffer for the final payload to parse.
 *
 * A ```visual block is held until its closing fence, judged as one unit (its
 * numbers read beside their labels and units, see visualText), and released
 * whole. onHold() fires once when one starts, so the user can be told a
 * visual is on its way while it is held.
 */
class SentenceGate {
  constructor({ check, emit, guard = true, onHold }) {
    this.check = check || (() => false);
    this.emitFn = emit || (() => {});
    this.onHold = onHold || (() => {});
    this.guard = guard;
    this.buf = '';
    this.released = '';
    this.blocked = false;
    this.held = false; // a CHART line has started; nothing after it is released
    this.holding = false; // a visual block is open
  }

  push(text) {
    if (this.blocked || !text) return;
    this.buf += text;
    this._drain(false);
  }

  /** Flush whatever is left. Returns the full raw text (released + held). */
  end() {
    if (!this.blocked) this._drain(true);
    return this.released + this.buf;
  }

  _drain(final) {
    for (;;) {
      if (this.blocked || (this.held && !final)) return;
      const v = findVisual(this.buf, final);
      if (v && v.start === 0) {
        if (v.end < 0 && !final) {
          if (!this.holding) { this.holding = true; this.onHold(); }
          return;
        }
        const block = this.buf.slice(0, v.end < 0 ? this.buf.length : v.end);
        if (this.guard && this.check(visualText(block))) { this.blocked = true; return; }
        this.holding = false;
        this.buf = this.buf.slice(block.length);
        this.released += block;
        this.emitFn(block);
        continue;
      }
      const before = this.buf.length;
      this._drainText(final, v ? v.start : this.buf.length);
      if (!v || this.blocked || this.buf.length === before) return;
    }
  }

  _drainText(final, visualAt) {
    let cut;
    const chartAt = this.buf.search(CHART_START_RE);
    const limit = Math.min(chartAt >= 0 ? chartAt : this.buf.length, visualAt);
    if (final || visualAt < this.buf.length) {
      cut = limit;
    } else {
      cut = 0;
      BOUNDARY_RE.lastIndex = 0;
      let m;
      while ((m = BOUNDARY_RE.exec(this.buf)) !== null) {
        const end = m.index + m[0].length;
        if (end > limit) break;
        cut = end;
      }
    }
    if (chartAt >= 0 && cut >= chartAt) this.held = true;
    if (cut <= 0) return;
    const piece = this.buf.slice(0, cut);
    if (this.guard && this.check(piece)) { this.blocked = true; return; }
    this.buf = this.buf.slice(cut);
    this.released += piece;
    this.emitFn(piece);
  }
}

/** True when an OpenAI-style chunk carries reasoning (OpenRouter: delta.reasoning / reasoning_details). */
function hasReasoning(chunk) {
  const c = chunk && chunk.choices && chunk.choices[0];
  const d = c && c.delta;
  return !!(d && (d.reasoning || (Array.isArray(d.reasoning_details) && d.reasoning_details.length)));
}

/**
 * While the model reasons, the user sees nothing, and neither does the
 * browser's idle timer. A throttled { t: 'status', text: 'Thinking' } says it
 * is still working. Only the word goes out; the reasoning itself never does.
 */
function thinkingBeat(onDelta, everyMs) {
  let last = 0;
  return function () {
    const now = Date.now();
    if (typeof onDelta !== 'function' || now - last < everyMs) return;
    last = now;
    onDelta({ t: 'status', text: 'Thinking' });
  };
}

/** Combine abort signals (AbortSignal.any where available). */
function anySignal(signals) {
  const list = signals.filter(Boolean);
  if (!list.length) return undefined;
  if (list.length === 1) return list[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const ctrl = new AbortController();
  for (const s of list) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

module.exports = { readSSE, readNDJSON, accumulateOpenAI, SentenceGate, anySignal, hasReasoning, thinkingBeat, visualText, guardable };
