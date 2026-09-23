/*!
 * K.R.1.S — embeddable assistant for GeoServe apps.
 *
 * K.R.1.S (say it "Kris") is a codename inspired by Lord Krishna: the calm
 * charioteer who guides without taking the reins. The widget is drawn in that
 * spirit — a small blue-skinned figure with a peacock feather in a golden
 * crown and a flute at the chest, sitting in the corner of your app.
 *
 * Floating (default): K.R.1.S sits in the corner and opens a chat panel.
 * The API endpoint follows wherever this script was loaded from, so embedding
 * needs no configuration beyond a token:
 *
 *   <script src="https://kris.your-domain.com/kris-widget.js"></script>
 *   <script>
 *     KRIS.init({ getToken: function () { return window.SESSION_TOKEN; } });
 *   </script>
 *
 * Inline: render inside your own layout (a sidebar, a drawer):
 *   KRIS.init({ mount: '#kris-slot', theme: 'dark' });
 *
 * Page context, so "fuel consumption last month" means *this* vessel:
 *   KRIS.setContext({ vesselId: '9851701', vesselName: 'Aurora Trader', page: 'vessel' });
 *
 * Brand:
 *   KRIS.init({ theme: 'auto', brand: { accent: '#2B3A9E', font: 'Inter, system-ui, sans-serif' } });
 *
 * Bring your own transport (optionally streaming via hooks.onDelta):
 *   KRIS.init({ ask: async function (text, pending, history, context, hooks) { ... return payload; } });
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
 * widget's CSS cannot leak out. No external requests, no fonts, no images:
 * the character is inline SVG. The conversation is kept in sessionStorage
 * (this tab only) so it survives page navigation; pass persist: false to keep
 * it in memory only.
 */
(function (global) {
  'use strict';

  if (global.KRIS && global.KRIS.__loaded) return;

  var VERSION = '2026-09-23.kris-1';

  // Where was this script loaded from? The API lives on the same origin.
  var SCRIPT_ORIGIN = '';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) SCRIPT_ORIGIN = new URL(cs.src, document.baseURI).origin;
  } catch (_) { SCRIPT_ORIGIN = ''; }

  // ==========================================================================
  //  The character.
  //
  //  A chibi portrait on a 100×100 grid: cloud-blue skin, dark curls, a golden
  //  mukut with a peacock feather, a Vaishnava tilak, makara earrings, a
  //  yellow pitambar with a flower garland, and a bansuri resting across the
  //  chest. Everything that moves (eyes, brows, mouths, cheeks, the feather)
  //  carries a k-* class so CSS can drive expressions without redrawing.
  //  The body is clipped to the disc; the feather is not, so on the launcher
  //  its tip lifts past the rim.
  // ==========================================================================
  function garland() {
    // Flowers along a U from shoulder to shoulder, alternating marigold,
    // jasmine and rose. Computed once when the template is built.
    var colours = ['#F59E0B', '#FFF7E0', '#E8517A', '#F59E0B', '#FFF7E0', '#E8517A', '#F59E0B', '#FFF7E0', '#E8517A'];
    var out = '';
    var n = colours.length;
    for (var i = 0; i < n; i++) {
      var t = i / (n - 1);
      // quadratic from (37.5,80.5) via (50,101) to (62.5,80.5)
      var x = (1 - t) * (1 - t) * 37.5 + 2 * (1 - t) * t * 50 + t * t * 62.5;
      var y = (1 - t) * (1 - t) * 80.5 + 2 * (1 - t) * t * 101 + t * t * 80.5;
      out += '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r="2.05" fill="' + colours[i] + '"/>' +
             '<circle cx="' + x.toFixed(2) + '" cy="' + y.toFixed(2) + '" r=".7" fill="#B45309" opacity=".55"/>';
    }
    return out;
  }

  var KRIS_SVG_TEMPLATE =
    '<svg class="k-char" viewBox="11 12 78 78" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<defs>' +
        '<clipPath id="kp-disc"><circle cx="50" cy="51" r="39"/></clipPath>' +
        '<radialGradient id="kp-halo" cx="50%" cy="46%" r="50%"><stop offset="0" stop-color="#FFE7A3" stop-opacity=".95"/><stop offset=".55" stop-color="#F5C14E" stop-opacity=".35"/><stop offset="1" stop-color="#F5C14E" stop-opacity="0"/></radialGradient>' +
        '<radialGradient id="kp-skin" cx="40%" cy="34%" r="75%"><stop offset="0" stop-color="#8DB7F2"/><stop offset=".6" stop-color="#5E8FDC"/><stop offset="1" stop-color="#3F6CC0"/></radialGradient>' +
        '<linearGradient id="kp-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFF0B8"/><stop offset=".45" stop-color="#F2C14E"/><stop offset="1" stop-color="#B7811C"/></linearGradient>' +
        '<linearGradient id="kp-silk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE071"/><stop offset="1" stop-color="#F2A516"/></linearGradient>' +
        '<linearGradient id="kp-sash" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#14A39A"/><stop offset="1" stop-color="#0B6F7A"/></linearGradient>' +
        '<linearGradient id="kp-hair" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A2F63"/><stop offset="1" stop-color="#12163A"/></linearGradient>' +
        '<linearGradient id="kp-flute" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E7B36A"/><stop offset=".5" stop-color="#C98B3A"/><stop offset="1" stop-color="#8E5B1E"/></linearGradient>' +
        '<linearGradient id="kp-vane" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3CCB8F"/><stop offset=".6" stop-color="#119373"/><stop offset="1" stop-color="#0A5E55"/></linearGradient>' +
        '<radialGradient id="kp-iris" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="#5B3A8A"/><stop offset="1" stop-color="#21133D"/></radialGradient>' +
      '</defs>' +

      // ---- halo and everything that lives inside the disc -------------------
      '<g clip-path="url(#kp-disc)">' +
        '<circle cx="50" cy="46" r="34" fill="url(#kp-halo)"/>' +

        // hair, behind the face
        '<path fill="url(#kp-hair)" d="M23 58 C20 40 32 30 50 30 C68 30 80 40 77 58 C79 66 76 73 71 76 L29 76 C24 73 21 66 23 58 Z"/>' +

        // pitambar (yellow silk) and sash
        '<path fill="url(#kp-silk)" d="M12 104 C13 89 26 81 40 79.5 L50 85 L60 79.5 C74 81 87 89 88 104 Z"/>' +
        '<path fill="#E0940F" opacity=".45" d="M40 79.5 L50 85 L60 79.5 L58 82 L50 88 L42 82 Z"/>' +
        '<path fill="url(#kp-sash)" d="M27 84 C40 90 57 97 70 104 L60 104 C49 98 37 93 24.5 88 Z"/>' +
        // neck
        '<path fill="#4F7FD0" d="M44 73 L56 73 L56.5 81 C54 83.6 46 83.6 43.5 81 Z"/>' +
        // necklace + kaustubha gem
        '<path d="M43.2 80.6 Q50 86.2 56.8 80.6" fill="none" stroke="url(#kp-gold)" stroke-width="1.3"/>' +
        '<circle cx="50" cy="84.4" r="2.3" fill="url(#kp-gold)"/><circle cx="50" cy="84.4" r="1.45" fill="#E11D48"/><circle cx="49.5" cy="83.9" r=".45" fill="#FFE4E6"/>' +
        // vaijayanti garland
        garland() +

        // bansuri across the chest, tassel hanging from the low end
        '<g class="k-flute" transform="translate(0 -7) rotate(-17 50 93)">' +
          '<rect x="22" y="91.2" width="58" height="3.6" rx="1.8" fill="url(#kp-flute)"/>' +
          '<rect x="27" y="91.1" width="2" height="3.8" fill="url(#kp-gold)"/><rect x="73" y="91.1" width="2" height="3.8" fill="url(#kp-gold)"/>' +
          '<g fill="#5A3510"><circle cx="46" cy="93" r=".7"/><circle cx="50" cy="93" r=".7"/><circle cx="54" cy="93" r=".7"/><circle cx="58" cy="93" r=".7"/><circle cx="62" cy="93" r=".7"/><circle cx="36" cy="93" r=".85"/></g>' +
          '<path d="M24 94.6 Q23 99 24.6 103" fill="none" stroke="#DC2626" stroke-width="1.2" stroke-linecap="round"/>' +
          '<circle cx="24" cy="95" r="1.1" fill="url(#kp-gold)"/>' +
        '</g>' +

        // ---- head -----------------------------------------------------------
        // ears + makara kundala
        '<ellipse fill="#5485D6" cx="28.2" cy="58.5" rx="3" ry="4.2"/><ellipse fill="#5485D6" cx="71.8" cy="58.5" rx="3" ry="4.2"/>' +
        '<g fill="url(#kp-gold)"><circle cx="27.6" cy="63.6" r="1.7"/><path d="M26.2 64.6 Q27.6 70 29 64.6 Z"/><circle cx="72.4" cy="63.6" r="1.7"/><path d="M71 64.6 Q72.4 70 73.8 64.6 Z"/></g>' +
        // face
        '<path fill="url(#kp-skin)" d="M28 56 C28 43 37 37 50 37 C63 37 72 43 72 56 C72 68.5 62.5 76.5 50 76.5 C37.5 76.5 28 68.5 28 56 Z"/>' +
        // side curls framing the face
        '<path fill="url(#kp-hair)" d="M28.4 46 C25.6 52 26.4 60 29.6 64.6 C29.8 58 31 51.6 34 47 Z"/>' +
        '<path fill="url(#kp-hair)" d="M71.6 46 C74.4 52 73.6 60 70.4 64.6 C70.2 58 69 51.6 66 47 Z"/>' +
        '<path fill="url(#kp-hair)" d="M33 43.6 C38 41 44 41.6 47 44.6 C42 44 37 45 33.6 47.6 Z"/>' +
        '<path fill="url(#kp-hair)" d="M67 43.6 C62 41 56 41.6 53 44.6 C58 44 63 45 66.4 47.6 Z"/>' +
        // cheeks: off at rest, faded in by mood
        '<g class="k-cheek"><ellipse fill="#FF8FB8" cx="36.2" cy="63.6" rx="4.4" ry="2.7" opacity=".75"/><ellipse fill="#FF8FB8" cx="63.8" cy="63.6" rx="4.4" ry="2.7" opacity=".75"/></g>' +
        // a soft rosy tint that is always there — chibi faces read as warm
        '<g opacity=".32"><ellipse fill="#FF9EC4" cx="36.4" cy="63.8" rx="3.6" ry="2.1"/><ellipse fill="#FF9EC4" cx="63.6" cy="63.8" rx="3.6" ry="2.1"/></g>' +
        // tilak: urdhva pundra, a cream U with a vermilion line
        '<path d="M47.7 42.6 Q47.9 48.8 50 49.2 Q52.1 48.8 52.3 42.6" fill="none" stroke="#FFF1C2" stroke-width="1.15" stroke-linecap="round"/>' +
        '<path d="M50 43.2 L50 47.8" stroke="#E23B2E" stroke-width="1.05" stroke-linecap="round"/>' +
        // nose
        '<path d="M49 60.6 Q50 61.5 51 60.6" fill="none" stroke="#2F5BAE" stroke-width=".8" stroke-linecap="round"/>' +
        // mouths — one visible at a time, chosen by data-mood
        '<path class="k-mouth m-idle"      d="M46.4 66 Q50 68.4 53.6 66"/>' +
        '<path class="k-mouth m-answered"  d="M45.4 65.4 Q50 70.2 54.6 65.4"/>' +
        '<path class="k-mouth m-asking"    d="M48 66.2 Q50 65.6 52 66.2 Q52 69.2 50 69.2 Q48 69.2 48 66.2 Z"/>' +
        '<path class="k-mouth m-blocked"   d="M46.6 67 L53.4 67"/>' +
        '<path class="k-mouth m-nothing"   d="M46.4 67.8 Q50 65.6 53.6 67.8"/>' +
        '<path class="k-mouth m-thinking"  d="M47 67 Q50 66.1 53.2 66.2"/>' +
        '<path class="k-mouth m-shy"       d="M46.8 66.4 Q48.4 67.8 50 66.6 Q51.6 67.8 53.2 66.4"/>' +
        '<path class="k-mouth m-surprised" d="M48.5 67.4 Q48.5 64.6 50 64.6 Q51.5 64.6 51.5 67.4 Q51.5 70.2 50 70.2 Q48.5 70.2 48.5 67.4 Z"/>' +
        '<path class="k-mouth m-sad"       d="M45.8 69 Q50 65 54.2 69"/>' +
        '<g class="k-mouthg m-happy">' +
          '<path fill="#7A2638" d="M45 65 Q50 64.2 55 65 Q54 71.2 50 71.2 Q46 71.2 45 65 Z"/>' +
          '<path fill="#FFFFFF" d="M45.9 65.3 Q50 64.8 54.1 65.3 Q53.8 66.6 50 66.7 Q46.2 66.6 45.9 65.3 Z"/>' +
          '<path fill="#F07A8E" d="M47.4 69.1 Q50 67.9 52.6 69.1 Q51.8 71 50 71 Q48.2 71 47.4 69.1 Z"/>' +
        '</g>' +
        '<g class="k-mouthg m-laughing">' +
          '<path fill="#7A2638" d="M44 64.6 Q50 63.4 56 64.6 Q55 73 50 73 Q45 73 44 64.6 Z"/>' +
          '<path fill="#FFFFFF" d="M45.1 65 Q50 64.1 54.9 65 Q54.6 66.6 50 66.7 Q45.4 66.6 45.1 65 Z"/>' +
          '<path fill="#F07A8E" d="M46.8 70 Q50 68.4 53.2 70 Q52.2 72.8 50 72.8 Q47.8 72.8 46.8 70 Z"/>' +
        '</g>' +
        '<g class="k-mouthg m-confused">' +
          '<path fill="#7A2638" d="M48.6 67.6 Q48.4 65 50.6 64.8 Q52.8 64.7 52.9 67.3 Q53 70 50.8 70.1 Q48.7 70.3 48.6 67.6 Z"/>' +
        '</g>' +
        // eyes: big and glossy, long upper lashes
        '<g class="k-eye k-eye-l">' +
          '<ellipse fill="#FFFFFF" cx="41" cy="55.4" rx="5" ry="5.6"/>' +
          '<circle class="k-iris" fill="url(#kp-iris)" cx="41.3" cy="56" r="3.7"/>' +
          '<circle class="k-pupil" fill="#0B0620" cx="41.3" cy="56.2" r="1.8"/>' +
          '<circle class="k-glint" fill="#FFFFFF" cx="42.6" cy="54.4" r="1.25"/>' +
          '<circle class="k-glint" fill="#FFFFFF" cx="40.1" cy="57.6" r=".55" opacity=".85"/>' +
          '<path fill="none" stroke="#12163A" stroke-width="1.35" stroke-linecap="round" d="M35.6 53.6 Q41 48.2 46.4 53.2"/>' +
          '<path fill="none" stroke="#12163A" stroke-width="1" stroke-linecap="round" d="M35.9 53.4 L34.2 52.2"/>' +
        '</g>' +
        '<g class="k-eye k-eye-r">' +
          '<ellipse fill="#FFFFFF" cx="59" cy="55.4" rx="5" ry="5.6"/>' +
          '<circle class="k-iris" fill="url(#kp-iris)" cx="59.3" cy="56" r="3.7"/>' +
          '<circle class="k-pupil" fill="#0B0620" cx="59.3" cy="56.2" r="1.8"/>' +
          '<circle class="k-glint" fill="#FFFFFF" cx="60.6" cy="54.4" r="1.25"/>' +
          '<circle class="k-glint" fill="#FFFFFF" cx="58.1" cy="57.6" r=".55" opacity=".85"/>' +
          '<path fill="none" stroke="#12163A" stroke-width="1.35" stroke-linecap="round" d="M53.6 53.2 Q59 48.2 64.4 53.6"/>' +
          '<path fill="none" stroke="#12163A" stroke-width="1" stroke-linecap="round" d="M64.1 53.4 L65.8 52.2"/>' +
        '</g>' +
        // closed, smiling eyes for a laugh — shown only when the open eyes hide
        '<g class="k-eyes-shut" fill="none" stroke="#12163A" stroke-width="1.7" stroke-linecap="round">' +
          '<path d="M36.4 57 Q41 51.8 45.6 57"/><path d="M54.4 57 Q59 51.8 63.6 57"/>' +
        '</g>' +
        // brows
        '<path class="k-brow k-brow-l" d="M36.8 47.4 Q40.6 45.4 44.4 46.6"/>' +
        '<path class="k-brow k-brow-r" d="M55.6 46.6 Q59.4 45.4 63.2 47.4"/>' +

        // ---- mukut (crown) ---------------------------------------------------
        '<path fill="url(#kp-gold)" d="M31 40 L35.5 27.5 L42 33.5 L50 17.5 L58 33.5 L64.5 27.5 L69 40 Z"/>' +
        '<path fill="#FFF6D5" opacity=".55" d="M50 20.5 L44.6 31.6 L46.6 32.6 Z"/>' +
        '<path fill="url(#kp-gold)" d="M28.6 42.2 C36 37.6 64 37.6 71.4 42.2 L71 37.6 C63 33.4 37 33.4 29 37.6 Z"/>' +
        '<path d="M29.6 39.8 C37 36 63 36 70.4 39.8" fill="none" stroke="#9A6A12" stroke-width=".5" opacity=".6"/>' +
        '<g fill="#FFFBEB"><circle cx="33" cy="39.4" r=".75"/><circle cx="38" cy="37.9" r=".75"/><circle cx="62" cy="37.9" r=".75"/><circle cx="67" cy="39.4" r=".75"/></g>' +
        '<circle cx="50" cy="28.6" r="2.7" fill="#E11D48"/><circle cx="49.2" cy="27.8" r=".8" fill="#FFE4E6"/>' +
        '<circle cx="36.4" cy="33.6" r="1.35" fill="#10B981"/><circle cx="63.6" cy="33.6" r="1.35" fill="#10B981"/>' +
        '<circle cx="50" cy="37.1" r="1.6" fill="#2563EB"/><circle cx="43.4" cy="37.4" r="1" fill="#E11D48"/><circle cx="56.6" cy="37.4" r="1" fill="#E11D48"/>' +
      '</g>' +

      // ---- the peacock feather: outside the clip, sways on its own ----------
      '<g class="k-plume">' +
        '<path d="M57.5 31 C62 24.5 67 18 73.5 8.5" fill="none" stroke="#8B6A1E" stroke-width="1.1" stroke-linecap="round"/>' +
        '<g transform="translate(0 7) rotate(32 71 7)">' +
          '<ellipse cx="71" cy="7" rx="6.4" ry="11.6" fill="url(#kp-vane)"/>' +
          '<g stroke="#2FBF86" stroke-width=".55" opacity=".8" fill="none" stroke-linecap="round">' +
            '<path d="M65 12 L62.6 14.6"/><path d="M64.6 7 L61.8 7.6"/><path d="M65.4 2.2 L63 0.6"/><path d="M77 12 L79.4 14.6"/><path d="M77.4 7 L80.2 7.6"/><path d="M76.6 2.2 L79 0.6"/>' +
          '</g>' +
          '<ellipse cx="71" cy="5.6" rx="4.4" ry="5.9" fill="#E9B83F"/>' +
          '<ellipse cx="71" cy="5.9" rx="3.3" ry="4.5" fill="#13A7A0"/>' +
          '<ellipse cx="71" cy="6.3" rx="2.2" ry="3.1" fill="#2446B8"/>' +
          '<ellipse cx="71" cy="6.7" rx="1.2" ry="1.8" fill="#0B1150"/>' +
          '<ellipse cx="70.2" cy="4.6" rx=".6" ry=".9" fill="#FFFFFF" opacity=".65"/>' +
        '</g>' +
      '</g>' +
    '</svg>';

  /**
   * Each copy of the character gets its own gradient and clip ids. Two copies
   * with the same ids would share defs, and a copy whose defs live inside a
   * hidden panel paints nothing.
   */
  function krisSvg(prefix) {
    return KRIS_SVG_TEMPLATE.replace(/kp-/g, 'kp-' + prefix + '-');
  }

  // Small ornaments used around the UI.
  var LOTUS =
    '<svg viewBox="0 0 24 16" width="22" height="15" aria-hidden="true" focusable="false">' +
      '<path d="M12 1.5 C14.6 4.6 14.6 9.4 12 13 C9.4 9.4 9.4 4.6 12 1.5 Z" fill="currentColor" opacity=".95"/>' +
      '<path d="M12 13 C9 12.6 6 10 5.4 5.6 C8.6 6.4 11 9 12 13 Z" fill="currentColor" opacity=".7"/>' +
      '<path d="M12 13 C15 12.6 18 10 18.6 5.6 C15.4 6.4 13 9 12 13 Z" fill="currentColor" opacity=".7"/>' +
      '<path d="M12 13.2 C8.4 13.8 4 12.6 1.4 9.6 C5.4 9.2 9.4 10.6 12 13.2 Z" fill="currentColor" opacity=".45"/>' +
      '<path d="M12 13.2 C15.6 13.8 20 12.6 22.6 9.6 C18.6 9.2 14.6 10.6 12 13.2 Z" fill="currentColor" opacity=".45"/>' +
    '</svg>';
  var FEATHER_EYE =
    '<svg viewBox="0 0 120 180" aria-hidden="true" focusable="false">' +
      '<ellipse cx="60" cy="90" rx="52" ry="84" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/>' +
      '<ellipse cx="60" cy="80" rx="34" ry="46" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".7"/>' +
      '<ellipse cx="60" cy="84" rx="22" ry="31" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".85"/>' +
      '<ellipse cx="60" cy="88" rx="11" ry="16" fill="currentColor" opacity=".9"/>' +
    '</svg>';
  var NOTE =
    '<svg viewBox="0 0 12 14" width="10" height="12" aria-hidden="true" focusable="false"><path d="M4.4 2.2 L11 .6 V9.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="3" cy="11" rx="2.6" ry="2" fill="currentColor"/><ellipse cx="8.8" cy="9.8" rx="2.4" ry="1.9" fill="currentColor"/><path d="M4.4 2.2 V11" stroke="currentColor" stroke-width="1.4"/></svg>';

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
    // prompt-card glyphs
    sun: icon('<circle cx="10" cy="10" r="3.2"/><path d="M10 2.8v1.6M10 15.6v1.6M2.8 10h1.6M15.6 10h1.6M4.9 4.9l1.1 1.1M14 14l1.1 1.1M4.9 15.1L6 14M14 6l1.1-1.1"/>', 16),
    chart: icon('<path d="M3.5 16.5h13"/><path d="M5.5 13.5V9.5"/><path d="M9 13.5V6"/><path d="M12.5 13.5V8"/><path d="M16 13.5V4.5"/>', 16),
    leaf: icon('<path d="M4 16c0-7 4.5-11.5 12-12c0 7.5-4.5 12-12 12z"/><path d="M4 16l6.5-6.5"/>', 16),
    compass: icon('<circle cx="10" cy="10" r="7"/><path d="M12.8 7.2l-1.7 4-4 1.7 1.7-4z"/>', 16),
  };
  var PROMPT_ICONS = { Briefing: 'sun', Data: 'chart', Compliance: 'leaf', App: 'compass' };

  // ==========================================================================
  //  Styles — scoped to the shadow root.
  //
  //  Palette: shyam indigo (the dusk-blue of the character), peacock teal,
  //  temple gold, marigold, lotus pink, on a warm ivory ground. Dark mode is
  //  a midnight indigo with the same accents turned up.
  // ==========================================================================
  var TOKENS_LIGHT =
    '--bg:#FFFCF6;--bg-2:#FBF6EC;--bg-3:#F3ECDC;--hover:rgba(34,40,110,.05);--press:rgba(34,40,110,.09);' +
    '--ink:#191C45;--ink-2:#474B72;--ink-3:#777A9C;--ink-4:#A9ABC4;' +
    '--line:#EEE6D6;--line-2:#E1D6C0;--line-3:#CDBF9F;' +
    '--accent:#2B3A9E;--accent-2:#0F8F8A;--accent-hover:#3346B8;--on-accent:#FFFFFF;' +
    '--gold:#C8911E;--gold-2:#F2C14E;--gold-soft:rgba(242,193,78,.16);' +
    '--peacock:#0F8584;--peacock-2:#9ED9D3;--peacock-soft:rgba(15,133,132,.09);' +
    '--lotus:#E0457B;--marigold:#F59E0B;' +
    '--ok:#1F9D6B;--warn:#B7791F;--warn-soft:#FDF5E3;--danger:#C0283E;--danger-soft:#FDF1F3;' +
    '--head-a:#1C2266;--head-b:#2B3A9E;--head-c:#0F8584;--head-ink:#FFFFFF;--head-ink-2:rgba(255,255,255,.72);' +
    '--user-a:#2B3A9E;--user-b:#3E4FC0;--user-ink:#FFFFFF;--code-bg:#F7F2E8;--focus:rgba(43,58,158,.16);' +
    '--shadow-panel:0 0 0 1px rgba(25,28,69,.07),0 28px 64px -18px rgba(25,28,69,.38),0 10px 24px -12px rgba(25,28,69,.18);' +
    '--shadow-badge:0 2px 4px rgba(25,28,69,.22),0 14px 30px -8px rgba(28,34,102,.55);';
  var TOKENS_DARK =
    '--bg:#0E1033;--bg-2:#13163F;--bg-3:#1A1E52;--hover:rgba(238,240,255,.06);--press:rgba(238,240,255,.1);' +
    '--ink:#EEF0FF;--ink-2:#B7BAE0;--ink-3:#8487B3;--ink-4:#585B8A;' +
    '--line:#1F2358;--line-2:#2A2F6C;--line-3:#3B4185;' +
    '--accent:#F2C14E;--accent-2:#3CCBBE;--accent-hover:#FFD470;--on-accent:#191C45;' +
    '--gold:#F2C14E;--gold-2:#FFD470;--gold-soft:rgba(242,193,78,.12);' +
    '--peacock:#3CCBBE;--peacock-2:#1D6F6E;--peacock-soft:rgba(60,203,190,.12);' +
    '--lotus:#FF7AA8;--marigold:#FBBF24;' +
    '--ok:#4AD39A;--warn:#F2B75B;--warn-soft:rgba(242,183,91,.1);--danger:#FF8FA3;--danger-soft:rgba(255,143,163,.1);' +
    '--head-a:#0A0C2A;--head-b:#1C2266;--head-c:#0C5F63;--head-ink:#FFFFFF;--head-ink-2:rgba(255,255,255,.68);' +
    '--user-a:#2B3A9E;--user-b:#3548BA;--user-ink:#FFFFFF;--code-bg:#13163F;--focus:rgba(242,193,78,.2);' +
    '--shadow-panel:0 0 0 1px rgba(255,255,255,.06),0 28px 64px -18px rgba(0,0,0,.7),0 10px 24px -12px rgba(0,0,0,.45);' +
    '--shadow-badge:0 2px 4px rgba(0,0,0,.4),0 14px 30px -8px rgba(0,0,0,.6);';

  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    'button{font:inherit;color:inherit}',
    '.root{' + TOKENS_LIGHT +
      '--font:"Inter var","Inter","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--display:"Inter var","Inter","Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--mono:"Cascadia Mono","SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;' +
      '--ease:cubic-bezier(.2,.8,.2,1);--spring:cubic-bezier(.34,1.56,.64,1);' +
      'position:fixed;right:22px;bottom:22px;z-index:2147483000;' +
      'font:400 14.5px/1.6 var(--font);color:var(--ink);letter-spacing:-.003em;' +
      '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;' +
      'display:flex;flex-direction:column;align-items:flex-end;gap:16px;' +
    '}',
    '.root[data-theme="dark"]{' + TOKENS_DARK + '}',
    '@media (prefers-color-scheme:dark){.root[data-theme="auto"]{' + TOKENS_DARK + '}}',
    '.root.left{right:auto;left:22px;align-items:flex-start}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',

    // --- the character, wherever it appears ----------------------------------
    '.k-char{width:100%;height:100%;display:block;overflow:visible}',
    '.k-brow{fill:none;stroke:#12163A;stroke-width:1.5;stroke-linecap:round;transition:transform .25s ease;transform-box:fill-box;transform-origin:center}',
    '.k-mouth{fill:none;stroke:#7A2638;stroke-width:1.3;stroke-linecap:round;display:none}',
    '.k-mouth.m-asking,.k-mouth.m-surprised{fill:#7A2638}',
    '.k-mouth.m-sad{stroke-width:1.5}',
    '.k-mouthg{display:none}',
    '.k-cheek{opacity:0;transition:opacity .32s ease}',
    '.k-eyes-shut{display:none}',
    '.k-eye{transform-box:fill-box;transform-origin:center;transition:transform .25s ease}',
    '.k-iris,.k-pupil,.k-glint{transition:transform .25s ease}',
    '.k-plume{transform-box:view-box;transform-origin:57.5px 31px;animation:sway 5.8s ease-in-out infinite}',
    '@keyframes sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(4deg)}}',
    '@keyframes breathe{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-1.2%) scale(1.012)}}',
    '@keyframes eyeDrift{0%,100%{transform:translate(0,0)}20%{transform:translate(1.1px,-.6px)}55%{transform:translate(-1px,.5px)}80%{transform:translate(.6px,.7px)}}',
    '.idle-drift .k-iris,.idle-drift .k-pupil,.idle-drift .k-glint{animation:eyeDrift 9s ease-in-out infinite}',
    '@keyframes moodPop{0%{transform:scale(1)}40%{transform:scale(1.09)}100%{transform:scale(1)}}',
    '.mood-pop{animation:moodPop .42s var(--spring)}',

    // moods: mouths
    'svg[data-mood="idle"] .m-idle,svg[data-mood="tired"] .m-idle{display:block}',
    'svg[data-mood="answered"] .m-answered,svg[data-mood="excited"] .m-answered{display:block}',
    'svg[data-mood="asking"] .m-asking,svg[data-mood="curious"] .m-asking{display:block}',
    'svg[data-mood="blocked"] .m-blocked{display:block}',
    'svg[data-mood="nothing"] .m-nothing,svg[data-mood="sorry"] .m-nothing{display:block}',
    'svg[data-mood="thinking"] .m-thinking{display:block}',
    'svg[data-mood="shy"] .m-shy,svg[data-mood="blush"] .m-shy{display:block}',
    'svg[data-mood="surprised"] .m-surprised{display:block}',
    'svg[data-mood="happy"] .m-happy{display:block}',
    'svg[data-mood="sad"] .m-sad{display:block}',
    'svg[data-mood="laughing"] .m-laughing{display:block}',
    'svg[data-mood="confused"] .m-confused{display:block}',
    // moods: brows, eyes, cheeks
    'svg[data-mood="thinking"] .k-brow{transform:translateY(-1.4px)}',
    'svg[data-mood="thinking"] .k-iris,svg[data-mood="thinking"] .k-pupil,svg[data-mood="thinking"] .k-glint{transform:translate(1.3px,-1.5px)}',
    'svg[data-mood="asking"] .k-brow-r{transform:translateY(-2px) rotate(-7deg)}',
    'svg[data-mood="blocked"] .k-brow-l{transform:translateY(1.3px) rotate(8deg)}',
    'svg[data-mood="blocked"] .k-brow-r{transform:translateY(1.3px) rotate(-8deg)}',
    'svg[data-mood="nothing"] .k-brow-l,svg[data-mood="sorry"] .k-brow-l{transform:translateY(-.8px) rotate(7deg)}',
    'svg[data-mood="nothing"] .k-brow-r,svg[data-mood="sorry"] .k-brow-r{transform:translateY(-.8px) rotate(-7deg)}',
    'svg[data-mood="excited"] .k-brow,svg[data-mood="curious"] .k-brow{transform:translateY(-1.8px)}',
    'svg[data-mood="excited"] .k-eye,svg[data-mood="curious"] .k-eye{transform:scale(1.06)}',
    'svg[data-mood="tired"] .k-eye{transform:scaleY(.55)}',
    'svg[data-mood="tired"] .k-brow{transform:translateY(1.4px)}',
    'svg[data-mood="surprised"] .k-brow{transform:translateY(-2.4px)}',
    'svg[data-mood="surprised"] .k-eye{transform:scale(1.14)}',
    'svg[data-mood="happy"] .k-brow{transform:translateY(-1.4px)}',
    'svg[data-mood="happy"] .k-eye{transform:scaleY(.9)}',
    'svg[data-mood="happy"] .k-cheek{opacity:.45}',
    'svg[data-mood="blush"] .k-cheek,svg[data-mood="shy"] .k-cheek{opacity:1}',
    'svg[data-mood="blush"] .k-brow,svg[data-mood="shy"] .k-brow{transform:translateY(1px)}',
    'svg[data-mood="blush"] .k-eye{transform:scaleY(.84)}',
    'svg[data-mood="blush"] .k-iris,svg[data-mood="blush"] .k-pupil,svg[data-mood="blush"] .k-glint,svg[data-mood="shy"] .k-iris,svg[data-mood="shy"] .k-pupil,svg[data-mood="shy"] .k-glint{transform:translate(1.4px,1.3px)}',
    'svg[data-mood="sad"] .k-brow-l{transform:translate(1px,-1.6px) rotate(12deg)}',
    'svg[data-mood="sad"] .k-brow-r{transform:translate(-1px,-1.6px) rotate(-12deg)}',
    'svg[data-mood="sad"] .k-eye{transform:scaleY(.82)}',
    'svg[data-mood="sad"] .k-iris,svg[data-mood="sad"] .k-pupil,svg[data-mood="sad"] .k-glint{transform:translate(0,1.4px)}',
    'svg[data-mood="laughing"] .k-eye{display:none}',
    'svg[data-mood="laughing"] .k-eyes-shut{display:block}',
    'svg[data-mood="laughing"] .k-brow{transform:translateY(-2px)}',
    'svg[data-mood="laughing"] .k-cheek{opacity:.7}',
    'svg[data-mood="confused"] .k-brow-l{transform:translateY(-2px) rotate(-9deg)}',
    'svg[data-mood="confused"] .k-brow-r{transform:translateY(1.2px) rotate(9deg)}',
    'svg[data-mood="confused"] .k-eye{transform:scale(1.08)}',
    // the feather perks up with delight and droops with disappointment
    'svg[data-mood="happy"] .k-plume,svg[data-mood="laughing"] .k-plume,svg[data-mood="excited"] .k-plume{animation:sway 1.6s ease-in-out infinite}',
    'svg[data-mood="sad"] .k-plume{animation:none;transform:rotate(9deg);transition:transform .6s ease}',

    // one-shot gestures
    '@keyframes laughShake{0%,100%{transform:none}18%{transform:translateY(-3%) rotate(-3deg)}38%{transform:translateY(1%) rotate(2.6deg)}58%{transform:translateY(-2%) rotate(-2deg)}78%{transform:translateY(.5%) rotate(1.4deg)}}',
    '.laugh-shake .k-char{animation:laughShake .78s ease-in-out 2!important;transform-origin:50% 75%}',
    '@keyframes sadSink{0%,100%{transform:none}55%{transform:translateY(4%) scale(.985)}}',
    '.sad-sink .k-char{animation:sadSink 1.5s ease-in-out!important;transform-origin:50% 75%}',
    '@keyframes blink{0%,93%,100%{transform:scaleY(1)}96%{transform:scaleY(.08)}}',
    '.blinking .k-eye{animation:blink 5.4s infinite}',
    '.blinking .k-eye-r{animation-delay:.05s}',

    // --- launcher -------------------------------------------------------------
    '.badge{width:64px;height:64px;border-radius:50%;padding:0;cursor:pointer;position:relative;display:block;flex:none;border:0;background:transparent;' +
      'transition:transform .28s var(--spring)}',
    // the aura: a slowly turning ring of gold, peacock and indigo
    '.badge .aura{position:absolute;inset:-4px;border-radius:50%;background:conic-gradient(from 0deg,#F2C14E,#14A39A,#2B3A9E,#E0457B,#F2C14E);' +
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));' +
      'animation:turn 9s linear infinite;opacity:.95}',
    '.badge .glow{position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle,rgba(242,193,78,.35),rgba(20,163,154,.12) 55%,transparent 70%);opacity:0;transition:opacity .3s;pointer-events:none}',
    '.badge:hover .glow,.badge:focus-visible .glow{opacity:1}',
    '.badge .disc{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 30%,#3A4BB8 0%,#1C2266 62%,#111540 100%);box-shadow:var(--shadow-badge),inset 0 0 0 1.5px rgba(242,193,78,.85)}',
    '.badge .fig{position:absolute;inset:0;animation:breathe 4.8s ease-in-out infinite}',
    '.badge:hover{transform:translateY(-3px) scale(1.03)}',
    '.badge:active{transform:translateY(0) scale(.96)}',
    '.badge:focus-visible{outline:2px solid var(--gold);outline-offset:6px}',
    '.badge .dot{position:absolute;top:0;right:0;width:14px;height:14px;border-radius:50%;background:var(--lotus);border:2px solid #FFFFFF;z-index:3;transform:scale(0);transition:transform .3s var(--spring)}',
    '.badge.unread .dot{transform:scale(1)}',
    '@keyframes turn{to{transform:rotate(360deg)}}',
    // flute notes drift up while K.R.1.S is working on an answer
    '.notes{position:absolute;left:50%;top:-4px;width:0;height:0;pointer-events:none;z-index:4}',
    '.notes i{position:absolute;left:0;top:0;color:var(--gold-2);opacity:0;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}',
    '.notes i svg{display:block}',
    '.root.busy .notes i{animation:note 2.4s ease-out infinite}',
    '.root.busy .notes i:nth-child(2){animation-delay:.8s;color:#5FE0D3}',
    '.root.busy .notes i:nth-child(3){animation-delay:1.6s;color:#FF9EC4}',
    '@keyframes note{0%{opacity:0;transform:translate(6px,6px) scale(.6) rotate(-10deg)}20%{opacity:1}100%{opacity:0;transform:translate(20px,-30px) scale(1) rotate(12deg)}}',

    // --- first-visit speech bubble --------------------------------------------
    '.nudge{position:relative;max-width:250px;padding:11px 34px 11px 14px;border-radius:16px 16px 6px 16px;background:var(--bg);color:var(--ink);' +
      'font-size:13.5px;line-height:1.45;box-shadow:var(--shadow-panel);cursor:pointer;animation:nudgeIn .45s var(--spring) both;' +
      'border:1px solid transparent;background:linear-gradient(var(--bg),var(--bg)) padding-box,linear-gradient(120deg,var(--gold-2),var(--peacock),var(--accent)) border-box}',
    '.nudge b{font-weight:650;color:var(--accent)}',
    '.root.left .nudge{border-radius:16px 16px 16px 6px}',
    '.nudge .x{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center}',
    '.nudge .x:hover{background:var(--hover);color:var(--ink)}',
    '.nudge .x svg{width:14px;height:14px}',
    '.root.open .nudge,.nudge.gone{display:none}',
    '@keyframes nudgeIn{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:none}}',

    // --- panel ----------------------------------------------------------------
    '.panel{width:412px;max-width:calc(100vw - 44px);height:min(712px,calc(100vh - 124px));' +
      'background:var(--bg);border-radius:24px;box-shadow:var(--shadow-panel);' +
      'display:none;flex-direction:column;overflow:hidden;transform-origin:bottom right;position:relative}',
    '.root.left .panel{transform-origin:bottom left}',
    '.root.open .panel{display:flex;animation:panelIn .32s var(--spring)}',
    '.root.closing .panel{display:flex;animation:panelOut .16s ease-in forwards}',
    '.root.restored .panel{animation:none}',
    '@keyframes panelIn{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes panelOut{to{opacity:0;transform:translateY(10px) scale(.97)}}',
    '.root.wide .panel{width:min(740px,calc(100vw - 44px));height:calc(100vh - 124px)}',

    // header: a dusk-to-peacock band with a faint feather eye
    '.head{position:relative;display:flex;align-items:center;gap:12px;padding:14px 10px 14px 16px;flex:none;overflow:hidden;color:var(--head-ink);' +
      'background:linear-gradient(125deg,var(--head-a) 0%,var(--head-b) 58%,var(--head-c) 118%)}',
    '.head::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,var(--gold-2),var(--peacock),var(--lotus),var(--gold-2));opacity:.9}',
    '.head .eye{position:absolute;right:-18px;top:-34px;width:120px;height:180px;color:#F2C14E;opacity:.13;transform:rotate(28deg);pointer-events:none}',
    '.head .eye svg{width:100%;height:100%;display:block}',
    '.avatar{position:relative;width:42px;height:42px;flex:none}',
    '.avatar .face{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 30%,#3A4BB8,#1C2266 62%,#111540);box-shadow:inset 0 0 0 1.5px rgba(242,193,78,.8),0 4px 12px -4px rgba(0,0,0,.4)}',
    '.avatar .fig{position:absolute;inset:0;animation:breathe 4.8s ease-in-out infinite}',
    '.avatar .presence{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;background:#9A9DC0;border:2px solid var(--head-b);transition:background .3s;z-index:2}',
    '.root[data-conn="online"] .avatar .presence{background:#4AD39A}',
    '.root[data-conn="waking"] .avatar .presence,.root[data-conn="connecting"] .avatar .presence{background:#F2C14E}',
    '.root[data-conn="offline"] .avatar .presence{background:#FF8FA3}',
    '.titles{position:relative;min-width:0;flex:1;line-height:1.25}',
    '.titles h2{margin:0;font:700 16px/1.2 var(--display);letter-spacing:.14em;color:var(--head-ink)}',
    '.titles h2 .sub{font:500 10.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold-2);margin-left:8px;vertical-align:2px;opacity:.9}',
    '.titles .status{margin:3px 0 0;font-size:12.5px;color:var(--head-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.titles .status button{border:0;background:none;padding:0;color:#FFFFFF;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-size:inherit}',
    '.tool{position:relative;width:34px;height:34px;border:0;border-radius:11px;background:transparent;color:var(--head-ink-2);cursor:pointer;display:grid;place-items:center;flex:none;transition:background .15s,color .15s}',
    '.tool:hover{background:rgba(255,255,255,.12);color:#FFFFFF}',
    '.tool:active{background:rgba(255,255,255,.2)}',
    '.tool:focus-visible{outline:2px solid var(--gold-2);outline-offset:-2px}',
    '.tool[hidden]{display:none}',

    // conversation
    '.body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:radial-gradient(120% 60% at 100% 0%,var(--gold-soft),transparent 60%),var(--bg)}',
    '.log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:20px 18px 12px;display:flex;flex-direction:column;gap:20px;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
    '.log::-webkit-scrollbar{width:10px}.log::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:10px;border:3px solid var(--bg)}',
    '.root.wide .log{padding:26px max(24px,calc((100% - 620px)/2)) 16px}',

    // welcome
    '.welcome{margin:auto 0;padding:6px 2px 4px;text-align:center;animation:fadeUp .4s var(--ease) both}',
    '.welcome .hero{position:relative;width:96px;height:96px;margin:6px auto 16px}',
    '.welcome .hero .ring{position:absolute;inset:-5px;border-radius:50%;background:conic-gradient(from 200deg,#F2C14E,#14A39A,#2B3A9E,#E0457B,#F2C14E);' +
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px));animation:turn 14s linear infinite}',
    '.welcome .hero .disc{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle at 50% 30%,#3A4BB8,#1C2266 62%,#111540);box-shadow:0 14px 30px -12px rgba(28,34,102,.55),inset 0 0 0 1.5px rgba(242,193,78,.8)}',
    '.welcome .hero .fig{position:absolute;inset:0}',
    '.welcome .kicker{display:inline-flex;align-items:center;gap:8px;margin:0 0 8px;font:600 10.5px/1 var(--mono);letter-spacing:.2em;text-transform:uppercase;color:var(--gold)}',
    '.welcome .kicker::before,.welcome .kicker::after{content:"";width:18px;height:1px;background:linear-gradient(90deg,transparent,var(--gold))}',
    '.welcome .kicker::after{transform:scaleX(-1)}',
    '.welcome h3{margin:0 0 8px;font:650 23px/1.2 var(--display);letter-spacing:-.022em;color:var(--ink)}',
    '.welcome p{margin:0 auto;color:var(--ink-2);font-size:14.5px;line-height:1.55;max-width:32em}',
    '.welcome .ctxline{margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--peacock);background:var(--peacock-soft);padding:4px 11px 4px 9px;border-radius:999px}',
    '.welcome .ctxline[hidden]{display:none}',
    '.prompts{list-style:none;margin:20px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left}',
    '.root.wide .prompts{grid-template-columns:repeat(4,1fr)}',
    '.prompts li{display:flex}',
    '.prompts button{position:relative;width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 12px 12px;border:1px solid var(--line);background:var(--bg);cursor:pointer;text-align:left;color:var(--ink);font-size:13.5px;line-height:1.35;border-radius:16px;' +
      'box-shadow:0 1px 2px rgba(25,28,69,.04);transition:border-color .18s,transform .22s var(--spring),box-shadow .18s}',
    '.prompts button:hover{border-color:var(--gold-2);transform:translateY(-2px);box-shadow:0 10px 22px -12px rgba(28,34,102,.35)}',
    '.prompts button:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.prompts .tag{display:inline-flex;align-items:center;gap:6px;font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold)}',
    '.prompts .tag .ic{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:var(--gold-soft);color:var(--accent)}',
    '.root[data-theme="dark"] .prompts .tag .ic{color:var(--gold)}',
    '.prompts .q{min-width:0;font-weight:500}',
    '.prompts .go{position:absolute;right:10px;top:12px;color:var(--ink-4);opacity:0;transform:translateX(-4px);transition:opacity .15s,transform .2s var(--ease)}',
    '.prompts button:hover .go,.prompts button:focus-visible .go{opacity:1;transform:none;color:var(--gold)}',
    '.trust{margin:18px auto 0;font-size:12px;color:var(--ink-3);display:flex;gap:8px;align-items:center;justify-content:center;line-height:1.45;max-width:30em;text-align:left}',
    '.trust .lotus{flex:none;color:var(--lotus);display:grid;place-items:center}',

    // turns
    '.turn{display:flex;flex-direction:column;min-width:0}',
    '.turn.anim{animation:fadeUp .24s var(--ease) both}',
    '@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@keyframes fadeIn{from{opacity:0}to{opacity:1}}',
    '.turn.user{align-items:flex-end}',
    '.bubble{max-width:86%;padding:9px 15px;border-radius:20px 20px 6px 20px;background:linear-gradient(135deg,var(--user-a),var(--user-b));color:var(--user-ink);white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;line-height:1.5;box-shadow:0 6px 16px -10px rgba(43,58,158,.7)}',
    '.turn.assistant{position:relative;padding-left:14px}',
    '.turn.assistant:has(.thinking)::before{display:none}',
    '.turn.assistant::before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:2px;border-radius:2px;background:linear-gradient(var(--gold-2),var(--peacock));opacity:.55}',
    '.msg{min-width:0;overflow-wrap:anywhere;color:var(--ink)}',
    '.msg > :first-child{margin-top:0}',
    '.msg p{margin:0}.msg p + p,.msg p + ul,.msg p + ol,.msg ul + p,.msg ol + p,.msg pre + p,.msg p + pre,.msg .tablewrap + p,.msg p + .tablewrap,.msg blockquote + p,.msg p + blockquote{margin-top:10px}',
    '.msg h4{margin:14px 0 6px;font:650 14.5px/1.4 var(--display);letter-spacing:-.01em}',
    '.msg h4:first-child{margin-top:0}',
    '.msg strong{font-weight:650;color:var(--ink)}',
    '.msg em{font-style:italic}',
    '.msg a{color:var(--peacock);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}',
    '.msg ul,.msg ol{margin:6px 0 0;padding-left:20px}',
    '.msg li{margin:3px 0;padding-left:2px}',
    '.msg li::marker{color:var(--gold)}',
    '.msg ul ul,.msg ol ul{margin-top:2px}',
    '.msg blockquote{margin:8px 0 0;padding:2px 0 2px 12px;border-left:2px solid var(--gold-2);color:var(--ink-2)}',
    '.msg hr{border:0;border-top:1px solid var(--line);margin:14px 0}',
    '.msg code{font:500 .86em/1.4 var(--mono);background:var(--code-bg);border:1px solid var(--line);padding:1px 5px;border-radius:6px}',
    '.codeblock{margin:10px 0 0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--code-bg)}',
    '.codeblock .bar{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 4px 12px;border-bottom:1px solid var(--line);font:500 11px/1 var(--mono);color:var(--ink-3);text-transform:lowercase}',
    '.codeblock .bar button{border:0;background:transparent;color:var(--ink-3);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border-radius:7px;font:500 11px/1 var(--font)}',
    '.codeblock .bar button:hover{background:var(--hover);color:var(--ink)}',
    '.codeblock pre{margin:0;padding:11px 13px;overflow-x:auto;font:400 12.5px/1.6 var(--mono);white-space:pre;tab-size:2}',
    '.codeblock pre code{background:none;border:0;padding:0;font:inherit}',
    '.caret{display:inline-block;width:.5em;height:1.05em;vertical-align:-.16em;margin-left:1px;border-radius:2px;background:linear-gradient(var(--gold-2),var(--peacock));opacity:.85;animation:caret 1s steps(1) infinite}',
    '@keyframes caret{50%{opacity:0}}',

    // thinking: three gems that rise in turn
    '.thinking{display:inline-flex;align-items:center;gap:10px;color:var(--ink-3);font-size:14px;animation:fadeIn .2s ease .12s both}',
    '.thinking .dots{display:inline-flex;gap:5px}',
    '.thinking .dots i{width:7px;height:7px;border-radius:2px;transform:rotate(45deg);animation:gem 1.3s infinite ease-in-out}',
    '.thinking .dots i:nth-child(1){background:var(--gold-2)}',
    '.thinking .dots i:nth-child(2){background:var(--peacock);animation-delay:.16s}',
    '.thinking .dots i:nth-child(3){background:var(--lotus);animation-delay:.32s}',
    '@keyframes gem{0%,70%,100%{opacity:.35;transform:rotate(45deg) translateY(0)}35%{opacity:1;transform:rotate(45deg) translate(-2px,-2px)}}',
    '.thinking .label{background:linear-gradient(90deg,var(--ink-3) 0%,var(--ink-3) 40%,var(--gold) 50%,var(--ink-3) 60%,var(--ink-3) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:shimmer 2.2s linear infinite}',
    '@keyframes shimmer{from{background-position:100% 0}to{background-position:-150% 0}}',

    // meta / actions
    '.meta{display:flex;align-items:center;gap:2px;margin-top:6px;margin-left:-6px;min-height:28px}',
    '.act{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s,opacity .15s}',
    '.act:hover{background:var(--hover);color:var(--ink)}',
    '.act:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px}',
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
    '.chip{border:1px solid var(--line-2);background:var(--bg);color:var(--ink-2);border-radius:999px;padding:5px 13px;font-size:13px;line-height:1.35;cursor:pointer;text-align:left;transition:border-color .15s,background .15s,color .15s,transform .2s var(--spring)}',
    '.chip:hover{border-color:var(--gold-2);background:var(--gold-soft);color:var(--ink);transform:translateY(-1px)}',
    '.chip:focus-visible{outline:2px solid var(--peacock);outline-offset:1px}',
    '.chip:disabled{opacity:.45;cursor:default;transform:none}',
    '.choices .chip{border-color:var(--peacock-2);color:var(--ink);background:var(--peacock-soft)}',
    '.choices .chip:hover{background:var(--peacock-soft);border-color:var(--peacock)}',
    '.chip.picked{border-color:var(--peacock);color:var(--ink);opacity:1}',

    // data readout
    '.card{position:relative;border:1px solid var(--line);border-radius:16px;padding:15px 16px 12px;background:var(--bg);margin-top:2px;overflow:hidden;box-shadow:0 8px 22px -18px rgba(28,34,102,.45)}',
    '.card::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--peacock),var(--gold-2))}',
    '.card + p,.msg p + .card{margin-top:10px}',
    '.eyebrow{font:600 10.5px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--gold);margin:0 0 6px}',
    '.figure{font:700 33px/1.1 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--accent);margin:0 0 4px;word-break:break-word}',
    '.root[data-theme="dark"] .figure{color:var(--ink)}',
    '@media (prefers-color-scheme:dark){.root[data-theme="auto"] .figure{color:var(--ink)}}',
    '.figure .unit{font:500 15px/1 var(--font);letter-spacing:0;color:var(--ink-3);margin-left:6px}',
    '.subject{color:var(--ink-2);font-size:13.5px;line-height:1.45;margin:0}',
    '.card .subject + .subject{margin-top:4px}',
    '.sources{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--line-2);font:400 11.5px/1.5 var(--mono);color:var(--ink-3)}',
    '.sources span{overflow-wrap:anywhere}',
    '.sources b{font-weight:500;color:var(--ink-2)}',
    '.note{margin-top:10px;padding:8px 11px;border-radius:10px;background:var(--warn-soft);color:var(--ink-2);font-size:13px;line-height:1.5}',
    '.note.hard{background:var(--danger-soft)}',
    'details.working{margin-top:10px;font-size:12.5px;color:var(--ink-3)}',
    'details.working summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px}',
    'details.working summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}',
    'details.working[open] summary::before{transform:rotate(45deg)}',
    'details.working pre{margin:8px 0 0;padding:10px 12px;background:var(--code-bg);border:1px solid var(--line);border-radius:10px;overflow-x:auto;font:400 11.5px/1.55 var(--mono);white-space:pre-wrap}',

    // tables
    '.tablewrap{margin-top:10px;overflow-x:auto;border:1px solid var(--line);border-radius:12px}',
    'table.grid{border-collapse:collapse;width:100%;font-size:13px}',
    'table.grid th,table.grid td{text-align:left;padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}',
    'table.grid tr:last-child td,table.grid tr:last-child th{border-bottom:0}',
    'table.grid th{font:600 10.5px/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);background:var(--bg-2);white-space:nowrap}',
    'table.grid td.num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;font-weight:500}',
    'table.grid td.none{color:var(--ink-4);font-style:italic}',
    '.card .tablewrap{border-radius:10px}',

    // charts
    '.chart-title{margin:12px 0 0;font-size:12.5px;font-weight:550;color:var(--ink-2)}',
    '.bars{margin-top:8px;width:100%;display:block}',
    '.bars rect.track{fill:var(--bg-3)}',
    '.bars rect.bar{fill:var(--peacock)}',
    '.bars text{font:400 11px var(--font);fill:var(--ink-2)}',
    '.bars text.val{font:500 11.5px var(--font);fill:var(--ink);font-variant-numeric:tabular-nums}',
    '.bars line.axis{stroke:var(--line-2);stroke-width:1}',
    '.spark{margin-top:12px;width:100%;height:96px;display:block;overflow:visible}',
    '.spark path.line{fill:none;stroke:var(--peacock);stroke-width:1.8;vector-effect:non-scaling-stroke;stroke-linejoin:round}',
    '.spark path.fill{fill:var(--peacock-soft)}',
    '.spark line.axis{stroke:var(--line-2);stroke-width:1;vector-effect:non-scaling-stroke}',
    '.spark text{font:400 10px var(--mono);fill:var(--ink-3)}',
    '.range{display:flex;justify-content:space-between;gap:12px;margin-top:6px;font:400 11px/1.4 var(--mono);color:var(--ink-3)}',
    '.range span{white-space:nowrap}',
    '.lohi{margin:6px 0 0;font:400 11.5px/1.4 var(--mono);color:var(--ink-2)}',
    '.lohi b{font-weight:500;color:var(--ink)}',
    '.card .range + .lohi + .subject,.card .lohi + .subject{margin-top:10px}',

    // notices
    '.notice{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:14px;background:var(--danger-soft);color:var(--ink)}',
    '.notice .ic{color:var(--danger);flex:none;margin-top:2px}',
    '.notice .txt{flex:1;min-width:0;font-size:14px}',
    '.notice .sub{margin-top:3px;font:400 11px/1.4 var(--mono);color:var(--ink-3);word-break:break-word}',
    '.notice .retry{margin-top:8px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);background:var(--bg);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:13px;font-weight:550}',
    '.notice .retry:hover{border-color:var(--gold-2)}',
    '.notice.soft{background:var(--bg-2)}',
    '.notice.soft .ic{color:var(--ink-3)}',
    '.stopped{margin-top:6px;font-size:12px;color:var(--ink-3)}',

    // jump to latest
    '.jump{position:absolute;left:50%;bottom:12px;transform:translate(-50%,8px);opacity:0;pointer-events:none;display:inline-flex;align-items:center;gap:6px;' +
      'border:1px solid var(--line-2);background:var(--bg);color:var(--ink-2);border-radius:999px;padding:6px 12px 6px 10px;font-size:12.5px;font-weight:550;cursor:pointer;' +
      'box-shadow:0 6px 16px -6px rgba(28,34,102,.3);transition:opacity .18s,transform .18s var(--ease)}',
    '.jump.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
    '.jump:hover{color:var(--ink);border-color:var(--gold-2)}',

    // composer
    '.composer{flex:none;padding:10px 14px 12px;background:var(--bg)}',
    '.root.wide .composer{padding:10px max(14px,calc((100% - 648px)/2)) 14px}',
    '.box{position:relative;display:flex;flex-direction:column;border:1px solid var(--line-2);border-radius:20px;background:var(--bg);' +
      'box-shadow:0 1px 2px rgba(25,28,69,.04),0 6px 16px -8px rgba(25,28,69,.12);transition:border-color .15s,box-shadow .15s}',
    '.box:hover{border-color:var(--line-3)}',
    '.box.focus{border-color:var(--accent);box-shadow:0 0 0 4px var(--focus),0 6px 16px -8px rgba(25,28,69,.12)}',
    '.box textarea{display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--ink);' +
      'font:400 15px/1.5 var(--font);letter-spacing:-.003em;padding:12px 16px 0;height:34px;min-height:34px;max-height:180px;overflow-y:auto;scrollbar-width:thin}',
    '.box textarea::placeholder{color:var(--ink-4)}',
    '.box .row{display:flex;align-items:center;gap:8px;padding:4px 8px 8px 12px;min-height:46px}',
    '.box .ctx{display:none;align-items:center;gap:6px;max-width:60%;padding:3px 9px 3px 7px;border-radius:999px;background:var(--peacock-soft);color:var(--peacock);font-size:12px;line-height:1.3}',
    '.box .ctx.on{display:inline-flex}',
    '.box .ctx span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.box .spacer{flex:1}',
    '.box .count{font:400 11px/1 var(--mono);color:var(--ink-3)}',
    '.box .count.over{color:var(--danger)}',
    '.send{width:36px;height:36px;border-radius:50%;border:0;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:var(--on-accent);cursor:pointer;display:grid;place-items:center;flex:none;' +
      'box-shadow:0 6px 14px -6px rgba(43,58,158,.7),inset 0 0 0 1px rgba(242,193,78,.45);transition:filter .15s,transform .2s var(--spring),opacity .15s}',
    '.send:hover:not(:disabled){filter:brightness(1.08)}',
    '.send:active:not(:disabled){transform:scale(.92)}',
    '.send:disabled{background:var(--bg-3);color:var(--ink-4);cursor:default;box-shadow:none}',
    '.send:focus-visible{outline:2px solid var(--gold);outline-offset:2px}',
    '.hint{display:flex;justify-content:center;gap:12px;margin:8px 4px 0;font-size:11.5px;color:var(--ink-4);line-height:1.3;white-space:nowrap;overflow:hidden}',
    '.hint kbd{font:500 11px/1 var(--font);color:var(--ink-3)}',
    '@media (hover:none){.hint .keys{display:none}}',

    // inline mode
    '.root.inline{position:static;width:100%;height:100%;display:block;z-index:auto}',
    '.root.inline .panel{display:flex;width:100%;max-width:none;height:100%;border-radius:0;box-shadow:none;animation:none}',
    '.root.inline .badge,.root.inline .nudge,.root.inline .tool.close,.root.inline .tool.expand{display:none}',

    // phones: the panel becomes a full-height sheet
    '@media (max-width:520px){' +
      '.root:not(.inline){right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}' +
      '.root.left:not(.inline){left:16px}' +
      '.root:not(.inline) .panel{position:fixed;inset:0;width:auto;max-width:none;height:100%;max-height:none;border-radius:0}' +
      '.root.open:not(.inline) .badge,.root.closing:not(.inline) .badge{display:none}' +
      '.head{padding-top:calc(14px + env(safe-area-inset-top,0px))}' +
      '.tool.expand{display:none}' +
      '.log{padding:16px 16px 10px}' +
      '.welcome .hero{width:82px;height:82px}' +
      '.prompts button{padding:10px 11px}' +
      '.composer{padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px))}' +
      '.box textarea{font-size:16px}' +
      '.hint{display:none}' +
      '.figure{font-size:29px}' +
    '}',
    '@media (prefers-reduced-motion:reduce){' +
      '.root.open .panel,.root.closing .panel,.turn.anim,.welcome,.nudge{animation:none!important}' +
      '.badge .aura,.welcome .hero .ring,.badge .fig,.avatar .fig,.k-plume,.thinking .dots i,.thinking .label,.caret,.root.busy .notes i{animation:none!important}' +
      '.root.busy .notes i{opacity:0}' +
      '.thinking .label{color:var(--ink-3);background:none}' +
      '.idle-drift .k-iris,.idle-drift .k-pupil,.idle-drift .k-glint,.mood-pop,.blinking .k-eye,.laugh-shake .k-char,.sad-sink .k-char{animation:none!important}' +
      '.badge,.badge:hover,.prompts button,.prompts button:hover,.chip,.chip:hover{transition:none;transform:none}' +
    '}'
  ].join('');

  // ==========================================================================
  //  Local instant replies — no network at all.
  //  Only the unambiguous: greetings, thanks, goodbyes, "how are you". Anything
  //  that could possibly be a question goes to the server.
  // ==========================================================================
  var NAME_ALTS = 'there|kris|krishna|k\\.?r\\.?1\\.?s\\.?|all|team|friend|ji';
  var NAME_WORDS = '(?:' + NAME_ALTS + ')';
  var KIND_GREETING_RE = /^\s*(namaste|namaskar|radhe radhe|hare krishna|jai (?:shri|shree|sri) krishna)\b/i;
  var LOCAL_GREET_RE = new RegExp('^\\s*(?:hi+|hello+|hey+|hiya|heya|yo|howdy|namaste|namaskar|radhe radhe|hare krishna|jai (?:shri|shree|sri) krishna|good (?:morning|afternoon|evening|day)|morning|evening)(?:\\s+' + NAME_WORDS + ')*\\s*[!.?,\\s\\u{1F44B}\\u{1F64F}]*$', 'iu');
  var LOCAL_THANKS_RE = new RegExp('^\\s*(?:thanks?|thank you|thank u|thx|ty|tysm|cheers|much appreciated|dhanyavaad|dhanyavad|shukriya)(?:\\s+(?:a lot|so much|very much|again|' + NAME_ALTS + '))*\\s*[!.?,\\s\\u{1F64F}\\u{1F44D}]*$', 'iu');
  var LOCAL_BYE_RE = new RegExp('^\\s*(?:bye+|goodbye|good night|see (?:you|ya)(?: later| soon)?|cya|later|ttyl)(?:\\s+' + NAME_WORDS + ')*\\s*[!.?,\\s\\u{1F44B}\\u{1F64F}]*$', 'iu');
  var LOCAL_HOW_RE = new RegExp('^\\s*(?:(?:hi|hey|hello|namaste)[,!\\s]+)?(?:how are you(?: doing)?(?: today)?|how(?:\'|\\u2019)?s it going|how are things|what(?:\'|\\u2019)?s up|sup|wassup)(?:\\s+' + NAME_WORDS + ')*\\s*[!.?,\\s]*$', 'i');

  function titleWords(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }

  function localReply(text, name) {
    var hour = new Date().getHours();
    var hello = hour < 5 ? 'Hello' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    var who = name ? ', ' + name : '';
    var seed = (Date.now() / 60000 | 0) + text.length;
    var pick = function (arr) { return arr[seed % arr.length]; };
    if (LOCAL_HOW_RE.test(text)) return pick(['Calm and content, thank you. What shall we look into?', 'All is well here. What do you need?', 'Peaceful as ever, thanks for asking. What are we looking at today?']);
    if (LOCAL_THANKS_RE.test(text)) return pick(['You’re welcome' + who + '. Ask whenever you need a figure from the records.', 'Any time' + who + '. I’m here when you need the numbers.', 'Happy to help' + who + '.']);
    if (LOCAL_BYE_RE.test(text)) return pick(['Go well' + who + '. I’m here whenever you need me.', 'Until next time' + who + '. The records will keep.']);
    if (LOCAL_GREET_RE.test(text)) {
      // A greeting the user chose comes back in kind — only ever their words.
      var kind = text.match(KIND_GREETING_RE);
      var m = text.toLowerCase().match(/good (morning|afternoon|evening)/);
      var h = kind ? titleWords(kind[1].replace(/\b(shree|sri)\b/i, 'shri')) : m ? 'Good ' + m[1] : hello;
      return pick([h + who + '. Ask me about a vessel, the app, or anything else you need.', h + who + '. What can I look up for you?', h + who + '. What do you need from the records?']);
    }
    return null;
  }

  // ==========================================================================
  //  Widget
  // ==========================================================================
  var DEFAULTS = {
    endpoint: SCRIPT_ORIGIN + '/api/kris',
    getToken: null,
    tokenInHeader: false,   // true: send "Authorization: Bearer" (costs a CORS preflight cross-origin)
    ask: null,
    title: 'K.R.1.S',
    tagline: 'your guide',  // small caps beside the title; '' to hide
    kicker: 'Namaste',      // the small line above the welcome greeting
    subtitle: null,         // null: live connection status
    greeting: null,         // null: time-of-day greeting
    intro: 'Calm guidance through your fleet’s records, the app, and anything else on your mind.',
    examples: [
      { tag: 'Briefing', text: 'Anything I should know today?' },
      { tag: 'Data', text: 'Fuel consumption last month' },
      { tag: 'Compliance', text: 'GHG intensity this year' },
      { tag: 'App', text: 'How do I export a report?' }
    ],
    placeholder: 'Ask K.R.1.S anything…',
    position: 'right',      // 'right' | 'left'
    openOnLoad: false,
    mount: null,            // CSS selector or element: render inline instead of floating
    theme: 'light',         // 'light' | 'dark' | 'auto'
    brand: null,            // { accent, accent2, font }
    nudge: true,            // first-visit speech bubble on the badge
    nudgeText: 'Namaste! Ask me anything about your fleet.',
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
    this._storeKey = 'kris:v1:' + this.opts.endpoint;
    this.mount();
  }

  // --- storage (per tab; every access guarded) -------------------------------
  function store(kind) {
    try { var s = kind === 'local' ? global.localStorage : global.sessionStorage; var k = '__kris_probe'; s.setItem(k, '1'); s.removeItem(k); return s; }
    catch (_) { return null; }
  }
  Widget.prototype.save = function () {
    if (!this.opts.persist) return;
    var s = store('session'); if (!s) return;
    try {
      var turns = this.turns.slice(-40);
      var blob = JSON.stringify({ v: 1, turns: turns, userName: this.profile.userName, pending: this.pending, open: this.open, wide: this.root.classList.contains('wide'), at: Date.now() });
      if (blob.length > 400000) blob = JSON.stringify({ v: 1, turns: turns.slice(-10), userName: this.profile.userName, pending: this.pending, open: this.open, at: Date.now() });
      s.setItem(this._storeKey, blob);
    } catch (_) { /* quota or privacy mode: memory only */ }
  };
  Widget.prototype.load = function () {
    if (!this.opts.persist) return null;
    var s = store('session'); if (!s) return null;
    try {
      var raw = s.getItem(this._storeKey);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || d.v !== 1 || !Array.isArray(d.turns)) return null;
      if (Date.now() - (d.at || 0) > 12 * 3600 * 1000) return null;
      return d;
    } catch (_) { return null; }
  };

  /** The character on a gold-rimmed indigo disc, with flute notes above it. */
  function portrait(prefix, withNotes) {
    var wrap = el('span', 'portrait');
    var disc = el('span', 'disc');
    var fig = el('span', 'fig');
    fig.innerHTML = krisSvg(prefix);
    wrap.appendChild(disc);
    wrap.appendChild(fig);
    if (withNotes) {
      var notes = el('span', 'notes');
      for (var i = 0; i < 3; i++) { var n = el('i'); n.innerHTML = NOTE; notes.appendChild(n); }
      wrap.appendChild(notes);
    }
    return { wrap: wrap, fig: fig, svg: fig.querySelector('svg') };
  }

  Widget.prototype.mount = function () {
    var self = this;
    var host = document.createElement('div');
    host.setAttribute('data-kris-widget', '');
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
    root.setAttribute('data-mood', 'idle');
    if (this.opts.brand) {
      if (this.opts.brand.accent) root.style.setProperty('--accent', String(this.opts.brand.accent));
      if (this.opts.brand.accent2) root.style.setProperty('--accent-2', String(this.opts.brand.accent2));
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
    panel.id = 'kris-panel';
    this.panel = panel;

    var head = el('div', 'head');
    var eye = el('span', 'eye');
    eye.innerHTML = FEATHER_EYE;
    head.appendChild(eye);
    var avatar = el('div', 'avatar blinking');
    var face = el('span', 'face');
    avatar.appendChild(face);
    var hp = portrait('h', false);
    avatar.appendChild(hp.fig);
    this.headFace = hp.svg;
    this.headFaceWrap = hp.fig;
    this.headFace.setAttribute('data-mood', 'idle');
    avatar.appendChild(el('span', 'presence'));
    var titles = el('div', 'titles');
    var h2 = el('h2', null, this.opts.title);
    if (this.opts.tagline) h2.appendChild(el('span', 'sub', this.opts.tagline));
    titles.appendChild(h2);
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
    ta.setAttribute('aria-label', 'Message ' + this.opts.title);
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
    badge.setAttribute('aria-controls', 'kris-panel');
    badge.appendChild(el('span', 'glow'));
    badge.appendChild(el('span', 'aura'));
    var bp = portrait('b', true);
    // the portrait's pieces sit directly in the badge so they share its box
    while (bp.wrap.firstChild) badge.appendChild(bp.wrap.firstChild);
    badge.appendChild(el('span', 'dot'));
    this.badgeFace = bp.svg;
    this.badgeFace.setAttribute('data-mood', 'idle');
    badge.addEventListener('click', function () { self.toggle(); });
    this.badge = badge;

    root.appendChild(panel);

    var ls = store('local');
    var nudgeSeen = false;
    try { nudgeSeen = !!(ls && ls.getItem('kris:nudge')); } catch (_) { nudgeSeen = false; }
    if (!this.inline && this.opts.nudge && !nudgeSeen) {
      var nudge = el('div', 'nudge');
      nudge.setAttribute('role', 'status');
      nudge.style.display = 'none';
      var nt = String(this.opts.nudgeText || '');
      var bang = nt.indexOf('! ');
      if (bang > 0 && bang < 24) { nudge.appendChild(el('b', null, nt.slice(0, bang + 1))); nudge.appendChild(document.createTextNode(nt.slice(bang + 1))); }
      else nudge.appendChild(document.createTextNode(nt));
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
    var hero = el('div', 'hero blinking');
    hero.appendChild(el('span', 'ring'));
    var wp = portrait('w', false);
    while (wp.wrap.firstChild) hero.appendChild(wp.wrap.firstChild);
    wp.svg.setAttribute('data-mood', 'happy');
    w.appendChild(hero);
    w.appendChild(el('p', 'kicker', this.opts.kicker || this.opts.title));
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
        var tag = el('span', 'tag');
        var ic = el('span', 'ic');
        ic.innerHTML = ICON[PROMPT_ICONS[item.tag] || 'arrow'];
        tag.appendChild(ic);
        tag.appendChild(document.createTextNode(item.tag || 'Ask'));
        b.appendChild(tag);
        var q = el('span', 'q', item.text);
        b.appendChild(q);
        var go = el('span', 'go'); go.innerHTML = ICON.arrow; b.appendChild(go);
        b.addEventListener('click', function () { self.submit(q.textContent); });
        li.appendChild(b); ul.appendChild(li);
        self.promptButtons.push({ item: item, q: q });
      });
      w.appendChild(ul);
    }
    var trust = el('div', 'trust');
    var lot = el('span', 'lotus'); lot.innerHTML = LOTUS; trust.appendChild(lot);
    trust.appendChild(el('span', null, 'Every figure comes straight from your records. If they don’t hold the answer, ' + this.opts.title + ' says so.'));
    w.appendChild(trust);
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
    if (forever) { try { var ls = store('local'); if (ls) ls.setItem('kris:nudge', '1'); } catch (_) { /* ignore */ } }
  };

  // --- composer helpers ------------------------------------------------------
  Widget.prototype.autosize = function () {
    var ta = this.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
  };

  Widget.prototype.updateComposer = function () {
    this.root.classList.toggle('busy', !!this.busy);
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

  /** Tell K.R.1.S what the user is looking at. Pass null to clear. */
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
        var cx = rect.left + rect.width * 0.5, cy = rect.top + rect.height * 0.56;
        var dx = mx - cx, dy = my - cy;
        var dist = Math.sqrt(dx * dx + dy * dy) || 1;
        var cap = 1.6; // px — small and natural, never lets the iris leave the socket
        var ox = (dx / dist) * Math.min(cap, dist / 40);
        var oy = (dy / dist) * Math.min(cap, dist / 40);
        var t = 'translate(' + ox.toFixed(2) + 'px,' + oy.toFixed(2) + 'px)';
        var parts = svg.querySelectorAll('.k-iris, .k-pupil, .k-glint');
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
      var parts = svg.querySelectorAll('.k-iris, .k-pupil, .k-glint');
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
    this.root.setAttribute('data-mood', mood);

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
   * failed. Called by KRIS.react().
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
   * microseconds of work — and picks the expression to show while K.R.1.S is
   * "thinking" about it. The actual reply, once it arrives, still sets the
   * real mood via moodFor(); this only governs the waiting expression, so it
   * can never contradict what K.R.1.S ends up saying.
   */
  // Gratitude — "thank you", "thanks a lot", "much appreciated", "cheers".
  var THANKS_RE = /\b(thank(?:s| you|ing you)|thx|ty|tysm|much appreciated|appreciate (?:it|that|you)|cheers(?: mate)?|grateful)\b/i;
  // Praise aimed at K.R.1.S directly — this is what earns the blush, and it is
  // deliberately narrower than gratitude: "thanks" is warm, "you're the best"
  // is embarrassing.
  var COMPLIMENT_RE = /\b(good (job|bot|work|lad)|well done|nice job|(?:you'?re|you are|ur) (?:so |really |such )?(?:a )?(?:the )?(smart|great|awesome|amazing|helpful|best|brilliant|legend|genius|goat|star|wonderful|excellent)|love (you|this bot|ya)|amazing (job|work)|impressive|brilliant work|you rock|proud of you|my hero|best (?:bot|assistant|guide|kris))\b/i;
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
   * you, K.R.1.S should not stop smiling the instant the answer lands.
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
    var bar = el('div', 'sources');
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
  var KRIS = {
    __loaded: true,
    version: VERSION,
    init: function (options) {
      if (instance) return KRIS;
      var start = function () { if (!instance) instance = new Widget(options); };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
      return KRIS;
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
     *   KRIS.react('success' | 'fail' | 'confused' | 'praise' | 'funny' ...)
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

  global.KRIS = KRIS;
  if (typeof module !== 'undefined' && module.exports) module.exports = KRIS;
})(typeof window !== 'undefined' ? window : this);
