/*!
 * Captain — embeddable vessel-data companion.
 *
 * Floating (default) — a captain in the corner, click to open. The API
 * endpoint is auto-detected from wherever this script was loaded from, so
 * no matter what Captain is hosted on, nothing else needs configuring:
 *
 *   <script src="https://captain.your-domain.com/captain-widget.js"></script>
 *   <script>
 *     Captain.init({
 *       getToken: function () { return window.SESSION_TOKEN; }
 *     });
 *   </script>
 *
 * Inline — render the panel inside your own layout (a sidebar, a drawer):
 *
 *   Captain.init({ mount: '#captain-slot', theme: 'dark' });
 *
 * Tell Captain what the user is looking at, so "fuel consumption last month"
 * means *this* vessel:
 *
 *   Captain.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
 *
 * Match your brand:
 *
 *   Captain.init({ theme: 'auto', brand: { accent: '#0B3B5C', font: 'Inter, system-ui, sans-serif' } });
 *
 * Or bring your own transport:
 *
 *   Captain.init({
 *     ask: async function (text, pending, history, context) {
 *       return yourApi.captain({ text, pending, history, context });  // engine JSON shape
 *     }
 *   });
 *
 * Everything renders inside a Shadow DOM, so the host page's CSS cannot reach
 * in and the widget's CSS cannot leak out. No external requests, no fonts, no
 * storage. Conversation state lives in memory for the page's lifetime.
 */
(function (global) {
  'use strict';

  if (global.Captain && global.Captain.__loaded) return;

  // Where was this script loaded from? When perform.geoserves.com includes
  // <script src="https://captain.your-domain.com/captain-widget.js">, the
  // API is on Captain's own origin, not the page's — so the default endpoint
  // follows the script, and cross-origin embedding needs no configuration on
  // the page side. Works with any host: a plain Node server, a VPS, a
  // container platform — nothing here is Netlify-specific.
  var SCRIPT_ORIGIN = '';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) SCRIPT_ORIGIN = new URL(cs.src, document.baseURI).origin;
  } catch (_) { SCRIPT_ORIGIN = ''; }

  // ==========================================================================
  //  The character.
  //
  //  An original ship's captain in dress whites: white peaked cap with a
  //  black visor, gold braid and an anchor badge; silver beard; white jacket
  //  with gold shoulder boards. Drawn once as SVG; the face is driven by a `mood` attribute so
  //  the character communicates state without a single word of UI copy.
  //
  //    idle      — neutral, blinks occasionally
  //    thinking  — eyes up, brows raised
  //    answered  — small smile
  //    asking    — one brow raised, mouth open
  //    blocked   — brows down, flat mouth
  //    nothing   — brows in, slight frown
  // ==========================================================================
  var CAPTAIN_SVG_TEMPLATE =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<defs>' +
        '<radialGradient id="cp-skin" cx="42%" cy="36%" r="70%"><stop offset="0" stop-color="#F6D9BF"/><stop offset=".7" stop-color="#E8BE9A"/><stop offset="1" stop-color="#D4A27C"/></radialGradient>' +
        '<linearGradient id="cp-white" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E4E8EC"/></linearGradient>' +
        '<linearGradient id="cp-white-h" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#F2F4F6"/><stop offset=".5" stop-color="#FFFFFF"/><stop offset="1" stop-color="#DDE2E7"/></linearGradient>' +
        '<linearGradient id="cp-visor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A4653"/><stop offset=".45" stop-color="#151C24"/><stop offset="1" stop-color="#0B1016"/></linearGradient>' +
        '<linearGradient id="cp-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F3D98B"/><stop offset=".5" stop-color="#C9A43E"/><stop offset="1" stop-color="#8E6F1E"/></linearGradient>' +
        '<linearGradient id="cp-beard" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9EBEC"/><stop offset="1" stop-color="#B9BFC5"/></linearGradient>' +
        '<linearGradient id="cp-iris" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6F8FA6"/><stop offset="1" stop-color="#3C5A70"/></linearGradient>' +
      '</defs>' +

      // ---- uniform: dress whites -------------------------------------------
      '<path class="c-coat" fill="url(#cp-white)" d="M15 100 C15 83 27 75 40 73 L50 80 L60 73 C73 75 85 83 85 100 Z"/>' +
      '<path class="c-coat-shade" fill="#C9D0D7" opacity=".55" d="M40 73 L50 80 L60 73 L58 76 L50 84 L42 76 Z"/>' +
      // collar
      '<path fill="#FFFFFF" stroke="#C4CBD2" stroke-width=".6" d="M40 73 L50 80 L46 88 L37 78 Z"/>' +
      '<path fill="#FFFFFF" stroke="#C4CBD2" stroke-width=".6" d="M60 73 L50 80 L54 88 L63 78 Z"/>' +
      // tie
      '<path fill="#16293D" d="M50 80 L47 84 L49 92 L50 96 L51 92 L53 84 Z"/>' +
      // shoulder boards
      '<rect fill="#16293D" x="21" y="77.5" width="12" height="4.2" rx="1" transform="rotate(-14 27 79)"/>' +
      '<rect fill="#16293D" x="67" y="77.5" width="12" height="4.2" rx="1" transform="rotate(14 73 79)"/>' +
      '<g fill="url(#cp-gold)" transform="rotate(-14 27 79)"><rect x="23" y="78.3" width="1.4" height="2.6"/><rect x="25.6" y="78.3" width="1.4" height="2.6"/><rect x="28.2" y="78.3" width="1.4" height="2.6"/><rect x="30.8" y="78.3" width="1.4" height="2.6"/></g>' +
      '<g fill="url(#cp-gold)" transform="rotate(14 73 79)"><rect x="68.8" y="78.3" width="1.4" height="2.6"/><rect x="71.4" y="78.3" width="1.4" height="2.6"/><rect x="74" y="78.3" width="1.4" height="2.6"/><rect x="76.6" y="78.3" width="1.4" height="2.6"/></g>' +
      // buttons
      '<circle fill="url(#cp-gold)" cx="44" cy="91" r="1.3"/><circle fill="url(#cp-gold)" cx="56" cy="91" r="1.3"/>' +
      '<circle fill="url(#cp-gold)" cx="44" cy="97" r="1.3"/><circle fill="url(#cp-gold)" cx="56" cy="97" r="1.3"/>' +

      // ---- head ------------------------------------------------------------
      '<rect fill="#D9AE88" x="43.5" y="63" width="13" height="12" rx="3"/>' +
      // beard: trimmed, silver
      '<path fill="url(#cp-beard)" d="M29 48 C27.5 62 34 74 50 74.5 C66 74 72.5 62 71 48 C69 57 61 60.5 50 60.5 C39 60.5 31 57 29 48 Z"/>' +
      '<path fill="#A7AEB5" opacity=".35" d="M36 66 C42 71 58 71 64 66 C58 68.5 42 68.5 36 66 Z"/>' +
      // face
      '<path fill="url(#cp-skin)" d="M30 44 C30 30 38 23 50 23 C62 23 70 30 70 44 C70 55 62 62 50 62 C38 62 30 55 30 44 Z"/>' +
      // jaw shading under beard line
      '<path fill="#C4956F" opacity=".22" d="M33 50 C38 58 44 61 50 61 C56 61 62 58 67 50 C62 55 56 57 50 57 C44 57 38 55 33 50 Z"/>' +
      // ears
      '<ellipse fill="#E2B18A" cx="29.5" cy="45" rx="2.8" ry="4.2"/><ellipse fill="#E2B18A" cx="70.5" cy="45" rx="2.8" ry="4.2"/>' +
      // crow's feet: experience, drawn lightly
      '<g stroke="#B98A63" stroke-width=".55" stroke-linecap="round" opacity=".7" fill="none">' +
        '<path d="M33.5 42.5 L31.5 41.8"/><path d="M33.5 44.5 L31.4 44.6"/><path d="M33.5 46.5 L31.6 47.4"/>' +
        '<path d="M66.5 42.5 L68.5 41.8"/><path d="M66.5 44.5 L68.6 44.6"/><path d="M66.5 46.5 L68.4 47.4"/>' +
      '</g>' +
      // moustache
      '<path fill="url(#cp-beard)" d="M38.5 55.2 C42.5 51.4 47 52.6 50 55.4 C53 52.6 57.5 51.4 61.5 55.2 C57.5 58.6 53.5 57.6 50 56.8 C46.5 57.6 42.5 58.6 38.5 55.2 Z"/>' +
      // mouths
      '<path class="c-mouth m-idle"     d="M45.5 60 Q50 61.6 54.5 60"/>' +
      '<path class="c-mouth m-answered" d="M44.5 59.4 Q50 64 55.5 59.4"/>' +
      '<path class="c-mouth m-asking"   d="M46.5 59.4 Q50 59.4 53.5 59.4 Q53.5 63 50 63 Q46.5 63 46.5 59.4 Z"/>' +
      '<path class="c-mouth m-blocked"  d="M45.5 60.6 L54.5 60.6"/>' +
      '<path class="c-mouth m-nothing"  d="M45.5 61.5 Q50 59.2 54.5 61.5"/>' +
      '<path class="c-mouth m-thinking" d="M46.5 60.6 Q50 59.8 53 60.6"/>' +
      // eyes
      '<g class="c-eye c-eye-l"><ellipse fill="#FDFDFD" cx="41.5" cy="43.5" rx="4.2" ry="3.9"/><circle class="c-iris" fill="url(#cp-iris)" cx="42" cy="43.9" r="2.5"/><circle class="c-pupil" fill="#111820" cx="42" cy="43.9" r="1.35"/><circle class="c-glint" fill="#FFF" cx="43" cy="42.9" r=".7"/><path stroke="#5B4636" stroke-width=".9" fill="none" stroke-linecap="round" d="M37.3 42.2 Q41.5 38.6 45.7 42.2"/></g>' +
      '<g class="c-eye c-eye-r"><ellipse fill="#FDFDFD" cx="58.5" cy="43.5" rx="4.2" ry="3.9"/><circle class="c-iris" fill="url(#cp-iris)" cx="59" cy="43.9" r="2.5"/><circle class="c-pupil" fill="#111820" cx="59" cy="43.9" r="1.35"/><circle class="c-glint" fill="#FFF" cx="60" cy="42.9" r=".7"/><path stroke="#5B4636" stroke-width=".9" fill="none" stroke-linecap="round" d="M54.3 42.2 Q58.5 38.6 62.7 42.2"/></g>' +
      // brows: silver, well kept
      '<path class="c-brow c-brow-l" d="M36.2 37.6 Q41.5 34.8 46.8 37.2"/>' +
      '<path class="c-brow c-brow-r" d="M53.2 37.2 Q58.5 34.8 63.8 37.6"/>' +

      // ---- cap: white crown, black visor, gold badge and braid ----------------
      '<path fill="#0E141B" opacity=".18" d="M27 35 C27 33 73 33 73 35 L73 37 L27 37 Z"/>' +
      '<path fill="url(#cp-white-h)" d="M26.5 34 C26.5 21 36.5 13.5 50 13.5 C63.5 13.5 73.5 21 73.5 34 Z"/>' +
      '<path fill="#FFFFFF" opacity=".7" d="M31 30 C33 21 40 16 50 15.5 C43 17.5 36 22 33 30 Z"/>' +
      // band
      '<rect fill="#16293D" x="25.5" y="31.5" width="49" height="6" rx="1.6"/>' +
      // visor
      '<path fill="url(#cp-visor)" d="M23 37.2 C33 42.8 67 42.8 77 37.2 C77 40.2 66 44.4 50 44.4 C34 44.4 23 40.2 23 37.2 Z"/>' +
      '<path fill="#FFFFFF" opacity=".16" d="M27 38 C35 41.5 65 41.5 73 38 C66 40.6 34 40.6 27 38 Z"/>' +
      // braid across the visor
      '<path stroke="url(#cp-gold)" stroke-width="1.4" fill="none" d="M28 37.4 C36 41 64 41 72 37.4"/>' +
      // badge: anchor in a laurel
      '<g transform="translate(50 25.5)">' +
        '<circle fill="#16293D" r="6.6"/>' +
        '<circle fill="none" stroke="url(#cp-gold)" stroke-width=".9" r="6.6"/>' +
        '<g fill="none" stroke="url(#cp-gold)" stroke-width="1.1" stroke-linecap="round">' +
          '<circle r="1.1" cy="-3.6" stroke-width=".9"/>' +
          '<path d="M0 -2.5 V3.4"/><path d="M-2.4 -0.9 H2.4"/><path d="M-3.4 1.2 Q0 4.6 3.4 1.2"/>' +
          '<path d="M-5.4 2.2 Q-5.6 -1.4 -3.6 -3.8" stroke-width=".7"/><path d="M5.4 2.2 Q5.6 -1.4 3.6 -3.8" stroke-width=".7"/>' +
        '</g>' +
      '</g>' +
    '</svg>';

  /**
   * Each instance of the character gets its own gradient ids. Two copies with
   * the same ids would share defs, and a copy whose defs live inside a hidden
   * panel paints nothing.
   */
  function captainSvg(prefix) {
    return CAPTAIN_SVG_TEMPLATE.replace(/cp-/g, 'cp-' + prefix + '-');
  }

  // ==========================================================================
  //  Styles — scoped to the shadow root.
  // ==========================================================================
  var CSS =
    ':host{all:initial}' +
    '*,*::before,*::after{box-sizing:border-box}' +

    // tokens: navigation-chart palette (shallow-water tint, land buff, chart-correction magenta).
    // --accent / --accent-2 / --font are the three a host app overrides to match its brand.
    '.root{' +
      '--paper:#F3F6F6;--paper-2:#FFFFFF;--shallow:#D3E4E7;--shallow-deep:#B4D2D7;--land:#E9DEC6;' +
      '--ink:#12232B;--ink-soft:#4A6069;--ink-faint:#8AA0A7;--magenta:#A81F73;--sea:#26697A;--rule:#C2D3D6;' +
      '--caution-bg:#E9DEC6;--caution-fg:#43371C;--caution-hard-bg:#F6E3EE;--caution-hard-fg:#6B1249;' +
      '--accent:#16293D;--accent-2:#1B3550;--gold:#C9A43E;--on-accent:#FFFFFF;--said:#26506E;' +
      '--card-shadow:0 1px 2px rgba(15,30,46,.04);' +
      '--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;' +
      '--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;' +
      '--font:var(--sans);' +
      'position:fixed;right:20px;bottom:20px;z-index:2147483000;' +
      'font:15px/1.5 var(--font);color:var(--ink);' +
      'display:flex;flex-direction:column;align-items:flex-end;gap:12px;' +
    '}' +
    // dark scheme: same relationships, inverted lightness. Applied by attribute,
    // or by the OS preference when theme is "auto".
    '.root[data-theme="dark"],.root[data-theme="auto"].dark-auto{' +
      '--paper:#0F1A24;--paper-2:#16232F;--shallow:#1E3140;--shallow-deep:#2A4457;--land:#3B3524;' +
      '--ink:#E6EDF1;--ink-soft:#A7B6C0;--ink-faint:#6F8290;--magenta:#D75CA6;--sea:#5FB0C9;--rule:#24384A;' +
      '--caution-bg:#3B3524;--caution-fg:#E8D9B0;--caution-hard-bg:#4A1F39;--caution-hard-fg:#F4C6E0;' +
      '--accent:#0F1E2E;--accent-2:#173049;--said:#2C6A8A;' +
      '--card-shadow:0 1px 2px rgba(0,0,0,.25);' +
    '}' +
    '@media (prefers-color-scheme:dark){.root[data-theme="auto"]{' +
      '--paper:#0F1A24;--paper-2:#16232F;--shallow:#1E3140;--shallow-deep:#2A4457;--land:#3B3524;' +
      '--ink:#E6EDF1;--ink-soft:#A7B6C0;--ink-faint:#6F8290;--magenta:#D75CA6;--sea:#5FB0C9;--rule:#24384A;' +
      '--caution-bg:#3B3524;--caution-fg:#E8D9B0;--caution-hard-bg:#4A1F39;--caution-hard-fg:#F4C6E0;' +
      '--accent:#0F1E2E;--accent-2:#173049;--said:#2C6A8A;' +
      '--card-shadow:0 1px 2px rgba(0,0,0,.25);' +
    '}}' +
    // inline mode: the panel is part of the host layout, not a floating window
    '.root.inline{position:static;right:auto;bottom:auto;width:100%;height:100%;display:block;z-index:auto}' +
    '.root.inline .panel{display:flex;width:100%;max-width:none;height:100%;max-height:none;border-radius:0;border:0;box-shadow:none;animation:none}' +
    '.root.inline .badge,.root.inline .nudge,.root.inline .close,.root.inline .expand{display:none}' +
    // wide mode on desktop
    '.root.wide .panel{width:560px}' +

    // --- the character button ---------------------------------------------
    '.badge{' +
      'width:68px;height:68px;border-radius:50%;border:2px solid #FFFFFF;padding:0;cursor:pointer;' +
      'background:radial-gradient(circle at 50% 30%,#2B4A68 0%,#16293D 62%,#0F1E2E 100%);' +
      'box-shadow:0 1px 2px rgba(15,30,46,.25),0 8px 20px rgba(15,30,46,.28),0 0 0 1px rgba(15,30,46,.08);' +
      'overflow:hidden;position:relative;display:block;' +
      'transition:transform .18s ease,box-shadow .18s ease;' +
    '}' +
    '.badge:hover{transform:translateY(-2px);box-shadow:0 4px 10px rgba(18,35,43,.2),0 14px 30px rgba(18,35,43,.18)}' +
    '.badge:focus-visible{outline:3px solid var(--magenta);outline-offset:3px}' +
    '.badge svg{width:100%;height:100%;display:block;transform:translateY(9%) scale(1.22)}' +
    '.badge .hint{' +
      'position:absolute;right:0;bottom:0;width:20px;height:20px;border-radius:50%;' +
      'background:#C9A43E;color:#16293D;font-size:12px;line-height:20px;text-align:center;font-weight:700;' +
      'border:2px solid #FFFFFF;' +
    '}' +
    '.root.open .badge .hint{display:none}' +
    // first-visit nudge: a small speech bubble anchored to the badge
    '.nudge{' +
      'position:relative;max-width:230px;padding:9px 32px 9px 12px;border-radius:10px;' +
      'background:var(--paper-2);color:var(--ink);border:1px solid var(--rule);font-size:13px;line-height:1.35;' +
      'box-shadow:0 6px 18px rgba(15,30,46,.16);animation:nudgeIn .28s ease-out .6s both;' +
    '}' +
    '.nudge::after{content:"";position:absolute;right:26px;bottom:-7px;width:12px;height:12px;background:var(--paper-2);border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);transform:rotate(45deg)}' +
    '.nudge button{position:absolute;top:4px;right:6px;border:0;background:transparent;color:var(--ink-faint);font-size:16px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:4px}' +
    '.nudge button:hover{color:var(--ink);background:var(--shallow)}' +
    '.nudge button:focus-visible{outline:2px solid var(--magenta);outline-offset:1px}' +
    '.root.open .nudge,.nudge.gone{display:none}' +
    '@keyframes nudgeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){.nudge{animation:none}}' +

    // --- character parts (colours are painted in the SVG; CSS only drives expression) ---
    '.c-brow{fill:none;stroke:#9FA6AD;stroke-width:2;stroke-linecap:round;transition:transform .25s ease;transform-box:fill-box;transform-origin:center}' +
    '.c-mouth{fill:none;stroke:#7A4A3C;stroke-width:1.4;stroke-linecap:round;display:none}' +
    '.c-mouth.m-asking{fill:#5A2E26}' +
    '.c-eye{transform-box:fill-box;transform-origin:center;transition:transform .25s ease}' +
    '.c-iris,.c-pupil,.c-glint{transition:transform .25s ease}' +

    // moods
    'svg[data-mood="idle"] .m-idle{display:block}' +
    'svg[data-mood="answered"] .m-answered{display:block}' +
    'svg[data-mood="asking"] .m-asking{display:block}' +
    'svg[data-mood="blocked"] .m-blocked{display:block}' +
    'svg[data-mood="nothing"] .m-nothing{display:block}' +
    'svg[data-mood="thinking"] .m-thinking{display:block}' +
    'svg[data-mood="thinking"] .c-brow{transform:translateY(-1.6px)}' +
    'svg[data-mood="thinking"] .c-iris,svg[data-mood="thinking"] .c-pupil,svg[data-mood="thinking"] .c-glint{transform:translate(1.1px,-1.4px)}' +
    'svg[data-mood="asking"] .c-brow-r{transform:translateY(-2.2px) rotate(-6deg)}' +
    'svg[data-mood="blocked"] .c-brow{transform:translateY(1.4px)}' +
    'svg[data-mood="blocked"] .c-brow-l{transform:translateY(1.4px) rotate(8deg)}' +
    'svg[data-mood="blocked"] .c-brow-r{transform:translateY(1.4px) rotate(-8deg)}' +
    'svg[data-mood="nothing"] .c-brow-l{transform:translateY(.8px) rotate(-6deg)}' +
    'svg[data-mood="nothing"] .c-brow-r{transform:translateY(.8px) rotate(6deg)}' +

    // blink: brief, infrequent, and off when motion is reduced
    '@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.08)}}' +
    '.blinking .c-eye{animation:blink 5.2s infinite}' +
    '.blinking .c-eye-r{animation-delay:.04s}' +
    '@media (prefers-reduced-motion:reduce){.blinking .c-eye{animation:none}.badge,.badge:hover{transition:none;transform:none}}' +

    // --- panel -------------------------------------------------------------
    '.panel{' +
      'width:392px;max-width:calc(100vw - 40px);height:600px;max-height:calc(100vh - 120px);' +
      'background:var(--paper);border:1px solid var(--rule);border-radius:12px;' +
      'box-shadow:0 2px 6px rgba(15,30,46,.12),0 28px 64px rgba(15,30,46,.26);' +
      'display:none;flex-direction:column;overflow:hidden;' +
      'transform-origin:bottom right;' +
    '}' +
    '.root.open .panel{display:flex;animation:rise .18s ease-out}' +
    '@keyframes rise{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){.root.open .panel{animation:none}}' +

    '.head{display:flex;align-items:center;gap:12px;padding:12px 14px;background:linear-gradient(180deg,var(--accent-2) 0%,var(--accent) 100%);color:var(--on-accent);border-bottom:2px solid var(--gold)}' +
    '.head .face{width:40px;height:40px;border-radius:50%;background:radial-gradient(circle at 50% 30%,#2B4A68,#0F1E2E);border:1.5px solid rgba(255,255,255,.85);overflow:hidden;flex:none}' +
    '.head .face svg{width:100%;height:100%;transform:translateY(9%) scale(1.22)}' +
    '.head .titles{min-width:0;flex:1}' +
    '.head h2{margin:0;font:600 15px/1.2 var(--font);color:var(--on-accent);letter-spacing:.01em}' +
    '.head p{margin:1px 0 0;font-size:12px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.head .ctx{display:none;margin-top:4px;font-size:11px;color:var(--on-accent);background:rgba(255,255,255,.14);border-radius:999px;padding:1px 8px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.head .ctx.on{display:inline-block}' +
    '.head .tool{border:0;background:transparent;cursor:pointer;color:rgba(255,255,255,.75);font-size:18px;line-height:1;padding:4px 8px;border-radius:6px;flex:none}' +
    '.head .tool:hover{background:rgba(255,255,255,.12);color:var(--on-accent)}' +
    '.head .tool:focus-visible{outline:2px solid var(--gold);outline-offset:2px}' +
    '.head .expand{font-size:15px}' +
    '@media (max-width:640px){.head .expand{display:none}}' +

    '.log{flex:1;overflow-y:auto;padding:14px 12px 8px;display:flex;flex-direction:column;gap:14px}' +

    '.opening{color:var(--ink-soft);font-size:14px}' +
    '.opening h3{font:400 20px/1.25 var(--serif);color:var(--ink);margin:0 0 6px}' +
    '.opening p{margin:0}' +
    '.opening ul{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px}' +
    '.opening li button{font:inherit;font-size:13px;padding:5px 10px;border:1px solid var(--rule);background:var(--paper-2);color:var(--ink-soft);border-radius:14px;cursor:pointer;text-align:left}' +
    '.opening li button:hover{border-color:var(--shallow-deep);color:var(--ink)}' +
    '.opening li button:focus-visible{outline:2px solid var(--magenta);outline-offset:2px}' +

    '.turn{display:flex;flex-direction:column;animation:turnIn .22s ease-out}' +
    '.turn.you{align-items:flex-end}' +
    '@keyframes turnIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}' +
    '@media (prefers-reduced-motion:reduce){.turn{animation:none}}' +
    '.said{max-width:86%;padding:7px 11px;border-radius:8px 8px 2px 8px;background:var(--said);color:#fff;line-height:1.4;font-size:14px}' +

    '.card{position:relative;background:var(--paper-2);border:1px solid var(--rule);border-left:3px solid var(--shallow-deep);border-radius:5px;padding:12px 13px;font-size:14px;box-shadow:var(--card-shadow)}' +
    '.card .copy{position:absolute;top:6px;right:6px;border:0;background:transparent;color:var(--ink-faint);font:inherit;font-size:11px;padding:3px 7px;border-radius:4px;cursor:pointer;opacity:0;transition:opacity .15s}' +
    '.card:hover .copy,.card:focus-within .copy{opacity:1}' +
    '.card .copy:hover{color:var(--ink);background:var(--shallow)}' +
    '.card .copy:focus-visible{outline:2px solid var(--magenta);outline-offset:1px;opacity:1}' +
    '@media (hover:none){.card .copy{opacity:1}}' +
    // contextual follow-ups: quieter than clarification choices, which demand an answer
    '.followups{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}' +
    '.followups button{font:inherit;font-size:12.5px;padding:4px 10px;border:1px solid var(--rule);background:transparent;color:var(--ink-soft);border-radius:14px;cursor:pointer}' +
    '.followups button:hover{border-color:var(--shallow-deep);color:var(--ink);background:var(--shallow)}' +
    '.followups button:focus-visible{outline:2px solid var(--magenta);outline-offset:2px}' +
    '.card.asking{border-left-color:var(--land)}' +
    '.card.blocked{border-left-color:var(--magenta)}' +
    '.card.nothing{border-left-color:var(--ink-faint)}' +
    '.card p{margin:0}.card p+p{margin-top:6px}' +

    // the signature: the figure in the chart serif, provenance strung beneath like soundings
    '.figure{font:400 30px/1.05 var(--serif);letter-spacing:-.015em;margin:3px 0 2px;word-break:break-word}' +
    '.figure .unit{font-size:15px;color:var(--ink-soft);margin-left:4px}' +
    '.subject{color:var(--ink-soft);font-size:13px}' +
    '.sounding{margin-top:10px;padding-top:8px;border-top:1px solid var(--rule);display:flex;flex-wrap:wrap;gap:2px 12px;font-size:11.5px;color:var(--ink-soft)}' +
    '.sounding b{font-weight:600;color:var(--ink)}' +
    '.caution{margin-top:9px;padding:7px 9px;background:var(--caution-bg);border-radius:4px;font-size:12.5px;line-height:1.45;color:var(--caution-fg)}' +
    '.caution.hard{background:var(--caution-hard-bg);color:var(--caution-hard-fg)}' +

    '.choices{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}' +
    '.choices button{font:inherit;font-size:13px;padding:5px 11px;border:1px solid var(--shallow-deep);background:var(--shallow);color:var(--ink);border-radius:14px;cursor:pointer}' +
    '.choices button:hover{background:var(--shallow-deep)}' +
    '.choices button:disabled{opacity:.5;cursor:default}' +
    '.choices button:focus-visible{outline:2px solid var(--magenta);outline-offset:2px}' +

    'table.grid{border-collapse:collapse;width:100%;margin-top:10px;font-size:12.5px}' +
    'table.grid th,table.grid td{text-align:left;padding:4px 8px 4px 0;border-bottom:1px solid var(--rule);vertical-align:top}' +
    'table.grid th{font-weight:600;color:var(--ink-soft);font-size:11.5px}' +
    'table.grid td.num{font-family:var(--serif);font-size:14px;text-align:right;padding-right:0;white-space:nowrap}' +
    'table.grid td.none{color:var(--ink-faint);font-style:italic}' +

    '.spark{margin-top:10px;width:100%;height:90px;display:block}' +
    '.spark path.line{fill:none;stroke:var(--sea);stroke-width:1.6}' +
    '.spark path.fill{fill:var(--shallow);opacity:.55}' +
    '.spark line.axis{stroke:var(--rule);stroke-width:1}' +
    '.spark text{font:400 9.5px var(--sans);fill:var(--ink-faint)}' +

    'details.working{margin-top:9px;font-size:12px;color:var(--ink-soft)}' +
    'details.working summary{cursor:pointer}' +
    'details.working summary:focus-visible{outline:2px solid var(--magenta);outline-offset:2px}' +
    'details.working pre{margin:6px 0 0;padding:7px;background:var(--paper);border:1px solid var(--rule);border-radius:4px;overflow-x:auto;font-size:11px;line-height:1.5;white-space:pre-wrap}' +

    '.waiting{display:inline-flex;gap:4px;align-items:center;color:var(--ink-soft);font-size:13px}' +
    '.waiting i{width:6px;height:6px;border-radius:50%;background:var(--ink-faint);animation:pulse 1.1s infinite ease-in-out}' +
    '.waiting i:nth-child(2){animation-delay:.15s}.waiting i:nth-child(3){animation-delay:.3s}' +
    '@keyframes pulse{0%,80%,100%{opacity:.25}40%{opacity:1}}' +
    '@media (prefers-reduced-motion:reduce){.waiting i{animation:none;opacity:.6}}' +

    '.composer{border-top:1px solid var(--rule);background:var(--paper-2);padding:10px 12px 11px}' +
    '.composer form{display:flex;gap:8px;align-items:flex-end}' +
    '.composer textarea{flex:1;font:inherit;font-size:14px;resize:none;padding:7px 9px;border:1px solid var(--rule);border-radius:5px;background:var(--paper);color:var(--ink);min-height:36px;max-height:120px;line-height:1.4}' +
    '.composer textarea:focus{outline:2px solid var(--sea);outline-offset:-1px;border-color:var(--sea)}' +
    '.composer button{font:inherit;font-size:14px;font-weight:600;padding:7px 14px;border:1px solid var(--accent);background:var(--accent);color:var(--on-accent);border-radius:5px;cursor:pointer}' +
    '.composer button:hover:not(:disabled){background:var(--accent-2)}' +
    '.composer button:disabled{opacity:.45;cursor:default}' +
    '.composer button:focus-visible{outline:2px solid var(--magenta);outline-offset:2px}' +
    '.composer .foot{margin:6px 0 0;font-size:11px;color:var(--ink-faint)}' +

    // phones: the panel becomes a sheet. 16px input stops iOS zooming on focus.
    '@media (max-width:480px){' +
      '.root{right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px))}' +
      '.root:not(.inline) .panel{position:fixed;inset:0;width:auto;max-width:none;height:auto;max-height:none;border-radius:0;border:0}' +
      '.root.open .badge{display:none}' +
      '.composer{padding-bottom:calc(11px + env(safe-area-inset-bottom,0px))}' +
      '.composer textarea{font-size:16px}' +
      '.figure{font-size:26px}' +
    '}';

  // ==========================================================================
  //  Widget
  // ==========================================================================
  var DEFAULTS = {
    endpoint: SCRIPT_ORIGIN + '/api/captain',
    getToken: null,
    ask: null,
    title: 'Captain',
    subtitle: 'Your guide to the fleet and the app',
    greeting: 'Ask about a vessel, the app, or just say hello.',
    examples: [
      'What was the S.P. yesterday?',
      'Fuel consumption last month',
      'Anything I should know?',
      'How do I export a report?'
    ],
    position: 'right',      // 'right' | 'left'
    openOnLoad: false,
    mount: null,            // CSS selector or element: render inline instead of floating
    theme: 'light',         // 'light' | 'dark' | 'auto'
    brand: null,            // { accent, accent2, font } to match the host app
    nudge: true,            // first-visit speech bubble on the badge
    nudgeText: 'Ask me about your fleet',
    followups: true,        // contextual next-question chips after a data answer
    onOpen: null,
    onClose: null,
    onAnswer: null
  };

  function Widget(options) {
    this.opts = assign({}, DEFAULTS, options || {});
    this.pending = null;
    this.history = [];
    this.context = null;
    this.busy = false;
    this.open = false;
    this.inline = false;
    this.mount();
  }

  Widget.prototype.mount = function () {
    var host = document.createElement('div');
    host.setAttribute('data-captain-widget', '');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    this.host = host;
    this.shadow = shadow;

    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    var root = el('div', 'root');
    root.setAttribute('data-theme', ['light', 'dark', 'auto'].indexOf(this.opts.theme) >= 0 ? this.opts.theme : 'light');
    if (this.opts.brand) {
      if (this.opts.brand.accent) root.style.setProperty('--accent', String(this.opts.brand.accent));
      if (this.opts.brand.accent2) root.style.setProperty('--accent-2', String(this.opts.brand.accent2));
      if (this.opts.brand.font) root.style.setProperty('--font', String(this.opts.brand.font));
    }
    var mountEl = this.opts.mount
      ? (typeof this.opts.mount === 'string' ? document.querySelector(this.opts.mount) : this.opts.mount)
      : null;
    this.inline = !!mountEl;
    if (this.inline) root.classList.add('inline');
    else if (this.opts.position === 'left') { root.style.right = 'auto'; root.style.left = '20px'; root.style.alignItems = 'flex-start'; }
    this.root = root;

    // panel
    var panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.opts.title);
    panel.setAttribute('aria-modal', 'false');
    panel.id = 'captain-panel';

    var head = el('div', 'head');
    var face = el('div', 'face');
    face.innerHTML = captainSvg('h');
    this.headFace = face.querySelector('svg');
    this.headFace.setAttribute('data-mood', 'idle');
    var titles = el('div', 'titles');
    titles.appendChild(el('h2', null, this.opts.title));
    titles.appendChild(el('p', null, this.opts.subtitle));
    var ctxPill = el('span', 'ctx');
    titles.appendChild(ctxPill);
    this.ctxPill = ctxPill;
    var expand = el('button', 'tool expand', '\u2922');
    expand.type = 'button';
    expand.setAttribute('aria-label', 'Toggle wide view');
    expand.setAttribute('aria-pressed', 'false');
    expand.addEventListener('click', function () {
      var wide = root.classList.toggle('wide');
      expand.setAttribute('aria-pressed', wide ? 'true' : 'false');
    });
    var close = el('button', 'tool close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', this.close.bind(this));
    head.appendChild(face); head.appendChild(titles); head.appendChild(expand); head.appendChild(close);

    var log = el('div', 'log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    this.log = log;

    var opening = el('div', 'opening');
    opening.appendChild(el('h3', null, this.opts.greeting));
    var openingCtx = el('p', 'ctxline');
    openingCtx.style.display = 'none';
    opening.appendChild(openingCtx);
    this.openingCtx = openingCtx;
    opening.appendChild(el('p', null, 'Every figure comes from your database. If the records do not hold the answer, I say so.'));
    var ul = el('ul');
    var self = this;
    this.opts.examples.forEach(function (q) {
      var li = el('li');
      var b = el('button', null, q);
      b.type = 'button';
      b.addEventListener('click', function () { self.submit(q); });
      li.appendChild(b);
      ul.appendChild(li);
    });
    opening.appendChild(ul);
    this.opening = opening;
    log.appendChild(opening);

    var composer = el('div', 'composer');
    var form = el('form');
    var ta = el('textarea');
    ta.rows = 1;
    ta.placeholder = 'Ask about your vessel\u2026';
    ta.setAttribute('aria-label', 'Ask Captain about your vessel data');
    var send = el('button', null, 'Ask');
    send.type = 'submit';
    form.appendChild(ta); form.appendChild(send);
    composer.appendChild(form);
    composer.appendChild(el('p', 'foot', 'Captain reads your vessel data. It cannot change it.'));
    this.input = ta;
    this.sendBtn = send;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ta.value.trim();
      if (!v) return;
      ta.value = '';
      ta.style.height = 'auto';
      self.submit(v);
    });
    ta.addEventListener('input', function () {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); }
    });

    panel.appendChild(head); panel.appendChild(log); panel.appendChild(composer);

    // the badge
    var badge = el('button', 'badge blinking');
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Open ' + this.opts.title);
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-controls', 'captain-panel');
    badge.innerHTML = captainSvg('b') + '<span class="hint" aria-hidden="true">?</span>';
    this.badgeFace = badge.querySelector('svg');
    this.badgeFace.setAttribute('data-mood', 'idle');
    badge.addEventListener('click', this.toggle.bind(this));
    this.badge = badge;

    root.appendChild(panel);

    if (!this.inline && this.opts.nudge) {
      var nudge = el('div', 'nudge');
      nudge.setAttribute('role', 'status');
      nudge.appendChild(document.createTextNode(this.opts.nudgeText));
      var dismiss = el('button', null, '\u00d7');
      dismiss.type = 'button';
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', function (e) { e.stopPropagation(); nudge.classList.add('gone'); });
      nudge.appendChild(dismiss);
      nudge.addEventListener('click', function () { self.openPanel(); });
      root.appendChild(nudge);
      this.nudge = nudge;
    }

    root.appendChild(badge);
    shadow.appendChild(root);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && self.open && !self.inline) self.close();
    });

    (mountEl || document.body || document.documentElement).appendChild(host);
    if (this.inline || this.opts.openOnLoad) this.openPanel();
  };

  /** Tell Captain what the user is looking at. Pass null to clear. */
  Widget.prototype.setContext = function (ctx) {
    this.context = ctx && typeof ctx === 'object'
      ? { vesselId: ctx.vesselId != null ? String(ctx.vesselId) : null,
          vesselName: ctx.vesselName != null ? String(ctx.vesselName) : null,
          page: ctx.page != null ? String(ctx.page) : null }
      : null;
    var name = this.context && this.context.vesselName;
    this.ctxPill.textContent = name ? 'Viewing ' + name : '';
    this.ctxPill.classList.toggle('on', !!name);
    if (this.openingCtx) {
      this.openingCtx.textContent = name ? 'Questions default to ' + name + ' unless you name another vessel.' : '';
      this.openingCtx.style.display = name ? '' : 'none';
    }
  };

  Widget.prototype.setMood = function (mood) {
    this.badgeFace.setAttribute('data-mood', mood);
    this.headFace.setAttribute('data-mood', mood);
  };

  Widget.prototype.toggle = function () { this.open ? this.close() : this.openPanel(); };

  Widget.prototype.openPanel = function () {
    this.open = true;
    if (this.nudge) this.nudge.classList.add('gone');
    this.root.classList.add('open');
    this.badge.setAttribute('aria-expanded', 'true');
    this.badge.setAttribute('aria-label', 'Close ' + this.opts.title);
    var self = this;
    setTimeout(function () { self.input.focus(); }, 30);
    if (typeof this.opts.onOpen === 'function') this.opts.onOpen();
  };

  Widget.prototype.close = function () {
    if (this.inline) return;
    this.open = false;
    this.root.classList.remove('open');
    this.badge.setAttribute('aria-expanded', 'false');
    this.badge.setAttribute('aria-label', 'Open ' + this.opts.title);
    this.badge.focus();
    if (typeof this.opts.onClose === 'function') this.opts.onClose();
  };

  // --- transport ------------------------------------------------------------
  Widget.prototype.transport = function (text, pending, history) {
    var context = this.context;
    if (typeof this.opts.ask === 'function') return Promise.resolve(this.opts.ask(text, pending, history, context));

    var headers = { 'Content-Type': 'application/json' };
    var token = typeof this.opts.getToken === 'function' ? this.opts.getToken() : null;
    if (token) headers.Authorization = 'Bearer ' + token;

    return fetch(this.opts.endpoint, {
      method: 'POST',
      headers: headers,
      credentials: 'omit',
      body: JSON.stringify({ text: text, pending: pending, history: history, context: context })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (res.status === 401) return { status: 'error', text: 'Your session has expired. Sign in again and ask me once more.' };
        return data;
      }, function () {
        return { status: 'error', text: 'The server sent a response I could not read.' };
      });
    });
  };

  Widget.prototype.submit = function (displayText, sendValue) {
    if (this.busy) return;
    var body = String(sendValue != null ? sendValue : displayText).trim();
    if (!body) return;

    var self = this;
    this.busy = true;
    this.sendBtn.disabled = true;
    this.showQuestion(displayText);
    this.setMood('thinking');

    var slot = this.showWaiting();
    var carried = this.pending;
    var historySnapshot = this.history.slice(-6);
    this.pending = null;

    this.transport(body, carried, historySnapshot).then(function (data) {
      slot.innerHTML = '';
      slot.appendChild(self.renderAnswer(data));
      if (data.pending) self.pending = data.pending;
      // Conversational turns build history for continuity; data lookups and
      // clarifications do not — there is nothing about a fuel figure the
      // companion needs to remember for small talk later.
      if (data.source === 'companion' || data.source === 'guide') {
        self.history.push({ role: 'user', text: body });
        self.history.push({ role: 'assistant', text: data.text });
        self.history = self.history.slice(-6);
      }
      self.setMood(moodFor(data));
      if (typeof self.opts.onAnswer === 'function') self.opts.onAnswer(data);
    }, function () {
      slot.innerHTML = '';
      slot.appendChild(self.renderAnswer({ status: 'error', text: 'I could not reach the vessel data just now. Nothing was changed. Try again in a moment.' }));
      self.setMood('blocked');
    }).then(function () {
      self.busy = false;
      self.sendBtn.disabled = false;
      self.scrollDown();
      self.input.focus();
      setTimeout(function () { if (!self.busy) self.setMood('idle'); }, 6000);
    });
  };

  function moodFor(data) {
    if (data.status === 'clarify' || data.status === 'confirm') return 'asking';
    if (data.status === 'unsupported' || data.status === 'error' || data.status === 'denied') return 'blocked';
    if (data.empty || data.status === 'no_scope' || data.status === 'unparsed') return 'nothing';
    return 'answered';
  }

  // --- rendering --------------------------------------------------------------
  Widget.prototype.scrollDown = function () { this.log.scrollTop = this.log.scrollHeight; };

  Widget.prototype.addTurn = function (cls) {
    if (this.opening && this.opening.parentNode) this.opening.parentNode.removeChild(this.opening);
    var t = el('div', 'turn ' + cls);
    this.log.appendChild(t);
    return t;
  };

  Widget.prototype.showQuestion = function (text) {
    this.addTurn('you').appendChild(el('div', 'said', text));
    this.scrollDown();
  };

  Widget.prototype.showWaiting = function () {
    var t = this.addTurn('captain');
    var w = el('div', 'waiting');
    w.appendChild(el('i')); w.appendChild(el('i')); w.appendChild(el('i'));
    w.appendChild(el('span', null, 'Reading the records'));
    t.appendChild(w);
    this.scrollDown();
    return t;
  };

  Widget.prototype.renderAnswer = function (data) {
    var kind = 'card';
    if (data.status === 'clarify' || data.status === 'confirm') kind += ' asking';
    else if (data.status === 'unsupported' || data.status === 'error' || data.status === 'denied') kind += ' blocked';
    else if (data.empty) kind += ' nothing';
    var card = el('div', kind);

    var headline = singleFigure(data);
    if (headline) {
      card.appendChild(el('p', 'subject', headline.subject));
      var fig = el('div', 'figure');
      fig.appendChild(document.createTextNode(headline.value));
      if (headline.unit) fig.appendChild(el('span', 'unit', headline.unit));
      card.appendChild(fig);
    } else {
      // Briefings send multiple bullet lines separated by \n; render each as
      // its own paragraph rather than collapsing them into one run of text.
      var lines = String(data.text || '').split('\n').filter(Boolean);
      lines.forEach(function (line) { card.appendChild(el('p', null, line)); });
      if (!lines.length) card.appendChild(el('p', null, ''));
    }

    if (data.series) card.appendChild(renderSeries(data));
    if (data.rows && data.rows.length > 1) card.appendChild(renderRows(data));
    if (data.overview) card.appendChild(renderOverview(data));
    if (data.comparison) card.appendChild(renderComparison(data));
    if (data.stats) card.appendChild(renderStats(data));
    if (data.metrics) card.appendChild(renderCatalogue(data));

    if (data.footnote) card.appendChild(el('p', 'subject', data.footnote));
    if (data.note) card.appendChild(el('div', 'caution', data.note));
    if (data.truncated) card.appendChild(el('div', 'caution hard', 'Only the first ' + data.rows.length + ' readings are shown. Narrow the period to see the rest.'));

    if (data.provenance) card.appendChild(renderProvenance(data));
    if (data.options && data.options.length) card.appendChild(this.renderChoices(data.options));

    if (this.opts.followups && data.status === 'answer') {
      var next = followupsFor(data);
      if (next.length) card.appendChild(this.renderFollowups(next));
    }
    if (data.status === 'answer' && data.text) card.appendChild(copyButton(data));
    return card;
  };

  Widget.prototype.renderFollowups = function (items) {
    var self = this;
    var wrap = el('div', 'followups');
    wrap.setAttribute('aria-label', 'Suggested follow-ups');
    items.forEach(function (it) {
      var b = el('button', null, it.label);
      b.type = 'button';
      b.addEventListener('click', function () { if (!self.busy) self.submit(it.text); });
      wrap.appendChild(b);
    });
    return wrap;
  };

  /**
   * Next questions Captain can answer from where the user just was. Built from
   * provenance only — the metric label and vessel name are both registered
   * aliases, so each chip is a question the parser will resolve without the
   * user having to type it. Nothing here guesses at data.
   */
  function followupsFor(data) {
    var p = data.provenance;
    // Only data answers carry provenance; a guide, briefing or companion reply
    // is excluded explicitly, and an answer with no source tag is judged by
    // whether it has provenance at all.
    if (!p || (data.source && data.source !== 'data')) return [];
    if (!p.metric || p.metric === 'Overview' || !p.vessels || p.vessels.length !== 1) return [];
    var metric = p.metric.toLowerCase();
    var vessel = p.vessels[0];
    var out = [];
    if (data.empty) {
      out.push({ label: 'Try the last 30 days', text: metric + ' for ' + vessel + ' last 30 days' });
      out.push({ label: 'Try this year', text: metric + ' for ' + vessel + ' this year' });
      return out;
    }
    if (!data.series) out.push({ label: 'Trend, last 30 days', text: metric + ' trend for ' + vessel + ' last 30 days' });
    if (!data.comparison) out.push({ label: 'Compare with last month', text: 'compare ' + metric + ' for ' + vessel + ' this month vs last month' });
    if (!data.stats && !data.series) out.push({ label: 'Analyse last 6 months', text: 'analyse ' + metric + ' for ' + vessel + ' last 6 months' });
    return out.slice(0, 3);
  }

  function copyButton(data) {
    var b = el('button', 'copy', 'Copy');
    b.type = 'button';
    b.setAttribute('aria-label', 'Copy answer');
    b.addEventListener('click', function () {
      var text = String(data.text || '');
      var done = function () { b.textContent = 'Copied'; setTimeout(function () { b.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
    return b;
  }

  Widget.prototype.renderChoices = function (options) {
    var self = this;
    var wrap = el('div', 'choices');
    options.forEach(function (opt) {
      var label = typeof opt === 'string' ? opt : opt.label;
      var value = typeof opt === 'string' ? opt : opt.value;
      var b = el('button', null, label);
      b.type = 'button';
      b.addEventListener('click', function () {
        if (self.busy) return;
        var all = wrap.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) all[i].disabled = true;
        self.submit(label, value);
      });
      wrap.appendChild(b);
    });
    return wrap;
  };

  function singleFigure(data) {
    if (data.status !== 'answer' || data.empty || data.value == null) return null;
    if (data.series || data.overview || data.comparison) return null;
    var text = data.text || '';
    var split = text.lastIndexOf(': ');
    if (split < 0) return null;
    var value = text.slice(split + 2).replace(/\.$/, '');
    var unit = data.unit || '';
    if (unit && value.slice(-unit.length) === unit) value = value.slice(0, -unit.length).trim();
    else unit = '';
    return { subject: text.slice(0, split), value: value, unit: unit };
  }

  function renderProvenance(data) {
    var p = data.provenance;
    var bar = el('div', 'sounding');
    var bits = [];
    if (p.vessels && p.vessels.length) bits.push(['Vessel', p.vessels.join(', ')]);
    if (p.period) bits.push(['Period', p.period]);
    if (data.rowsUsed != null) bits.push(['Reports read', String(data.rowsUsed)]);
    if (p.source) bits.push(['Source', p.source]);
    bits.forEach(function (pair) {
      var s = el('span');
      s.appendChild(document.createTextNode(pair[0] + ' '));
      s.appendChild(el('b', null, pair[1]));
      bar.appendChild(s);
    });
    if (!p.sql) return bar;
    var frag = document.createDocumentFragment();
    frag.appendChild(bar);
    var d = el('details', 'working');
    d.appendChild(el('summary', null, 'Show the query behind this figure'));
    d.appendChild(el('pre', null, p.sql + '\n\n-- values: ' + JSON.stringify(p.sqlValues)));
    frag.appendChild(d);
    return frag;
  }

  function renderSeries(data) {
    var pts = data.series;
    var ns = 'http://www.w3.org/2000/svg';
    var w = 640, h = 90, padL = 6, padR = 6, padT = 8, padB = 16;
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', pts.length + ' points from ' + pts[0].bucket + ' to ' + pts[pts.length - 1].bucket);

    var vals = pts.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) hi = lo + 1;
    var x = function (i) { return padL + (i / Math.max(1, pts.length - 1)) * (w - padL - padR); };
    var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (h - padT - padB); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1); }).join(' ');
    var area = d + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (h - padB) + ' L' + x(0).toFixed(1) + ' ' + (h - padB) + ' Z';

    var fill = document.createElementNS(ns, 'path'); fill.setAttribute('class', 'fill'); fill.setAttribute('d', area); svg.appendChild(fill);
    var line = document.createElementNS(ns, 'path'); line.setAttribute('class', 'line'); line.setAttribute('d', d); svg.appendChild(line);
    var axis = document.createElementNS(ns, 'line'); axis.setAttribute('class', 'axis');
    axis.setAttribute('x1', padL); axis.setAttribute('x2', w - padR); axis.setAttribute('y1', h - padB); axis.setAttribute('y2', h - padB); svg.appendChild(axis);
    [[padL, pts[0].bucket, 'start'], [w - padR, pts[pts.length - 1].bucket, 'end']].forEach(function (t) {
      var tx = document.createElementNS(ns, 'text');
      tx.setAttribute('x', t[0]); tx.setAttribute('y', h - 4); tx.setAttribute('text-anchor', t[2]);
      tx.textContent = t[1]; svg.appendChild(tx);
    });

    var frag = document.createDocumentFragment();
    frag.appendChild(svg);
    frag.appendChild(el('p', 'subject', 'Low ' + fmtNumber(lo, data.unit) + ' \u00b7 high ' + fmtNumber(hi, data.unit)));
    return frag;
  }

  function renderRows(data) {
    var table = el('table', 'grid');
    var head = el('tr'); head.appendChild(el('th', null, 'Date')); head.appendChild(el('th', null, data.unit || 'Value')); table.appendChild(head);
    data.rows.slice(0, 60).forEach(function (r) {
      var tr = el('tr'); tr.appendChild(el('td', null, r.at)); tr.appendChild(el('td', 'num', fmtNumber(r.value))); table.appendChild(tr);
    });
    return table;
  }

  function renderOverview(data) {
    var table = el('table', 'grid');
    var head = el('tr');
    ['Measurement', 'Reports', 'Figure', 'Low', 'High'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    data.overview.forEach(function (b) {
      var tr = el('tr');
      tr.appendChild(el('td', null, b.metric + (b.reports ? ' (' + b.headlineKind + ')' : '')));
      tr.appendChild(el('td', null, String(b.reports)));
      if (!b.reports) { var none = el('td', 'none', 'no data'); none.colSpan = 3; tr.appendChild(none); }
      else {
        tr.appendChild(el('td', 'num', fmtNumber(b.headline)));
        tr.appendChild(el('td', 'num', fmtNumber(b.minimum)));
        tr.appendChild(el('td', 'num', fmtNumber(b.maximum)));
      }
      table.appendChild(tr);
    });
    return table;
  }

  function renderComparison(data) {
    var c = data.comparison;
    var table = el('table', 'grid');
    var head = el('tr');
    ['Period', 'Reports', data.unit || 'Value'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    [c.a, c.b].forEach(function (side) {
      var tr = el('tr');
      tr.appendChild(el('td', null, side.label)); tr.appendChild(el('td', null, String(side.rows))); tr.appendChild(el('td', 'num', fmtNumber(side.value)));
      table.appendChild(tr);
    });
    return table;
  }

  function renderStats(data) {
    var s = data.stats;
    var table = el('table', 'grid');
    [['Reports', s.reports], ['Total', s.total], ['Average', s.average], ['Lowest', s.minimum], ['Highest', s.maximum], ['First record', s.firstAt], ['Last record', s.lastAt]]
      .forEach(function (p) {
        if (p[1] == null) return;
        var tr = el('tr');
        tr.appendChild(el('th', null, p[0]));
        var isNum = typeof p[1] === 'number';
        tr.appendChild(el('td', isNum ? 'num' : null, isNum ? fmtNumber(p[1]) : String(p[1])));
        table.appendChild(tr);
      });
    return table;
  }

  function renderCatalogue(data) {
    var table = el('table', 'grid');
    var head = el('tr');
    ['Measurement', 'Unit', 'Also called'].forEach(function (h) { head.appendChild(el('th', null, h)); });
    table.appendChild(head);
    data.metrics.forEach(function (m) {
      var tr = el('tr');
      tr.appendChild(el('td', null, m.label)); tr.appendChild(el('td', null, m.unit)); tr.appendChild(el('td', null, (m.aliases || []).join(', ')));
      table.appendChild(tr);
    });
    return table;
  }

  // --- utilities --------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML, for anything from the server
    return n;
  }
  function fmtNumber(n, unit) {
    if (n == null) return null;
    return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
  }
  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i]; if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  // ==========================================================================
  //  Public API
  // ==========================================================================
  var instance = null;
  var Captain = {
    __loaded: true,
    init: function (options) {
      if (instance) return instance;
      var start = function () { instance = new Widget(options); };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
      return Captain;
    },
    open: function () { if (instance) instance.openPanel(); },
    close: function () { if (instance) instance.close(); },
    ask: function (text) { if (instance) { instance.openPanel(); instance.submit(text); } },
    setContext: function (ctx) { if (instance) instance.setContext(ctx); },
    clearContext: function () { if (instance) instance.setContext(null); },
    setTheme: function (theme) { if (instance && ['light', 'dark', 'auto'].indexOf(theme) >= 0) instance.root.setAttribute('data-theme', theme); },
    destroy: function () {
      if (instance && instance.host.parentNode) instance.host.parentNode.removeChild(instance.host);
      instance = null;
    },
    _instance: function () { return instance; },
    scriptOrigin: SCRIPT_ORIGIN
  };

  global.Captain = Captain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Captain;
})(typeof window !== 'undefined' ? window : this);
