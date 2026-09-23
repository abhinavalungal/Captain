/*!
 * Captain Nav — embeddable assistant for GeoServe apps.
 *
 * Floating (default): the captain sits in the corner and opens a chat panel.
 * The API endpoint follows wherever this script was loaded from, so embedding
 * needs no configuration beyond a token:
 *
 *   <script src="https://captain.your-domain.com/captain-widget.js"></script>
 *   <script>
 *     Captain.init({ getToken: function () { return window.SESSION_TOKEN; } });
 *   </script>
 *
 * Inline: render inside your own layout (a sidebar, a drawer):
 *   Captain.init({ mount: '#captain-slot', theme: 'dark' });
 *
 * Page context, so "fuel consumption last month" means *this* vessel:
 *   Captain.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
 *
 * Brand:
 *   Captain.init({ theme: 'auto', brand: { accent: '#0B3B5C', font: 'Inter, system-ui, sans-serif' } });
 *
 * Bring your own transport (optionally streaming via hooks.onDelta):
 *   Captain.init({ ask: async function (text, pending, history, context, hooks) { ... return payload; } });
 *
 * Speed, by design:
 *   - Greetings, thanks and goodbyes are answered locally, with no network.
 *   - Every message is a CORS "simple request" (text/plain body, token in the
 *     body), so the browser never spends a round trip on a preflight.
 *   - The server connection (and, server-side, the database and model
 *     connections) are warmed when the page is idle, before the first message.
 *   - Model answers stream in as they are written.
 *
 * Everything renders inside a Shadow DOM, so host CSS cannot reach in and the
 * widget's CSS cannot leak out. No external requests, no fonts. The
 * conversation is kept in sessionStorage (this tab only) so it survives page
 * navigation; pass persist: false to keep it in memory only.
 */
(function (global) {
  'use strict';

  if (global.Captain && global.Captain.__loaded) return;

  var VERSION = '2026-09-23.1';

  // Where was this script loaded from? The API lives on the same origin.
  var SCRIPT_ORIGIN = '';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) SCRIPT_ORIGIN = new URL(cs.src, document.baseURI).origin;
  } catch (_) { SCRIPT_ORIGIN = ''; }

  // ==========================================================================
  //  The character (unchanged from the original design).
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
      // cheeks: the blush. Painted here so they sit on the face but under the
      // moustache and eyes. Invisible until a mood turns them on.
      '<g class="c-cheek c-cheek-l">' +
        '<ellipse fill="#E8798A" opacity=".55" cx="37.6" cy="49.6" rx="5.4" ry="3.3"/>' +
        '<g stroke="#D4566B" stroke-width=".7" stroke-linecap="round" opacity=".55" fill="none">' +
          '<path d="M34.6 48.6 L40.6 48.6"/><path d="M34.2 50.2 L41 50.2"/><path d="M35.2 51.6 L40 51.6"/>' +
        '</g>' +
      '</g>' +
      '<g class="c-cheek c-cheek-r">' +
        '<ellipse fill="#E8798A" opacity=".55" cx="62.4" cy="49.6" rx="5.4" ry="3.3"/>' +
        '<g stroke="#D4566B" stroke-width=".7" stroke-linecap="round" opacity=".55" fill="none">' +
          '<path d="M59.4 48.6 L65.4 48.6"/><path d="M59 50.2 L65.8 50.2"/><path d="M60 51.6 L64.8 51.6"/>' +
        '</g>' +
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
      '<path class="c-mouth m-shy"       d="M46.3 60.2 Q50 61.7 53.6 59.9"/>' +
      '<path class="c-mouth m-surprised" d="M47.4 61 Q47.4 57.7 50 57.7 Q52.6 57.7 52.6 61 Q52.6 64.3 50 64.3 Q47.4 64.3 47.4 61 Z"/>' +
      // disappointed: a deeper downturn than m-nothing, corners pulled well down
      '<path class="c-mouth m-sad"       d="M44.8 62.8 Q50 58.6 55.2 62.8"/>' +
      // Open mouths are groups, not single strokes: dark interior, a row of
      // teeth, a tongue. They carry .c-mouthg so the flat-stroke .c-mouth rules
      // never repaint them.
      '<g class="c-mouthg m-happy">' +
        '<path fill="#5A2E26" d="M43.6 58.4 Q50 57.4 56.4 58.4 Q55.2 65.8 50 65.8 Q44.8 65.8 43.6 58.4 Z"/>' +
        '<path fill="#FFFFFF" d="M44.7 58.9 Q50 58.1 55.3 58.9 Q54.9 61.3 50 61.5 Q45.1 61.3 44.7 58.9 Z"/>' +
        '<path fill="#C4566A" d="M46.7 63 Q50 61.9 53.3 63 Q52.6 65.6 50 65.6 Q47.4 65.6 46.7 63 Z"/>' +
      '</g>' +
      '<g class="c-mouthg m-laughing">' +
        '<path fill="#5A2E26" d="M42.6 57.9 Q50 56.5 57.4 57.9 Q56.4 67.4 50 67.4 Q43.6 67.4 42.6 57.9 Z"/>' +
        '<path fill="#FFFFFF" d="M43.9 58.5 Q50 57.3 56.1 58.5 Q55.7 61.4 50 61.6 Q44.3 61.4 43.9 58.5 Z"/>' +
        '<path fill="#D2687C" d="M45.6 63.4 Q50 61.8 54.4 63.4 Q53.4 67.2 50 67.2 Q46.6 67.2 45.6 63.4 Z"/>' +
      '</g>' +
      '<g class="c-mouthg m-confused">' +
        '<path fill="#5A2E26" d="M47.1 61.3 Q46.9 58 50.1 57.8 Q53.3 57.7 53.4 61 Q53.5 64.4 50.3 64.5 Q47.2 64.7 47.1 61.3 Z"/>' +
        '<path fill="#C4566A" opacity=".8" d="M48.6 62.9 Q50.2 62 51.8 62.8 Q51.6 64.3 50.2 64.4 Q48.8 64.4 48.6 62.9 Z"/>' +
      '</g>' +
      // eyes
      '<g class="c-eye c-eye-l"><ellipse fill="#FDFDFD" cx="41.5" cy="43.5" rx="4.2" ry="3.9"/><circle class="c-iris" fill="url(#cp-iris)" cx="42" cy="43.9" r="2.5"/><circle class="c-pupil" fill="#111820" cx="42" cy="43.9" r="1.35"/><circle class="c-glint" fill="#FFF" cx="43" cy="42.9" r=".7"/><path stroke="#5B4636" stroke-width=".9" fill="none" stroke-linecap="round" d="M37.3 42.2 Q41.5 38.6 45.7 42.2"/></g>' +
      '<g class="c-eye c-eye-r"><ellipse fill="#FDFDFD" cx="58.5" cy="43.5" rx="4.2" ry="3.9"/><circle class="c-iris" fill="url(#cp-iris)" cx="59" cy="43.9" r="2.5"/><circle class="c-pupil" fill="#111820" cx="59" cy="43.9" r="1.35"/><circle class="c-glint" fill="#FFF" cx="60" cy="42.9" r=".7"/><path stroke="#5B4636" stroke-width=".9" fill="none" stroke-linecap="round" d="M54.3 42.2 Q58.5 38.6 62.7 42.2"/></g>' +
      // eyes squeezed shut, the way they go in a real laugh. Shown only when
      // the open eyes above are hidden, so the two never overlap.
      // The visor covers everything above roughly y=44.4, so these arcs sit
      // low, in the strip of eye that is actually visible under the cap.
      '<g class="c-eyes-shut" fill="none" stroke="#5B4636" stroke-width="1.6" stroke-linecap="round">' +
        '<path d="M37.4 47.8 Q41.5 42 45.6 47.8"/>' +
        '<path d="M54.4 47.8 Q58.5 42 62.6 47.8"/>' +
      '</g>' +
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
  //  Icons — 20px grid, 1.6px strokes, drawn once.
  // ==========================================================================
  function icon(paths, size) {
    var s = size || 18;
    return '<svg viewBox="0 0 20 20" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';
  }
  var ICON = {
    send: icon('<path d="M10 15.5V4.5"/><path d="M5.5 9L10 4.5L14.5 9"/>', 18),
    stop: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false"><rect x="4.5" y="4.5" width="11" height="11" rx="2.2" fill="currentColor"/></svg>',
    copy: icon('<rect x="6.5" y="6.5" width="9" height="9" rx="2"/><path d="M13.5 6.5V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v7A1.5 1.5 0 0 0 5 13.5h1.5"/>', 15),
    check: icon('<path d="M4.5 10.5l3.5 3.5l7.5-8"/>', 15),
    up: icon('<path d="M6.5 9v7.5H4.5a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1h2z"/><path d="M6.5 9l3-5.5a1.8 1.8 0 0 1 2.3 1.7V8h3.6a1.5 1.5 0 0 1 1.5 1.8l-1.1 5.5a1.5 1.5 0 0 1-1.5 1.2H6.5"/>', 15),
    down: icon('<path d="M6.5 11V3.5H4.5a1 1 0 0 0-1 1V10a1 1 0 0 0 1 1h2z"/><path d="M6.5 11l3 5.5a1.8 1.8 0 0 0 2.3-1.7V12h3.6a1.5 1.5 0 0 0 1.5-1.8l-1.1-5.5a1.5 1.5 0 0 0-1.5-1.2H6.5"/>', 15),
    retry: icon('<path d="M15.5 10a5.5 5.5 0 1 1-1.8-4.1"/><path d="M15.5 3.8v3.4h-3.4"/>', 15),
    newchat: icon('<path d="M10 4.5v11"/><path d="M4.5 10h11"/>', 18),
    expand: icon('<path d="M11.5 3.5h5v5"/><path d="M8.5 16.5h-5v-5"/><path d="M16.5 3.5L11 9"/><path d="M3.5 16.5L9 11"/>', 16),
    collapse: icon('<path d="M16.5 8.5h-5v-5"/><path d="M3.5 11.5h5v5"/><path d="M11.5 8.5l5-5"/><path d="M8.5 11.5l-5 5"/>', 16),
    close: icon('<path d="M5 5l10 10"/><path d="M15 5L5 15"/>', 18),
    down2: icon('<path d="M10 4.5v11"/><path d="M5.5 11L10 15.5L14.5 11"/>', 16),
    alert: icon('<circle cx="10" cy="10" r="7"/><path d="M10 6.5v4"/><path d="M10 13.4v.1"/>', 16),
    vessel: icon('<path d="M3 13.5l1.6 2.5h10.8l1.6-2.5H3z"/><path d="M5 13.5V9.5h10v4"/><path d="M8 9.5V6.5h4v3"/><path d="M10 6.5V3.5"/>', 14),
    arrow: icon('<path d="M4.5 10h11"/><path d="M11 5.5L15.5 10L11 14.5"/>', 15),
  };

  // ==========================================================================
  //  Styles — scoped to the shadow root.
  // ==========================================================================
  var TOKENS_LIGHT =
    '--bg:#FFFFFF;--bg-2:#F7F8FA;--bg-3:#EFF2F5;--hover:rgba(13,27,38,.05);--press:rgba(13,27,38,.08);' +
    '--ink:#0D1B26;--ink-2:#46535F;--ink-3:#76838E;--ink-4:#A7B0B8;' +
    '--line:#E7EAEE;--line-2:#D5DBE1;--line-3:#BCC5CD;' +
    '--accent:#0F2A40;--accent-hover:#193E5C;--on-accent:#FFFFFF;--brass:#B08A3E;' +
    '--sea:#1D6B7E;--sea-2:#8FC0CB;--sea-soft:rgba(29,107,126,.09);' +
    '--ok:#2E8B57;--warn:#A86B12;--warn-soft:#FBF4E6;--danger:#B42318;--danger-soft:#FDF2F1;' +
    '--user-bg:#EEF2F6;--user-ink:#0D1B26;--code-bg:#F5F7F9;--focus:rgba(15,42,64,.14);' +
    '--shadow-panel:0 0 0 1px rgba(13,27,38,.07),0 24px 56px -16px rgba(13,27,38,.30),0 8px 20px -10px rgba(13,27,38,.14);' +
    '--shadow-badge:0 1px 2px rgba(13,27,38,.22),0 10px 24px -6px rgba(13,27,38,.35);';
  var TOKENS_DARK =
    '--bg:#0F1720;--bg-2:#141E29;--bg-3:#1A2632;--hover:rgba(231,237,242,.06);--press:rgba(231,237,242,.1);' +
    '--ink:#E8EDF1;--ink-2:#AEB9C3;--ink-3:#7F8C97;--ink-4:#56636E;' +
    '--line:#1F2B37;--line-2:#2A3845;--line-3:#3A4A58;' +
    '--accent:#E8EDF1;--accent-hover:#FFFFFF;--on-accent:#0F1720;--brass:#C9A45A;' +
    '--sea:#62B6C9;--sea-2:#2F6674;--sea-soft:rgba(98,182,201,.13);' +
    '--ok:#4CC08A;--warn:#E0A64A;--warn-soft:rgba(224,166,74,.1);--danger:#F28B82;--danger-soft:rgba(242,139,130,.1);' +
    '--user-bg:#1D2A36;--user-ink:#E8EDF1;--code-bg:#141E29;--focus:rgba(232,237,241,.16);' +
    '--shadow-panel:0 0 0 1px rgba(255,255,255,.06),0 24px 56px -16px rgba(0,0,0,.6),0 8px 20px -10px rgba(0,0,0,.4);' +
    '--shadow-badge:0 1px 2px rgba(0,0,0,.4),0 10px 24px -6px rgba(0,0,0,.55);';

  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    'button{font:inherit;color:inherit}',
    '.root{' + TOKENS_LIGHT +
      '--font:"Inter var","Inter","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--display:"Inter var","Inter","Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--mono:"Cascadia Mono","SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;' +
      '--ease:cubic-bezier(.2,.8,.2,1);' +
      'position:fixed;right:20px;bottom:20px;z-index:2147483000;' +
      'font:400 14.5px/1.6 var(--font);color:var(--ink);letter-spacing:-.003em;' +
      '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;' +
      'display:flex;flex-direction:column;align-items:flex-end;gap:14px;' +
    '}',
    '.root[data-theme="dark"]{' + TOKENS_DARK + '}',
    '@media (prefers-color-scheme:dark){.root[data-theme="auto"]{' + TOKENS_DARK + '}}',
    '.root.left{right:auto;left:20px;align-items:flex-start}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',

    // --- launcher -----------------------------------------------------------
    '.badge{width:60px;height:60px;border-radius:50%;padding:0;cursor:pointer;position:relative;display:block;flex:none;' +
      'border:0;background:#0F2A40;box-shadow:var(--shadow-badge);transition:transform .2s var(--ease),box-shadow .2s var(--ease)}',
    '.badge::before{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 1.5px rgba(214,178,110,.9),inset 0 0 0 3px rgba(15,42,64,1);pointer-events:none;z-index:2}',
    '.badge .clip{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:radial-gradient(circle at 50% 28%,#274866 0%,#0F2A40 70%)}',
    '.badge:hover{transform:translateY(-2px)}',
    '.badge:active{transform:translateY(0) scale(.97)}',
    '.badge:focus-visible{outline:2px solid var(--sea);outline-offset:3px}',
    '.badge svg{width:100%;height:100%;display:block;transform:translateY(9%) scale(1.22);animation:breathe 4.6s ease-in-out infinite}',
    '.badge .dot{position:absolute;top:2px;right:2px;width:13px;height:13px;border-radius:50%;background:#D64545;border:2px solid var(--bg);z-index:3;transform:scale(0);transition:transform .25s var(--ease)}',
    '.badge.unread .dot{transform:scale(1)}',
    '@keyframes breathe{0%,100%{transform:translateY(9%) scale(1.22)}50%{transform:translateY(9%) scale(1.233)}}',
    '@keyframes eyeDrift{0%,100%{transform:translate(0,0)}20%{transform:translate(1.1px,-.6px)}55%{transform:translate(-1px,.5px)}80%{transform:translate(.6px,.7px)}}',
    '.idle-drift .c-iris,.idle-drift .c-pupil,.idle-drift .c-glint{animation:eyeDrift 9s ease-in-out infinite}',
    '@keyframes moodPop{0%{transform:scale(1)}40%{transform:scale(1.08)}100%{transform:scale(1)}}',
    '.mood-pop{animation:moodPop .4s ease-out}',

    '.nudge{position:relative;max-width:240px;padding:10px 34px 10px 14px;border-radius:12px;background:var(--bg);color:var(--ink);' +
      'font-size:13.5px;line-height:1.4;box-shadow:var(--shadow-panel);cursor:pointer;animation:nudgeIn .35s var(--ease) both}',
    '.nudge b{font-weight:600}',
    '.nudge::after{content:"";position:absolute;right:24px;bottom:-6px;width:12px;height:12px;background:var(--bg);transform:rotate(45deg);box-shadow:3px 3px 4px -2px rgba(13,27,38,.12)}',
    '.root.left .nudge::after{right:auto;left:24px}',
    '.nudge .x{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center}',
    '.nudge .x:hover{background:var(--hover);color:var(--ink)}',
    '.nudge .x svg{width:14px;height:14px}',
    '.root.open .nudge,.nudge.gone{display:none}',
    '@keyframes nudgeIn{from{opacity:0;transform:translateY(6px) scale(.98)}to{opacity:1;transform:none}}',

    // --- character parts (colours are painted in the SVG; CSS only drives expression) ---
    '.c-brow{fill:none;stroke:#9FA6AD;stroke-width:2;stroke-linecap:round;transition:transform .25s ease;transform-box:fill-box;transform-origin:center}',
    '.c-mouth{fill:none;stroke:#7A4A3C;stroke-width:1.4;stroke-linecap:round;display:none}',
    '.c-mouth.m-asking{fill:#5A2E26}',
    '.c-mouth.m-surprised{fill:#5A2E26}',
    '.c-mouth.m-sad{stroke-width:1.6}',
    // open mouths: painted groups, hidden by default like the stroke mouths
    '.c-mouthg{display:none}',
    // the blush. Off at rest, faded in by mood — never popped in instantly.
    '.c-cheek{opacity:0;transition:opacity .32s ease}',
    // closed laughing eyes, shown only when the open eyes are hidden
    '.c-eyes-shut{display:none}',
    '.c-eye{transform-box:fill-box;transform-origin:center;transition:transform .25s ease}',
    '.c-iris,.c-pupil,.c-glint{transition:transform .25s ease}',

    // moods
    'svg[data-mood="idle"] .m-idle{display:block}',
    'svg[data-mood="answered"] .m-answered{display:block}',
    'svg[data-mood="asking"] .m-asking{display:block}',
    'svg[data-mood="blocked"] .m-blocked{display:block}',
    'svg[data-mood="nothing"] .m-nothing{display:block}',
    'svg[data-mood="thinking"] .m-thinking{display:block}',
    'svg[data-mood="shy"] .m-shy{display:block}',
    'svg[data-mood="excited"] .m-answered{display:block}',
    'svg[data-mood="tired"] .m-idle{display:block}',
    'svg[data-mood="confused"] .m-thinking{display:block}',
    'svg[data-mood="curious"] .m-asking{display:block}',
    'svg[data-mood="surprised"] .m-surprised{display:block}',
    'svg[data-mood="sorry"] .m-nothing{display:block}',
    'svg[data-mood="thinking"] .c-brow{transform:translateY(-1.6px)}',
    'svg[data-mood="thinking"] .c-iris,svg[data-mood="thinking"] .c-pupil,svg[data-mood="thinking"] .c-glint{transform:translate(1.1px,-1.4px)}',
    'svg[data-mood="asking"] .c-brow-r{transform:translateY(-2.2px) rotate(-6deg)}',
    'svg[data-mood="blocked"] .c-brow{transform:translateY(1.4px)}',
    'svg[data-mood="blocked"] .c-brow-l{transform:translateY(1.4px) rotate(8deg)}',
    'svg[data-mood="blocked"] .c-brow-r{transform:translateY(1.4px) rotate(-8deg)}',
    'svg[data-mood="nothing"] .c-brow-l{transform:translateY(.8px) rotate(-6deg)}',
    'svg[data-mood="nothing"] .c-brow-r{transform:translateY(.8px) rotate(6deg)}',

    // --- personality moods: bashful, delighted, weary, puzzled, wide-eyed, surprised, apologetic ---
    'svg[data-mood="shy"] .c-brow{transform:translateY(1px)}',
    'svg[data-mood="shy"] .c-cheek{opacity:.92}',
    'svg[data-mood="shy"] .c-iris,svg[data-mood="shy"] .c-pupil,svg[data-mood="shy"] .c-glint{transform:translate(1.3px,1.1px)}',

    'svg[data-mood="excited"] .c-brow{transform:translateY(-1.8px)}',
    'svg[data-mood="excited"] .c-eye{transform:scale(1.05)}',

    'svg[data-mood="tired"] .c-eye{transform:scaleY(.55)}',
    'svg[data-mood="tired"] .c-brow{transform:translateY(1.6px) rotate(2deg)}',

    'svg[data-mood="confused"] .c-brow-l{transform:translateY(-2px) rotate(-8deg)}',
    'svg[data-mood="confused"] .c-brow-r{transform:translateY(1.4px) rotate(9deg)}',

    'svg[data-mood="curious"] .c-brow{transform:translateY(-2px)}',
    'svg[data-mood="curious"] .c-eye{transform:scale(1.06)}',

    'svg[data-mood="surprised"] .c-brow{transform:translateY(-2.6px)}',
    'svg[data-mood="surprised"] .c-eye{transform:scale(1.16)}',

    'svg[data-mood="sorry"] .c-brow-l{transform:translateY(-1.6px) rotate(6deg)}',
    'svg[data-mood="sorry"] .c-brow-r{transform:translateY(-1.6px) rotate(-6deg)}',
    'svg[data-mood="sorry"] .c-iris,svg[data-mood="sorry"] .c-pupil,svg[data-mood="sorry"] .c-glint{transform:translate(0,1.4px)}',

    // ======================================================================
    //  The five reference expressions.
    //
    //  These are the moods drawn from the style sheet: happy, blush, sad,
    //  laughing, confused. The older mood names above still work and are
    //  mapped onto these in JS, so nothing that already calls setMood()
    //  changes behaviour — "shy" is now a real blush, "blocked" a real frown.
    // ======================================================================

    // happy — open smile, teeth showing, eyes lifted and slightly narrowed
    'svg[data-mood="happy"] .m-happy{display:block}',
    'svg[data-mood="happy"] .c-brow{transform:translateY(-1.5px)}',
    'svg[data-mood="happy"] .c-eye{transform:scaleY(.88)}',
    'svg[data-mood="happy"] .c-cheek{opacity:.28}',

    // blush — cheeks lit, gaze dropped away, brows softened down
    'svg[data-mood="blush"] .m-shy{display:block}',
    'svg[data-mood="blush"] .c-cheek{opacity:1}',
    'svg[data-mood="blush"] .c-brow{transform:translateY(1.2px)}',
    'svg[data-mood="blush"] .c-eye{transform:scaleY(.82)}',
    'svg[data-mood="blush"] .c-iris,svg[data-mood="blush"] .c-pupil,svg[data-mood="blush"] .c-glint{transform:translate(1.4px,1.2px)}',
    // the older "shy" mood now blushes for real
    'svg[data-mood="shy"] .c-cheek{opacity:1}',

    // sad — deep downturn, inner brow ends lifted, eyes lowered
    'svg[data-mood="sad"] .m-sad{display:block}',
    'svg[data-mood="sad"] .c-brow-l{transform:translate(1px,-2px) rotate(11deg)}',
    'svg[data-mood="sad"] .c-brow-r{transform:translate(-1px,-2px) rotate(-11deg)}',
    'svg[data-mood="sad"] .c-eye{transform:scaleY(.8)}',
    'svg[data-mood="sad"] .c-iris,svg[data-mood="sad"] .c-pupil,svg[data-mood="sad"] .c-glint{transform:translate(0,1.5px)}',

    // laughing — wide open mouth, eyes squeezed shut, cheeks up
    'svg[data-mood="laughing"] .m-laughing{display:block}',
    'svg[data-mood="laughing"] .c-eye{display:none}',
    'svg[data-mood="laughing"] .c-eyes-shut{display:block}',
    'svg[data-mood="laughing"] .c-brow{transform:translateY(-2.4px)}',
    'svg[data-mood="laughing"] .c-cheek{opacity:.5}',

    // confused — open round mouth, one brow up and one down, eyes wide
    'svg[data-mood="confused"] .m-thinking{display:none}',
    'svg[data-mood="confused"] .m-confused{display:block}',
    'svg[data-mood="confused"] .c-eye{transform:scale(1.1)}',

    // motion: each expression gets one short, non-looping gesture
    '@keyframes laughShake{0%,100%{transform:translateY(9%) scale(1.22)}',
      '18%{transform:translateY(7.4%) scale(1.235) rotate(-2.2deg)}',
      '38%{transform:translateY(9.6%) scale(1.215) rotate(2deg)}',
      '58%{transform:translateY(7.6%) scale(1.233) rotate(-1.6deg)}',
      '78%{transform:translateY(9.4%) scale(1.219) rotate(1.2deg)}}',
    '.laugh-shake svg{animation:laughShake .78s ease-in-out 2!important;transform-origin:50% 70%}',
    '@keyframes sadSink{0%,100%{transform:translateY(9%) scale(1.22)}55%{transform:translateY(11.4%) scale(1.205)}}',
    '.sad-sink svg{animation:sadSink 1.5s ease-in-out!important;transform-origin:50% 70%}',
    '@media (prefers-reduced-motion:reduce){.laugh-shake svg,.sad-sink svg{animation:none!important}}',

    // blink: brief, infrequent, and off when motion is reduced
    '@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.08)}}',
    '.blinking .c-eye{animation:blink 5.2s infinite}',
    '.blinking .c-eye-r{animation-delay:.04s}',
    '@media (prefers-reduced-motion:reduce){.blinking .c-eye{animation:none}.badge,.badge:hover{transition:none;transform:none}}',


    // --- panel ----------------------------------------------------------------
    '.panel{width:408px;max-width:calc(100vw - 40px);height:min(700px,calc(100vh - 116px));' +
      'background:var(--bg);border-radius:18px;box-shadow:var(--shadow-panel);' +
      'display:none;flex-direction:column;overflow:hidden;transform-origin:bottom right;position:relative}',
    '.root.left .panel{transform-origin:bottom left}',
    '.root.open .panel{display:flex;animation:panelIn .22s var(--ease)}',
    '.root.closing .panel{display:flex;animation:panelOut .16s ease-in forwards}',
    '.root.restored .panel{animation:none}',
    '@keyframes panelIn{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}',
    '@keyframes panelOut{to{opacity:0;transform:translateY(8px) scale(.985)}}',
    '.root.wide .panel{width:min(720px,calc(100vw - 40px));height:calc(100vh - 116px)}',

    // header
    '.head{display:flex;align-items:center;gap:11px;padding:12px 10px 12px 14px;border-bottom:1px solid var(--line);flex:none;background:var(--bg)}',
    '.avatar{position:relative;width:36px;height:36px;flex:none}',
    '.avatar .face{width:36px;height:36px;border-radius:50%;overflow:hidden;background:radial-gradient(circle at 50% 28%,#274866,#0F2A40 70%);box-shadow:inset 0 0 0 1px rgba(214,178,110,.55)}',
    '.avatar .face svg{width:100%;height:100%;display:block;transform:translateY(9%) scale(1.22);animation:breathe 4.6s ease-in-out infinite}',
    '.avatar .presence{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:var(--ink-4);border:2px solid var(--bg);transition:background .3s}',
    '.root[data-conn="online"] .avatar .presence{background:var(--ok)}',
    '.root[data-conn="waking"] .avatar .presence,.root[data-conn="connecting"] .avatar .presence{background:var(--warn)}',
    '.root[data-conn="offline"] .avatar .presence{background:var(--danger)}',
    '.titles{min-width:0;flex:1;line-height:1.25}',
    '.titles h2{margin:0;font:600 15px/1.25 var(--display);letter-spacing:-.012em;color:var(--ink)}',
    '.titles .status{margin:1px 0 0;font-size:12.5px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.titles .status button{border:0;background:none;padding:0;color:var(--sea);cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-size:inherit}',
    '.tool{width:34px;height:34px;border:0;border-radius:9px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center;flex:none;transition:background .15s,color .15s}',
    '.tool:hover{background:var(--hover);color:var(--ink)}',
    '.tool:active{background:var(--press)}',
    '.tool:focus-visible{outline:2px solid var(--sea);outline-offset:-2px}',
    '.tool[hidden]{display:none}',

    // conversation
    '.body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}',
    '.log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 18px 12px;display:flex;flex-direction:column;gap:20px;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
    '.log::-webkit-scrollbar{width:10px}.log::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:10px;border:3px solid var(--bg)}',
    '.root.wide .log{padding:24px max(24px,calc((100% - 620px)/2)) 16px}',

    // welcome
    '.welcome{margin:auto 0;padding:8px 2px 4px;animation:fadeUp .35s var(--ease) both}',
    '.welcome .hero{width:52px;height:52px;border-radius:50%;overflow:hidden;background:radial-gradient(circle at 50% 28%,#274866,#0F2A40 70%);box-shadow:inset 0 0 0 1.5px rgba(214,178,110,.6),0 6px 16px -6px rgba(13,27,38,.35);margin-bottom:18px}',
    '.welcome .hero svg{width:100%;height:100%;display:block;transform:translateY(9%) scale(1.22)}',
    '.welcome h3{margin:0 0 6px;font:600 22px/1.2 var(--display);letter-spacing:-.022em;color:var(--ink)}',
    '.welcome p{margin:0;color:var(--ink-2);font-size:14.5px;line-height:1.55;max-width:34em}',
    '.welcome .ctxline{margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--sea);background:var(--sea-soft);padding:4px 10px 4px 8px;border-radius:999px}',
    '.welcome .ctxline[hidden]{display:none}',
    '.prompts{list-style:none;margin:22px 0 0;padding:0;border-top:1px solid var(--line)}',
    '.prompts li{border-bottom:1px solid var(--line)}',
    '.prompts button{width:100%;display:flex;align-items:center;gap:12px;padding:11px 4px;border:0;background:transparent;cursor:pointer;text-align:left;color:var(--ink);font-size:14px;border-radius:0;transition:background .15s,padding .2s var(--ease)}',
    '.prompts button:hover{background:linear-gradient(90deg,var(--hover),transparent);padding-left:8px}',
    '.prompts button:focus-visible{outline:2px solid var(--sea);outline-offset:-2px}',
    '.prompts .tag{flex:none;width:78px;font:500 10.5px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}',
    '.prompts .q{flex:1;min-width:0}',
    '.prompts .go{flex:none;color:var(--ink-4);opacity:0;transform:translateX(-4px);transition:opacity .15s,transform .2s var(--ease)}',
    '.prompts button:hover .go,.prompts button:focus-visible .go{opacity:1;transform:none;color:var(--ink-2)}',
    '.trust{margin-top:18px;font-size:12px;color:var(--ink-3);display:flex;gap:7px;align-items:flex-start;line-height:1.45}',
    '.trust::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--brass);margin-top:6px}',

    // turns
    '.turn{display:flex;flex-direction:column;min-width:0}',
    '.turn.anim{animation:fadeUp .22s var(--ease) both}',
    '@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@keyframes fadeIn{from{opacity:0}to{opacity:1}}',
    '.turn.user{align-items:flex-end}',
    '.bubble{max-width:86%;padding:9px 14px;border-radius:18px 18px 5px 18px;background:var(--user-bg);color:var(--user-ink);white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;line-height:1.5}',
    '.turn.user .edit{margin-top:4px;opacity:0;transition:opacity .15s}',
    '.msg{min-width:0;overflow-wrap:anywhere;color:var(--ink)}',
    '.msg > :first-child{margin-top:0}',
    '.msg p{margin:0}.msg p + p,.msg p + ul,.msg p + ol,.msg ul + p,.msg ol + p,.msg pre + p,.msg p + pre,.msg .tablewrap + p,.msg p + .tablewrap,.msg blockquote + p,.msg p + blockquote{margin-top:10px}',
    '.msg h4{margin:14px 0 6px;font:600 14.5px/1.4 var(--display);letter-spacing:-.01em}',
    '.msg h4:first-child{margin-top:0}',
    '.msg strong{font-weight:600;color:var(--ink)}',
    '.msg em{font-style:italic}',
    '.msg a{color:var(--sea);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}',
    '.msg ul,.msg ol{margin:6px 0 0;padding-left:20px}',
    '.msg li{margin:3px 0;padding-left:2px}',
    '.msg li::marker{color:var(--ink-3)}',
    '.msg ul ul,.msg ol ul{margin-top:2px}',
    '.msg blockquote{margin:8px 0 0;padding:2px 0 2px 12px;border-left:2px solid var(--line-2);color:var(--ink-2)}',
    '.msg hr{border:0;border-top:1px solid var(--line);margin:14px 0}',
    '.msg code{font:500 .86em/1.4 var(--mono);background:var(--code-bg);border:1px solid var(--line);padding:1px 5px;border-radius:5px}',
    '.codeblock{margin:10px 0 0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--code-bg)}',
    '.codeblock .bar{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 4px 12px;border-bottom:1px solid var(--line);font:500 11px/1 var(--mono);color:var(--ink-3);text-transform:lowercase}',
    '.codeblock .bar button{border:0;background:transparent;color:var(--ink-3);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border-radius:6px;font:500 11px/1 var(--font)}',
    '.codeblock .bar button:hover{background:var(--hover);color:var(--ink)}',
    '.codeblock pre{margin:0;padding:11px 13px;overflow-x:auto;font:400 12.5px/1.6 var(--mono);white-space:pre;tab-size:2}',
    '.codeblock pre code{background:none;border:0;padding:0;font:inherit}',
    '.caret{display:inline-block;width:.5em;height:1.05em;vertical-align:-.16em;margin-left:1px;border-radius:1.5px;background:var(--ink);opacity:.75;animation:caret 1s steps(1) infinite}',
    '@keyframes caret{50%{opacity:0}}',

    // thinking
    '.thinking{display:inline-flex;align-items:center;gap:10px;color:var(--ink-3);font-size:14px;animation:fadeIn .2s ease .12s both}',
    '.thinking .dots{display:inline-flex;gap:4px}',
    '.thinking .dots i{width:6px;height:6px;border-radius:50%;background:var(--ink-3);animation:dot 1.2s infinite ease-in-out}',
    '.thinking .dots i:nth-child(2){animation-delay:.15s}.thinking .dots i:nth-child(3){animation-delay:.3s}',
    '@keyframes dot{0%,70%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-2px)}}',
    '.thinking .label{background:linear-gradient(90deg,var(--ink-3) 0%,var(--ink-3) 40%,var(--ink) 50%,var(--ink-3) 60%,var(--ink-3) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shimmer 2.2s linear infinite}',
    '@keyframes shimmer{from{background-position:100% 0}to{background-position:-150% 0}}',

    // meta / actions
    '.meta{display:flex;align-items:center;gap:2px;margin-top:6px;margin-left:-6px;min-height:28px}',
    '.act{width:28px;height:28px;border:0;border-radius:7px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s,opacity .15s}',
    '.act:hover{background:var(--hover);color:var(--ink)}',
    '.act:focus-visible{outline:2px solid var(--sea);outline-offset:-2px}',
    '.act.on{color:var(--ink)}',
    '.act.on.up{color:var(--ok)}',
    '.act.on.down{color:var(--danger)}',
    '.meta .time.err{margin-left:0}',
    '.meta .time{margin-left:6px;font:400 11.5px/1 var(--mono);color:var(--ink-4);letter-spacing:.01em;white-space:nowrap}',
    '.turn.assistant .meta{opacity:0;transition:opacity .15s}',
    '.turn.assistant:hover .meta,.turn.assistant:focus-within .meta,.turn.assistant.last .meta{opacity:1}',
    '@media (hover:none){.turn.assistant .meta{opacity:1}}',

    // chips
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
    '.chip{border:1px solid var(--line-2);background:var(--bg);color:var(--ink-2);border-radius:999px;padding:5px 12px;font-size:13px;line-height:1.35;cursor:pointer;text-align:left;transition:border-color .15s,background .15s,color .15s}',
    '.chip:hover{border-color:var(--line-3);background:var(--bg-2);color:var(--ink)}',
    '.chip:focus-visible{outline:2px solid var(--sea);outline-offset:1px}',
    '.chip:disabled{opacity:.45;cursor:default}',
    '.choices .chip{border-color:var(--sea-2);color:var(--ink);background:var(--sea-soft)}',
    '.choices .chip:hover{background:var(--sea-soft);border-color:var(--sea)}',
    '.chip.picked{border-color:var(--sea);color:var(--ink);opacity:1}',

    // data readout
    '.card{border:1px solid var(--line);border-radius:14px;padding:14px 16px 12px;background:var(--bg);margin-top:2px}',
    '.card + p,.msg p + .card{margin-top:10px}',
    '.eyebrow{font:500 10.5px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);margin:0 0 6px}',
    '.figure{font:600 32px/1.1 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--ink);margin:0 0 4px;word-break:break-word}',
    '.figure .unit{font:500 15px/1 var(--font);letter-spacing:0;color:var(--ink-3);margin-left:6px}',
    '.subject{color:var(--ink-2);font-size:13.5px;line-height:1.45;margin:0}',
    '.card .subject + .subject{margin-top:4px}',
    '.soundings{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--line-2);font:400 11.5px/1.5 var(--mono);color:var(--ink-3)}',
    '.soundings span{overflow-wrap:anywhere}',
    '.soundings b{font-weight:500;color:var(--ink-2)}',
    '.note{margin-top:10px;padding:8px 11px;border-radius:9px;background:var(--warn-soft);color:var(--ink-2);font-size:13px;line-height:1.5}',
    '.note.hard{background:var(--danger-soft)}',
    'details.working{margin-top:10px;font-size:12.5px;color:var(--ink-3)}',
    'details.working summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px}',
    'details.working summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}',
    'details.working[open] summary::before{transform:rotate(45deg)}',
    'details.working pre{margin:8px 0 0;padding:10px 12px;background:var(--code-bg);border:1px solid var(--line);border-radius:9px;overflow-x:auto;font:400 11.5px/1.55 var(--mono);white-space:pre-wrap}',

    // tables
    '.tablewrap{margin-top:10px;overflow-x:auto;border:1px solid var(--line);border-radius:10px}',
    'table.grid{border-collapse:collapse;width:100%;font-size:13px}',
    'table.grid th,table.grid td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}',
    'table.grid tr:last-child td,table.grid tr:last-child th{border-bottom:0}',
    'table.grid th{font:500 10.5px/1.3 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);background:var(--bg-2);white-space:nowrap}',
    'table.grid td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;font-weight:500}',
    'table.grid td.none{color:var(--ink-4);font-style:italic}',
    '.card .tablewrap{border-radius:9px}',

    // charts
    '.chart-title{margin:12px 0 0;font-size:12.5px;font-weight:500;color:var(--ink-2)}',
    '.bars{margin-top:8px;width:100%;display:block}',
    '.bars rect.track{fill:var(--bg-3)}',
    '.bars rect.bar{fill:var(--sea)}',
    '.bars text{font:400 11px var(--font);fill:var(--ink-2)}',
    '.bars text.val{font:500 11.5px var(--font);fill:var(--ink);font-variant-numeric:tabular-nums}',
    '.bars line.axis{stroke:var(--line-2);stroke-width:1}',
    '.spark{margin-top:12px;width:100%;height:96px;display:block;overflow:visible}',
    '.spark path.line{fill:none;stroke:var(--sea);stroke-width:1.8;vector-effect:non-scaling-stroke;stroke-linejoin:round}',
    '.spark path.fill{fill:var(--sea-soft)}',
    '.spark line.axis{stroke:var(--line-2);stroke-width:1;vector-effect:non-scaling-stroke}',
    '.spark text{font:400 10px var(--mono);fill:var(--ink-3)}',
    '.range{display:flex;justify-content:space-between;gap:12px;margin-top:6px;font:400 11px/1.4 var(--mono);color:var(--ink-3)}',
    '.range span{white-space:nowrap}',
    '.lohi{margin:6px 0 0;font:400 11.5px/1.4 var(--mono);color:var(--ink-2)}',
    '.lohi b{font-weight:500;color:var(--ink)}',
    '.card .range + .lohi + .subject,.card .lohi + .subject{margin-top:10px}',

    // notices
    '.notice{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:12px;background:var(--danger-soft);color:var(--ink)}',
    '.notice .ic{color:var(--danger);flex:none;margin-top:2px}',
    '.notice .txt{flex:1;min-width:0;font-size:14px}',
    '.notice .sub{margin-top:3px;font:400 11px/1.4 var(--mono);color:var(--ink-3);word-break:break-word}',
    '.notice .retry{margin-top:8px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);background:var(--bg);border-radius:8px;padding:5px 11px;cursor:pointer;font-size:13px;font-weight:500}',
    '.notice .retry:hover{border-color:var(--line-3)}',
    '.notice.soft{background:var(--bg-2)}',
    '.notice.soft .ic{color:var(--ink-3)}',
    '.stopped{margin-top:6px;font-size:12px;color:var(--ink-3)}',

    // jump to latest
    '.jump{position:absolute;left:50%;bottom:12px;transform:translate(-50%,8px);opacity:0;pointer-events:none;display:inline-flex;align-items:center;gap:6px;' +
      'border:1px solid var(--line-2);background:var(--bg);color:var(--ink-2);border-radius:999px;padding:6px 12px 6px 10px;font-size:12.5px;font-weight:500;cursor:pointer;' +
      'box-shadow:0 4px 14px -4px rgba(13,27,38,.2);transition:opacity .18s,transform .18s var(--ease)}',
    '.jump.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
    '.jump:hover{color:var(--ink)}',

    // composer
    '.composer{flex:none;padding:10px 14px 12px;background:var(--bg)}',
    '.root.wide .composer{padding:10px max(14px,calc((100% - 648px)/2)) 14px}',
    '.box{position:relative;display:flex;flex-direction:column;border:1px solid var(--line-2);border-radius:16px;background:var(--bg);' +
      'box-shadow:0 1px 2px rgba(13,27,38,.04),0 4px 12px -6px rgba(13,27,38,.08);transition:border-color .15s,box-shadow .15s}',
    '.box:hover{border-color:var(--line-3)}',
    '.box.focus{border-color:var(--ink-3);box-shadow:0 0 0 4px var(--focus),0 4px 12px -6px rgba(13,27,38,.08)}',
    '.box textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--ink);' +
      'font:400 15px/1.5 var(--font);letter-spacing:-.003em;padding:12px 14px 0;height:34px;min-height:34px;max-height:180px;overflow-y:auto;scrollbar-width:thin}',
    '.box textarea::placeholder{color:var(--ink-4)}',
    '.box .row{display:flex;align-items:center;gap:8px;padding:4px 8px 8px 12px;min-height:44px}',
    '.box .ctx{display:none;align-items:center;gap:6px;max-width:60%;padding:3px 8px 3px 6px;border-radius:7px;background:var(--bg-2);color:var(--ink-2);font-size:12px;line-height:1.3}',
    '.box .ctx.on{display:inline-flex}',
    '.box .ctx span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.box .spacer{flex:1}',
    '.box .count{font:400 11px/1 var(--mono);color:var(--ink-3)}',
    '.box .count.over{color:var(--danger)}',
    '.send{width:34px;height:34px;border-radius:10px;border:0;background:var(--accent);color:var(--on-accent);cursor:pointer;display:grid;place-items:center;flex:none;' +
      'transition:background .15s,transform .12s,opacity .15s}',
    '.send:hover:not(:disabled){background:var(--accent-hover)}',
    '.send:active:not(:disabled){transform:scale(.94)}',
    '.send:disabled{background:var(--bg-3);color:var(--ink-4);cursor:default}',
    '.send:focus-visible{outline:2px solid var(--sea);outline-offset:2px}',
    '.hint{display:flex;justify-content:center;gap:12px;margin:8px 4px 0;font-size:11.5px;color:var(--ink-4);line-height:1.3;white-space:nowrap;overflow:hidden}',
    '.hint kbd{font:500 11px/1 var(--font);color:var(--ink-3)}',
    '@media (hover:none){.hint .keys{display:none}}',

    // inline mode
    '.root.inline{position:static;width:100%;height:100%;display:block;z-index:auto}',
    '.root.inline .panel{display:flex;width:100%;max-width:none;height:100%;border-radius:0;box-shadow:none;animation:none}',
    '.root.inline .badge,.root.inline .nudge,.root.inline .tool.close,.root.inline .tool.expand{display:none}',

    // phones: the panel becomes a full-height sheet
    '@media (max-width:520px){' +
      '.root:not(.inline){right:14px;bottom:calc(14px + env(safe-area-inset-bottom,0px))}' +
      '.root.left:not(.inline){left:14px}' +
      '.root:not(.inline) .panel{position:fixed;inset:0;width:auto;max-width:none;height:100%;max-height:none;border-radius:0}' +
      '.root.open:not(.inline) .badge,.root.closing:not(.inline) .badge{display:none}' +
      '.head{padding-top:calc(12px + env(safe-area-inset-top,0px))}' +
      '.tool.expand{display:none}' +
      '.log{padding:16px 16px 10px}' +
      '.composer{padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px))}' +
      '.box textarea{font-size:16px}' +
      '.hint{display:none}' +
      '.figure{font-size:28px}' +
    '}',
    '@media (prefers-reduced-motion:reduce){' +
      '.root.open .panel,.root.closing .panel,.turn.anim,.welcome,.nudge{animation:none!important}' +
      '.badge svg,.avatar .face svg,.thinking .dots i,.thinking .label,.caret{animation:none!important}' +
      '.thinking .label{color:var(--ink-3);background:none}' +
      '.idle-drift .c-iris,.idle-drift .c-pupil,.idle-drift .c-glint,.mood-pop{animation:none}' +
      '.badge,.badge:hover{transition:none;transform:none}' +
    '}'
  ].join('');

  // ==========================================================================
  //  Local instant replies — no network at all.
  //  Only the unambiguous: greetings, thanks, goodbyes, "how are you". Anything
  //  that could possibly be a question goes to the server.
  // ==========================================================================
  var LOCAL_GREET_RE = /^\s*(?:hi+|hello+|hey+|hiya|heya|yo|howdy|good (?:morning|afternoon|evening|day)|morning|evening)(?:\s+(?:there|captain|nav|captain nav|all|team|mate))?\s*[!.?,\s\u{1F44B}]*$/iu;
  var LOCAL_THANKS_RE = /^\s*(?:thanks?|thank you|thank u|thx|ty|tysm|cheers|much appreciated)(?:\s+(?:a lot|so much|very much|captain|nav|mate|again))*\s*[!.?,\s\u{1F64F}\u{1F44D}]*$/iu;
  var LOCAL_BYE_RE = /^\s*(?:bye+|goodbye|good night|see (?:you|ya)(?: later| soon)?|cya|later|ttyl)(?:\s+(?:captain|nav|mate))?\s*[!.?,\s\u{1F44B}]*$/iu;
  var LOCAL_HOW_RE = /^\s*(?:(?:hi|hey|hello)[,!\s]+)?(?:how are you(?: doing)?(?: today)?|how(?:'|’)?s it going|how are things|what(?:'|’)?s up|sup|wassup)(?:\s+(?:captain|nav|mate))?\s*[!.?,\s]*$/i;

  function localReply(text, name) {
    var hour = new Date().getHours();
    var hello = hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    var who = name ? ', ' + name : '';
    var seed = (Date.now() / 60000 | 0) + text.length;
    var pick = function (arr) { return arr[seed % arr.length]; };
    if (LOCAL_HOW_RE.test(text)) return pick(['All well on the bridge, thanks. What can I get you?', 'Steady as she goes. What do you need?', 'Shipshape, thanks for asking. What are we looking at today?']);
    if (LOCAL_THANKS_RE.test(text)) return pick(['You’re welcome' + who + '. Ask whenever you need a figure from the records.', 'Any time' + who + '. I’m here when you need the numbers.', 'Glad to help' + who + '.']);
    if (LOCAL_BYE_RE.test(text)) return pick(['Fair winds' + who + '. I’m here when you need me.', 'Safe watch' + who + '. Come find me any time.']);
    if (LOCAL_GREET_RE.test(text)) {
      var m = text.toLowerCase().match(/good (morning|afternoon|evening)/);
      var h = m ? 'Good ' + m[1] : hello;
      return pick([h + who + '. Ask me about a vessel, the app, or anything else you need.', h + who + '. What can I look up for you?', h + who + '. What do you need from the records?']);
    }
    return null;
  }

  // ==========================================================================
  //  Widget
  // ==========================================================================
  var DEFAULTS = {
    endpoint: SCRIPT_ORIGIN + '/api/captain',
    getToken: null,
    tokenInHeader: false,   // true: send "Authorization: Bearer" (costs a CORS preflight cross-origin)
    ask: null,
    title: 'Captain Nav',
    subtitle: null,         // null: live connection status
    greeting: null,         // null: time-of-day greeting
    intro: 'I read your fleet’s records, find things in the app, and help with anything else.',
    examples: [
      { tag: 'Briefing', text: 'Anything I should know today?' },
      { tag: 'Data', text: 'Fuel consumption last month' },
      { tag: 'Compliance', text: 'GHG intensity this year' },
      { tag: 'App', text: 'How do I export a report?' }
    ],
    placeholder: 'Ask Captain anything…',
    position: 'right',      // 'right' | 'left'
    openOnLoad: false,
    mount: null,            // CSS selector or element: render inline instead of floating
    theme: 'light',         // 'light' | 'dark' | 'auto'
    brand: null,            // { accent, accent2, font }
    nudge: true,            // first-visit speech bubble on the badge
    nudgeText: 'Ask me about your fleet',
    followups: true,        // contextual next-question chips after a data answer
    persist: true,          // keep the conversation for this tab (sessionStorage)
    localReplies: true,     // answer pure greetings/thanks instantly, offline
    warm: true,             // warm the server connection when the page is idle
    maxLength: 1000,
    timeoutMs: 90000,
    onOpen: null,
    onClose: null,
    onAnswer: null,
    onReaction: null,       // fn({reaction,question,answer,source,status,at})
    reactionEndpoint: null  // optional URL to POST reaction feedback to
  };

  function Widget(options) {
    this.opts = assign({}, DEFAULTS, options || {});
    if (options && options.examples && !options.examples.length) this.opts.examples = [];
    this.pending = null;
    this.history = [];
    this.turns = [];          // persisted transcript: { role, text, data, at, ms }
    this.context = null;
    this.profile = { userName: null };
    this.busy = false;
    this.open = false;
    this.inline = false;
    this.currentMood = 'idle';
    this.submitTimes = [];
    this.turnCount = 0;
    this._lastNorm = null;
    this._stick = true;
    this._conn = 'connecting';
    this._reducedMotion = !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this._storeKey = 'captain:v2:' + this.opts.endpoint;
    this.mount();
  }

  // --- storage (per tab; every access guarded) -------------------------------
  function store(kind) {
    try { var s = kind === 'local' ? global.localStorage : global.sessionStorage; var k = '__captain_probe'; s.setItem(k, '1'); s.removeItem(k); return s; }
    catch (_) { return null; }
  }
  Widget.prototype.save = function () {
    if (!this.opts.persist) return;
    var s = store('session'); if (!s) return;
    try {
      var turns = this.turns.slice(-40);
      var blob = JSON.stringify({ v: 2, turns: turns, userName: this.profile.userName, pending: this.pending, open: this.open, wide: this.root.classList.contains('wide'), at: Date.now() });
      if (blob.length > 400000) blob = JSON.stringify({ v: 2, turns: turns.slice(-10), userName: this.profile.userName, pending: this.pending, open: this.open, at: Date.now() });
      s.setItem(this._storeKey, blob);
    } catch (_) { /* quota or privacy mode: memory only */ }
  };
  Widget.prototype.load = function () {
    if (!this.opts.persist) return null;
    var s = store('session'); if (!s) return null;
    try {
      var raw = s.getItem(this._storeKey);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || d.v !== 2 || !Array.isArray(d.turns)) return null;
      if (Date.now() - (d.at || 0) > 12 * 3600 * 1000) return null;
      return d;
    } catch (_) { return null; }
  };

  Widget.prototype.mount = function () {
    var self = this;
    var host = document.createElement('div');
    host.setAttribute('data-captain-widget', '');
    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    this.host = host;
    this.shadow = shadow;

    // Constructable stylesheet where supported (also sidesteps host CSP
    // style-src restrictions on inline <style>); a <style> element otherwise.
    var adopted = false;
    try {
      if (shadow.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function' && CSSStyleSheet.prototype.replaceSync) {
        var sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); shadow.adoptedStyleSheets = [sheet]; adopted = true;
      }
    } catch (_) { adopted = false; }
    if (!adopted) { var style = document.createElement('style'); style.textContent = CSS; shadow.appendChild(style); }

    var root = el('div', 'root');
    root.setAttribute('data-theme', ['light', 'dark', 'auto'].indexOf(this.opts.theme) >= 0 ? this.opts.theme : 'light');
    root.setAttribute('data-conn', 'connecting');
    if (this.opts.brand) {
      if (this.opts.brand.accent) root.style.setProperty('--accent', String(this.opts.brand.accent));
      if (this.opts.brand.accent2) root.style.setProperty('--accent-hover', String(this.opts.brand.accent2));
      if (this.opts.brand.font) { root.style.setProperty('--font', String(this.opts.brand.font)); root.style.setProperty('--display', String(this.opts.brand.font)); }
    }
    var mountEl = this.opts.mount ? (typeof this.opts.mount === 'string' ? document.querySelector(this.opts.mount) : this.opts.mount) : null;
    this.inline = !!mountEl;
    if (this.inline) root.classList.add('inline');
    else if (this.opts.position === 'left') root.classList.add('left');
    this.root = root;

    // ---- panel
    var panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.opts.title);
    panel.setAttribute('aria-modal', 'false');
    panel.id = 'captain-panel';
    this.panel = panel;

    var head = el('div', 'head');
    var avatar = el('div', 'avatar');
    var face = el('div', 'face');
    face.innerHTML = captainSvg('h');
    this.headFace = face.querySelector('svg');
    this.headFaceWrap = face;
    this.headFace.setAttribute('data-mood', 'idle');
    avatar.appendChild(face);
    avatar.appendChild(el('span', 'presence'));
    var titles = el('div', 'titles');
    titles.appendChild(el('h2', null, this.opts.title));
    this.statusEl = el('p', 'status', this.opts.subtitle || 'Connecting…');
    this.statusEl.setAttribute('aria-live', 'polite');
    titles.appendChild(this.statusEl);
    var bNew = toolButton('tool newchat', ICON.newchat, 'New conversation');
    bNew.hidden = true;
    bNew.addEventListener('click', function () { self.reset(); self.input.focus(); });
    this.newBtn = bNew;
    var bExpand = toolButton('tool expand', ICON.expand, 'Expand');
    bExpand.setAttribute('aria-pressed', 'false');
    bExpand.addEventListener('click', function () { self.setWide(!root.classList.contains('wide')); });
    this.expandBtn = bExpand;
    var bClose = toolButton('tool close', ICON.close, 'Close');
    bClose.addEventListener('click', function () { self.close(); });
    head.appendChild(avatar); head.appendChild(titles); head.appendChild(bNew); head.appendChild(bExpand); head.appendChild(bClose);

    var body = el('div', 'body');
    var log = el('div', 'log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'off');
    log.setAttribute('aria-label', 'Conversation');
    this.log = log;
    log.addEventListener('scroll', function () {
      var d = log.scrollHeight - log.scrollTop - log.clientHeight;
      self._stick = d < 48;
      if (self._stick) self.jump.classList.remove('on');
    }, { passive: true });
    var jump = el('button', 'jump');
    jump.type = 'button';
    jump.innerHTML = ICON.down2;
    jump.appendChild(document.createTextNode('Latest'));
    jump.addEventListener('click', function () { self.scrollDown(true); });
    this.jump = jump;
    body.appendChild(log); body.appendChild(jump);

    this.buildWelcome();

    // ---- composer
    var composer = el('div', 'composer');
    var form = el('form', 'box');
    form.setAttribute('novalidate', '');
    var ta = el('textarea');
    ta.rows = 1;
    ta.placeholder = this.opts.placeholder;
    ta.setAttribute('aria-label', 'Message Captain');
    ta.setAttribute('enterkeyhint', 'send');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'true');
    var row = el('div', 'row');
    var ctx = el('span', 'ctx');
    ctx.innerHTML = ICON.vessel;
    this.ctxText = el('span');
    ctx.appendChild(this.ctxText);
    this.ctxChip = ctx;
    var count = el('span', 'count');
    this.countEl = count;
    var send = el('button', 'send');
    send.type = 'submit';
    send.innerHTML = ICON.send;
    send.setAttribute('aria-label', 'Send message');
    send.disabled = true;
    row.appendChild(ctx); row.appendChild(el('span', 'spacer')); row.appendChild(count); row.appendChild(send);
    form.appendChild(ta); form.appendChild(row);
    composer.appendChild(form);
    var hint = el('div', 'hint');
    var keys = el('span', 'keys');
    keys.appendChild(kbd('Enter')); keys.appendChild(document.createTextNode(' to send · ')); keys.appendChild(kbd('Shift')); keys.appendChild(document.createTextNode(' + ')); keys.appendChild(kbd('Enter')); keys.appendChild(document.createTextNode(' for a new line'));
    hint.appendChild(keys);
    composer.appendChild(hint);
    this.input = ta; this.sendBtn = send; this.form = form;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (self.busy) { self.stop(); return; }
      var v = ta.value.trim();
      if (!v || v.length > self.opts.maxLength) return;
      ta.value = '';
      self.autosize();
      self.updateComposer();
      self.submit(v);
    });
    ta.addEventListener('input', function () { self.autosize(); self.updateComposer(); });
    ta.addEventListener('focus', function () { form.classList.add('focus'); });
    ta.addEventListener('blur', function () { form.classList.remove('focus'); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (self.busy) return;
        if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
      } else if (e.key === 'ArrowUp' && !ta.value && !self.busy) {
        var last = self.lastUserText();
        if (last) { e.preventDefault(); ta.value = last; self.autosize(); self.updateComposer(); ta.setSelectionRange(last.length, last.length); }
      } else if (e.key === 'Escape') {
        if (self.busy) { e.stopPropagation(); self.stop(); }
      }
    });
    form.addEventListener('click', function (e) { if (e.target === form || e.target === row) ta.focus(); });

    var live = el('div', 'sr');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('role', 'status');
    this.live = live;

    panel.appendChild(head); panel.appendChild(body); panel.appendChild(composer); panel.appendChild(live);

    // ---- launcher
    var badge = el('button', 'badge blinking');
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Open ' + this.opts.title);
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-controls', 'captain-panel');
    var clip = el('span', 'clip');
    clip.innerHTML = captainSvg('b');
    badge.appendChild(clip);
    badge.appendChild(el('span', 'dot'));
    this.badgeFace = clip.querySelector('svg');
    this.badgeFace.setAttribute('data-mood', 'idle');
    badge.addEventListener('click', function () { self.toggle(); });
    this.badge = badge;

    root.appendChild(panel);

    var ls = store('local');
    var nudgeSeen = false;
    try { nudgeSeen = !!(ls && ls.getItem('captain:nudge')); } catch (_) { nudgeSeen = false; }
    if (!this.inline && this.opts.nudge && !nudgeSeen) {
      var nudge = el('div', 'nudge');
      nudge.setAttribute('role', 'status');
      nudge.style.display = 'none';
      nudge.appendChild(document.createTextNode(this.opts.nudgeText));
      var dismiss = el('button', 'x');
      dismiss.type = 'button';
      dismiss.innerHTML = ICON.close;
      dismiss.setAttribute('aria-label', 'Dismiss');
      dismiss.addEventListener('click', function (e) { e.stopPropagation(); self.hideNudge(true); });
      nudge.appendChild(dismiss);
      nudge.addEventListener('click', function () { self.openPanel(); });
      root.appendChild(nudge);
      this.nudge = nudge;
      this._nudgeT = setTimeout(function () { if (!self.open && self.nudge) self.nudge.style.display = ''; }, 2500);
    }

    root.appendChild(badge);
    shadow.appendChild(root);

    this._onKeydown = function (e) {
      if (e.key === 'Escape' && self.open && !self.inline && !self.busy) {
        var path = e.composedPath ? e.composedPath() : [];
        if (path.indexOf(self.host) >= 0 || document.activeElement === self.host) self.close();
      }
    };
    document.addEventListener('keydown', this._onKeydown);

    (mountEl || document.body || document.documentElement).appendChild(host);

    // Restore this tab's conversation (page navigations inside the app).
    var saved = this.load();
    if (saved) this.restore(saved);

    if (this.inline || this.opts.openOnLoad || (saved && saved.open)) this.openPanel(saved && saved.open ? 'restored' : null);

    this.setupLife();
    this.scheduleWarm();
  };

  // --- welcome ---------------------------------------------------------------
  Widget.prototype.buildWelcome = function () {
    var self = this;
    var w = el('div', 'welcome');
    var hero = el('div', 'hero');
    hero.innerHTML = captainSvg('w');
    hero.firstChild.setAttribute('data-mood', 'happy');
    w.appendChild(hero);
    this.welcomeTitle = el('h3', null, this.greetingText());
    w.appendChild(this.welcomeTitle);
    w.appendChild(el('p', null, this.opts.intro));
    var ctxl = el('div', 'ctxline');
    ctxl.hidden = true;
    ctxl.innerHTML = ICON.vessel;
    this.welcomeCtxText = el('span');
    ctxl.appendChild(this.welcomeCtxText);
    this.welcomeCtx = ctxl;
    w.appendChild(ctxl);
    if (this.opts.examples && this.opts.examples.length) {
      var ul = el('ul', 'prompts');
      ul.setAttribute('aria-label', 'Suggested questions');
      this.promptButtons = [];
      this.opts.examples.forEach(function (ex) {
        var item = typeof ex === 'string' ? { tag: 'Ask', text: ex } : ex;
        var li = el('li');
        var b = el('button');
        b.type = 'button';
        b.appendChild(el('span', 'tag', item.tag || 'Ask'));
        var q = el('span', 'q', item.text);
        b.appendChild(q);
        var go = el('span', 'go'); go.innerHTML = ICON.arrow; b.appendChild(go);
        b.addEventListener('click', function () { self.submit(q.textContent); });
        li.appendChild(b); ul.appendChild(li);
        self.promptButtons.push({ item: item, q: q });
      });
      w.appendChild(ul);
    }
    w.appendChild(el('div', 'trust', 'Every figure comes straight from your database. If the records don’t hold the answer, Captain says so.'));
    this.welcome = w;
    this.log.appendChild(w);
  };

  Widget.prototype.greetingText = function () {
    if (this.opts.greeting) return this.opts.greeting;
    var h = new Date().getHours();
    var g = h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return g + (this.profile.userName ? ', ' + this.profile.userName : '') + '.';
  };

  Widget.prototype.showWelcome = function () {
    if (this.welcome && !this.welcome.parentNode) this.log.appendChild(this.welcome);
    if (this.welcomeTitle) this.welcomeTitle.textContent = this.greetingText();
    this.newBtn.hidden = true;
  };

  Widget.prototype.hideWelcome = function () {
    if (this.welcome && this.welcome.parentNode) this.welcome.parentNode.removeChild(this.welcome);
    this.newBtn.hidden = false;
  };

  Widget.prototype.hideNudge = function (forever) {
    if (this._nudgeT) clearTimeout(this._nudgeT);
    if (this.nudge) this.nudge.classList.add('gone');
    if (forever) { try { var ls = store('local'); if (ls) ls.setItem('captain:nudge', '1'); } catch (_) { /* ignore */ } }
  };

  // --- composer helpers ------------------------------------------------------
  Widget.prototype.autosize = function () {
    var ta = this.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  };

  Widget.prototype.updateComposer = function () {
    var len = this.input.value.trim().length;
    var raw = this.input.value.length;
    var max = this.opts.maxLength;
    if (this.busy) {
      this.sendBtn.disabled = false;
      this.sendBtn.innerHTML = ICON.stop;
      this.sendBtn.setAttribute('aria-label', 'Stop');
      this.sendBtn.title = 'Stop (Esc)';
    } else {
      this.sendBtn.innerHTML = ICON.send;
      this.sendBtn.setAttribute('aria-label', 'Send message');
      this.sendBtn.title = '';
      this.sendBtn.disabled = !len || raw > max;
    }
    if (raw > max * 0.8) {
      this.countEl.textContent = raw + ' / ' + max;
      this.countEl.classList.toggle('over', raw > max);
    } else {
      this.countEl.textContent = '';
    }
  };

  Widget.prototype.lastUserText = function () {
    for (var i = this.turns.length - 1; i >= 0; i--) if (this.turns[i].role === 'user') return this.turns[i].text;
    return '';
  };

  Widget.prototype.setWide = function (wide) {
    this.root.classList.toggle('wide', !!wide);
    this.expandBtn.innerHTML = wide ? ICON.collapse : ICON.expand;
    this.expandBtn.setAttribute('aria-label', wide ? 'Collapse' : 'Expand');
    this.expandBtn.title = wide ? 'Collapse' : 'Expand';
    this.expandBtn.setAttribute('aria-pressed', wide ? 'true' : 'false');
    this.scrollDown();
    this.save();
  };

  // --- connection status + warm-up -------------------------------------------
  Widget.prototype.setConn = function (state) {
    this._conn = state;
    this.root.setAttribute('data-conn', state);
    if (this.opts.subtitle) return;
    var self = this;
    this.statusEl.textContent = '';
    if (this.busy && state === 'online') return this.setStatusText(this._busyLabel || 'Thinking…');
    if (state === 'online') this.statusEl.textContent = 'Online';
    else if (state === 'waking') this.statusEl.textContent = 'Waking up the server…';
    else if (state === 'connecting') this.statusEl.textContent = 'Connecting…';
    else if (state === 'offline') {
      this.statusEl.appendChild(document.createTextNode((global.navigator && navigator.onLine === false ? 'You’re offline' : 'Can’t reach the server') + ' · '));
      var b = el('button', null, 'Retry');
      b.type = 'button';
      b.addEventListener('click', function () { self.warm(true); });
      this.statusEl.appendChild(b);
    }
  };

  Widget.prototype.setStatusText = function (t) {
    if (this.opts.subtitle) return;
    this.statusEl.textContent = t;
  };

  Widget.prototype.scheduleWarm = function () {
    var self = this;
    if (typeof this.opts.ask === 'function' || !this.opts.warm) { this.setConn('online'); return; }
    var go = function () { self.warm(); };
    if (global.requestIdleCallback) global.requestIdleCallback(go, { timeout: 2500 }); else setTimeout(go, 600);
    this._onOnline = function () { self.warm(true); };
    global.addEventListener && global.addEventListener('online', this._onOnline);
  };

  /**
   * GET the health endpoint: wakes a sleeping host (Render's free tier), opens
   * the TLS connection the first message will reuse, and — server-side —
   * warms the database and model connections. Never blocks anything.
   */
  Widget.prototype.warm = function (force) {
    var self = this;
    if (typeof fetch !== 'function' || typeof this.opts.ask === 'function') return Promise.resolve();
    if (this._warming && !force) return this._warming;
    if (this._conn !== 'online') this.setConn('connecting');
    var slow = setTimeout(function () { if (self._conn === 'connecting') self.setConn('waking'); }, 1500);
    this._warming = fetch(this.opts.endpoint, { method: 'GET', credentials: 'omit', cache: 'no-store' })
      .then(function (r) { clearTimeout(slow); self.setConn(r.ok ? 'online' : 'offline'); return r.ok ? r.json() : null; })
      .then(function (h) { self.health = h || null; })
      .catch(function () { clearTimeout(slow); self.setConn('offline'); })
      .then(function () { self._warming = null; });
    return this._warming;
  };

  // --- open / close ---------------------------------------------------------
  Widget.prototype.toggle = function () { this.open ? this.close() : this.openPanel(); };

  Widget.prototype.openPanel = function (how) {
    var self = this;
    if (this.open) return;
    this.open = true;
    this.hideNudge(false);
    this.root.classList.remove('closing');
    if (how === 'restored') this.root.classList.add('restored');
    this.root.classList.add('open');
    this.badge.classList.remove('unread');
    this.badge.setAttribute('aria-expanded', 'true');
    this.badge.setAttribute('aria-label', 'Close ' + this.opts.title);
    if (this._conn !== 'online' && !this._warming) this.warm();
    if (global.matchMedia && global.matchMedia('(max-width: 520px)').matches && !this.inline) {
      this._bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    setTimeout(function () {
      self.root.classList.remove('restored');
      self.scrollDown();
      if (how !== 'restored' || !('ontouchstart' in global)) { try { self.input.focus({ preventScroll: true }); } catch (_) { self.input.focus(); } }
    }, 30);
    if (typeof this.opts.onOpen === 'function') this.opts.onOpen();
    this.save();
  };

  Widget.prototype.close = function () {
    var self = this;
    if (this.inline || !this.open) return;
    this.open = false;
    this.badge.setAttribute('aria-expanded', 'false');
    this.badge.setAttribute('aria-label', 'Open ' + this.opts.title);
    if (this._bodyOverflow !== undefined) { document.body.style.overflow = this._bodyOverflow; this._bodyOverflow = undefined; }
    this.root.classList.remove('open');
    if (!this._reducedMotion) {
      this.root.classList.add('closing');
      clearTimeout(this._closeT);
      this._closeT = setTimeout(function () { self.root.classList.remove('closing'); }, 170);
    }
    try { this.badge.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    if (typeof this.opts.onClose === 'function') this.opts.onClose();
    this.save();
  };

  /** Start a fresh conversation. The user's name is kept. */
  Widget.prototype.reset = function () {
    this.stop(true);
    this.turns = []; this.history = []; this.pending = null;
    var kids = Array.prototype.slice.call(this.log.childNodes);
    for (var i = 0; i < kids.length; i++) if (kids[i] !== this.welcome) this.log.removeChild(kids[i]);
    this.showWelcome();
    this.setMood('idle');
    this.save();
  };

  /** Tell Captain what the user is looking at. Pass null to clear. */
  Widget.prototype.setContext = function (ctx) {
    this.context = ctx && typeof ctx === 'object'
      ? { vesselId: ctx.vesselId != null ? String(ctx.vesselId) : null,
          vesselName: ctx.vesselName != null ? String(ctx.vesselName) : null,
          page: ctx.page != null ? String(ctx.page) : null }
      : null;
    var name = this.context && (this.context.vesselName || this.context.vesselId);
    this.ctxText.textContent = name ? String(name) : '';
    this.ctxChip.classList.toggle('on', !!name);
    this.ctxChip.title = name ? 'Questions default to ' + name : '';
    if (this.welcomeCtx) {
      this.welcomeCtx.hidden = !name;
      this.welcomeCtxText.textContent = name ? 'Questions default to ' + name + ' unless you name another vessel' : '';
    }
    if (this.promptButtons) {
      this.promptButtons.forEach(function (p) {
        var t = p.item.text;
        if (name && /^(fuel consumption|shaft power|speed|distance)\b/i.test(t) && !/\bfor\b/i.test(t)) t = t.replace(/^(.+?)( last| this| today| yesterday)/i, '$1 for ' + name + '$2');
        p.q.textContent = t;
      });
    }
  };

  /**
   * Ambient "alive" behaviour, entirely local: eyes follow the cursor, a slow
   * idle look-around when the mouse has been still, a subtle breathing loop
   * (pure CSS, always on). None of this touches the network or the request
   * pipeline — it is cosmetic only, throttled to one recompute per animation
   * frame, and skipped entirely under prefers-reduced-motion.
   */
  Widget.prototype.setupLife = function () {
    if (this._reducedMotion) return;
    var self = this;
    var raf = global.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
    var caf = global.cancelAnimationFrame || global.clearTimeout;
    var rafId = null;
    var mx = null, my = null;

    function apply() {
      rafId = null;
      // Some moods own the eyes — thought looks away, a laugh shuts them, a
      // blush drops the gaze. Tracking must not fight them.
      if (NO_TRACK[self.currentMood]) return;
      if (mx == null) return;
      [self.badgeFace, self.headFace].forEach(function (svg) {
        if (!svg) return;
        var rect = svg.getBoundingClientRect();
        if (!rect || !rect.width) return; // hidden (panel closed, or off mobile view) — nothing to move
        var cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.42;
        var dx = mx - cx, dy = my - cy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var cap = 1.6; // px — small and natural, never lets the iris leave the socket
        var ox = (dx / dist) * Math.min(cap, dist / 40);
        var oy = (dy / dist) * Math.min(cap, dist / 40);
        var t = 'translate(' + ox.toFixed(2) + 'px,' + oy.toFixed(2) + 'px)';
        var parts = svg.querySelectorAll('.c-iris, .c-pupil, .c-glint');
        for (var i = 0; i < parts.length; i++) parts[i].style.transform = t;
      });
    }

    this._onMove = function (e) {
      mx = e.clientX; my = e.clientY;
      self.root.classList.remove('idle-drift');
      clearTimeout(self._idleT);
      self._idleT = setTimeout(function () {
        self.root.classList.add('idle-drift');
        self.clearEyeOffset();
      }, 6000);
      if (rafId == null) rafId = raf(apply);
    };
    document.addEventListener('mousemove', this._onMove, { passive: true });

    this._visHandler = function () {
      if (document.hidden) document.removeEventListener('mousemove', self._onMove);
      else document.addEventListener('mousemove', self._onMove, { passive: true });
    };
    document.addEventListener('visibilitychange', this._visHandler);

    this._rafCancel = function () { if (rafId != null) caf(rafId); };
  };

  Widget.prototype.clearEyeOffset = function () {
    [this.badgeFace, this.headFace].forEach(function (svg) {
      if (!svg) return;
      var parts = svg.querySelectorAll('.c-iris, .c-pupil, .c-glint');
      for (var i = 0; i < parts.length; i++) parts[i].style.transform = '';
    });
  };

  /** A brief, one-shot bounce — used for excited/surprised, never looping. */
  Widget.prototype.pulse = function () {
    if (this._reducedMotion) return;
    [this.badge, this.headFaceWrap].forEach(function (elx) {
      if (!elx) return;
      elx.classList.remove('mood-pop');
      void elx.offsetWidth; // restart the animation even if it's still playing
      elx.classList.add('mood-pop');
    });
  };

  /**
   * Older mood names map onto the five reference expressions, so every
   * existing setMood() call keeps working and simply looks better: a
   * compliment already asked for "shy", which is now a real blush; a failed
   * lookup already asked for "blocked", which is now a real frown.
   */
  var MOOD_ALIAS = {
    shy: 'blush',
    blocked: 'sad',
    sorry: 'sad',
    unparsed: 'confused'
  };

  /** Moods that own the eyes, so cursor-tracking must keep its hands off. */
  var NO_TRACK = { thinking: 1, laughing: 1, sad: 1, blush: 1 };

  /** How long an emotional reaction holds before easing back to idle. */
  var MOOD_HOLD = { happy: 4200, blush: 4600, sad: 5000, laughing: 3600, confused: 5200 };

  /**
   * Show an expression.
   *
   * @param {string} mood  a mood name, or one of the legacy aliases above
   * @param {number} [holdMs]  revert to idle after this long. Omit to hold
   *        until something else changes it (the request pipeline's own
   *        behaviour, which is unchanged).
   */
  Widget.prototype.setMood = function (mood, holdMs) {
    mood = MOOD_ALIAS[mood] || mood || 'idle';
    if (this._moodT) { clearTimeout(this._moodT); this._moodT = null; }

    this.badgeFace.setAttribute('data-mood', mood);
    this.headFace.setAttribute('data-mood', mood);
    this.currentMood = mood;

    // Moods that take the eyes over need any tracked offset cleared, or the
    // shut-eye arcs and the dropped gaze fight a stale inline transform.
    if (NO_TRACK[mood]) this.clearEyeOffset();

    if (mood === 'excited' || mood === 'surprised' || mood === 'happy') this.pulse();
    if (mood === 'laughing') this.gesture('laugh-shake', 1600);
    if (mood === 'sad') this.gesture('sad-sink', 1500);

    var hold = holdMs != null ? holdMs : null;
    if (hold) {
      var self = this;
      this._moodT = setTimeout(function () {
        self._moodT = null;
        if (!self.busy) self.setMood('idle');
      }, hold);
    }
  };

  /**
   * Drive an expression from something that happened in the host app rather
   * than something the user typed — a save that worked, an export that
   * failed. Called by Captain.react().
   */
  var REACTIONS = {
    success: 'happy',
    complete: 'happy',
    thanks: 'happy',
    praise: 'blush',
    blush: 'blush',
    fail: 'sad',
    error: 'sad',
    sad: 'sad',
    funny: 'laughing',
    laugh: 'laughing',
    unclear: 'confused',
    confused: 'confused'
  };

  Widget.prototype.react = function (event, holdMs) {
    var mood = REACTIONS[String(event || '').toLowerCase()];
    if (!mood) return false;
    this.setMood(mood, holdMs != null ? holdMs : MOOD_HOLD[mood]);
    return true;
  };

  /** One-shot body gesture: a laugh shake, a disappointed sink. */
  Widget.prototype.gesture = function (cls, ms) {
    if (this._reducedMotion) return;
    var targets = [this.badge, this.headFaceWrap];
    targets.forEach(function (elx) {
      if (!elx) return;
      elx.classList.remove(cls);
      void elx.offsetWidth; // restart even if it is still playing
      elx.classList.add(cls);
    });
    setTimeout(function () {
      targets.forEach(function (elx) { if (elx) elx.classList.remove(cls); });
    }, ms || 1200);
  };

  /**
   * Reads the message the user is about to send — nothing else, no network,
   * microseconds of work — and picks the expression to show while Captain is
   * "thinking" about it. The actual reply, once it arrives, still sets the
   * real mood via moodFor(); this only governs the waiting expression, so it
   * can never contradict what Captain ends up saying.
   */
  // Gratitude — "thank you", "thanks a lot", "much appreciated", "cheers".
  var THANKS_RE = /\b(thank(?:s| you|ing you)|thx|ty|tysm|much appreciated|appreciate (?:it|that|you)|cheers(?: mate)?|grateful)\b/i;
  // Praise aimed at Captain himself — this is what earns the blush, and it is
  // deliberately narrower than gratitude: "thanks" is warm, "you're the best"
  // is embarrassing.
  var COMPLIMENT_RE = /\b(good (job|bot|work|lad)|well done|nice job|(?:you'?re|you are|ur) (?:so |really |such )?(?:a )?(?:the )?(smart|great|awesome|amazing|helpful|best|brilliant|legend|genius|goat|star|wonderful|excellent)|love (you|this bot|ya)|amazing (job|work)|impressive|brilliant work|you rock|proud of you|my hero|best (?:bot|assistant|captain))\b/i;
  // Something funny happened, or the user is joking around.
  var FUNNY_RE = /\b(lol|lmao|rofl|haha+|hehe+|hah|ha ha|funny|hilarious|joke|joking|kidding|jk|that'?s a good one|cracking me up|made me laugh|😂|🤣)|\b(?:ha){2,}\b/i;
  // The user could not be understood, or said so themselves. A run of question
  // marks belongs here rather than with surprise: "??" is bewilderment.
  var UNCLEAR_RE = /\?{2,}|\b(huh|what\?|wat|eh\?|i don'?t (?:get|understand)|makes no sense|that'?s not what i (?:meant|asked)|not what i (?:meant|asked)|you misunderstood|confusing|unclear|come again)\b/i;
  var CURIOUS_RE = /\b(random|weird|strange|odd|riddle|guess|imagine|hypothetical(?:ly)?|trivia|fun fact)\b/i;
  var POSITIVE_RE = /\b(perfect|exactly|that'?s it|awesome|great|nice one|excellent|fantastic|love it|woohoo)\b/i;
  var SORRY_TRIGGER_RE = /\b(that(?:'?s| is) (?:wrong|not right)|(?:you'?re|you are|ur) wrong|incorrect|not right|wrong answer|mistake|error in that)\b/i;
  var SURPRISE_RE = /!{2,}|\b(wow|whoa|no way|insane|crazy|wild|omg)\b/i;

  // Keyboard mashing, matched on adjacent-key runs rather than on a vowel
  // count — "strength" and "bunkers" are vowel-poor but perfectly real, and a
  // vowel heuristic flags them.
  var KEYSMASH_RE = /(asdf|sdfg|dfgh|fghj|ghjk|hjkl|qwer|wert|erty|rtyu|tyui|yuio|uiop|zxcv|xcvb|cvbn|vbnm|poiu|oiuy|lkjh|mnbv)/i;
  var NO_VOWEL_RE = /^[bcdfghjklmnpqrstvwxz]{5,}$/i;
  // Punctuation soup — but not a bare run of "!", which is excitement, and not
  // an emoji-only message, which the funny test above has already claimed.
  var PUNCT_ONLY_RE = /^(?=.*[^\s!])[^a-z0-9]+$/i;

  function looksLikeGibberish(t) {
    return KEYSMASH_RE.test(t) || NO_VOWEL_RE.test(t) || PUNCT_ONLY_RE.test(t);
  }

  Widget.prototype.classifyOutgoing = function (text) {
    var t = String(text || '').trim();
    var norm = t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
    var isRepeat = !!norm && norm.length > 3 && norm === this._lastNorm;
    this._lastNorm = norm;

    // Order is deliberate. Praise is checked before plain gratitude, so
    // "thanks, you're the best" blushes rather than merely smiling; and both
    // are checked before the generic positives, which are weaker signals.
    if (isRepeat) return 'confused';
    if (SORRY_TRIGGER_RE.test(t)) return 'sad';
    if (COMPLIMENT_RE.test(t)) return 'blush';
    // Funny is tested before the gibberish check so an emoji-only reply is
    // read as laughter rather than as punctuation soup.
    if (FUNNY_RE.test(t)) return 'laughing';
    if (THANKS_RE.test(t)) return 'happy';
    if (UNCLEAR_RE.test(t) || looksLikeGibberish(t)) return 'confused';
    if (SURPRISE_RE.test(t)) return 'surprised';
    if (POSITIVE_RE.test(t)) return 'excited';
    if (CURIOUS_RE.test(t)) return 'curious';
    if (this.isFatigued()) return 'tired';
    return 'thinking';
  };

  /**
   * Expressions that are a genuine reaction to the user rather than a
   * "working on it" face. These must survive the reply: if someone says thank
   * you, Captain should not stop smiling the instant the answer lands.
   */
  var REACTIVE = { happy: 1, blush: 1, laughing: 1, confused: 1, sad: 1 };

  /** True after a burst of rapid-fire questions, or a long-running conversation. */
  Widget.prototype.isFatigued = function () {
    var now = Date.now();
    var recent = this.submitTimes.filter(function (ts) { return now - ts < 60000; });
    return recent.length >= 4 || this.turnCount >= 15;
  };


  Widget.prototype.teardown = function () {
    if (this._onMove) document.removeEventListener('mousemove', this._onMove);
    if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
    if (this._onKeydown) document.removeEventListener('keydown', this._onKeydown);
    if (this._onOnline && global.removeEventListener) global.removeEventListener('online', this._onOnline);
    if (this._idleT) clearTimeout(this._idleT);
    if (this._moodT) clearTimeout(this._moodT);
    if (this._nudgeT) clearTimeout(this._nudgeT);
    if (this._rafCancel) this._rafCancel();
    if (this._bodyOverflow !== undefined) document.body.style.overflow = this._bodyOverflow;
    this.stop(true);
  };

  // ==========================================================================
  //  Transport
  // ==========================================================================
  Widget.prototype.buildContext = function () {
    return assign({}, this.context || {}, {
      tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { return null; } })(),
      locale: (typeof navigator !== 'undefined' && navigator.language) || null,
      userName: this.profile.userName || null
    });
  };

  /**
   * Send one message. Resolves to the final payload. `hooks.onDelta(evt)` is
   * called for streamed events: { t: 'delta'|'replace'|'status', text }.
   */
  Widget.prototype.transport = function (text, pending, history, hooks) {
    var self = this;
    var context = this.buildContext();
    if (typeof this.opts.ask === 'function') {
      return Promise.resolve(this.opts.ask(text, pending, history, context, hooks));
    }
    var tokenP;
    try { tokenP = Promise.resolve(typeof this.opts.getToken === 'function' ? this.opts.getToken() : null); }
    catch (e) { tokenP = Promise.resolve(null); }

    return tokenP.then(function (token) {
      var payload = { text: text, pending: pending, history: history, context: context, stream: true };
      // text/plain + token in the body = a CORS "simple request": no preflight.
      var headers = { 'Content-Type': 'text/plain;charset=UTF-8' };
      if (token && typeof token === 'string') {
        if (self.opts.tokenInHeader) { headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }; }
        else payload.token = token;
      }
      return fetch(self.opts.endpoint, {
        method: 'POST',
        headers: headers,
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify(payload),
        signal: hooks && hooks.signal
      });
    }).then(function (res) {
      self.setConn('online');
      var ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (/ndjson/i.test(ctype) && res.body && res.body.getReader) return readStream(res, hooks);
      return res.json().then(function (data) {
        if (res.status === 401) return { status: 'error', reason: 'unauthenticated', text: 'Your session has expired. Sign in again and ask me once more.' };
        if (res.status === 413) return { status: 'error', text: 'That message is too long for me.' };
        return data;
      }, function () {
        return { status: 'error', reason: 'bad_response', text: 'The server sent a response I could not read.', code: 'HTTP ' + res.status };
      });
    });
  };

  function readStream(res, hooks) {
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = '';
    var final = null;
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          var evt; try { evt = JSON.parse(line); } catch (_) { continue; }
          if (evt.t === 'final') final = evt.data || null;
          else if (hooks && hooks.onDelta) hooks.onDelta(evt);
        }
        return pump();
      });
    }
    return pump().then(function () {
      return final || { status: 'error', reason: 'stream_cut', text: 'The connection closed before I finished. Try again?' };
    });
  }

  // ==========================================================================
  //  Sending
  // ==========================================================================
  Widget.prototype.submit = function (displayText, sendValue, opts) {
    if (this.busy) return;
    var body = String(sendValue != null ? sendValue : displayText).trim();
    if (!body) return;
    opts = opts || {};
    var self = this;

    this.hideWelcome();
    this.busy = true;
    this.updateComposer();
    if (!opts.retry) this.addUserTurn(String(displayText));
    var turnRec = { role: 'user', text: String(displayText), send: body, at: Date.now() };
    if (!opts.retry) this.turns.push(turnRec);
    this._stick = true;
    this.scrollDown(true);

    var reactiveMood = this.classifyOutgoing(body);
    this.submitTimes.push(Date.now());
    this.submitTimes = this.submitTimes.slice(-12);
    this.turnCount++;
    this.setMood(reactiveMood);

    var started = performanceNow();
    var carried = this.pending;
    var historySnapshot = this.history.slice(-8);
    this.pending = null;

    // ---- local: greetings and thanks never touch the network ---------------
    var local = this.opts.localReplies && !carried && typeof this.opts.ask !== 'function' ? localReply(body, this.profile.userName) : null;
    if (local) {
      var slotL = this.addAssistantTurn();
      this.finishTurn(slotL, { status: 'answer', source: 'local', instant: true, text: local }, body, reactiveMood, started, historySnapshot);
      return;
    }

    var slot = this.addAssistantTurn();
    var thinking = el('div', 'thinking');
    var dots = el('span', 'dots'); dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    thinking.appendChild(dots);
    var label = el('span', 'label', waitLabelFor(body));
    thinking.appendChild(label);
    slot.msg.appendChild(thinking);
    this.scrollDown();
    this._busyLabel = waitLabelFor(body) + '…';
    this.setStatusText(this._busyLabel);

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, this.opts.timeoutMs);
    var stream = new Typewriter(this, slot);
    this._active = { ctrl: ctrl, stream: stream, slot: slot, body: body };

    var hooks = {
      signal: ctrl ? ctrl.signal : undefined,
      onDelta: function (evt) {
        if (!evt) return;
        if (evt.t === 'status') { label.textContent = evt.text || label.textContent; self.setStatusText((evt.text || '') + '…'); return; }
        if (evt.t === 'delta' || evt.t === 'replace') {
          if (!stream.started) { stream.start(); self.setStatusText('Replying…'); if (self.currentMood === 'thinking') self.setMood('idle'); }
          if (evt.t === 'replace') stream.replace(evt.text || ''); else stream.push(evt.text || '');
        }
      }
    };

    this.transport(body, carried, historySnapshot, hooks).then(function (data) {
      clearTimeout(timer);
      if (!data || typeof data !== 'object') data = { status: 'error', text: 'The server sent an empty response.' };
      return stream.finish(data).then(function () {
        self.finishTurn(slot, data, body, reactiveMood, started, historySnapshot);
      });
    }, function (err) {
      clearTimeout(timer);
      var aborted = err && err.name === 'AbortError';
      if (aborted && !timedOut) {
        // The user pressed stop: keep what was written, say so quietly.
        var partial = stream.text();
        stream.cancel();
        var data = partial
          ? { status: 'answer', source: 'stopped', text: partial, stopped: true }
          : { status: 'stopped', source: 'stopped', text: '' };
        self.finishTurn(slot, data, body, 'idle', started, historySnapshot);
        return;
      }
      stream.cancel();
      var offline = global.navigator && navigator.onLine === false;
      if (!aborted) self.setConn('offline');
      self.finishTurn(slot, {
        status: 'error', reason: aborted ? 'timeout' : offline ? 'offline' : 'network',
        text: aborted ? 'That took longer than I could wait. Nothing was changed — try again.'
          : offline ? 'You’re offline. Check your connection and try again.'
          : 'I couldn’t reach the server just now. Nothing was changed — try again in a moment.'
      }, body, 'sad', started, historySnapshot);
    });
  };

  /** Stop the reply in progress (Esc, or the stop button). */
  Widget.prototype.stop = function (silent) {
    var a = this._active;
    if (!a) return;
    if (a.ctrl) a.ctrl.abort();
    if (silent) { a.stream.cancel(); this._active = null; this.busy = false; this.updateComposer(); }
  };

  Widget.prototype.finishTurn = function (slot, data, body, reactiveMood, started, historySnapshot) {
    var self = this;
    this._active = null;
    var ms = Math.max(0, Math.round(performanceNow() - started));
    slot.msg.innerHTML = '';
    slot.el.classList.remove('streaming');
    if (data.status === 'stopped') {
      slot.msg.appendChild(el('div', 'stopped', 'Stopped.'));
    } else {
      slot.msg.appendChild(this.renderAnswer(data, body));
      if (data.stopped) slot.msg.appendChild(el('div', 'stopped', 'Stopped.'));
    }
    this.renderMeta(slot, data, body, ms);

    if (data.pending) this.pending = data.pending;
    if (data.remember && data.remember.userName) this.profile.userName = String(data.remember.userName).slice(0, 60);

    // Every USER turn goes into history: that is what lets the server turn
    // "and last week?" into the previous question over a new period.
    // Assistant turns are kept only for conversational sources.
    this.history.push({ role: 'user', text: body });
    if (/^(companion|guide|identity|agent|router|local|instant)$/.test(String(data.source || '')) && data.text) {
      this.history.push({ role: 'assistant', text: String(data.text).slice(0, 1200) });
    }
    this.history = this.history.slice(-10);
    this.turns.push({ role: 'assistant', text: data.text || '', data: slimForStore(data), at: Date.now(), ms: ms, send: body });
    this.markLast(slot.el);

    if (data.status !== 'error' && data.status !== 'stopped' && this._conn !== 'online') this.setConn('online');

    var mood = moodFor(data);
    if (mood === 'answered' && this.isFatigued()) mood = 'tired';
    if (REACTIVE[reactiveMood] && mood !== 'sad' && mood !== 'confused' && mood !== 'asking') mood = reactiveMood;
    this.setMood(mood, MOOD_HOLD[mood] || 6000);

    this.busy = false;
    this._busyLabel = null;
    this.setConn(this._conn);
    this.updateComposer();
    if (!this.open && !this.inline) this.badge.classList.add('unread');
    this.live.textContent = String(data.text || '').slice(0, 400);
    this.scrollDown();
    if (this.open && document.activeElement !== this.input && !('ontouchstart' in global)) {
      try { this.input.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
    this.save();
    if (typeof this.opts.onAnswer === 'function') { try { this.opts.onAnswer(data); } catch (_) { /* host hook */ } }
  };

  Widget.prototype.markLast = function (turnEl) {
    var prev = this.log.querySelectorAll('.turn.assistant.last');
    for (var i = 0; i < prev.length; i++) if (prev[i] !== turnEl) prev[i].classList.remove('last');
    turnEl.classList.add('last');
    var retries = this.log.querySelectorAll('.act.retry');
    for (var j = 0; j < retries.length; j++) retries[j].hidden = !turnEl.contains(retries[j]);
  };

  /** Re-ask the last question, replacing the last answer. */
  Widget.prototype.retry = function () {
    if (this.busy) return;
    var lastA = null, lastU = null, i;
    for (i = this.turns.length - 1; i >= 0; i--) { if (this.turns[i].role === 'assistant') { lastA = i; break; } }
    for (i = (lastA == null ? this.turns.length : lastA) - 1; i >= 0; i--) { if (this.turns[i].role === 'user') { lastU = i; break; } }
    if (lastU == null) return;
    var u = this.turns[lastU];
    if (lastA != null) this.turns.splice(lastA, 1);
    // drop the matching history entries
    if (this.history.length && this.history[this.history.length - 1].role === 'assistant') this.history.pop();
    if (this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop();
    var nodes = this.log.querySelectorAll('.turn.assistant');
    var lastNode = nodes[nodes.length - 1];
    if (lastNode) lastNode.parentNode.removeChild(lastNode);
    this.submit(u.text, u.send || u.text, { retry: true });
  };

  // ==========================================================================
  //  Streaming renderer: steady reveal, markdown re-rendered per frame
  // ==========================================================================
  function Typewriter(widget, slot) {
    this.w = widget; this.slot = slot;
    this.target = ''; this.shown = 0; this.started = false; this.done = false;
    this.raf = null; this.resolve = null; this.last = 0;
  }
  Typewriter.prototype.start = function () {
    this.started = true;
    this.slot.el.classList.add('streaming');
    this.slot.msg.innerHTML = '';
    this.tick();
  };
  Typewriter.prototype.push = function (t) { this.target += t; this.tick(); };
  Typewriter.prototype.replace = function (t) { this.target = t; this.shown = Math.min(this.shown, t.length); if (t.length < this.shown) this.shown = 0; this.tick(); };
  Typewriter.prototype.text = function () { return this.target; };
  Typewriter.prototype.cancel = function () { this.done = true; if (this.raf) caf(this.raf); this.raf = null; if (this.resolve) { var r = this.resolve; this.resolve = null; r(); } };
  Typewriter.prototype.tick = function () {
    var self = this;
    if (this.raf || this.done || !this.started) return;
    this.raf = raf(function (ts) { self.raf = null; self.frame(ts || performanceNow()); });
  };
  Typewriter.prototype.frame = function () {
    if (this.done) return;
    var remaining = this.target.length - this.shown;
    if (remaining > 0) {
      // Reveal faster the further behind we are: smooth when the model is
      // slow, never lagging far behind when it is fast.
      var step = this.w._reducedMotion ? remaining : Math.max(2, Math.ceil(remaining / 7));
      this.shown = Math.min(this.target.length, this.shown + step);
      this.render(false);
    }
    if (this.shown < this.target.length) this.tick();
    else if (this.resolve) { var r = this.resolve; this.resolve = null; r(); }
  };
  Typewriter.prototype.render = function () {
    var msg = this.slot.msg;
    msg.innerHTML = '';
    renderRich(msg, this.target.slice(0, this.shown), true);
    var caret = el('span', 'caret');
    var lastBlock = msg.lastElementChild;
    var host = lastBlock && /^(P|LI|H4)$/.test(lastBlock.tagName) ? lastBlock
      : lastBlock && (lastBlock.tagName === 'UL' || lastBlock.tagName === 'OL') ? (lastBlock.lastElementChild || lastBlock) : msg;
    host.appendChild(caret);
    this.w.stick();
  };
  /** Let the reveal catch up with the final text, then resolve. */
  Typewriter.prototype.finish = function (data) {
    var self = this;
    if (!this.started) return Promise.resolve();
    var finalText = data && typeof data.text === 'string' ? data.text : this.target;
    if (data && data.blocked) this.replace(finalText);
    else if (finalText.indexOf(this.target) === 0) this.target = finalText;
    if (this.shown >= this.target.length || this.target.length - this.shown > 1200) { this.done = true; return Promise.resolve(); }
    return new Promise(function (resolve) { self.resolve = resolve; self.tick(); setTimeout(function () { self.cancel(); }, 2500); }).then(function () { self.done = true; });
  };

  // ==========================================================================
  //  Rendering
  // ==========================================================================
  Widget.prototype.scrollDown = function (smooth) {
    var log = this.log;
    this._stick = true;
    this.jump.classList.remove('on');
    if (smooth && log.scrollTo && !this._reducedMotion) { try { log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' }); return; } catch (_) { /* fall through */ } }
    log.scrollTop = log.scrollHeight;
  };

  /** Keep pinned to the bottom while content grows — unless the user scrolled up. */
  Widget.prototype.stick = function () {
    if (this._stick) this.log.scrollTop = this.log.scrollHeight;
    else this.jump.classList.add('on');
  };

  Widget.prototype.addUserTurn = function (text, restoring) {
    var self = this;
    var t = el('div', 'turn user' + (restoring ? '' : ' anim'));
    t.appendChild(el('div', 'bubble', text));
    this.log.appendChild(t);
    return t;
  };

  Widget.prototype.addAssistantTurn = function (restoring) {
    var t = el('div', 'turn assistant' + (restoring ? '' : ' anim'));
    var msg = el('div', 'msg');
    t.appendChild(msg);
    this.log.appendChild(t);
    return { el: t, msg: msg };
  };

  Widget.prototype.restore = function (saved) {
    var self = this;
    if (saved.userName) this.profile.userName = saved.userName;
    if (saved.pending) this.pending = saved.pending;
    if (saved.wide) this.setWide(true);
    var turns = saved.turns || [];
    if (!turns.length) return;
    this.hideWelcome();
    var lastSlot = null;
    turns.forEach(function (tr) {
      if (tr.role === 'user') {
        self.addUserTurn(tr.text, true);
        self.history.push({ role: 'user', text: tr.send || tr.text });
      } else {
        var slot = self.addAssistantTurn(true);
        var data = tr.data || { status: 'answer', text: tr.text };
        slot.msg.appendChild(self.renderAnswer(data, tr.send, true));
        self.renderMeta(slot, data, tr.send, tr.ms, tr.at);
        if (/^(companion|guide|identity|agent|router|local|instant)$/.test(String(data.source || '')) && data.text) self.history.push({ role: 'assistant', text: String(data.text).slice(0, 1200) });
        lastSlot = slot;
      }
    });
    this.turns = turns;
    this.history = this.history.slice(-10);
    if (lastSlot) this.markLast(lastSlot.el);
    // Restored choices from an old turn should not be clickable any more.
    var olds = this.log.querySelectorAll('.turn.assistant:not(.last) .choices .chip');
    for (var i = 0; i < olds.length; i++) olds[i].disabled = true;
  };

  Widget.prototype.renderMeta = function (slot, data, body, ms, at) {
    var self = this;
    if (data.status === 'stopped') return;
    var meta = el('div', 'meta');
    var isErr = data.status === 'error' || data.status === 'unauthenticated' || data.status === 'denied';
    if (data.text && !isErr) {
      var copy = actButton('act copy', ICON.copy, 'Copy');
      copy.addEventListener('click', function () {
        var text = plainText(data);
        var done = function () { copy.innerHTML = ICON.check; copy.classList.add('on'); setTimeout(function () { copy.innerHTML = ICON.copy; copy.classList.remove('on'); }, 1400); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done); else done();
      });
      meta.appendChild(copy);
    }
    if (data.status === 'answer' || data.status === 'help') {
      var up = actButton('act react up', ICON.up, 'Good answer');
      var down = actButton('act react down', ICON.down, 'Bad answer');
      var pickR = function (btn, key, react) {
        return function () {
          var was = btn.classList.contains('on');
          up.classList.remove('on'); down.classList.remove('on');
          up.setAttribute('aria-pressed', 'false'); down.setAttribute('aria-pressed', 'false');
          if (was) return;
          btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
          self.react(react);
          self.recordReaction(key, data, body);
        };
      };
      up.setAttribute('aria-pressed', 'false'); down.setAttribute('aria-pressed', 'false');
      up.addEventListener('click', pickR(up, 'up', 'success'));
      down.addEventListener('click', pickR(down, 'down', 'fail'));
      meta.appendChild(up); meta.appendChild(down);
    }
    if (!isErr) {   // an error card carries its own "Try again"
      var retry = actButton('act retry', ICON.retry, 'Regenerate');
      retry.addEventListener('click', function () { self.retry(); });
      meta.appendChild(retry);
    }
    var when = new Date(at || Date.now());
    var tm = el('span', isErr ? 'time err' : 'time', pad2(when.getHours()) + ':' + pad2(when.getMinutes()) + (ms != null ? ' · ' + fmtMs(ms) : ''));
    tm.title = ms != null ? 'Replied in ' + fmtMs(ms) + (data.ms != null ? ' (server ' + data.ms + ' ms)' : '') : '';
    meta.appendChild(tm);
    slot.el.appendChild(meta);
  };

  Widget.prototype.renderAnswer = function (data, question, restoring) {
    var self = this;
    var frag = document.createDocumentFragment();

    if (data.status === 'error' || data.status === 'unauthenticated' || data.status === 'denied') {
      var n = el('div', 'notice');
      var ic = el('span', 'ic'); ic.innerHTML = ICON.alert; n.appendChild(ic);
      var tx = el('div', 'txt');
      tx.appendChild(el('div', null, data.text || 'Something went wrong.'));
      var sub = [data.code, data.detail || null, data.build ? 'build ' + data.build : null].filter(Boolean).join(' · ');
      if (sub) tx.appendChild(el('div', 'sub', sub));
      if (data.status === 'error' && data.reason !== 'unauthenticated' && question && !restoring) {
        var rb = el('button', 'retry');
        rb.type = 'button';
        rb.innerHTML = ICON.retry;
        rb.appendChild(document.createTextNode('Try again'));
        rb.addEventListener('click', function () { self.retry(); });
        tx.appendChild(rb);
      }
      n.appendChild(tx);
      frag.appendChild(n);
      return frag;
    }

    var isData = !!(data.provenance || data.series || data.rows || data.overview || data.comparison || data.stats || data.metrics || data.value != null);
    var container = frag;
    var headline = singleFigure(data);
    if (isData) {
      var card = el('div', 'card');
      frag.appendChild(card);
      container = card;
      if (data.provenance && data.provenance.metric && data.provenance.metric !== 'Overview') {
        card.appendChild(el('p', 'eyebrow', data.provenance.metric + (data.provenance.vessels && data.provenance.vessels.length === 1 ? ' · ' + data.provenance.vessels[0] : '')));
      }
    }

    if (headline) {
      var fig = el('div', 'figure');
      fig.appendChild(document.createTextNode(headline.value));
      if (headline.unit) fig.appendChild(el('span', 'unit', headline.unit));
      container.appendChild(fig);
      container.appendChild(el('p', 'subject', headline.subject));
    } else if (isData) {
      var wrap = el('div', 'rich');
      renderRich(wrap, String(data.text || ''));
      container.appendChild(wrap);
    } else {
      renderRich(container, String(data.text || ''));
    }

    if (data.series) container.appendChild(renderSeries(data));
    var hasChartData = data.chart && Array.isArray(data.chart.labels) && Array.isArray(data.chart.values)
      && data.chart.labels.length === data.chart.values.length && data.chart.values.length >= 2;
    if (hasChartData && data.chart.type !== 'line') container.appendChild(renderBars(data.chart));
    if (hasChartData && data.chart.type === 'line' && !data.series) container.appendChild(renderSeries({
      series: data.chart.labels.map(function (l, i) { return { bucket: l, value: data.chart.values[i] }; }),
      unit: data.chart.unit, title: data.chart.title
    }));
    if (data.rows && data.rows.length > 1) container.appendChild(tableWrap(renderRows(data)));
    if (data.overview) container.appendChild(tableWrap(renderOverview(data)));
    if (data.comparison) container.appendChild(tableWrap(renderComparison(data)));
    if (data.stats) container.appendChild(tableWrap(renderStats(data)));
    if (data.metrics) container.appendChild(tableWrap(renderCatalogue(data)));

    if (data.interpreted) container.appendChild(el('p', 'subject', 'Read as “' + data.interpreted + '”'));
    if (data.footnote) container.appendChild(el('p', 'subject', data.footnote));
    if (data.note) container.appendChild(el('div', 'note', data.note));
    if (data.truncated && data.rows) container.appendChild(el('div', 'note hard', 'Only the first ' + data.rows.length + ' readings are shown. Narrow the period to see the rest.'));
    if (data.provenance) container.appendChild(renderProvenance(data));

    if (data.options && data.options.length) frag.appendChild(this.renderChoices(data.options, restoring));

    var chips = [];
    if (this.opts.followups && data.status === 'answer') chips = followupsFor(data);
    if (Array.isArray(data.suggestions)) chips = chips.concat(data.suggestions.slice(0, 4).map(function (s) { return { label: String(s), text: String(s) }; }));
    if (chips.length) frag.appendChild(this.renderFollowups(chips));
    return frag;
  };

  Widget.prototype.recordReaction = function (reaction, data, question) {
    var payload = {
      reaction: reaction,
      question: question || (data && data.interpreted) || null,
      answer: (data && data.text) || null,
      source: (data && data.source) || null,
      status: (data && data.status) || null,
      at: new Date().toISOString()
    };
    try { if (typeof this.opts.onReaction === 'function') this.opts.onReaction(payload); } catch (e) { /* host hook */ }
    var url = this.opts.reactionEndpoint;
    if (!url) return;
    try {
      var body = JSON.stringify(payload);
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      else if (typeof fetch === 'function') fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body, credentials: 'omit', keepalive: true }).catch(function () {});
    } catch (e) { /* ignore */ }
  };

  Widget.prototype.renderFollowups = function (items) {
    var self = this;
    var wrap = el('div', 'chips followups');
    wrap.setAttribute('aria-label', 'Suggested follow-ups');
    items.forEach(function (it) {
      var b = el('button', 'chip', it.label);
      b.type = 'button';
      b.addEventListener('click', function () { if (!self.busy) self.submit(it.text); });
      wrap.appendChild(b);
    });
    return wrap;
  };

  Widget.prototype.renderChoices = function (options, restoring) {
    var self = this;
    var wrap = el('div', 'chips choices');
    options.forEach(function (opt) {
      var label = typeof opt === 'string' ? opt : opt.label;
      var value = typeof opt === 'string' ? opt : opt.value;
      var b = el('button', 'chip', label);
      b.type = 'button';
      if (restoring) b.disabled = true;
      b.addEventListener('click', function () {
        if (self.busy) return;
        var all = wrap.querySelectorAll('button');
        for (var i = 0; i < all.length; i++) all[i].disabled = true;
        b.classList.add('picked');
        self.submit(label, value);
      });
      wrap.appendChild(b);
    });
    return wrap;
  };

  // --- labels and moods ------------------------------------------------------
  var INSTANT_RE = /\b(what(?:'s| is)(?: the| today'?s)? (?:date|time|year|day)|what (?:day|time) is it|days? until|from now|divided by|times|plus|minus|% of|your name|who are you|my name is|call me|what'?s my name|what (?:can |could )?(?:you|u) (?:can )?do|how do i|where (?:is|do i))\b|^[\d\s+\-*/^().,]+$/i;
  var DATA_HINT_RE = /\b(fuel|consumption|power|speed|distance|rpm|co2|emission|ghg|intensity|compliance|balance|off.?hire|legs?|voyage|penalty|energy|report|trend|compare|average|total)\b/i;

  function waitLabelFor(text) {
    if (/\b(brief|anything i should know|status of|how is the fleet)\b/i.test(text)) return 'Checking your fleet';
    if (/\b(how do i|where is|how can i|where do i)\b/i.test(text)) return 'Looking that up';
    if (INSTANT_RE.test(text)) return 'One moment';
    if (DATA_HINT_RE.test(text)) return 'Reading the records';
    return 'Thinking';
  }

  function moodFor(data) {
    if (data.status === 'unparsed') return 'confused';
    if (data.status === 'clarify' || data.status === 'confirm') return 'asking';
    if (data.pending && data.pending.kind === 'name') return 'asking';
    if (data.status === 'unsupported' || data.status === 'error' || data.status === 'denied') return 'sad';
    if (data.status === 'stopped' || data.stopped) return 'idle';
    if (data.empty || data.status === 'no_scope') return 'nothing';
    if (hasResult(data)) return 'happy';
    return 'answered';
  }

  function hasResult(data) {
    return !!(data && (data.value != null || data.stats || data.comparison ||
      (data.rows && data.rows.length) || (data.series && data.series.length) ||
      (data.overview && data.overview.length) || (data.metrics && data.metrics.length)));
  }

  function followupsFor(data) {
    var p = data.provenance;
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
    var frag = document.createDocumentFragment();
    var bar = el('div', 'soundings');
    var bits = [];
    if (p.vessels && p.vessels.length) bits.push(['Vessel', p.vessels.join(', ')]);
    if (p.period) bits.push(['Period', p.period]);
    if (data.rowsUsed != null) bits.push(['Reports', String(data.rowsUsed)]);
    if (p.source) bits.push(['Source', p.source]);
    bits.forEach(function (pair) {
      var s = el('span');
      s.appendChild(document.createTextNode(pair[0] + ' '));
      s.appendChild(el('b', null, pair[1]));
      bar.appendChild(s);
    });
    frag.appendChild(bar);
    if (p.sql) {
      var d = el('details', 'working');
      d.appendChild(el('summary', null, 'Show the query behind this figure'));
      d.appendChild(el('pre', null, p.sql + '\n\n-- values: ' + JSON.stringify(p.sqlValues)));
      frag.appendChild(d);
    }
    return frag;
  }

  function plainText(data) {
    var t = String(data.text || '');
    var p = data.provenance;
    if (p && (p.period || (p.vessels && p.vessels.length))) {
      t += '\n\n' + [p.vessels && p.vessels.length ? 'Vessel: ' + p.vessels.join(', ') : null, p.period ? 'Period: ' + p.period : null, data.rowsUsed != null ? 'Reports: ' + data.rowsUsed : null, p.source ? 'Source: ' + p.source : null].filter(Boolean).join(' · ');
    }
    return t;
  }

  // --- markdown: DOM nodes only, never innerHTML for server text -------------
  /**
   * Paragraphs, line breaks, headings, bullet and numbered lists (one level of
   * nesting), blockquotes, rules, fenced code with a copy button, simple
   * tables, **bold**, *italic*, `code` and [links](https://...). Safe while
   * streaming: an unclosed fence renders as code until it closes.
   */
  function renderRich(container, text, streaming) {
    text = String(text || '').replace(/\r/g, '');
    if (!text.trim()) { if (!streaming) container.appendChild(el('p', null, '')); return; }
    var lines = text.split('\n');
    var i = 0;
    var para = [];
    function flushPara() {
      if (!para.length) return;
      var p = el('p');
      para.forEach(function (l, k) { if (k) p.appendChild(document.createElement('br')); appendInline(p, l); });
      container.appendChild(p);
      para = [];
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = line.match(/^\s*```\s*([\w+#.-]*)\s*$/);
      if (fence) {
        flushPara();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        container.appendChild(codeBlock(code.join('\n'), fence[1]));
        continue;
      }
      if (!line.trim()) { flushPara(); i++; continue; }
      var h = line.match(/^\s*(#{1,6})\s+(.*)$/);
      if (h) { flushPara(); var hd = el('h4'); appendInline(hd, h[2].replace(/\s*#+\s*$/, '')); container.appendChild(hd); i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); container.appendChild(el('hr')); i++; continue; }
      if (/^\s*>/.test(line)) {
        flushPara();
        var q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        var bq = el('blockquote');
        renderRich(bq, q.join('\n'), streaming);
        container.appendChild(bq);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        flushPara();
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        container.appendChild(mdTable(rows));
        continue;
      }
      var li = line.match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
      if (li) {
        flushPara();
        var ordered = /\d/.test(li[2]);
        var list = el(ordered ? 'ol' : 'ul');
        if (ordered && parseInt(li[2], 10) > 1) list.setAttribute('start', String(parseInt(li[2], 10)));
        var baseIndent = li[1].length;
        var lastLi = null;
        while (i < lines.length) {
          var m2 = lines[i].match(/^(\s*)([-*•]|\d+[.)])\s+(.*)$/);
          if (m2) {
            if (m2[1].length > baseIndent + 1 && lastLi) {
              var sub = lastLi.querySelector('ul,ol');
              if (!sub) { sub = el(/\d/.test(m2[2]) ? 'ol' : 'ul'); lastLi.appendChild(sub); }
              var sli = el('li'); appendInline(sli, m2[3]); sub.appendChild(sli);
            } else {
              lastLi = el('li'); appendInline(lastLi, m2[3]); list.appendChild(lastLi);
            }
            i++;
          } else if (lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && lastLi) {
            lastLi.appendChild(document.createElement('br')); appendInline(lastLi, lines[i].trim()); i++;
          } else break;
        }
        container.appendChild(list);
        continue;
      }
      para.push(line);
      i++;
    }
    flushPara();
  }

  function mdTable(rows) {
    var cells = function (r) { return r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }); };
    var head = cells(rows[0]);
    var t = el('table', 'grid');
    var tr = el('tr');
    head.forEach(function (c) { var th = el('th'); appendInline(th, c); tr.appendChild(th); });
    t.appendChild(tr);
    rows.slice(2).forEach(function (r) {
      var row = el('tr');
      cells(r).forEach(function (c) { var td = el('td', /^[-+]?[\d,.]+\s*%?$/.test(c) ? 'num' : null); appendInline(td, c); row.appendChild(td); });
      t.appendChild(row);
    });
    return tableWrap(t);
  }

  function codeBlock(code, lang) {
    var wrap = el('div', 'codeblock');
    var bar = el('div', 'bar');
    bar.appendChild(el('span', null, lang || 'code'));
    var b = el('button');
    b.type = 'button';
    b.innerHTML = ICON.copy;
    b.appendChild(document.createTextNode('Copy'));
    b.addEventListener('click', function () {
      var done = function () { b.lastChild.textContent = 'Copied'; setTimeout(function () { b.lastChild.textContent = 'Copy'; }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done); else done();
    });
    bar.appendChild(b);
    wrap.appendChild(bar);
    var pre = el('pre');
    pre.appendChild(el('code', null, code));
    wrap.appendChild(pre);
    return wrap;
  }

  // No lookbehind anywhere (older Safari cannot parse it and would drop the
  // whole script): the "not inside a word" test for *italic* is done by hand.
  var INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*[^*\s][^*\n]*\*(?=$|[\s.,;:!?)])|_[^_\s][^_\n]*_(?=$|[\s.,;:!?)]))/g;
  function appendInline(parent, line) {
    var re = new RegExp(INLINE_RE.source, 'g');
    var last = 0, m;
    while ((m = re.exec(line)) !== null) {
      var tok = m[0];
      var c0 = tok.charAt(0);
      var before = m.index > 0 ? line.charAt(m.index - 1) : '';
      var single = (c0 === '*' && tok.charAt(1) !== '*') || (c0 === '_' && tok.charAt(1) !== '_');
      if (single && before && !/[\s(]/.test(before)) { re.lastIndex = m.index + 1; continue; }
      if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
      if (c0 === '`') parent.appendChild(el('code', null, tok.slice(1, -1)));
      else if (tok.slice(0, 2) === '**' || tok.slice(0, 2) === '__') parent.appendChild(el('strong', null, tok.slice(2, -2)));
      else if (c0 === '[') {
        var lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        var a = el('a', null, lm[1]);
        a.href = lm[2]; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
        parent.appendChild(a);
      } else parent.appendChild(el('em', null, tok.slice(1, -1)));
      last = m.index + tok.length;
    }
    if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
  }

  function tableWrap(table) {
    if (table && table.classList && table.classList.contains('tablewrap')) return table;
    var w = el('div', 'tablewrap');
    w.appendChild(table);
    return w;
  }

  // --- charts ----------------------------------------------------------------
  function renderBars(chart) {
    var ns = 'http://www.w3.org/2000/svg';
    var n = chart.values.length;
    var w = 640, barH = 22, gap = 12, padT = 4;
    var fmtV = function (v) {
      var d = chart.decimals != null ? chart.decimals : (Math.abs(v) >= 1000 ? 1 : 3);
      return Number(v).toLocaleString('en-GB', { maximumFractionDigits: d }) + (chart.unit ? ' ' + chart.unit : '');
    };
    var h = padT + n * (barH + gap);
    var max = Math.max.apply(null, chart.values.map(function (v) { return Math.abs(v); })) || 1;
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'bars');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', (chart.title || 'Comparison') + ': ' + chart.labels.map(function (l, i) { return l + ' ' + fmtV(chart.values[i]); }).join(', '));
    var labelW = 170, valW = 120;
    var plotW = w - labelW - valW;
    chart.values.forEach(function (v, i) {
      var y = padT + i * (barH + gap);
      var len = Math.max(3, Math.round((Math.abs(v) / max) * plotW));
      var lab = document.createElementNS(ns, 'text');
      lab.setAttribute('x', 0); lab.setAttribute('y', y + barH * 0.7);
      lab.textContent = String(chart.labels[i]).length > 24 ? String(chart.labels[i]).slice(0, 23) + '…' : chart.labels[i];
      svg.appendChild(lab);
      var track = document.createElementNS(ns, 'rect');
      track.setAttribute('class', 'track');
      track.setAttribute('x', labelW); track.setAttribute('y', y); track.setAttribute('width', plotW); track.setAttribute('height', barH); track.setAttribute('rx', 4);
      svg.appendChild(track);
      var r = document.createElementNS(ns, 'rect');
      r.setAttribute('class', 'bar');
      r.setAttribute('x', labelW); r.setAttribute('y', y);
      r.setAttribute('width', len); r.setAttribute('height', barH); r.setAttribute('rx', 4);
      svg.appendChild(r);
      var val = document.createElementNS(ns, 'text');
      val.setAttribute('class', 'val');
      val.setAttribute('x', labelW + plotW + 10); val.setAttribute('y', y + barH * 0.7);
      val.textContent = fmtV(v);
      svg.appendChild(val);
    });
    var frag = document.createDocumentFragment();
    if (chart.title) frag.appendChild(el('p', 'chart-title', chart.title));
    frag.appendChild(svg);
    return frag;
  }

  function renderSeries(data) {
    var pts = data.series;
    var ns = 'http://www.w3.org/2000/svg';
    var w = 640, h = 96, padT = 6, padB = 6;
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', pts.length + ' points from ' + pts[0].bucket + ' to ' + pts[pts.length - 1].bucket);
    var vals = pts.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var span = hi === lo ? 1 : hi - lo;
    var x = function (i) { return (i / Math.max(1, pts.length - 1)) * w; };
    var y = function (v) { return padT + (1 - (v - lo) / span) * (h - padT - padB); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1); }).join(' ');
    var area = d + ' L' + x(pts.length - 1).toFixed(1) + ' ' + h + ' L0 ' + h + ' Z';
    var fill = document.createElementNS(ns, 'path'); fill.setAttribute('class', 'fill'); fill.setAttribute('d', area); svg.appendChild(fill);
    var line = document.createElementNS(ns, 'path'); line.setAttribute('class', 'line'); line.setAttribute('d', d); svg.appendChild(line);
    var axis = document.createElementNS(ns, 'line'); axis.setAttribute('class', 'axis');
    axis.setAttribute('x1', 0); axis.setAttribute('x2', w); axis.setAttribute('y1', h); axis.setAttribute('y2', h); svg.appendChild(axis);
    var frag = document.createDocumentFragment();
    if (data.title) frag.appendChild(el('p', 'chart-title', data.title));
    frag.appendChild(svg);
    var range = el('div', 'range');
    range.appendChild(el('span', null, String(pts[0].bucket)));
    range.appendChild(el('span', null, String(pts[pts.length - 1].bucket)));
    frag.appendChild(range);
    var lohi = el('p', 'lohi');
    lohi.appendChild(document.createTextNode('Low ')); lohi.appendChild(el('b', null, fmtNumber(lo, data.unit)));
    lohi.appendChild(document.createTextNode(' High ')); lohi.appendChild(el('b', null, fmtNumber(hi, data.unit)));
    lohi.appendChild(document.createTextNode(' ' + pts.length + ' points'));
    frag.appendChild(lohi);
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
      tr.appendChild(el('td', 'num', String(b.reports)));
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
      tr.appendChild(el('td', null, side.label)); tr.appendChild(el('td', 'num', String(side.rows))); tr.appendChild(el('td', 'num', fmtNumber(side.value)));
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

  // --- utilities ---------------------------------------------------------------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // textContent, never innerHTML, for anything from the server
    return n;
  }
  function kbd(t) { return el('kbd', null, t); }
  function toolButton(cls, svg, label) {
    var b = el('button', cls);
    b.type = 'button';
    b.innerHTML = svg;
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  }
  function actButton(cls, svg, label) { return toolButton(cls, svg, label); }
  function fmtNumber(n, unit) {
    if (n == null) return null;
    return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
  }
  function fmtMs(ms) { return ms < 1000 ? Math.max(1, Math.round(ms)) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function performanceNow() { return (global.performance && performance.now) ? performance.now() : Date.now(); }
  var raf = global.requestAnimationFrame ? function (cb) { return global.requestAnimationFrame(cb); } : function (cb) { return setTimeout(function () { cb(performanceNow()); }, 16); };
  var caf = global.cancelAnimationFrame ? function (id) { global.cancelAnimationFrame(id); } : function (id) { clearTimeout(id); };
  function slimForStore(data) {
    var d = assign({}, data);
    delete d.error; delete d.build;
    if (d.rows && d.rows.length > 60) d.rows = d.rows.slice(0, 60);
    return d;
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
    version: VERSION,
    init: function (options) {
      if (instance) return Captain;
      var start = function () { if (!instance) instance = new Widget(options); };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
      return Captain;
    },
    open: function () { if (instance) instance.openPanel(); },
    close: function () { if (instance) instance.close(); },
    toggle: function () { if (instance) instance.toggle(); },
    ask: function (text) { if (instance) { instance.openPanel(); instance.submit(text); } },
    reset: function () { if (instance) instance.reset(); },
    warm: function () { return instance ? instance.warm(true) : Promise.resolve(); },
    setContext: function (ctx) { if (instance) instance.setContext(ctx); },
    clearContext: function () { if (instance) instance.setContext(null); },
    setTheme: function (theme) { if (instance && ['light', 'dark', 'auto'].indexOf(theme) >= 0) instance.root.setAttribute('data-theme', theme); },

    /**
     * React to something that happened in your app:
     *   Captain.react('success' | 'fail' | 'confused' | 'praise' | 'funny' ...)
     */
    react: function (event, holdMs) { return instance ? instance.react(event, holdMs) : false; },
    setMood: function (mood, holdMs) { if (instance) instance.setMood(mood, holdMs); },
    emotions: ['idle', 'happy', 'blush', 'sad', 'laughing', 'confused', 'thinking',
               'answered', 'asking', 'nothing', 'excited', 'curious', 'surprised', 'tired'],

    destroy: function () {
      if (instance) {
        if (typeof instance.teardown === 'function') instance.teardown();
        if (instance.host.parentNode) instance.host.parentNode.removeChild(instance.host);
      }
      instance = null;
    },
    _instance: function () { return instance; },
    _localReply: localReply,
    scriptOrigin: SCRIPT_ORIGIN
  };

  global.Captain = Captain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Captain;
})(typeof window !== 'undefined' ? window : this);
