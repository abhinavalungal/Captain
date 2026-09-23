'use strict';

/**
 * A local, OpenAI-compatible chat-completions server for tests and latency
 * benchmarks. No network, no key, no cost.
 *
 *   const mock = await startMockLLM({ firstTokenMs: 1800, tokenMs: 20 });
 *   env.KRIS_LLM_URL = mock.url;   // http://127.0.0.1:<port>
 *   ...
 *   await mock.close();
 *
 * Behaviour
 *   - POST /v1/chat/completions, stream true or false, same shapes OpenRouter
 *     returns (SSE "data: {...}" lines, then "data: [DONE]").
 *   - firstTokenMs simulates model latency before the first token (queueing +
 *     reasoning); tokenMs is the gap between streamed tokens. A non-streamed
 *     request waits for the whole generation, exactly like a real provider.
 *   - If the last user message matches `toolWhen` and tools were offered, the
 *     first completion is a get_vessel_data tool call; the follow-up (after the
 *     tool result) is a plain answer quoting the tool's text.
 *   - `reply(messages)` can override the text for a given conversation.
 *   - `reasoningMs` streams reasoning deltas for that long before the answer.
 *   - Every request is recorded in `mock.requests` for assertions.
 *   - GET /v1/models answers instantly (used by the server's connection warm-up).
 */
const http = require('http');

function startMockLLM(opts = {}) {
  const firstTokenMs = opts.firstTokenMs != null ? opts.firstTokenMs : 400;
  const tokenMs = opts.tokenMs != null ? opts.tokenMs : 15;
  const toolWhen = opts.toolWhen || /\b(fuel|shaft power|consumption|speed|off.?hire|compliance)\b/i;
  const requests = [];

  const defaultReply = (messages) => {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    const text = String((last && last.content) || '');
    const toolMsg = [...messages].reverse().find((m) => m.role === 'tool');
    if (toolMsg) {
      let t = '';
      try { t = JSON.parse(toolMsg.content).text || ''; } catch (_) { t = ''; }
      return t ? 'Here is what the records show. ' + t : 'I could not find that in the records.';
    }
    if (/joke/i.test(text)) return 'Why did the flute never argue? It only ever played its part. I will keep my day job.';
    if (/explain|what is|what does/i.test(text)) {
      return 'Good question. FuelEU Maritime sets a limit on the greenhouse-gas intensity of the energy a ship uses on board.\n\n'
        + '- **Scope:** ships over 5,000 GT calling at EU ports.\n'
        + '- **Metric:** well-to-wake GHG intensity, in gCO2e per MJ.\n'
        + '- **Balance:** a surplus can be banked or pooled; a deficit carries a penalty.\n\n'
        + 'If you want your own figures, ask me for the compliance balance of a vessel and I will read it from the records.';
    }
    return 'Happy to help with that. Tell me a little more and I will get you an answer.';
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && /\/models/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{"data":[]}');
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { body = {}; }
    requests.push({ at: Date.now(), body });

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const hasToolResult = messages.some((m) => m.role === 'tool');
    const wantsTool = Array.isArray(body.tools) && body.tools.length && !hasToolResult
      && lastUser && toolWhen.test(String(lastUser.content || ''));

    let aborted = false;
    req.on('close', () => { aborted = true; });
    res.on('close', () => { aborted = true; });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    if (wantsTool) {
      const call = { id: 'call_1', type: 'function', function: { name: 'get_vessel_data', arguments: JSON.stringify({ question: String(lastUser.content) }) } };
      await sleep(firstTokenMs);
      if (aborted) return;
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] } }] }) + '\n\n');
        const a = call.function.arguments;
        for (let i = 0; i < a.length; i += 12) {
          res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(i, i + 12) } }] } }] }) + '\n\n');
        }
        res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
    }

    const text = (opts.reply && opts.reply(messages, body)) || defaultReply(messages);
    const tokens = text.match(/\S+\s*|\s+/g) || [text];

    if (!body.stream) {
      await sleep(firstTokenMs + tokens.length * tokenMs);
      if (aborted) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': OPENROUTER PROCESSING\n\n');
    await sleep(firstTokenMs);
    // A reasoning model thinks out loud first (OpenRouter: delta.reasoning).
    for (let t = 0; t < (opts.reasoningMs || 0); t += 50) {
      if (aborted) return;
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { reasoning: 'SECRET-REASONING ' } }] }) + '\n\n');
      await sleep(50);
    }
    for (const tok of tokens) {
      if (aborted) return;
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: tok } }] }) + '\n\n');
      if (tokenMs) await sleep(tokenMs);
    }
    if (aborted) return;
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port,
        requests,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { startMockLLM };
