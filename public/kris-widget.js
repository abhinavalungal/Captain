/*!
 * K.R.1.S — embeddable assistant for GeoServe apps.
 *
 * K.R.1.S (say it "Kris") is a codename inspired by Lord Krishna: the calm
 * charioteer who guides without taking the reins. The widget is drawn in that
 * spirit — a small blue-skinned figure with a peacock feather in a golden
 * crown and a flute at the chest, sitting in the corner of your app.
 *
 * A small widget on the surface, a personal assistant underneath:
 *
 *   Chat       streamed answers, data readouts, follow-ups, edit & resend,
 *              copy, regenerate, stop, clear thinking / error / retry states
 *   History    past conversations on this device, searchable, 30-day retention
 *   Profile    who the user is and how they like answers, editable any time
 *   Memory     what K.R.1.S may remember across conversations — only what the
 *              user approved, visible, editable, deletable, and pausable
 *   Appearance light / dark / system, text size, density, motion
 *   Settings   send key, follow-ups, history, shortcuts, reset
 *   About      version, server status, how data is handled
 *
 * Two kinds of context, kept apart on purpose:
 *   - Conversation context: the current chat (its messages, anything the user
 *     mentioned in it, the page they are on). Gone when a new chat starts.
 *   - Long-term memory: only what the user said yes to. When K.R.1.S notices
 *     something useful ("I'm a marine emissions analyst") it asks first; it
 *     never saves silently, and it refuses passwords, IDs, contact, health
 *     and financial details outright.
 *
 * Embedding needs no configuration beyond a token — the API endpoint follows
 * wherever this script was loaded from:
 *
 *   <script src="https://kris.your-domain.com/kris-widget.js"></script>
 *   <script>
 *     KRIS.init({
 *       getToken: function () { return window.SESSION_TOKEN; },
 *       user: { id: window.CURRENT_USER_ID }   // keeps each user's memory and history apart
 *     });
 *   </script>
 *
 * Inline, inside your own layout:   KRIS.init({ mount: '#kris-slot' });
 * Page context:                     KRIS.setContext({ vesselId, vesselName, page });
 * Open a section from your own UI:  KRIS.openView('memory');
 * Sign-out on a shared machine:     KRIS.forget();
 * Your own memory store:            KRIS.init({ memoryStore: { load, save } });
 *
 * Speed, by design:
 *   - Greetings, thanks, goodbyes and memory commands ("what do you remember
 *     about me?") are answered locally, with no network.
 *   - Every message is a CORS "simple request" (text/plain body, token in the
 *     body), so the browser never spends a round trip on a preflight.
 *   - The server connection is warmed when the page is idle.
 *   - Model answers stream in as they are written.
 *
 * Everything renders inside a Shadow DOM, so host CSS cannot reach in and the
 * widget's CSS cannot leak out. No external requests, no fonts, no images:
 * the character is inline SVG.
 */
(function (global) {
  'use strict';

  if (global.KRIS && global.KRIS.__loaded) return;

  var VERSION = '2026-09-25.kris-14';

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
  function icon(paths, size, cls) {
    var s = size || 18;
    return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 20 20" width="' + s + '" height="' + s + '" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + paths + '</svg>';
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
    // theme switch: both glyphs live in the button and cross-fade
    moon: icon('<path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z"/>', 17, 'moon'),
    sunTool: icon('<circle cx="10" cy="10" r="3.4"/><path d="M10 2.5v1.7M10 15.8v1.7M2.5 10h1.7M15.8 10h1.7M4.7 4.7l1.2 1.2M14.1 14.1l1.2 1.2M4.7 15.3l1.2-1.2M14.1 5.9l1.2-1.2"/>', 18, 'sun'),
    // prompt-card glyphs
    sun: icon('<circle cx="10" cy="10" r="3.2"/><path d="M10 2.8v1.6M10 15.6v1.6M2.8 10h1.6M15.6 10h1.6M4.9 4.9l1.1 1.1M14 14l1.1 1.1M4.9 15.1L6 14M14 6l1.1-1.1"/>', 16),
    chart: icon('<path d="M3.5 16.5h13"/><path d="M5.5 13.5V9.5"/><path d="M9 13.5V6"/><path d="M12.5 13.5V8"/><path d="M16 13.5V4.5"/>', 16),
    leaf: icon('<path d="M4 16c0-7 4.5-11.5 12-12c0 7.5-4.5 12-12 12z"/><path d="M4 16l6.5-6.5"/>', 16),
    compass: icon('<circle cx="10" cy="10" r="7"/><path d="M12.8 7.2l-1.7 4-4 1.7 1.7-4z"/>', 16),
  };
  var PROMPT_ICONS = { Briefing: 'sun', Data: 'chart', Compliance: 'leaf', App: 'compass' };

  // Navigation, settings and memory glyphs — same 20px grid, same stroke.
  assign(ICON, {
    menu: icon('<path d="M3.5 6h13"/><path d="M3.5 10h13"/><path d="M3.5 14h8"/>', 18),
    chat: icon('<path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6.5a1.5 1.5 0 0 1-1.5 1.5H9l-3.5 3v-3H4A1.5 1.5 0 0 1 2.5 12.5V6A1.5 1.5 0 0 1 4 4.5z"/>', 17),
    history: icon('<path d="M3.6 10a6.4 6.4 0 1 0 1.9-4.5"/><path d="M3.5 3.8v2.9h2.9"/><path d="M10 6.6V10l2.4 1.6"/>', 17),
    user: icon('<circle cx="10" cy="7" r="3.2"/><path d="M3.8 16.5c.9-3 3.3-4.6 6.2-4.6s5.3 1.6 6.2 4.6"/>', 17),
    memory: icon('<path d="M10 2.8l1.6 3.9 3.9 1.6-3.9 1.6L10 13.8l-1.6-3.9-3.9-1.6 3.9-1.6z"/><path d="M15.6 12.6l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>', 17),
    palette: icon('<path d="M10 3a7 7 0 1 0 0 14c1 0 1.6-.7 1.6-1.5 0-.9-.7-1.3-.7-2.1 0-.9.7-1.4 1.6-1.4h1.7A3.3 3.3 0 0 0 17 8.7C17 5.5 13.9 3 10 3z"/><circle cx="6.6" cy="9.4" r=".9"/><circle cx="8.8" cy="6.3" r=".9"/><circle cx="12.4" cy="6.4" r=".9"/>', 17),
    gear: icon('<circle cx="10" cy="10" r="2.5"/><path d="M10 2.8v1.8M10 15.4v1.8M17.2 10h-1.8M4.6 10H2.8M15.1 4.9l-1.3 1.3M6.2 13.8l-1.3 1.3M15.1 15.1l-1.3-1.3M6.2 6.2L4.9 4.9"/>', 17),
    info: icon('<circle cx="10" cy="10" r="7"/><path d="M10 9v4.6"/><path d="M10 6.4v.1"/>', 17),
    back: icon('<path d="M12.5 4.5L7 10l5.5 5.5"/>', 17),
    trash: icon('<path d="M4 6h12"/><path d="M8 6V4.5h4V6"/><path d="M5.6 6l.7 9.5h7.4l.7-9.5"/>', 15),
    edit: icon('<path d="M12.6 4.2l3.2 3.2L7.6 15.6l-3.8.6.6-3.8z"/><path d="M11.2 5.6l3.2 3.2"/>', 15),
    search: icon('<circle cx="9" cy="9" r="5"/><path d="M12.8 12.8L16.5 16.5"/>', 16),
    plus: icon('<path d="M10 4.5v11"/><path d="M4.5 10h11"/>', 16),
    shield: icon('<path d="M10 2.8l6 2.3v4.3c0 3.8-2.6 6.4-6 7.8-3.4-1.4-6-4-6-7.8V5.1z"/><path d="M7.4 10.1l1.8 1.8 3.5-3.7"/>', 16),
    undo: icon('<path d="M6.5 7.5H12a4 4 0 0 1 0 8H8"/><path d="M9 4.5l-3 3 3 3"/>', 15),
    pause: icon('<rect x="5.5" y="4.5" width="3" height="11" rx="1"/><rect x="11.5" y="4.5" width="3" height="11" rx="1"/>', 15)
  });

  // ==========================================================================
  //  Design tokens.
  //
  //  Two themes, each designed on its own terms rather than inverted:
  //
  //  Ivory (light) — warm paper, white cards that lift off it with soft
  //  shadows, shyam-indigo ink and accents, gold kept to ornament and to the
  //  darker "text gold" that holds AA contrast on paper.
  //
  //  Midnight (dark) — a deep indigo night, cards a half-step lighter and
  //  outlined rather than shadowed, gold becomes the accent (focus, send,
  //  links of emphasis) and the headline figure turns to moonlight white.
  //
  //  Both share the indigo header band, the gold hairline and the character,
  //  so the widget is recognisably the same product in either.
  // ==========================================================================
  var TOKENS_LIGHT =
    'color-scheme:light;' +
    '--bg:#FAF7F0;--surface:#FFFFFF;--surface-2:#F5F0E6;--surface-3:#ECE5D7;' +
    '--hover:rgba(27,32,96,.05);--press:rgba(27,32,96,.09);' +
    '--ink:#161A40;--ink-2:#42476E;--ink-3:#63678A;--ink-4:#9A9CB5;' +
    '--line:#EAE3D4;--line-2:#DDD3BF;--line-3:#C8BA9B;' +
    '--accent:var(--brand-accent,#2B3A9E);--accent-2:var(--brand-accent-2,#0F7F7B);--on-accent:#FFFFFF;' +
    '--gold:#8A600D;--gold-2:#E0AE45;--gold-soft:rgba(224,174,69,.15);' +
    '--peacock:#0B7470;--peacock-2:#A8DCD6;--peacock-soft:rgba(11,116,112,.08);' +
    '--lotus:#C93A6B;' +
    '--ok:#17835A;--danger:#B4233A;--danger-soft:#FCEFF1;--warn-soft:#FBF3E1;' +
    '--figure:var(--accent);--link:var(--peacock);' +
    '--user-bg:linear-gradient(135deg,#2B3A9E,#3B4CC0);--user-ink:#FFFFFF;--user-shadow:0 8px 18px -12px rgba(43,58,158,.75);' +
    '--head-bg:linear-gradient(125deg,#1A2066 0%,#2B3A9E 58%,#127A7C 128%);--head-ink:#FFFFFF;--head-ink-2:rgba(255,255,255,.76);' +
    '--glow:radial-gradient(120% 55% at 100% 0%,rgba(224,174,69,.13),transparent 62%);' +
    '--ring:rgba(43,58,158,.18);--ring-line:var(--accent);' +
    '--send-bg:linear-gradient(135deg,var(--accent),var(--accent-2));' +
    '--chip-bg:var(--surface);--code-bg:#F6F1E7;' +
    '--shadow-sm:0 1px 2px rgba(22,26,64,.05);' +
    '--shadow-md:0 1px 2px rgba(22,26,64,.04),0 10px 24px -16px rgba(22,26,64,.28);' +
    '--shadow-lift:0 14px 28px -16px rgba(27,32,102,.38);' +
    '--shadow-panel:0 0 0 1px rgba(22,26,64,.07),0 30px 70px -20px rgba(22,26,64,.40),0 12px 26px -14px rgba(22,26,64,.20);' +
    '--shadow-badge:0 2px 4px rgba(22,26,64,.22),0 14px 30px -8px rgba(27,32,102,.55);' +
    '--head-shadow:rgba(22,26,64,.22);';

  var TOKENS_DARK =
    'color-scheme:dark;' +
    '--bg:#0D0F2E;--surface:#12153B;--surface-2:#171B48;--surface-3:#20245B;' +
    '--hover:rgba(236,238,255,.06);--press:rgba(236,238,255,.1);' +
    '--ink:#EDEFFF;--ink-2:#BFC2E8;--ink-3:#9A9DCB;--ink-4:#6A6E9E;' +
    '--line:#232862;--line-2:#2F3576;--line-3:#434A96;' +
    '--accent:var(--brand-accent-dark,#F2C14E);--accent-2:#E8A93A;--on-accent:#171A45;' +
    '--gold:#F2C14E;--gold-2:#FFD470;--gold-soft:rgba(242,193,78,.12);' +
    '--peacock:#4CD3C6;--peacock-2:#1E6E6C;--peacock-soft:rgba(76,211,198,.11);' +
    '--lotus:#FF7FAC;' +
    '--ok:#4FD69E;--danger:#FF93A6;--danger-soft:rgba(255,147,166,.10);--warn-soft:rgba(242,183,91,.10);' +
    '--figure:#FFFFFF;--link:var(--peacock);' +
    '--user-bg:linear-gradient(135deg,#2F3FAA,#3A4CC4);--user-ink:#FFFFFF;--user-shadow:0 10px 22px -14px rgba(0,0,0,.9);' +
    '--head-bg:linear-gradient(125deg,#10144A 0%,#1C2370 60%,#0E4C5A 128%);--head-ink:#FFFFFF;--head-ink-2:rgba(255,255,255,.72);' +
    '--glow:radial-gradient(110% 55% at 100% 0%,rgba(104,92,214,.16),transparent 62%);' +
    '--ring:rgba(242,193,78,.18);--ring-line:#D9AE52;' +
    '--send-bg:linear-gradient(135deg,#F7CF6A,#E3A43A);' +
    '--chip-bg:transparent;--code-bg:#161A45;' +
    '--shadow-sm:none;' +
    '--shadow-md:0 12px 26px -20px rgba(0,0,0,.8);' +
    '--shadow-lift:0 16px 30px -18px rgba(0,0,0,.9);' +
    '--shadow-panel:0 0 0 1px rgba(255,255,255,.06),0 30px 70px -20px rgba(0,0,0,.72),0 12px 26px -14px rgba(0,0,0,.5);' +
    '--shadow-badge:0 2px 4px rgba(0,0,0,.4),0 14px 30px -8px rgba(0,0,0,.6);' +
    '--head-shadow:rgba(0,0,0,.55);';

  // The indigo disc the character sits on — the same in both themes.
  var DISC = 'radial-gradient(circle at 50% 30%,#3A4BB8 0%,#1C2266 62%,#111540 100%)';

  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    'button{font:inherit;color:inherit;margin:0}',
    'button:disabled{cursor:default}',
    '[hidden]{display:none!important}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',

    '.root{' + TOKENS_LIGHT +
      '--font:"Inter var","Inter","Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--display:"Inter var","Inter","Segoe UI Variable Display","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Display","Helvetica Neue",Roboto,Arial,sans-serif;' +
      '--mono:"Cascadia Mono","SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;' +
      '--ease:cubic-bezier(.2,.8,.2,1);--spring:cubic-bezier(.34,1.56,.64,1);' +
      '--r-panel:24px;--r-card:16px;--r-ctl:12px;' +
      'position:fixed;right:22px;bottom:22px;z-index:2147483000;' +
      'font:400 var(--fs,14.5px)/1.6 var(--font);color:var(--ink);letter-spacing:-.003em;' +
      '-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;' +
      'display:flex;flex-direction:column;align-items:flex-end;gap:16px}',
    '.root[data-theme="dark"]{' + TOKENS_DARK + '}',
    '.root.left{right:auto;left:22px;align-items:flex-start}',

    // A theme switch cross-fades colours for a moment, then lets go, so
    // ordinary interactions keep their own snappier transitions.
    '.root.theming,.root.theming *,.root.theming *::before,.root.theming *::after{' +
      'transition-property:background-color,border-color,color,fill,stroke,box-shadow,opacity!important;' +
      'transition-duration:.38s!important;transition-timing-function:var(--ease)!important}',

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
    '.badge{width:64px;height:64px;border-radius:50%;padding:0;cursor:pointer;position:relative;display:block;flex:none;border:0;background:transparent;transition:transform .28s var(--spring)}',
    '.badge .aura{position:absolute;inset:-4px;border-radius:50%;background:conic-gradient(from 0deg,#F2C14E,#14A39A,#2B3A9E,#E0457B,#F2C14E);' +
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));' +
      'animation:turn 9s linear infinite;opacity:.95}',
    '.badge .glow{position:absolute;inset:-10px;border-radius:50%;background:radial-gradient(circle,rgba(242,193,78,.35),rgba(20,163,154,.12) 55%,transparent 70%);opacity:0;transition:opacity .3s;pointer-events:none}',
    '.badge:hover .glow,.badge:focus-visible .glow{opacity:1}',
    '.disc{position:absolute;inset:0;border-radius:50%;background:' + DISC + ';box-shadow:inset 0 0 0 1.5px rgba(242,193,78,.85)}',
    '.badge .disc{box-shadow:var(--shadow-badge),inset 0 0 0 1.5px rgba(242,193,78,.85)}',
    '.fig{position:absolute;inset:0}',
    '.badge .fig,.avatar .fig{animation:breathe 4.8s ease-in-out infinite}',
    '.badge:hover{transform:translateY(-3px) scale(1.03)}',
    '.badge:active{transform:scale(.96)}',
    '.badge:focus-visible{outline:2px solid var(--gold-2);outline-offset:6px}',
    '.badge .dot{position:absolute;top:0;right:0;width:14px;height:14px;border-radius:50%;background:var(--lotus);border:2px solid #FFFFFF;z-index:3;transform:scale(0);transition:transform .3s var(--spring)}',
    '.badge.unread .dot{transform:scale(1)}',
    '@keyframes turn{to{transform:rotate(360deg)}}',
    // flute notes drift up while K.R.1.S is working on an answer
    '.notes{position:absolute;left:50%;top:-4px;width:0;height:0;pointer-events:none;z-index:4}',
    '.notes i{position:absolute;left:0;top:0;color:#FFD470;opacity:0;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}',
    '.notes i svg{display:block}',
    '.root.busy .notes i{animation:note 2.4s ease-out infinite}',
    '.root.busy .notes i:nth-child(2){animation-delay:.8s;color:#5FE0D3}',
    '.root.busy .notes i:nth-child(3){animation-delay:1.6s;color:#FF9EC4}',
    '@keyframes note{0%{opacity:0;transform:translate(6px,6px) scale(.6) rotate(-10deg)}20%{opacity:1}100%{opacity:0;transform:translate(20px,-30px) scale(1) rotate(12deg)}}',

    // --- first-visit speech bubble --------------------------------------------
    '.nudge{position:relative;max-width:252px;padding:11px 34px 11px 14px;border-radius:16px 16px 6px 16px;color:var(--ink);font-size:13.5px;line-height:1.45;' +
      'box-shadow:var(--shadow-panel);cursor:pointer;animation:nudgeIn .45s var(--spring) both;border:1px solid transparent;' +
      'background:linear-gradient(var(--surface),var(--surface)) padding-box,linear-gradient(120deg,var(--gold-2),var(--peacock),var(--accent)) border-box}',
    '.nudge b{font-weight:650;color:var(--accent)}',
    '.root.left .nudge{border-radius:16px 16px 16px 6px}',
    '.nudge .x{position:absolute;top:6px;right:6px;width:24px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center}',
    '.nudge .x:hover{background:var(--hover);color:var(--ink)}',
    '.nudge .x svg{width:14px;height:14px}',
    '.root.open .nudge,.nudge.gone{display:none}',
    '@keyframes nudgeIn{from{opacity:0;transform:translateY(8px) scale(.94)}to{opacity:1;transform:none}}',

    // --- panel ----------------------------------------------------------------
    '.panel{width:416px;max-width:calc(100vw - 44px);height:min(720px,calc(100vh - 124px));height:min(720px,calc(100dvh - 124px));' +
      'background:var(--bg);border-radius:var(--r-panel);box-shadow:var(--shadow-panel);' +
      'display:none;flex-direction:column;overflow:hidden;transform-origin:bottom right;position:relative;container:kris/inline-size}',
    '.root.left .panel{transform-origin:bottom left}',
    '.root.open .panel{display:flex;animation:panelIn .32s var(--spring)}',
    '.root.closing .panel{display:flex;animation:panelOut .16s ease-in forwards}',
    '.root.restored .panel{animation:none}',
    '@keyframes panelIn{from{opacity:0;transform:translateY(14px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes panelOut{to{opacity:0;transform:translateY(10px) scale(.97)}}',
    '.root.wide .panel{width:min(760px,calc(100vw - 44px));height:calc(100vh - 124px);height:calc(100dvh - 124px)}',

    // header: the indigo band with a gold hairline and a faint feather eye
    '.head{position:relative;z-index:2;display:flex;align-items:center;gap:11px;padding:11px 10px 11px 16px;flex:none;overflow:hidden;color:var(--head-ink);background:var(--head-bg);transition:box-shadow .2s}',
    '.head::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:linear-gradient(90deg,var(--gold-2),#14A39A,#E0457B,var(--gold-2));opacity:.9}',
    '.panel.scrolled .head{box-shadow:0 10px 20px -14px var(--head-shadow)}',
    '.head .eye{position:absolute;right:-18px;top:-34px;width:120px;height:180px;color:#F2C14E;opacity:.13;transform:rotate(28deg);pointer-events:none}',
    '.head .eye svg{width:100%;height:100%;display:block}',
    '.avatar{position:relative;width:40px;height:40px;flex:none}',
    '.avatar .disc{box-shadow:inset 0 0 0 1.5px rgba(242,193,78,.8),0 4px 12px -4px rgba(0,0,0,.4)}',
    '.avatar .presence{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;background:#9A9DC0;border:2px solid #1C2266;transition:background .3s;z-index:2}',
    '.root[data-conn="online"] .presence{background:#4AD39A}',
    '.root[data-conn="waking"] .presence,.root[data-conn="connecting"] .presence{background:#F2C14E}',
    '.root[data-conn="offline"] .presence{background:#FF8FA3}',
    '.titles{position:relative;min-width:0;flex:1;line-height:1.25}',
    '.titles h2{margin:0;font:700 16px/1.2 var(--display);letter-spacing:.14em;color:var(--head-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.titles h2 .sub{font:500 10.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:#F2C14E;margin-left:8px;vertical-align:2px}',
    '.titles .status{margin:3px 0 0;font-size:12.5px;color:var(--head-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.titles .status button{border:0;background:none;padding:0;color:#FFFFFF;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-size:inherit}',
    '.tools{position:relative;display:flex;align-items:center;gap:2px;flex:none}',
    '.tool{position:relative;width:34px;height:34px;border:0;border-radius:11px;background:transparent;color:var(--head-ink-2);cursor:pointer;display:grid;place-items:center;flex:none;transition:background .15s,color .15s}',
    '.tool:hover{background:rgba(255,255,255,.12);color:#FFFFFF}',
    '.tool:active{background:rgba(255,255,255,.2)}',
    '.tool:focus-visible{outline:2px solid #F2C14E;outline-offset:-2px}',
    // theme switch: sun and moon trade places with a quarter turn
    '.tool.theme svg{position:absolute;transition:transform .45s var(--spring),opacity .25s}',
    '.tool.theme .moon{opacity:1;transform:none}',
    '.tool.theme .sun{opacity:0;transform:rotate(-90deg) scale(.5)}',
    '.root[data-theme="dark"] .tool.theme .moon{opacity:0;transform:rotate(90deg) scale(.5)}',
    '.root[data-theme="dark"] .tool.theme .sun{opacity:1;transform:none}',

    // --- conversation -----------------------------------------------------------
    '.body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;background:var(--glow),var(--bg)}',
    '.log{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:18px 18px 14px;display:flex;flex-direction:column;gap:20px;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
    '.log::-webkit-scrollbar{width:10px}',
    '.log::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:10px;border:3px solid var(--bg)}',

    // welcome
    '.welcome{margin:auto 0;padding:4px 2px;text-align:center;animation:fadeUp .4s var(--ease) both}',
    '.hero{position:relative;width:92px;height:92px;margin:4px auto 16px}',
    '.hero .ring{position:absolute;inset:-5px;border-radius:50%;background:conic-gradient(from 200deg,#F2C14E,#14A39A,#2B3A9E,#E0457B,#F2C14E);' +
      '-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2.5px),#000 calc(100% - 2px))}',
    '.hero .disc{box-shadow:0 16px 32px -14px rgba(28,34,102,.6),inset 0 0 0 1.5px rgba(242,193,78,.8)}',
    '.kicker{display:inline-flex;align-items:center;gap:8px;margin:0 0 8px;font:600 10.5px/1 var(--mono);letter-spacing:.22em;text-transform:uppercase;color:var(--gold)}',
    '.kicker::before,.kicker::after{content:"";width:18px;height:1px;background:linear-gradient(90deg,transparent,var(--gold))}',
    '.kicker::after{transform:scaleX(-1)}',
    '.welcome h3{margin:0 0 8px;font:650 23px/1.2 var(--display);letter-spacing:-.022em;color:var(--ink)}',
    '.welcome .intro{margin:0 auto;color:var(--ink-2);font-size:14.5px;line-height:1.55;max-width:31em}',
    '.ctxline{margin-top:12px;display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--peacock);background:var(--peacock-soft);padding:4px 11px 4px 9px;border-radius:14px;max-width:100%;text-align:left;line-height:1.4}',
    '.ctxline svg{flex:none}',
    '.welcome .ctxline{white-space:normal;overflow:visible}',
    '.prompts{list-style:none;margin:20px 0 0;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;text-align:left}',
    '.prompts li{display:flex}',
    '.prompts button{position:relative;width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:9px;padding:12px;border:1px solid var(--line);background:var(--surface);cursor:pointer;text-align:left;color:var(--ink);font-size:13.5px;line-height:1.38;border-radius:var(--r-card);' +
      'box-shadow:var(--shadow-sm);transition:border-color .18s,transform .22s var(--spring),box-shadow .18s,background .18s}',
    '.prompts button:hover{border-color:var(--gold-2);transform:translateY(-2px);box-shadow:var(--shadow-lift)}',
    '.prompts button:active{transform:translateY(0)}',
    '.prompts button:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.prompts .tag{display:inline-flex;align-items:center;gap:7px;font:600 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold)}',
    '.prompts .ic{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:var(--gold-soft);color:var(--accent)}',
    '.prompts .q{min-width:0;font-weight:500}',
    '.prompts .go{position:absolute;right:10px;top:12px;color:var(--gold);opacity:0;transform:translateX(-4px);transition:opacity .15s,transform .2s var(--ease)}',
    '.prompts button:hover .go,.prompts button:focus-visible .go{opacity:1;transform:none}',
    '.trust{margin:18px auto 0;font-size:12px;color:var(--ink-3);display:flex;gap:8px;align-items:center;justify-content:center;line-height:1.45;max-width:30em;text-align:left}',
    '.trust .lotus{flex:none;color:var(--lotus);display:grid;place-items:center}',

    // turns
    '.turn{display:flex;flex-direction:column;min-width:0}',
    '.turn.anim{animation:fadeUp .24s var(--ease) both}',
    '@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@keyframes fadeIn{from{opacity:0}to{opacity:1}}',
    '.turn.user{align-items:flex-end}',
    '.bubble{max-width:86%;padding:9px 15px;border-radius:19px 19px 6px 19px;background:var(--user-bg);color:var(--user-ink);white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;box-shadow:var(--user-shadow)}',
    '.turn.assistant{position:relative}',

    // rich text
    '.msg{min-width:0;overflow-wrap:anywhere;color:var(--ink)}',
    '.msg > :first-child{margin-top:0}',
    '.msg p{margin:0}',
    '.msg p + p,.msg p + ul,.msg p + ol,.msg ul + p,.msg ol + p,.msg pre + p,.msg p + pre,.msg .tablewrap + p,.msg p + .tablewrap,.msg blockquote + p,.msg p + blockquote{margin-top:10px}',
    '.msg h4{margin:18px 0 6px;font:650 calc(var(--fs,14.5px) + 1px)/1.35 var(--display);letter-spacing:-.012em;color:var(--ink)}',
    '.msg h4:first-child{margin-top:0}',
    '.msg strong{font-weight:650;color:var(--ink)}',
    '.msg em{font-style:italic}',
    '.msg a{color:var(--link);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}',
    '.msg a:hover{text-decoration-thickness:2px}',
    '.msg ul,.msg ol{margin:6px 0 0;padding-left:20px}',
    '.msg li{margin:3px 0;padding-left:2px}',
    '.msg li::marker{color:var(--gold)}',
    '.msg ul ul,.msg ol ul{margin-top:2px}',
    '.msg blockquote{margin:8px 0 0;padding:2px 0 2px 12px;border-left:2px solid var(--gold-2);color:var(--ink-2)}',
    '.msg hr{border:0;border-top:1px solid var(--line);margin:14px 0}',
    '.msg code{font:500 .86em/1.4 var(--mono);background:var(--code-bg);border:1px solid var(--line);padding:1px 5px;border-radius:6px}',
    '.codeblock{margin:10px 0 0;border:1px solid var(--line);border-radius:var(--r-ctl);overflow:hidden;background:var(--code-bg)}',
    '.codeblock .bar{display:flex;align-items:center;justify-content:space-between;padding:4px 6px 4px 12px;border-bottom:1px solid var(--line);font:500 11px/1 var(--mono);color:var(--ink-3);text-transform:lowercase}',
    '.codeblock .bar button{border:0;background:transparent;color:var(--ink-3);cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:5px 7px;border-radius:7px;font:500 11px/1 var(--font)}',
    '.codeblock .bar button:hover{background:var(--hover);color:var(--ink)}',
    '.codeblock pre{margin:0;padding:11px 13px;overflow-x:auto;font:400 12.5px/1.6 var(--mono);white-space:pre;tab-size:2;color:var(--ink)}',
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

    // actions under an answer
    '.meta{display:flex;align-items:center;gap:2px;margin:4px 0 0 -6px;min-height:30px}',
    '.act{width:30px;height:30px;border:0;border-radius:9px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s}',
    '.act:hover{background:var(--hover);color:var(--ink)}',
    '.act:active{background:var(--press)}',
    '.act:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px}',
    '.act.on{color:var(--ink)}',
    '.act.on.up{color:var(--ok)}',
    '.act.on.down{color:var(--danger)}',
    '.meta .time{margin-left:6px;font:400 11.5px/1 var(--mono);color:var(--ink-3);letter-spacing:.01em;white-space:nowrap}',
    '.turn.assistant .meta{opacity:0;transition:opacity .15s}',
    '.turn.assistant:hover .meta,.turn.assistant:focus-within .meta,.turn.assistant.last .meta{opacity:1}',
    '@media (hover:none){.turn.assistant .meta{opacity:1}}',

    // chips
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}',
    '.chip{border:1px solid var(--line-2);background:var(--chip-bg);color:var(--ink-2);border-radius:999px;padding:5px 13px;font-size:13px;line-height:1.35;cursor:pointer;text-align:left;' +
      'transition:border-color .15s,background .15s,color .15s,transform .2s var(--spring)}',
    '.chip:hover:not(:disabled){border-color:var(--gold-2);background:var(--gold-soft);color:var(--ink);transform:translateY(-1px)}',
    '.chip:focus-visible{outline:2px solid var(--peacock);outline-offset:1px}',
    '.chip:disabled{opacity:.45}',
    '.choices .chip{border-color:var(--peacock-2);color:var(--ink);background:var(--peacock-soft)}',
    '.choices .chip:hover:not(:disabled){background:var(--peacock-soft);border-color:var(--peacock)}',
    '.chip.picked{border-color:var(--peacock);color:var(--ink);opacity:1}',

    // data readout
    '.card{position:relative;border:1px solid var(--line);border-radius:var(--r-card);padding:16px 16px 12px;background:var(--surface);margin-top:2px;overflow:hidden;box-shadow:var(--shadow-md)}',
    '.card::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;background:linear-gradient(90deg,var(--accent),#14A39A,var(--gold-2))}',
    '.root[data-theme="dark"] .card::before{background:linear-gradient(90deg,#F2C14E,#14A39A,#F2C14E)}',
    '.eyebrow{font:600 10.5px/1.3 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold);margin:0 0 6px}',
    '.figure{font:700 34px/1.1 var(--display);letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:var(--figure);margin:0 0 4px;word-break:break-word}',
    '.figure .unit{font:500 15px/1 var(--font);letter-spacing:0;color:var(--ink-3);margin-left:6px}',
    '.subject{color:var(--ink-2);font-size:13.5px;line-height:1.45;margin:0}',
    '.ctxline{color:var(--ink-3);font-size:12px;line-height:1.4;margin:0 0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.card .subject + .subject{margin-top:4px}',
    '.sources{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:12px;padding-top:10px;border-top:1px dashed var(--line-2);font:400 11.5px/1.5 var(--mono);color:var(--ink-3)}',
    '.sources span{overflow-wrap:anywhere}',
    '.sources b{font-weight:500;color:var(--ink)}',
    '.note{margin-top:10px;padding:8px 11px;border-radius:10px;background:var(--warn-soft);color:var(--ink-2);font-size:13px;line-height:1.5}',
    '.note.hard{background:var(--danger-soft)}',
    'details.working{margin-top:10px;font-size:12.5px;color:var(--ink-3)}',
    'details.working summary{cursor:pointer;list-style:none;display:inline-flex;align-items:center;gap:6px;border-radius:6px}',
    'details.working summary::-webkit-details-marker{display:none}',
    'details.working summary:hover{color:var(--ink-2)}',
    'details.working summary:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    'details.working summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .15s}',
    'details.working[open] summary::before{transform:rotate(45deg)}',
    'details.working pre{margin:8px 0 0;padding:10px 12px;background:var(--code-bg);color:var(--ink-2);border:1px solid var(--line);border-radius:10px;overflow-x:auto;font:400 11.5px/1.55 var(--mono);white-space:pre-wrap}',

    // tables
    '.tablewrap{margin-top:10px;overflow-x:auto;border:1px solid var(--line);border-radius:var(--r-ctl);background:var(--surface)}',
    '.card .tablewrap{border-radius:10px}',
    'table.grid{border-collapse:collapse;width:100%;font-size:13px}',
    'table.grid th,table.grid td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:normal;word-break:normal}',
    'table.grid td:first-child{font-weight:550;color:var(--ink)}',
    'table.grid tr:last-child td,table.grid tr:last-child th{border-bottom:0}',
    'table.grid th{font:600 10.5px/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);background:var(--surface-2);white-space:nowrap}',
    'table.grid .num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}',
    'table.grid td.num{font-weight:500}',
    'table.grid td.none{color:var(--ink-3);font-style:italic}',
    'table.grid tbody tr:hover td{background:var(--hover)}',

    // charts
    '.chart-title{margin:12px 0 0;font-size:12.5px;font-weight:550;color:var(--ink-2)}',
    '.bars{margin-top:8px;width:100%;display:block}',
    '.bars rect.track{fill:var(--surface-3)}',
    '.bars rect.bar{fill:var(--peacock)}',
    '.bars text{font:400 11px var(--font);fill:var(--ink-2)}',
    '.bars text.val{font:500 11.5px var(--font);fill:var(--ink);font-variant-numeric:tabular-nums}',
    '.spark{margin-top:12px;width:100%;height:96px;display:block;overflow:visible}',
    '.spark path.line{fill:none;stroke:var(--peacock);stroke-width:1.8;vector-effect:non-scaling-stroke;stroke-linejoin:round}',
    '.spark path.fill{fill:var(--peacock-soft)}',
    '.spark line.axis{stroke:var(--line-2);stroke-width:1;vector-effect:non-scaling-stroke}',
    '.range{display:flex;justify-content:space-between;gap:12px;margin-top:6px;font:400 11px/1.4 var(--mono);color:var(--ink-3)}',
    '.range span{white-space:nowrap}',
    '.lohi{margin:6px 0 0;font:400 11.5px/1.4 var(--mono);color:var(--ink-2)}',
    '.lohi b{font-weight:500;color:var(--ink)}',
    '.card .lohi + .subject{margin-top:10px}',

    // notices
    '.notice{display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:14px;background:var(--danger-soft);color:var(--ink);border:1px solid transparent}',
    '.root[data-theme="dark"] .notice{border-color:rgba(255,147,166,.18)}',
    '.notice .ic{color:var(--danger);flex:none;margin-top:2px}',
    '.notice .txt{flex:1;min-width:0;font-size:14px}',
    '.notice .sub{margin-top:3px;font:400 11px/1.4 var(--mono);color:var(--ink-3);word-break:break-word}',
    '.notice .retry{margin-top:9px;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-2);background:var(--surface);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:13px;font-weight:550;transition:border-color .15s}',
    '.notice .retry:hover{border-color:var(--gold-2)}',
    '.notice .retry:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.stopped{margin-top:6px;font-size:12px;color:var(--ink-3)}',

    // jump to latest
    '.jump{position:absolute;left:50%;bottom:12px;transform:translate(-50%,8px);opacity:0;pointer-events:none;display:inline-flex;align-items:center;gap:6px;' +
      'border:1px solid var(--line-2);background:var(--surface);color:var(--ink-2);border-radius:999px;padding:6px 12px 6px 10px;font-size:12.5px;font-weight:550;cursor:pointer;' +
      'box-shadow:var(--shadow-lift);transition:opacity .18s,transform .18s var(--ease)}',
    '.jump.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}',
    '.jump:hover{color:var(--ink);border-color:var(--gold-2)}',
    '.jump:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',

    // --- composer -------------------------------------------------------------
    '.composer{flex:none;padding:4px 14px 14px;background:var(--bg)}',
    '.box{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;border:1px solid var(--line-2);border-radius:18px;background:var(--surface);' +
      'box-shadow:var(--shadow-md);transition:border-color .15s,box-shadow .15s;cursor:text}',
    '.box:hover{border-color:var(--line-3)}',
    '.box.focus{border-color:var(--ring-line);box-shadow:0 0 0 3px var(--ring)}',
    '.box textarea{grid-column:1;display:block;width:100%;border:0;outline:0;resize:none;background:transparent;color:var(--ink);' +
      'font:400 calc(var(--fs,14.5px) + .5px)/1.5 var(--font);letter-spacing:-.003em;padding:13px 6px 13px 16px;height:48px;min-height:48px;max-height:180px;overflow-y:hidden;scrollbar-width:thin}',
    '.box textarea::placeholder{color:var(--ink-3);opacity:1}',
    '.send{grid-column:2;margin:6px 6px 6px 0;width:36px;height:36px;border-radius:50%;border:0;background:var(--send-bg);color:var(--on-accent);cursor:pointer;display:grid;place-items:center;flex:none;' +
      'box-shadow:0 6px 14px -7px rgba(27,32,102,.8),inset 0 0 0 1px rgba(255,255,255,.18);transition:filter .15s,transform .2s var(--spring),background .15s}',
    '.send:hover:not(:disabled){filter:brightness(1.08)}',
    '.send:active:not(:disabled){transform:scale(.92)}',
    '.send:disabled{background:var(--surface-3);color:var(--ink-4);box-shadow:none}',
    '.send:focus-visible{outline:2px solid var(--gold);outline-offset:2px}',
    '.foot{grid-column:1 / -1;display:none;align-items:center;gap:8px;padding:0 10px 8px 12px;min-height:30px;position:relative}',
    '.foot.on{display:flex}',
    '.ctx{display:none;align-items:center;gap:5px;max-width:60%;min-width:0;height:22px;padding:0 8px 0 6px;border:0;border-radius:999px;background:var(--peacock-soft);color:var(--peacock);font-size:11.5px;line-height:1;cursor:pointer}',
    '.ctx svg{width:13px;height:13px;flex:none}',
    '.ctx.on{display:inline-flex}',
    '.ctx.unset{background:transparent;color:var(--ink-3);box-shadow:inset 0 0 0 1px var(--line-2)}',
    '.ctx:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--peacock)}',
    '.ctx:disabled{cursor:default}',
    '.ctx:focus-visible,.ctx-clear:focus-visible,.ctxmenu button:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.ctx span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ctx-clear{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:-4px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--ink-3);cursor:pointer}',
    '.ctx-clear[hidden]{display:none}',
    '.ctx-clear:hover{color:var(--ink);background:var(--peacock-soft)}',
    '.ctx-clear svg{width:13px;height:13px}',
    '.ctxmenu{position:absolute;left:8px;bottom:calc(100% + 6px);z-index:6;min-width:220px;max-width:calc(100% - 16px);max-height:260px;overflow:auto;padding:6px;border:1px solid var(--line);border-radius:var(--r-ctl);background:var(--surface);box-shadow:var(--shadow-md)}',
    '.ctxmenu[hidden]{display:none}',
    '.ctxmenu-h{padding:6px 10px 4px;font-size:11.5px;color:var(--ink-3)}',
    '.ctxmenu-note{padding:6px 10px 8px;font-size:12.5px;line-height:1.4;color:var(--ink-3)}',
    '.ctxmenu button{display:flex;align-items:center;gap:8px;width:100%;min-height:36px;padding:7px 10px;border:0;border-radius:8px;background:transparent;text-align:left;font-size:13.5px;cursor:pointer}',
    '.ctxmenu button span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ctxmenu button:hover{background:var(--peacock-soft)}',
    '.ctxmenu button[aria-checked="true"]{color:var(--peacock);font-weight:600}',
    '.ctxmenu button.clear{color:var(--ink-3);border-top:1px solid var(--line);border-radius:0 0 8px 8px;margin-top:4px}',
    '.ctxmenu .tick{display:inline-flex;color:var(--peacock)}',
    '.foot .spacer{flex:1}',
    '.count{font:400 11px/1 var(--mono);color:var(--ink-3)}',
    '.count.over{color:var(--danger)}',
    '.hint{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:1;color:var(--ink-3);opacity:0;transition:opacity .15s}',
    '.box.focus .hint{opacity:1}',
    '.hint kbd{display:inline-block;font:500 10px/1 var(--mono);color:var(--ink-2);padding:2px 4px;border:1px solid var(--line-2);border-radius:4px;background:var(--bg)}',
    '@media (hover:none){.hint{display:none}}',

    // --- layouts ----------------------------------------------------------------
    // inline: fill the host's slot
    '.root.inline{position:static;width:100%;height:100%;display:block;z-index:auto}',
    '.root.inline .panel{display:flex;width:100%;max-width:none;height:100%;border-radius:0;box-shadow:none;animation:none}',
    '.root.inline .badge,.root.inline .nudge,.root.inline .tool.close,.root.inline .tool.expand{display:none}',

    // the panel adapts to its own width (floating, expanded, or inline slot)
    '@container kris (max-width:360px){' +
      '.prompts{grid-template-columns:1fr}' +
      '.welcome h3{font-size:21px}' +
      '.log{padding:16px 14px 10px}' +
      '.hint{display:none}' +
    '}',
    '@container kris (min-width:600px){' +
      '.log{padding:26px max(24px,calc((100% - 640px) / 2)) 16px}' +
      '.composer{padding:8px max(14px,calc((100% - 668px) / 2)) 14px}' +
      '.prompts{grid-template-columns:repeat(4,1fr)}' +
    '}',

    // short screens (a laptop with the browser's toolbars open)
    '@media (max-height:640px) and (min-width:521px){' +
      '.panel,.root.wide .panel{height:calc(100vh - 104px);height:calc(100dvh - 104px)}' +
      '.hero{width:72px;height:72px;margin-bottom:12px}' +
    '}',

    // phones: the panel becomes a full-height sheet
    '@media (max-width:520px){' +
      '.root:not(.inline){right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px))}' +
      '.root.left:not(.inline){left:16px}' +
      '.root:not(.inline) .panel,.root.wide:not(.inline) .panel{position:fixed;inset:0;width:auto;max-width:none;height:100%;border-radius:0}' +
      '.root.open:not(.inline) .badge,.root.closing:not(.inline) .badge{display:none}' +
      '.head{padding-top:calc(11px + env(safe-area-inset-top,0px))}' +
      '.tool.expand{display:none}' +
      '.hero{width:80px;height:80px}' +
      '.prompts button{padding:10px 11px}' +
      '.composer{padding:8px 10px calc(10px + env(safe-area-inset-bottom,0px))}' +
      '.box textarea{font-size:16px}' +
      '.hint{display:none}' +
      '.figure{font-size:30px}' +
    '}',

    // Windows high-contrast: keep every control outlined
    '@media (forced-colors:active){' +
      '.box,.chip,.prompts button,.card,.send,.act,.tool,.notice .retry,.jump{border:1px solid CanvasText}' +
      '.send:disabled{color:GrayText}' +
    '}',

    '@media (prefers-reduced-motion:reduce){' +
      '.root.open .panel,.root.closing .panel,.turn.anim,.welcome,.nudge{animation:none!important}' +
      '.badge .aura,.hero .ring,.badge .fig,.avatar .fig,.k-plume,.thinking .dots i,.thinking .label,.caret,.root.busy .notes i{animation:none!important}' +
      '.root.busy .notes i{opacity:0}' +
      '.thinking .label{color:var(--ink-3);background:none}' +
      '.idle-drift .k-iris,.idle-drift .k-pupil,.idle-drift .k-glint,.mood-pop,.blinking .k-eye,.laugh-shake .k-char,.sad-sink .k-char{animation:none!important}' +
      '.badge,.badge:hover,.prompts button,.prompts button:hover,.chip,.chip:hover,.tool.theme svg{transition:none!important;transform:none}' +
      '.root[data-theme="dark"] .tool.theme .moon,.tool.theme .sun{transform:none}' +
    '}'
  ].join('');

  // ==========================================================================
  //  Navigation, settings, memory and state styles.
  //
  //  Everything below reuses the same tokens, radii and type ramp as the chat,
  //  so Profile or Appearance reads as another room of the same house, not a
  //  settings app bolted on: gold mono eyebrows, ivory/midnight ground, white
  //  (or half-step lighter) cards, indigo/gold accents, peacock for focus.
  // ==========================================================================
  CSS += [
    '.root{--fs:14.5px;--scrim:rgba(22,26,64,.26);--toast-bg:#161A40;--toast-ink:#FFFFFF;--toast-act:#F2C14E}',
    '.root[data-theme="dark"]{--scrim:rgba(4,5,22,.58);--toast-bg:#EDEFFF;--toast-ink:#12153B;--toast-act:#2B3A9E}',
    '.root[data-size="s"]{--fs:13.5px}',
    '.root[data-size="l"]{--fs:16px}',

    // --- header: the menu button sits before the portrait ----------------------
    '.head{padding-left:8px}',
    '.head .tool.menu{margin-right:-4px}',
    '.tool.menu[aria-expanded="true"]{background:rgba(255,255,255,.16);color:#FFFFFF}',

    // --- stage: everything under the header ------------------------------------
    '.stage{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}',
    '.panel.in-view .body,.panel.in-view .composer{visibility:hidden}',

    // --- drawer ------------------------------------------------------------------
    '.scrim{position:absolute;inset:0;z-index:8;background:var(--scrim);opacity:0;pointer-events:none;transition:opacity .22s var(--ease)}',
    '.drawer{position:absolute;top:0;bottom:0;left:0;z-index:9;width:min(300px,86%);display:flex;flex-direction:column;background:var(--surface);border-right:1px solid var(--line);' +
      'box-shadow:24px 0 48px -28px rgba(22,26,64,.45);transform:translateX(-102%);visibility:hidden;transition:transform .24s var(--ease),visibility 0s linear .24s}',
    '.root[data-theme="dark"] .drawer{background:#10133A;box-shadow:24px 0 48px -24px rgba(0,0,0,.75)}',
    '.panel.drawer-open .drawer{transform:none;visibility:visible;transition:transform .28s var(--ease),visibility 0s}',
    '.panel.drawer-open .scrim{opacity:1;pointer-events:auto}',
    '.dscroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:12px 10px 10px;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
    '.dnew{width:100%;display:flex;align-items:center;gap:10px;height:42px;padding:0 10px;border:1px solid var(--line-2);border-radius:12px;background:var(--bg);color:var(--ink);cursor:pointer;font-size:13.5px;font-weight:600;transition:border-color .15s,box-shadow .18s}',
    '.dnew:hover{border-color:var(--gold-2);box-shadow:var(--shadow-lift)}',
    '.dnew .ic{width:24px;height:24px;border-radius:8px;display:grid;place-items:center;background:var(--send-bg);color:var(--on-accent)}',
    '.dnav{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:1px}',
    '.ditem{width:100%;display:flex;align-items:center;gap:11px;height:38px;padding:0 10px;border:0;border-radius:10px;background:transparent;color:var(--ink-2);cursor:pointer;font-size:13.5px;font-weight:550;text-align:left;transition:background .15s,color .15s}',
    '.ditem:hover{background:var(--hover);color:var(--ink)}',
    '.ditem svg{flex:none;color:var(--ink-3);transition:color .15s}',
    '.ditem[aria-current="page"]{background:var(--gold-soft);color:var(--ink)}',
    '.ditem[aria-current="page"] svg{color:var(--gold)}',
    '.ditem .lbl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.pill{flex:none;font:600 9.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:4px 7px;border-radius:999px;background:var(--peacock-soft);color:var(--peacock)}',
    '.pill.off{background:var(--surface-3);color:var(--ink-3)}',
    '.pill.gold{background:var(--gold-soft);color:var(--gold)}',
    '.dlabel{margin:14px 10px 4px;font:600 10px/1.3 var(--mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ink-3)}',
    '.drecent{list-style:none;margin:0;padding:0}',
    '.drecent button{width:100%;display:flex;align-items:baseline;gap:8px;padding:7px 10px;border:0;border-radius:9px;background:transparent;color:var(--ink-2);cursor:pointer;text-align:left;font-size:13px;line-height:1.35}',
    '.drecent button:hover{background:var(--hover);color:var(--ink)}',
    '.drecent button[aria-current="true"]{color:var(--ink);background:var(--surface-2)}',
    '.drecent .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.drecent .w{flex:none;font:400 10.5px/1 var(--mono);color:var(--ink-3)}',
    '.dempty{margin:2px 10px;font-size:12.5px;line-height:1.45;color:var(--ink-3)}',
    '.dsep{height:1px;margin:12px 6px 10px;background:var(--line)}',
    '.dfoot{flex:none;padding:8px 10px 10px;border-top:1px solid var(--line)}',
    '.duser{width:100%;display:flex;align-items:center;gap:10px;padding:8px;border:0;border-radius:12px;background:transparent;cursor:pointer;text-align:left;color:var(--ink);transition:background .15s}',
    '.duser:hover{background:var(--hover)}',
    '.duser .txt,.pcard .txt{flex:1;min-width:0}',
    '.duser .nm,.duser .sb{display:block}',
    '.duser .nm{font-size:13.5px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.duser .sb{font-size:12px;line-height:1.35;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.uavatar{flex:none;width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:linear-gradient(135deg,#0F8F8A,#2B3A9E);color:#FFFFFF;font:700 12.5px/1 var(--display);letter-spacing:.03em;box-shadow:inset 0 0 0 1.5px rgba(242,193,78,.75)}',
    '.uavatar svg{width:17px;height:17px}',
    '.ditem:focus-visible,.drecent button:focus-visible,.dnew:focus-visible,.duser:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px}',

    // --- views (History, Profile, Memory, Appearance, Settings, About) -----------
    '.views{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;background:var(--glow),var(--bg)}',
    '.panel.in-view .views{display:flex;animation:viewIn .22s var(--ease)}',
    '@keyframes viewIn{from{opacity:0;transform:translateX(12px)}to{opacity:1;transform:none}}',
    '.vpane{display:none;flex:1;min-height:0;flex-direction:column}',
    '.vpane.on{display:flex}',
    '.vhead{display:flex;align-items:center;gap:4px;padding:10px 14px 10px 8px;flex:none;border-bottom:1px solid var(--line)}',
    '.vback{display:inline-flex;align-items:center;gap:2px;height:32px;padding:0 10px 0 4px;border:0;border-radius:10px;background:transparent;color:var(--ink-2);cursor:pointer;font-size:13px;font-weight:550;transition:background .15s,color .15s}',
    '.vback:hover{background:var(--hover);color:var(--ink)}',
    '.vback:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px}',
    '.vhead h3{margin:0 0 0 4px;flex:1;min-width:0;font:650 16px/1.2 var(--display);letter-spacing:-.01em;color:var(--ink);outline:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.vbody{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:16px 16px 26px;scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
    '.vbody::-webkit-scrollbar{width:10px}',
    '.vbody::-webkit-scrollbar-thumb{background:var(--line-2);border-radius:10px;border:3px solid var(--bg)}',
    '.sec{margin:0 0 22px}',
    '.sec:last-child{margin-bottom:0}',
    '.sec > h4{margin:0 2px 8px;display:flex;align-items:center;gap:8px;font:600 10.5px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}',
    '.sec > h4 .count{margin-left:auto;font:500 11px/1 var(--mono);letter-spacing:.02em;text-transform:none;color:var(--ink-3)}',
    '.sec > .lead{margin:-2px 2px 10px;font-size:12.5px;line-height:1.5;color:var(--ink-3)}',
    '.sec > .foot-note{margin:8px 2px 0;font-size:12px;line-height:1.5;color:var(--ink-3)}',
    '.group{background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);box-shadow:var(--shadow-sm);overflow:hidden}',
    '.row{display:flex;align-items:center;gap:12px;padding:12px 14px;min-height:54px}',
    '.row + .row,.field + .field,.row + .field,.field + .row{border-top:1px solid var(--line)}',
    '.row .rt{flex:1;min-width:0}',
    '.row .rl{font-size:13.5px;font-weight:550;line-height:1.35;color:var(--ink)}',
    '.row .rd{margin-top:2px;font-size:12.5px;line-height:1.45;color:var(--ink-3)}',
    '.row.stack{flex-direction:column;align-items:stretch;gap:9px}',
    '.row.disabled .rl,.row.disabled .rd{opacity:.55}',

    // switch
    '.switch{position:relative;flex:none;width:40px;height:24px;margin:0;padding:0;border:0;border-radius:999px;cursor:pointer;background:var(--surface-3);box-shadow:inset 0 0 0 1px var(--line-2);transition:background .2s var(--ease),box-shadow .2s}',
    '.switch::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#FFFFFF;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .22s var(--spring)}',
    '.switch[aria-checked="true"]{background:var(--accent);box-shadow:none}',
    '.switch[aria-checked="true"]::after{transform:translateX(16px)}',
    '.root[data-theme="dark"] .switch[aria-checked="true"]::after{background:#171A45}',
    '.switch:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.switch:disabled{opacity:.45;cursor:default}',

    // segmented control
    '.seg{display:inline-flex;flex:none;padding:3px;gap:2px;border-radius:11px;background:var(--surface-2);border:1px solid var(--line)}',
    '.seg.full{display:flex}',
    '.seg.full button{flex:1}',
    '.seg button{border:0;background:transparent;color:var(--ink-2);height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:550;white-space:nowrap;transition:background .15s,color .15s,box-shadow .15s}',
    '.seg button:hover{color:var(--ink)}',
    '.seg button[aria-checked="true"]{background:var(--surface);color:var(--ink);box-shadow:0 1px 2px rgba(22,26,64,.12),0 0 0 1px var(--line-2)}',
    '.root[data-theme="dark"] .seg button[aria-checked="true"]{background:var(--surface-3);box-shadow:none}',
    '.seg button:focus-visible{outline:2px solid var(--peacock);outline-offset:-1px}',

    // fields
    '.field{padding:12px 14px}',
    '.flabel{display:flex;align-items:center;gap:8px;margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink-2)}',
    '.flabel label{cursor:pointer}',
    '.src{flex:none;font:500 10.5px/1 var(--font);padding:3px 7px;border-radius:999px;background:var(--peacock-soft);color:var(--peacock);white-space:nowrap}',
    '.src.app{background:var(--gold-soft);color:var(--gold)}',
    '.saved{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:550;color:var(--ok);opacity:0;transition:opacity .2s}',
    '.saved.on{opacity:1}',
    '.input,.textarea{display:block;width:100%;margin:0;border:1px solid var(--line-2);border-radius:10px;background:var(--bg);color:var(--ink);font:400 14px/1.4 var(--font);padding:9px 11px;outline:0;transition:border-color .15s,box-shadow .15s}',
    '.textarea{resize:vertical;min-height:78px;line-height:1.5}',
    '.input::placeholder,.textarea::placeholder{color:var(--ink-4);opacity:1}',
    '.input:hover,.textarea:hover{border-color:var(--line-3)}',
    '.input:focus,.textarea:focus{border-color:var(--ring-line);box-shadow:0 0 0 3px var(--ring)}',
    '.input[aria-invalid="true"]{border-color:var(--danger)}',
    '.fhint{margin-top:6px;font-size:12px;line-height:1.45;color:var(--ink-3)}',
    '.fhint.err{color:var(--danger)}',

    // buttons
    '.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 14px;margin:0;border-radius:10px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);cursor:pointer;font-size:13px;font-weight:600;white-space:nowrap;transition:border-color .15s,background .15s,color .15s,transform .15s,filter .15s}',
    '.btn:hover{border-color:var(--gold-2)}',
    '.btn:active{transform:scale(.98)}',
    '.btn:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.btn.primary{border-color:transparent;background:var(--send-bg);color:var(--on-accent);box-shadow:0 6px 14px -8px rgba(27,32,102,.7)}',
    '.btn.primary:hover{filter:brightness(1.07)}',
    '.btn.ghost{border-color:transparent;background:transparent;color:var(--ink-2)}',
    '.btn.ghost:hover{background:var(--hover);color:var(--ink)}',
    '.btn.danger{color:var(--danger)}',
    '.btn.danger:hover{border-color:var(--danger)}',
    '.btn.danger.armed{background:var(--danger);border-color:var(--danger);color:#FFFFFF}',
    '.root[data-theme="dark"] .btn.danger.armed{color:#240C16}',
    '.btn.sm{height:30px;padding:0 11px;font-size:12.5px;border-radius:9px}',
    '.btn:disabled{opacity:.5;cursor:default;transform:none}',
    '.iconbtn{width:30px;height:30px;flex:none;margin:0;padding:0;border:0;border-radius:9px;background:transparent;color:var(--ink-3);cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s,opacity .15s}',
    '.iconbtn:hover{background:var(--hover);color:var(--ink)}',
    '.iconbtn.del:hover{color:var(--danger)}',
    '.iconbtn:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px}',
    '.linkbtn{border:0;background:none;padding:0;margin:0;color:var(--link);cursor:pointer;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}',
    '.linkbtn:hover{text-decoration-thickness:2px}',
    '.linkbtn:focus-visible{outline:2px solid var(--peacock);outline-offset:2px;border-radius:3px}',
    '.check{flex:none;appearance:none;-webkit-appearance:none;width:18px;height:18px;margin:0;border-radius:5px;border:1.5px solid var(--line-3);background:var(--surface);cursor:pointer;display:grid;place-items:center;transition:background .15s,border-color .15s}',
    '.check:checked{background:var(--accent);border-color:var(--accent)}',
    '.check:checked::after{content:"";width:5px;height:9px;border:solid var(--on-accent);border-width:0 2px 2px 0;transform:translateY(-1px) rotate(45deg)}',
    '.check:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',

    // banners, empty states
    '.banner{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:10px 10px 10px 12px;border-radius:12px;background:var(--warn-soft);color:var(--ink-2);font-size:12.5px;line-height:1.45}',
    '.banner svg{flex:none;color:var(--gold)}',
    '.banner .txt{flex:1;min-width:0}',
    '.empty{text-align:center;padding:26px 18px;color:var(--ink-3);font-size:13px;line-height:1.55}',
    '.empty .lotus{color:var(--lotus);display:grid;place-items:center;margin-bottom:8px}',
    '.empty b{display:block;margin-bottom:3px;color:var(--ink);font-size:14px;font-weight:600}',
    '.empty .btn{margin-top:12px}',

    // profile
    '.pcard{display:flex;align-items:center;gap:12px;margin:0 0 20px;padding:14px;border-radius:var(--r-card);background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow-sm)}',
    '.pcard .uavatar{width:46px;height:46px;font-size:16px}',
    '.pcard .uavatar svg{width:22px;height:22px}',
    '.pcard .nm{font:650 15.5px/1.25 var(--display);color:var(--ink);overflow-wrap:anywhere}',
    '.pcard .sb{margin-top:2px;font-size:12.5px;line-height:1.4;color:var(--ink-3)}',

    // memory list
    '.mrow{display:flex;align-items:flex-start;gap:10px;padding:11px 8px 11px 14px}',
    '.mrow + .mrow{border-top:1px solid var(--line)}',
    '.mrow .mt{flex:1;min-width:0}',
    '.mk{font:600 10px/1.3 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}',
    '.mv{margin-top:2px;font-size:13.5px;line-height:1.45;color:var(--ink);overflow-wrap:anywhere}',
    '.mm{margin-top:3px;font-size:11.5px;color:var(--ink-3)}',
    '.mbtns{display:flex;gap:2px;flex:none}',
    '.medit{display:flex;gap:6px;margin-top:6px}',
    '.medit .input{padding:7px 10px}',
    '.addrow{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--line);background:var(--surface-2)}',
    '.addrow .input{background:var(--surface);padding-top:8px;padding-bottom:8px}',
    '.addrow .btn{height:auto}',

    // history
    '.search{position:relative;margin:0 0 16px}',
    '.search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--ink-3);pointer-events:none}',
    '.search .input{padding-left:34px;background:var(--surface)}',
    '.hlist{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);overflow:hidden;box-shadow:var(--shadow-sm)}',
    '.hrow{display:flex;align-items:center;gap:2px;padding-right:6px}',
    '.hrow + .hrow{border-top:1px solid var(--line)}',
    '.hopen{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;margin:0;padding:10px 8px 10px 14px;border:0;background:transparent;color:var(--ink);cursor:pointer;text-align:left}',
    '.hopen:focus-visible{outline:2px solid var(--peacock);outline-offset:-2px;border-radius:12px}',
    '.ht{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:600;line-height:1.35;min-width:0}',
    '.ht span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hopen:hover .ht span{color:var(--accent)}',
    '.hs{font-size:12px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hrow .iconbtn{opacity:0}',
    '.hrow:hover .iconbtn,.hrow:focus-within .iconbtn{opacity:1}',

    // appearance
    '.themes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.tcard{display:flex;flex-direction:column;gap:8px;margin:0;padding:7px 7px 9px;border:1.5px solid var(--line);border-radius:14px;background:var(--surface);cursor:pointer;color:var(--ink-2);font-size:12.5px;font-weight:600;text-align:left;transition:border-color .15s,box-shadow .15s,transform .2s var(--spring)}',
    '.tcard:hover{border-color:var(--line-3);transform:translateY(-1px)}',
    '.tcard[aria-checked="true"]{border-color:var(--gold-2);color:var(--ink);box-shadow:0 0 0 3px var(--gold-soft)}',
    '.tcard:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.tcard .tl{display:flex;align-items:center;justify-content:space-between;padding:0 3px}',
    '.tcard .tl svg{color:var(--gold);opacity:0;transition:opacity .15s}',
    '.tcard[aria-checked="true"] .tl svg{opacity:1}',
    '.tprev{position:relative;height:58px;border-radius:9px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(0,0,0,.07)}',
    '.tprev i{position:absolute;display:block}',
    '.tprev .band{left:0;right:0;top:0;height:15px}',
    '.tprev .b1{right:8px;top:23px;width:42%;height:8px;border-radius:5px}',
    '.tprev .b2{left:8px;top:37px;width:58%;height:7px;border-radius:5px}',
    '.tprev .b3{left:8px;top:48px;width:36%;height:5px;border-radius:5px}',
    '.tprev.light{background:#FAF7F0}',
    '.tprev.light .band{background:linear-gradient(125deg,#1A2066,#2B3A9E 58%,#127A7C)}',
    '.tprev.light .b1{background:#2B3A9E}',
    '.tprev.light .b2,.tprev.light .b3{background:#E4DCCB}',
    '.tprev.dark{background:#0D0F2E}',
    '.tprev.dark .band{background:linear-gradient(125deg,#10144A,#1C2370 60%,#0E4C5A)}',
    '.tprev.dark .b1{background:#3A4CC4}',
    '.tprev.dark .b2,.tprev.dark .b3{background:#2A2F6E}',
    '.tprev.auto{background:linear-gradient(118deg,#FAF7F0 50%,#0D0F2E 50%)}',
    '.tprev.auto .band{background:linear-gradient(125deg,#1A2066,#1C2370 60%,#0E4C5A)}',
    '.tprev.auto .b1{background:#3A4CC4}',
    '.tprev.auto .b2,.tprev.auto .b3{background:#8C90B8}',
    '.sample{margin:0;padding:10px 12px;border-radius:10px;background:var(--bg);border:1px dashed var(--line-2);color:var(--ink-2);font-size:var(--fs);line-height:1.55}',

    // shortcuts + about
    '.vbody kbd{display:inline-block;font:500 10.5px/1 var(--mono);color:var(--ink-2);padding:3px 6px 4px;border:1px solid var(--line-2);border-bottom-width:2px;border-radius:5px;background:var(--surface)}',
    '.keys{list-style:none;margin:0;padding:0}',
    '.keys li{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;font-size:13px;color:var(--ink-2)}',
    '.keys li + li{border-top:1px solid var(--line)}',
    '.keys li span:last-child{flex:none;display:inline-flex;gap:4px;align-items:center;color:var(--ink-3)}',
    '.about{text-align:center;padding:4px 0 20px}',
    '.about .hero{width:84px;height:84px;margin:4px auto 12px}',
    '.about h3{margin:0;font:700 20px/1.2 var(--display);letter-spacing:.14em;color:var(--ink)}',
    '.about .say{margin:5px 0 12px;font:500 10.5px/1.3 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}',
    '.about .meaning{margin:0 auto;max-width:31em;font-size:13.5px;line-height:1.6;color:var(--ink-2)}',
    '.kv{display:flex;justify-content:space-between;align-items:baseline;gap:12px;padding:10px 14px;font-size:13px}',
    '.kv + .kv{border-top:1px solid var(--line)}',
    '.kv span{flex:none;color:var(--ink-3)}',
    '.kv b{min-width:0;font:500 12px/1.4 var(--mono);color:var(--ink);text-align:right;overflow-wrap:anywhere}',
    '.kv b.okc{color:var(--ok)}',
    '.kv b.badc{color:var(--danger)}',
    '.plist{margin:0;padding:12px 16px 12px 32px;font-size:13px;line-height:1.55;color:var(--ink-2)}',
    '.plist li + li{margin-top:7px}',
    '.plist li::marker{color:var(--gold)}',

    // --- chat additions ----------------------------------------------------------
    // "remember this?" — the same gold→peacock→indigo edge as the first-visit
    // bubble: it is K.R.1.S speaking up, and it should look like it
    '.memo{margin-top:12px;padding:12px 14px;border-radius:14px;border:1px solid transparent;' +
      'background:linear-gradient(var(--surface),var(--surface)) padding-box,linear-gradient(120deg,var(--gold-2),var(--peacock),var(--accent)) border-box;box-shadow:var(--shadow-md);animation:fadeUp .28s var(--ease) both}',
    '.memo .mh{display:flex;align-items:flex-start;gap:9px;font-size:13.5px;font-weight:600;line-height:1.45;color:var(--ink)}',
    '.memo .mh .lotus{flex:none;color:var(--lotus);margin-top:1px}',
    '.memo ul{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}',
    '.memo li{display:flex;align-items:center;gap:9px}',
    '.memo .k{flex:none;width:78px;font:600 10px/1.2 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}',
    '.memo input.v{flex:1;min-width:0;margin:0;border:1px solid transparent;border-radius:8px;background:var(--surface-2);color:var(--ink);font:500 13.5px/1.3 var(--font);padding:6px 9px;outline:0;transition:border-color .15s,box-shadow .15s}',
    '.memo input.v:hover{border-color:var(--line-2)}',
    '.memo input.v:focus{border-color:var(--ring-line);box-shadow:0 0 0 3px var(--ring);background:var(--surface)}',
    '.memo input.v:disabled{opacity:.5}',
    '.memo .ma{display:flex;align-items:center;gap:6px;margin-top:12px;flex-wrap:wrap}',
    '.memo .mf{margin-left:auto;font-size:11.5px;color:var(--ink-3)}',
    '.memo.done{padding:8px 12px;border:0;background:var(--peacock-soft);box-shadow:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--ink-2)}',
    '.memo.done .ok{color:var(--ok);display:grid;place-items:center}',
    '.memo.done b{font-weight:600;color:var(--ink)}',
    '.memo.done .sp{flex:1}',

    // action chips (local replies: "Manage memory", "Turn memory on")
    '.chips.actions .chip{display:inline-flex;align-items:center;gap:6px;border-color:var(--line-2);background:var(--surface);color:var(--ink)}',
    '.chips.actions .chip svg{color:var(--gold)}',
    '.chips.actions .chip.danger{color:var(--danger)}',
    '.chips.actions .chip.danger.armed{background:var(--danger);border-color:var(--danger);color:#FFFFFF}',
    '.root[data-theme="dark"] .chips.actions .chip.danger.armed{color:#240C16}',

    // your own messages: copy, edit, and the sending / not-delivered state
    '.turn.user{flex-direction:row-reverse;align-items:flex-end;justify-content:flex-start;gap:4px}',
    '.uact{flex:none;display:flex;align-items:center;gap:1px;margin-bottom:3px;opacity:0;transition:opacity .15s}',
    '.turn.user:hover .uact,.turn.user:focus-within .uact,.turn.user.sending .uact,.turn.user.failed .uact{opacity:1}',
    '.uact .act{width:28px;height:28px;border-radius:8px}',
    '.ustate{font:400 11px/1 var(--mono);color:var(--ink-3);margin-right:6px;white-space:nowrap}',
    '.ustate:empty{display:none}',
    '.turn.user.sending .bubble{opacity:.8}',
    '.turn.user.failed .bubble{box-shadow:0 0 0 2px var(--danger-soft),var(--user-shadow)}',
    '.turn.user.failed .ustate{color:var(--danger)}',
    '.turn.user.editing .bubble{opacity:.5}',
    '.turn.user:not(.lastu) .uact .act.edit,.root.busy .uact .act.edit{display:none}',

    // editing a sent message
    '.editbar{display:none;align-items:center;gap:8px;margin:0 2px 7px;padding:5px 5px 5px 10px;border-radius:10px;background:var(--gold-soft);color:var(--ink-2);font-size:12.5px;font-weight:550}',
    '.editbar svg{color:var(--gold)}',
    '.editbar .sp{flex:1}',
    '.composer.editing .editbar{display:flex}',
    '.composer.editing .box{border-color:var(--gold-2)}',

    '.msg .codeblock + p,.msg .codeblock + ul,.msg .codeblock + ol,.msg .codeblock + .codeblock,.msg .tablewrap + ul,.msg ul + .codeblock,.msg p + .codeblock{margin-top:10px}',

    // thinking: elapsed time and the patient hint
    '.thinking .secs{font:400 11.5px/1 var(--mono);color:var(--ink-3)}',
    '.slowhint{margin-top:6px;font-size:12.5px;line-height:1.45;color:var(--ink-3);animation:fadeIn .3s ease both}',

    // pick up where you left off
    '.resume{display:flex;align-items:center;gap:10px;width:100%;margin:14px 0 0;padding:10px 12px;border:1px dashed var(--line-3);border-radius:var(--r-card);background:transparent;color:var(--ink-2);cursor:pointer;text-align:left;font-size:13px;line-height:1.35;transition:border-color .15s,background .15s,color .15s}',
    '.resume:hover{border-color:var(--gold-2);background:var(--surface);color:var(--ink)}',
    '.resume:focus-visible{outline:2px solid var(--peacock);outline-offset:2px}',
    '.resume svg{flex:none;color:var(--gold)}',
    '.resume .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.resume .t b{font-weight:600;color:var(--ink)}',
    '.resume .w{flex:none;font:400 11px/1 var(--mono);color:var(--ink-3)}',

    // toasts
    '.toasts{position:absolute;left:12px;right:12px;bottom:16px;z-index:12;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}',
    '.toast{pointer-events:auto;display:inline-flex;align-items:center;gap:8px;max-width:100%;padding:8px 8px 8px 14px;min-height:38px;border-radius:12px;background:var(--toast-bg);color:var(--toast-ink);font-size:13px;font-weight:500;line-height:1.35;box-shadow:0 14px 30px -12px rgba(0,0,0,.45);animation:toastIn .26s var(--spring) both}',
    '.toast.solo{padding-right:14px}',
    '.toast.out{animation:toastOut .18s ease-in forwards}',
    '.toast button{flex:none;border:0;background:transparent;color:var(--toast-act);font:600 13px/1 var(--font);padding:7px 9px;border-radius:8px;cursor:pointer}',
    '.toast button:hover{background:rgba(127,127,160,.18)}',
    '.toast button:focus-visible{outline:2px solid var(--toast-act);outline-offset:1px}',
    '@keyframes toastIn{from{opacity:0;transform:translateY(8px) scale(.96)}to{opacity:1;transform:none}}',
    '@keyframes toastOut{to{opacity:0;transform:translateY(6px)}}',

    // --- density, text size, times -----------------------------------------------
    '.root[data-density="compact"] .log{gap:10px;padding-top:14px}',
    '.root[data-density="compact"] .bubble{padding:7px 13px}',
    '.root[data-density="compact"] .card{padding:12px 14px 10px}',
    '.root[data-density="compact"] .meta{min-height:26px;margin-top:2px}',
    '.root[data-density="compact"] .chips{margin-top:7px}',
    '.root[data-density="compact"] .row{min-height:46px;padding-top:9px;padding-bottom:9px}',
    '.root[data-times="off"] .meta .time{display:none}',
    '.chip,.prompts button,.resume{font-size:calc(var(--fs) - 1.2px)}',

    // --- motion preferences: the user's choice, on top of the OS setting ----------
    '.root.calm,.root.calm *,.root.calm *::before,.root.calm *::after{animation-duration:.001ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.001ms!important;transition-delay:0s!important}',
    '.root.calm .thinking .label{color:var(--ink-3);background:none}',
    '.root.calm.busy .notes i{opacity:0}',
    '.root.still .badge .aura,.root.still .hero .ring,.root.still .fig,.root.still .k-plume,.root.still .blinking .k-eye,' +
      '.root.still .idle-drift .k-iris,.root.still .idle-drift .k-pupil,.root.still .idle-drift .k-glint,.root.still.busy .notes i,.root.still .laugh-shake .k-char,.root.still .sad-sink .k-char,.root.still .mood-pop{animation:none!important}',
    '.root.still.busy .notes i{opacity:0}',

    // --- small panels, phones, touch ---------------------------------------------------
    '.panel.chatting .titles h2 .sub{display:none}',
    '@container kris (min-width:540px){.panel.chatting .titles h2 .sub{display:inline}}',
    '@container kris (max-width:420px){.memo .k{width:62px}}',
    '@container kris (max-width:380px){' +
      '.titles h2 .sub{display:none}' +
      '.memo .k{width:64px}' +
      '.themes{gap:6px}' +
      '.seg button{padding:0 9px}' +
    '}',
    '@media (max-width:520px){' +
      '.drawer{width:min(320px,88%)}' +
      '.vbody{padding:14px 12px calc(20px + env(safe-area-inset-bottom,0px))}' +
      '.input,.textarea,.memo input.v{font-size:16px}' +
      '.toasts{bottom:calc(16px + env(safe-area-inset-bottom,0px))}' +
    '}',
    '@media (hover:none){.turn.user.lastu .uact,.hrow .iconbtn{opacity:1}}',
    '@media (pointer:coarse){' +
      '.act,.iconbtn{width:36px;height:36px}' +
      '.ditem{height:44px}' +
      '.seg button{height:34px}' +
    '}',
    '@media (forced-colors:active){' +
      '.switch,.seg,.btn,.tcard,.check,.dnew,.memo,.group,.hlist,.toast,.resume{border:1px solid CanvasText}' +
      '.switch[aria-checked="true"]{background:Highlight}' +
      '.seg button[aria-checked="true"],.tcard[aria-checked="true"]{outline:2px solid Highlight}' +
    '}',
    '@media (prefers-reduced-motion:reduce){' +
      '.drawer,.scrim,.switch,.switch::after,.tcard,.btn{transition:none!important}' +
      '.panel.in-view .views,.memo,.toast,.toast.out,.slowhint{animation:none!important}' +
    '}'
  ].join('');

  // ==========================================================================
  //  Visual styles: one design language for every chart, card and flow.
  //  Thin marks, hairline grids, text in ink (never in a series colour), 2px
  //  surface gaps between touching fills, status only with an icon and a word.
  // ==========================================================================
  CSS += [
    '.root{--vz-1:#3B4CC0;--vz-2:#10948C;--vz-3:#E07A1F;--vz-4:#D6457C;--vz-5:#7A5BD0;--vz-6:#AD840A;--vz-mute:#CFC8B8;--vz-grid:#EFEAE0;' +
      '--vz-good:#0CA30C;--vz-warn:#FAB219;--vz-bad:#D03B3B;--vz-good-t:rgba(12,163,12,.16);--vz-warn-t:rgba(250,178,25,.24);--vz-bad-t:rgba(208,59,59,.16);--vz-neutral-t:var(--surface-3)}',
    '.root[data-theme="dark"]{--vz-1:#7282F2;--vz-2:#1D9E93;--vz-3:#D8772A;--vz-4:#D9558A;--vz-5:#8E73E6;--vz-6:#B0851A;--vz-mute:#3A4078;--vz-grid:#232862;' +
      '--vz-good-t:rgba(12,163,12,.22);--vz-warn-t:rgba(250,178,25,.2);--vz-bad-t:rgba(208,59,59,.26)}',

    // the card every visual sits on
    '.vz{margin:14px 0 0;padding:14px 16px 15px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface);box-shadow:var(--shadow-sm);min-width:0}',
    '.msg .vz + p,.msg .vz + ul,.msg .vz + ol,.msg .vz + h4,.msg .vz + .tablewrap,.msg .vz + .vz{margin-top:14px}',
    '.msg > .vz:first-child{margin-top:2px}',
    // the chat's list styles are for prose, not for a visual's rows
    '.vz ol,.vz ul{padding:0;list-style:none}',
    '.vz li{margin:0;padding-left:0}',
    '.vz ol.vz-flow,.vz ol.vz-tl{margin:0}',
    '.vz ul.vz-legend{margin:13px 0 0}',
    '.vz-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0 0 12px}',
    '.vz-t{font:650 13.5px/1.35 var(--display);letter-spacing:-.006em;color:var(--ink);min-width:0}',
    '.vz-u{font:500 11px/1 var(--mono);letter-spacing:.02em;color:var(--ink-3);white-space:nowrap}',
    '.s0{--c:var(--vz-1)}.s1{--c:var(--vz-2)}.s2{--c:var(--vz-3)}.s3{--c:var(--vz-4)}.s4{--c:var(--vz-5)}.s5{--c:var(--vz-6)}.so{--c:var(--vz-mute)}',

    // status: a tint, an icon and a word — never colour alone
    '.vz-tone{display:inline-flex;align-items:center;gap:4px;padding:3px 8px 3px 5px;border-radius:999px;font:600 11px/1.2 var(--font);color:var(--ink);white-space:nowrap}',
    '.vz-tone .ic{display:grid;place-items:center}.vz-tone svg{width:12px;height:12px;stroke-width:2.2}',
    '.vz-tone.t-good{background:var(--vz-good-t)}.vz-tone.t-good .ic{color:var(--vz-good)}',
    '.vz-tone.t-warn{background:var(--vz-warn-t)}.vz-tone.t-warn .ic{color:#B87A00}',
    '.root[data-theme="dark"] .vz-tone.t-warn .ic{color:var(--vz-warn)}',
    '.vz-tone.t-bad{background:var(--vz-bad-t)}.vz-tone.t-bad .ic{color:var(--vz-bad)}',
    '.vz-tone.t-neutral{background:var(--vz-neutral-t)}.vz-tone.t-neutral .ic{color:var(--ink-3)}',

    // stats: tiles on one card, split by hairlines
    '.vz.vz-stats{padding:0;overflow:hidden}',
    '.vz.vz-stats .vz-h{padding:13px 16px 0;margin-bottom:11px}',
    '.vz-stats-g{display:flex;flex-wrap:wrap;gap:1px;background:var(--line)}',
    '.vz-map svg{display:block;width:100%;height:auto;background:var(--vz-grid);border-radius:10px}',
    '.vz-map .pin{fill:var(--vz-1);stroke:#fff;stroke-width:2}',
    '.vz-map .pin-l{font:600 11px/1 inherit;fill:var(--ink);paint-order:stroke;stroke:var(--surface,#fff);stroke-width:3px;stroke-linejoin:round}',
    '.vz-map .trk{fill:none;stroke:var(--vz-2);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;opacity:.9}',
    '.vz-map-a{margin:6px 0 0;font-size:10.5px;color:var(--ink-3)}',
    '.vz-map-l{list-style:none;margin:8px 0 0;padding:0;display:grid;gap:3px;font-size:12.5px;color:var(--ink-2)}',
    '.vz-map-l b{color:var(--ink);font-weight:600}',
    '.vz.vz-stats .vz-h + .vz-stats-g{border-top:1px solid var(--line)}',
    '.vz-stat{flex:1 1 124px;background:var(--surface);padding:13px 16px 14px;min-width:0}',
    '.vz-sl{font-size:12px;line-height:1.35;color:var(--ink-3);margin:0 0 6px}',
    '.vz-sv{font:650 25px/1.1 var(--display);letter-spacing:-.022em;color:var(--ink);overflow-wrap:anywhere}',
    '.vz-su{font:500 12.5px/1 var(--font);letter-spacing:0;color:var(--ink-3);margin-left:5px}',
    '.vz-sn{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;font-size:12px;line-height:1.4;color:var(--ink-2)}',
    '.vz-d{font:600 12px/1 var(--font);font-variant-numeric:tabular-nums;color:var(--ink)}',

    // bars: one hue, label | bar | value; highlight = emphasis, the rest recede
    '.vz-bars{display:grid;gap:9px}',
    '.vz-row{display:grid;grid-template-columns:minmax(56px,32%) minmax(0,1fr) auto;align-items:center;gap:10px;font-size:12.5px;line-height:1.3}',
    '.vz-bl{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vz-track{position:relative;height:12px}',
    '.vz-bars.pos .vz-track::before{content:"";position:absolute;left:0;top:-3px;bottom:-3px;width:1px;background:var(--line-2)}',
    '.vz-track i{position:absolute;top:0;bottom:0;border-radius:0 4px 4px 0;background:var(--vz-1);transform-origin:left center;transition:filter .15s}',
    '.vz-track i.neg{border-radius:4px 0 0 4px;transform-origin:right center}',
    '.vz-zero{position:absolute;top:-3px;bottom:-3px;width:1px;background:var(--line-3)}',
    '.vz-row.lo .vz-track i{background:var(--vz-mute)}',
    '.vz-row.hi .vz-bl,.vz-row.hi .vz-bv{color:var(--ink);font-weight:650}',
    '.vz-row:hover .vz-track i{filter:brightness(1.1) saturate(1.05)}',
    '.vz-bv{font:500 12px/1 var(--font);font-variant-numeric:tabular-nums;color:var(--ink);text-align:right;white-space:nowrap}',

    // line: SVG for the marks (non-scaling strokes), HTML for every word and dot
    '.vz-plot{position:relative;height:148px;margin-top:16px;outline:none;touch-action:pan-y;cursor:crosshair}',
    '.vz-plot:focus-visible{box-shadow:0 0 0 2px var(--surface),0 0 0 4px var(--peacock);border-radius:4px}',
    '.vz-gl{position:absolute;left:var(--gut,34px);right:0;height:0;border-top:1px solid var(--vz-grid)}',
    '.vz-gl span{position:absolute;right:calc(100% + 7px);top:-6px;font:400 10.5px/1 var(--font);font-variant-numeric:tabular-nums;color:var(--ink-3);white-space:nowrap}',
    '.vz-area{position:absolute;top:0;bottom:0;left:calc(var(--gut,34px) + 6px);right:10px}',
    '.vz-area svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}',
    '.vz-area path.ln{fill:none;stroke:var(--c);stroke-width:2;stroke-linejoin:round;stroke-linecap:round;vector-effect:non-scaling-stroke}',
    '.vz-area path.ar{fill:var(--c);stroke:none;opacity:.1}',
    '.vz-dot{position:absolute;width:9px;height:9px;margin:-4.5px 0 0 -4.5px;border-radius:50%;background:var(--c);box-shadow:0 0 0 2px var(--surface);pointer-events:none}',
    '.vz-hd{display:none;width:11px;height:11px;margin:-5.5px 0 0 -5.5px}',
    '.vz-endv{position:absolute;right:4px;transform:translateY(-170%);font:650 11.5px/1 var(--font);font-variant-numeric:tabular-nums;color:var(--ink);background:var(--surface);padding:2px 4px;border-radius:5px;white-space:nowrap;pointer-events:none}',
    '.vz-x{position:absolute;top:0;bottom:0;width:1px;margin-left:-.5px;background:var(--line-3);display:none;pointer-events:none}',
    '.vz-tip{position:absolute;top:2px;display:none;margin-left:10px;min-width:92px;max-width:70%;padding:8px 10px;border:1px solid var(--line-2);border-radius:10px;background:var(--surface);box-shadow:var(--shadow-lift);font-size:12px;line-height:1.35;pointer-events:none;z-index:2}',
    '.vz-tip.left{transform:translateX(-100%);margin-left:-10px}',
    '.vz-tip .k{font:500 11px/1.3 var(--font);color:var(--ink-3);margin-bottom:3px}',
    '.vz-tip .r{display:flex;align-items:center;gap:6px;white-space:nowrap}',
    '.vz-tip .r i{width:12px;height:2px;border-radius:2px;background:var(--c);flex:none}',
    '.vz-tip b{font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums}',
    '.vz-tip .r span{color:var(--ink-3)}',
    '.vz-plot.hover .vz-x,.vz-plot.hover .vz-tip,.vz-plot.hover .vz-hd{display:block}',
    '.vz-plot.hover .vz-endv{opacity:0}',
    '.vz-xa{position:relative;height:15px;margin:8px 10px 0 calc(var(--gut,34px) + 6px);font:400 11px/1.3 var(--font);color:var(--ink-3)}',
    '.vz-xa span{position:absolute;top:0;transform:translateX(-50%);white-space:nowrap}',
    '.vz-xa span.first{transform:none}.vz-xa span.last{transform:translateX(-100%)}',
    '.vz-lg{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:10px;font-size:12px;color:var(--ink-2)}',
    '.vz-lg span{display:inline-flex;align-items:center;gap:7px}',
    '.vz-lg i{width:14px;height:2px;border-radius:2px;background:var(--c)}',
    '.card .chart-title + .vz-linec .vz-plot,.card .chart-title + .vz-bars{margin-top:10px}',

    // breakdown: one stacked bar, 2px surface gaps, and a legend that carries the numbers
    '.vz-stack{display:flex;gap:2px;height:14px;border-radius:5px;overflow:hidden}',
    '.vz-stack span{min-width:3px;height:100%;background:var(--c);transform-origin:left center}',
    '.vz-legend{list-style:none;margin:13px 0 0;padding:0;display:grid;gap:7px}',
    '.vz-legend li{display:grid;grid-template-columns:10px minmax(0,1fr) auto 3.4em;align-items:center;gap:9px;font-size:12.5px;line-height:1.3}',
    '.vz-legend.pct li{grid-template-columns:10px minmax(0,1fr) 3.4em}',
    '.vz-legend i{width:10px;height:10px;border-radius:3px;background:var(--c)}',
    '.vz-legend .l{color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.vz-legend .v{font-weight:550;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.vz-legend .p{font:500 11.5px/1 var(--mono);color:var(--ink-3);text-align:right}',

    // meter: a value against a limit or a rating scale
    '.vz-mh{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 9px}',
    '.vz-mv{font:650 26px/1.05 var(--display);letter-spacing:-.022em;color:var(--ink)}',
    '.vz-mu{font-size:13px;color:var(--ink-3)}',
    '.vz-mh .vz-tone{align-self:center}',
    '.vz-mtrack{position:relative;height:10px;margin:30px 0 0;border-radius:999px;background:var(--surface-3)}',
    '.vz-mtrack.banded{background:transparent}',
    '.vz-mseg{position:absolute;top:0;bottom:0;opacity:.3;transform-origin:left center}',
    '.vz-mseg.first{border-radius:999px 0 0 999px}.vz-mseg.last{border-radius:0 999px 999px 0}.vz-mseg.first.last{border-radius:999px}',
    '.vz-mseg.on{opacity:1}',
    '.vz-mseg.t-good{background:var(--vz-good)}.vz-mseg.t-warn{background:var(--vz-warn)}.vz-mseg.t-bad{background:var(--vz-bad)}.vz-mseg.t-neutral{background:var(--ink-4)}',
    '.vz-mfill{position:absolute;left:0;top:0;bottom:0;border-radius:999px;background:var(--vz-1);transform-origin:left center}',
    '.vz-mfill.t-good{background:var(--vz-good)}.vz-mfill.t-bad{background:var(--vz-bad)}.vz-mfill.t-warn{background:var(--vz-warn)}',
    '.vz-mk{position:absolute;top:50%;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 3px var(--surface),0 3px 8px -2px rgba(0,0,0,.35);z-index:1}',
    '.vz-tg{position:absolute;top:-7px;bottom:-7px;width:2px;margin-left:-1px;border-radius:2px;background:var(--ink-2)}',
    '.vz-tg span{position:absolute;bottom:calc(100% + 4px);left:50%;transform:translateX(-50%);font:500 10.5px/1 var(--font);color:var(--ink-2);white-space:nowrap}',
    '.vz-ms{position:relative;height:14px;margin-top:9px;font:600 11px/1 var(--font);color:var(--ink-3)}',
    '.vz-ms span{position:absolute;transform:translateX(-50%);white-space:nowrap}',
    '.vz-ms .lo{left:0;transform:none}.vz-ms .hi{right:0;left:auto;transform:none}',
    '.vz-tg.lo span{left:-1px;transform:none}.vz-tg.hi span{left:auto;right:-1px;transform:none}',
    '.vz ul.vz-mlegend{display:flex;flex-wrap:wrap;gap:5px 14px;margin:12px 0 0;font:400 11.5px/1.3 var(--font);color:var(--ink-3);font-variant-numeric:tabular-nums}',
    '.vz-mlegend li{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}',
    '.vz-mlegend li.on{color:var(--ink)}',
    '.vz-mlegend b{font-weight:650;color:var(--ink-2)}.vz-mlegend li.on b{color:var(--ink)}',
    '.vz-mlegend i{width:8px;height:8px;border-radius:2px;opacity:.55}.vz-mlegend li.on i{opacity:1}',
    '.vz-mlegend i.t-good{background:var(--vz-good)}.vz-mlegend i.t-warn{background:var(--vz-warn)}.vz-mlegend i.t-bad{background:var(--vz-bad)}.vz-mlegend i.t-neutral{background:var(--ink-4)}',

    // compare: options side by side, the recommended one outlined
    '.vz-cmp{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,150px),1fr));gap:10px}',
    '.vz-card{position:relative;min-width:0;padding:13px 14px 14px;border:1px solid var(--line);border-radius:12px;background:var(--bg)}',
    '.vz-card.hi{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
    '.vz-best{position:absolute;top:-9px;right:10px;padding:3px 8px;border-radius:999px;background:var(--accent);color:var(--on-accent);font:650 10px/1.2 var(--font);letter-spacing:.02em}',
    '.vz-ctag{margin:0 0 6px;font:600 10px/1.2 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--gold)}',
    '.vz-cn{font:650 14px/1.3 var(--display);letter-spacing:-.008em;color:var(--ink)}',
    '.vz-cv{margin-top:6px;font:650 20px/1.1 var(--display);letter-spacing:-.02em;color:var(--ink)}',
    '.vz-card ul{list-style:none;margin:9px 0 0;padding:0;display:grid;gap:6px}',
    '.vz-card li{position:relative;padding-left:15px;font-size:12.5px;line-height:1.45;color:var(--ink-2)}',
    '.vz-card li::before{content:"";position:absolute;left:1px;top:.5em;width:5px;height:5px;border-radius:1.5px;background:var(--vz-2);transform:rotate(45deg)}',
    '.vz-cver{margin-top:11px;padding-top:9px;border-top:1px solid var(--line);font-size:12.5px;line-height:1.45;color:var(--ink);font-weight:550}',

    // steps: a numbered flow joined by a rail
    '.vz-flow{list-style:none;margin:0;padding:0}',
    '.vz-flow li{position:relative;display:grid;grid-template-columns:28px minmax(0,1fr);gap:12px;padding-bottom:14px}',
    '.vz-flow li:last-child{padding-bottom:0}',
    '.vz-flow li::before{content:"";position:absolute;left:13.5px;top:31px;bottom:3px;width:1px;background:var(--line-2)}',
    '.vz-flow li:last-child::before{display:none}',
    '.vz-n{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font:650 12.5px/1 var(--font);color:var(--accent);background:var(--gold-soft);box-shadow:inset 0 0 0 1.5px var(--gold-2)}',
    '.vz-flow b,.vz-tl b{display:block;font:600 13.5px/1.4 var(--display);color:var(--ink)}',
    '.vz-flow b{padding-top:4px}',
    '.vz-flow p,.vz-tl p{margin:2px 0 0;font-size:12.5px;line-height:1.5;color:var(--ink-2)}',

    // timeline: dated milestones on a rail
    '.vz-tl{list-style:none;margin:0;padding:0}',
    '.vz-tl li{position:relative;padding:0 0 15px 24px}',
    '.vz-tl li:last-child{padding-bottom:0}',
    '.vz-tl li::before{content:"";position:absolute;left:5px;top:16px;bottom:-1px;width:2px;border-radius:2px;background:var(--line)}',
    '.vz-tl li:last-child::before{display:none}',
    '.vz-tl li::after{content:"";position:absolute;left:0;top:3px;width:12px;height:12px;border-radius:50%;background:var(--surface);box-shadow:inset 0 0 0 2.5px var(--vz-2)}',
    '@container kris (min-width:600px){' +
      '.vz-tl.fits{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:16px}' +
      '.vz-tl.fits li{padding:24px 0 0}' +
      '.vz-tl.fits li::before{left:18px;right:-12px;top:5px;bottom:auto;width:auto;height:2px}' +
    '}',
    '.vz-when{display:inline-block;margin:0 0 5px;padding:3px 7px;border-radius:6px;background:var(--peacock-soft);color:var(--peacock);font:600 11px/1.2 var(--mono);letter-spacing:.03em}',

    // dashboard: several views of one subject
    '.vz.vz-dashboard{padding:14px 14px 15px;background:linear-gradient(180deg,var(--gold-soft),transparent 90px),var(--surface)}',
    '.vz-dashboard > .vz-h .vz-t{font-size:14.5px}',
    '.vz-dash{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,232px),1fr));gap:10px}',
    '.vz-dash > .vz{margin:0;box-shadow:none;background:var(--surface)}',
    '.vz-dash > .vz.vz-stats{grid-column:1 / -1}',

    // the placeholder while a visual is on its way
    '.vz-skel{margin:14px 0 0;padding:14px 16px;border:1px solid var(--line);border-radius:var(--r-card);background:var(--surface);display:grid;gap:10px}',
    '.vz-skel .lbl{font-size:12.5px;color:var(--ink-3)}',
    '.vz-skel i{display:block;height:10px;border-radius:5px;background:linear-gradient(90deg,var(--surface-3) 0%,var(--surface-2) 50%,var(--surface-3) 100%);background-size:200% 100%;animation:vzShimmer 1.3s linear infinite}',
    '.vz-skel .a{width:82%}.vz-skel .b{width:58%}.vz-skel .c{width:70%}',
    '@keyframes vzShimmer{from{background-position:100% 0}to{background-position:-100% 0}}',

    // arrival: once, the first time a visual appears — never on a re-render
    '@keyframes vzUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '@keyframes vzGrow{from{transform:scaleX(0)}to{transform:scaleX(1)}}',
    '@keyframes vzWipe{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}',
    '@keyframes vzPop{from{opacity:0;transform:scale(.3)}to{opacity:1;transform:none}}',
    '.turn.anim .vz.fresh{animation:vzUp .38s var(--ease) both}',
    '.turn.anim .vz.fresh .vz-track i,.turn.anim .vz.fresh .vz-mfill,.turn.anim .vz.fresh .vz-mseg,.turn.anim .vz.fresh .vz-stack span{animation:vzGrow .7s var(--ease) both;animation-delay:calc(var(--i,0) * 45ms + 120ms)}',
    '.turn.anim .vz.fresh .vz-area svg{animation:vzWipe .95s var(--ease) both .12s}',
    '.turn.anim .vz.fresh .vz-area > .vz-dot:not(.vz-hd),.turn.anim .vz.fresh .vz-endv,.turn.anim .vz.fresh .vz-mk{animation:vzPop .4s var(--spring) both .85s}',
    '.turn.anim .vz.fresh .vz-stat,.turn.anim .vz.fresh .vz-card,.turn.anim .vz.fresh .vz-flow li,.turn.anim .vz.fresh .vz-tl li{animation:vzUp .42s var(--ease) both;animation-delay:calc(var(--i,0) * 60ms + 90ms)}',
    '@media (prefers-reduced-motion:reduce){.vz,.vz *,.vz-skel i{animation:none!important}}',
    '@media (forced-colors:active){.vz,.vz-card,.vz-tone{border:1px solid CanvasText}.vz-track i,.vz-stack span,.vz-mfill,.vz-mk,.vz-dot{forced-color-adjust:none}}',
    '@container kris (max-width:360px){.vz{padding:12px 13px 13px}.vz-row{grid-template-columns:minmax(48px,30%) minmax(0,1fr) auto}.vz-sv{font-size:22px}}'
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

  function timeGreeting() {
    var h = new Date().getHours();
    return h < 5 ? 'Hello' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  function localReply(text, name) {
    var hello = timeGreeting();
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
  //  Memory: what K.R.1.S may know about the user.
  //
  //  One schema drives everything — the Profile form, the Memory list, the
  //  "remember this?" card, what is sent to the server, and what detection is
  //  allowed to look for. Detection can only ever propose one of these fields
  //  (or a note the user explicitly asked for), so random conversation content
  //  never becomes permanent memory.
  // ==========================================================================
  var FIELDS = [
    { key: 'name', label: 'Name', group: 'you', max: 60, hint: 'Your full name.', ph: 'e.g. Alex Morgan' },
    { key: 'preferredName', label: 'Preferred name', long: 'What should K.R.1.S call you?', group: 'you', max: 40, ph: 'Leave empty to use your first name' },
    { key: 'role', label: 'Role', group: 'work', max: 80, ph: 'e.g. Marine emissions analyst' },
    { key: 'company', label: 'Company', group: 'work', max: 80, ph: 'e.g. GeoServe' },
    { key: 'department', label: 'Department', long: 'Department or team', group: 'work', max: 60, ph: 'e.g. Emissions team' },
    { key: 'location', label: 'Location', group: 'work', max: 80, ph: 'e.g. Mumbai' },
    { key: 'timezone', label: 'Time zone', group: 'work', max: 64, ph: '' },
    { key: 'interests', label: 'Interests', long: 'Professional interests', group: 'interests', max: 300, ph: 'e.g. FuelEU Maritime, EU ETS, CII', hint: 'Separate with commas. K.R.1.S uses these to pick examples and suggestions.' },
    { key: 'length', label: 'Answer length', group: 'style', choices: [['brief', 'Brief'], ['balanced', 'Balanced'], ['detailed', 'Thorough']] },
    { key: 'tone', label: 'Tone', group: 'style', choices: [['warm', 'Warm'], ['neutral', 'Neutral'], ['formal', 'Formal']] },
    { key: 'instructions', label: 'Custom instructions', long: 'Anything else about how K.R.1.S should answer?', group: 'style', max: 600, ph: 'e.g. Use metric tonnes. Put the figure first, then the context.', multi: true }
  ];
  var FIELD = {};
  FIELDS.forEach(function (f) { FIELD[f.key] = f; });
  var NOTE_MAX = 200, NOTES_MAX = 12;

  function choiceLabel(key, value) {
    var f = FIELD[key];
    if (!f || !f.choices) return value;
    for (var i = 0; i < f.choices.length; i++) if (f.choices[i][0] === value) return f.choices[i][1];
    return value;
  }

  /** One tidy line, capped. Newlines would let a value pose as a new prompt section. */
  function oneLine(v, max) {
    if (v == null || typeof v === 'object') return '';
    var s = String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max) : s;
  }

  // --- sensitive or unnecessary: never stored, whoever asks --------------------
  // Credentials and identifiers, contact details, and the special categories
  // (health, religion, orientation, family status, money, criminal record).
  var SENSITIVE_RE = new RegExp('\\b(?:' + [
    'pass(?:word|code|phrase)s?', 'pwd', 'pw', 'passwd', 'login', 'username', 'user name', 'pin(?: code| number)?', 'otp', 'one[- ]time (?:code|password)',
    'api[- ]?keys?', 'secret', 'access token', 'auth token', 'bearer', 'private key', 'credit card', 'debit card', 'card (?:number|no)', 'cvv', 'cvc',
    'iban', 'swift code', 'routing number', '(?:bank )?(?:account|acct|a/c) (?:number|no|is)', 'acct', 'sort code', 'ssn', 'social security', 'passport', 'aadhaa?r',
    'pan (?:card|number|no)', 'national id', '(?:phone|mobile|cell) (?:number|no|is)', 'wi-?fi (?:key|password|code)', 'driv(?:er\'?s?|ing) licen[cs]e', 'tax id', '(?:home |postal |street |my )address', 'date of birth', 'dob', 'birthday', 'born on',
    'diagnos\\w*', 'disease', 'illness', 'medical', 'medication', 'prescription', 'therapy', 'therapist', 'pregnan\\w*', 'disabilit\\w*', 'disabled',
    'mental health', 'depress\\w*', 'antidepress\\w*', 'anxiety', 'adhd', 'autis\\w*', 'diabet\\w*', 'cancer', 'hiv', 'asthma', 'epilep\\w*',
    'religio\\w*', 'muslim', 'hindu', 'christian', 'jewish', 'sikh', 'buddhist', 'atheist', 'catholic', 'caste',
    'gay', 'lesbian', 'bisexual', 'transgender', 'trans', 'queer', 'sexual\\w*', 'orientation',
    'married', 'divorced', 'widow\\w*', 'politic\\w*', 'vot(?:e|ed|er|ing)', 'union member\\w*', 'trade union',
    'salary', 'income', 'i earn', 'net worth', 'bank balance', 'debts?', 'criminal', 'convict\\w*', 'arrest\\w*'
  ].join('|') + ')\\b', 'i');

  /** Numbers, keys and contact details that should never sit in memory. */
  function looksLikeSecret(text) {
    var t = String(text || '');
    if (/(?:\d[ -]?){12,19}/.test(t)) return true;                                  // card and account numbers
    var runs = t.match(/[A-Za-z0-9_.\-]{24,}/g) || [];                             // keys and tokens: a long random
    for (var r = 0; r < runs.length; r++) {                                         // segment, not hyphenated words
      var segs = runs[r].split(/[-_.]/);
      for (var q = 0; q < segs.length; q++) if (segs[q].length >= 16 && /\d/.test(segs[q]) && /[A-Za-z]/.test(segs[q])) return true;
    }
    if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return true;                             // email addresses
    var phones = t.match(/\+?\d[\d ()-]{8,}\d/g) || [];                             // phone numbers (not dates)
    for (var i = 0; i < phones.length; i++) if (phones[i].replace(/\D/g, '').length >= 10) return true;
    return false;
  }
  function isSensitive(text) {
    var t = String(text || '');
    return SENSITIVE_RE.test(t) || looksLikeSecret(t);
  }

  // --- detection ---------------------------------------------------------------
  // Deterministic and local: microseconds, no network, no model. It only looks
  // for the fields above, in first-person statements, and it proposes — the
  // user decides.
  var ROLE_HEADS = 'analyst|engineer|manager|officer|superintendent|super|captain|master|mate|chief|director|lead|head|specialist|consultant|developer|coordinator|executive|planner|operator|technician|auditor|inspector|scientist|student|intern|advisor|adviser|architect|administrator|designer|owner|founder|ceo|cto|cfo|coo|vp|president|broker|surveyor|controller|accountant|trader|charterer|buyer|economist|researcher|associate|assistant|supervisor|programmer|strategist|partner|representative|expert|leader|secretary|clerk|trainee|cadet|electrician|fitter|bosun|purser|pilot|navigator';
  var ROLE_HEAD_RE = new RegExp('\\b(?:' + ROLE_HEADS + ')s?\\b', 'i');
  // Words that follow "I'm …" far more often than a name, a role or a place does.
  var NOT_WORDS = ('fine good great ok okay well tired bored busy sorry sure not so very here back done confused lost hungry happy sad angry new just still also ' +
    'curious ready looking trying asking wondering thinking testing going doing working interested glad stuck a an the all always never really kind kinda afraid unsure ' +
    'having getting checking waiting unable no yes yeah nope none nothing nobody anonymous yesterday today tomorrow week month year quarter power fuel speed distance ' +
    'consumption shaft rpm help hello hi hey thanks thank kris krishna in at on from with for of to by based located living staying currently now about into responsible part ' +
    'one certain aware able planning hoping using calling writing reading there this that it what who how why when where fairly pretty quite bit little more less your ' +
    'my our his her their them us you me him sick unwell feeling excited worried concerned late early off away out free available leaving joining only actually basically ' +
    'literally definitely probably maybe totally honestly seriously usually sometimes charge onboard aboard frustrated impressed travelling traveling finished home ' +
    'dr mr mrs ms miss prof sir madam capt lucky sorry myself alone around nearby somewhere everywhere doing well badly').split(' ');
  var NOT_ROLE = toSet(NOT_WORDS);
  var NOT_NAME = toSet(NOT_WORDS.concat(ROLE_HEADS.split('|')));
  var STOP_AFTER = '(?=\\s+(?:and|but|so|at|for|in|with|on|since|where|who|from|as|here|btw|by the way)\\b|\\s*[,.;:!?()\\n]|\\s*$)';
  var PHRASE = "([^,.;:!?()\\n]{2,60}?)";
  var PREP_RE = /\b(?:of|for|with|about|to|into|from|than|like)\b/i;
  var PLACE_WORD_RE = /\b(?:office|site|port|terminal|yard|vessel|ship|desk|headquarters|hq|branch|building|floor)$/i;

  // "my name is X" and "call me X" are always introductions; a bare "I'm X"
  // counts only when X looks like a name (capitalised, or the whole message
  // is a short introduction), so "I'm frustrated" never becomes a nametag.
  var NAME_RE = new RegExp("\\b(my name(?:'s| is)|name's|call me|you can call me|please call me|i am|i'm|i’m|im)\\s+([a-z][a-z'’-]{0,29}(?:\\s+[a-z][a-z'’-]{0,29}){0,2}?)" + STOP_AFTER, 'i');
  var ROLE_RES = [
    new RegExp("\\bi(?: work| am working|'m working|’m working| currently work| now work) as (?:an? |the )?" + PHRASE + STOP_AFTER, 'i'),
    new RegExp("\\bmy (?:role|job title|title|position|designation) is (?:an? |the )?" + PHRASE + STOP_AFTER, 'i'),
    new RegExp("\\b(?:i am|i'm|i’m|im)\\s+(?:an?|the)\\s+((?:[a-z&/-]+\\s+){0,4}(?:" + ROLE_HEADS + "))\\b", 'i')
  ];
  var MYJOB_RE = new RegExp("\\bmy job is (?:an? |the )?" + PHRASE + STOP_AFTER, 'i');
  var APPOSITIVE_ROLE_RE = new RegExp('^\\s*,\\s*(?:the|an?)\\s+((?:[a-z&/-]+\\s+){0,4}(?:' + ROLE_HEADS + '))\\b', 'i');
  var AFTER_ROLE_COMPANY_RE = new RegExp("^\\s+(?:at|with)\\s+(?:the\\s+)?" + PHRASE + STOP_AFTER, 'i');
  var COMPANY_RES = [
    new RegExp("\\bi(?: work| am working|'m working|’m working| currently work) (?:at|for|with) (?:the\\s+)?" + PHRASE + STOP_AFTER, 'i'),
    new RegExp("\\bmy (?:company|employer|organi[sz]ation|firm) is (?:the\\s+)?" + PHRASE + STOP_AFTER, 'i')
  ];
  var DEPT_RES = [
    /\bi(?: work| am|'m|’m) (?:in|on|with) (?:the )?([a-z][^,.;:!?()\n]{1,40}?) (team|department|dept|division|desk|unit|group)\b/i,
    new RegExp("\\bmy (?:department|team|dept|division|desk) is (?:the\\s+)?" + PHRASE + STOP_AFTER, 'i')
  ];
  var LOC_RES = [
    new RegExp("\\b(?:i am|i'm|i’m|im)\\s+(?:currently\\s+|now\\s+)?(?:based|located|stationed) (?:in|at|out of) " + PHRASE + STOP_AFTER, 'i'),
    new RegExp("\\bi live in " + PHRASE + STOP_AFTER, 'i'),
    new RegExp("\\bour office is in " + PHRASE + STOP_AFTER, 'i'),
    // "… a data engineer at GeoServe, based in Kochi"
    new RegExp("(?:[,;]\\s*|\\band\\s+)(?:currently\\s+|now\\s+)?(?:based|located|stationed) (?:in|at|out of) " + PHRASE + STOP_AFTER, 'i')
  ];
  // "Abhinav here" / "Priya Nair here." — a capitalised name, then "here".
  var HERE_NAME_RE = /^\s*([A-Z][a-z'’-]{1,29}(?:\s+[A-Z][a-z'’-]{1,29})?)\s+here\b/;
  var NOT_PLACE = toSet('home office the office a meeting meetings transit a hurry the loop the middle the zone'.split(' '));
  var INTEREST_RES = [
    /\bi(?:'m|’m| am)? (?:really |mostly |mainly |particularly |especially |currently )?(?:interested in|focus(?:ed|ing)? on|specialis(?:e|ing) in|specializ(?:e|ing) in|work mostly on|mostly work on)\s+([^.;!?\n]{2,120}?)\s*(?=[.;!?\n]|$)/i,
    /\bmy (?:focus|main focus|interests?|area) (?:is|are) (?:on )?([^.;!?\n]{2,120}?)\s*(?=[.;!?\n]|$)/i
  ];
  var NOT_INTEREST_RE = /\b(?:why|how|what|whether|when|where|who|if)\b|^(?:knowing|learning|understanding|finding|seeing|getting|making|doing|hearing|reading|talking|chatting|asking|trying|helping)\b/i;
  var TZ_RE = /\bmy time ?zone is ([A-Za-z_\/+\-0-9: ]{2,40}?)\s*(?=[.,;!?]|$)/i;
  // Abbreviations that mean one zone to GeoServe's users. Ambiguous ones
  // (CST: China or US Central) are left for the user to spell out.
  var TZ_ABBR = { ist: 'Asia/Kolkata', sgt: 'Asia/Singapore', gst: 'Asia/Dubai', jst: 'Asia/Tokyo', kst: 'Asia/Seoul', hkt: 'Asia/Hong_Kong', est: 'America/New_York', edt: 'America/New_York', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', bst: 'Europe/London', gmt: 'Europe/London', cet: 'Europe/Paris', cest: 'Europe/Paris', eet: 'Europe/Athens', aest: 'Australia/Sydney', utc: 'UTC' };
  var STYLE_RES = [
    ['length', 'brief', /\b(?:keep (?:it|them|answers|replies|responses|things) (?:short|brief|concise|crisp|tight)|(?:i )?prefer (?:short|brief|concise|quick|shorter) (?:answers|replies|responses)|be (?:more )?(?:brief|concise|succinct)|(?:short|brief|concise) (?:answers|replies) please|no long (?:answers|replies|essays))\b/i],
    ['length', 'detailed', /\b(?:(?:i )?(?:prefer|like|want) (?:detailed|thorough|in-depth|longer|comprehensive|fuller) (?:answers|replies|responses|explanations)|be (?:more )?(?:detailed|thorough)|(?:detailed|thorough) (?:answers|explanations) please)\b/i],
    ['tone', 'warm', /\b(?:no need to be (?:so )?formal|(?:be|keep it) (?:casual|informal|friendly|relaxed)|don'?t be (?:so )?formal)\b/i],
    ['tone', 'formal', /\b(?:(?:please )?(?:be|keep it|stay) (?:formal|professional)|(?:i )?prefer a (?:formal|professional) tone)\b/i]
  ];

  function toSet(arr) { var o = {}; arr.forEach(function (w) { if (w) o[w.toLowerCase()] = 1; }); return o; }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function lowerFirst(s) { return s && !/^[A-Z]{2,}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s; }
  function titleWord(w) { return w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w; }
  function titleCaseName(s) { return String(s).trim().split(/\s+/).map(titleWord).join(' '); }
  function tidyPhrase(s) { return String(s).replace(/^(?:the|a|an)\s+/i, '').replace(/\s+/g, ' ').trim(); }
  function tidyProper(s) { var t = tidyPhrase(s); return t === t.toLowerCase() ? titleCaseName(t) : t; }
  function tidyRole(s) { var t = tidyPhrase(s); return t === t.toLowerCase() ? capFirst(t) : t; }
  function firstWord(s) { return String(s).trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, ''); }

  function validTz(tz) {
    if (!tz) return false;
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch (_) { return false; }
  }
  function normaliseTz(raw) {
    var t = oneLine(raw, 64);
    if (!t) return null;
    if (TZ_ABBR[t.toLowerCase()]) return TZ_ABBR[t.toLowerCase()];
    return validTz(t) ? t : null;
  }
  function detectedTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; } }

  function nameOk(candidate, bare, text) {
    var words = String(candidate).trim().split(/\s+/);
    if (!words.length || words.length > 3) return false;
    for (var i = 0; i < words.length; i++) {
      var w = words[i].toLowerCase().replace(/[^a-z]/g, '');
      if (!w || NOT_NAME[w]) return false;
      if (bare && /(?:ed|ing|ful|ly|ous|ive|able|ible|less|ish|ic)$/.test(w) && w.length > 4) return false;
    }
    if (isSensitive(candidate)) return false;
    // "I'm alex" is an introduction when that is the whole message; inside a
    // longer sentence a bare name has to look like one.
    if (bare && !/^[A-Z]/.test(words[0]) && String(text).trim().split(/\s+/).length > 4) return false;
    return true;
  }

  /** A department or company value that reads as a thing, not a sentence. */
  function orgOk(v) {
    var t = tidyPhrase(v);
    if (!t || t.split(/\s+/).length > 6) return false;
    if (NOT_ROLE[firstWord(t)]) return false;
    if (PREP_RE.test(t)) return false;
    return true;
  }

  /**
   * Facts the user stated about themselves in `text`, as [{ key, value }].
   * Questions, long pasted text and anything sensitive propose nothing.
   */
  function detectFacts(text) {
    var t = String(text || '').trim();
    var out = [];
    if (!t || t.length > 400 || t.split('\n').length > 4) return out;
    if (/\?\s*$/.test(t) || /^\s*(?:what|who|where|when|which|why|how|is|are|am|do|does|did|can|could|would|should|will)\b/i.test(t)) return out;
    if (isSensitive(t)) return out;
    var seen = {};
    var add = function (key, value) {
      value = oneLine(value, FIELD[key] && FIELD[key].max);
      if (!value || seen[key]) return;
      seen[key] = 1;
      out.push({ key: key, value: value });
    };
    var m, i;

    // "call me X" is how they want to be addressed; the other forms are a name.
    m = t.match(NAME_RE);
    var nameEnd = -1;
    if (m) {
      var intro = /^(?:my name|name's|call me|you can call me|please call me)/i.test(m[1]);
      if (nameOk(m[2], !intro, t)) {
        add(/call me/i.test(m[1]) ? 'preferredName' : 'name', titleCaseName(m[2]));
        nameEnd = m.index + m[0].length;
      }
    }
    m = !seen.name && t.match(HERE_NAME_RE);
    if (m && nameOk(m[1], false, t)) add('name', m[1]);

    var roleEnd = -1;
    var roleOk = function (r) { return r && r.split(/\s+/).length <= 6 && !NOT_ROLE[r.toLowerCase()] && !NOT_ROLE[firstWord(r)] && /[a-z]/i.test(r) && !/^(?:to|about)\b/i.test(r); };
    if (nameEnd >= 0) {
      m = t.slice(nameEnd).match(APPOSITIVE_ROLE_RE);
      if (m && roleOk(tidyRole(m[1]))) { add('role', tidyRole(m[1])); roleEnd = nameEnd + m.index + m[0].length; }
    }
    for (i = 0; i < ROLE_RES.length && !seen.role; i++) {
      m = t.match(ROLE_RES[i]);
      if (m && roleOk(tidyRole(m[1]))) { add('role', tidyRole(m[1])); roleEnd = m.index + m[0].length; }
    }
    // "my job is …" is as often a duty as a title: only a title counts.
    if (!seen.role) {
      m = t.match(MYJOB_RE);
      if (m && ROLE_HEAD_RE.test(m[1]) && roleOk(tidyRole(m[1]))) { add('role', tidyRole(m[1])); roleEnd = m.index + m[0].length; }
    }
    if (roleEnd >= 0) {
      m = t.slice(roleEnd).match(AFTER_ROLE_COMPANY_RE);
      if (m && orgOk(m[1]) && !PLACE_WORD_RE.test(m[1].trim())) {
        if (/\b(team|department|dept|division|desk|unit|group)$/i.test(m[1].trim())) add('department', tidyRole(m[1]));
        else add('company', tidyProper(m[1]));
      }
    }
    for (i = 0; i < DEPT_RES.length && !seen.department; i++) {
      m = t.match(DEPT_RES[i]);
      if (!m) continue;
      var dept = m[1] + (m[2] && /team|desk|unit|group/i.test(m[2]) ? ' ' + m[2].toLowerCase() : '');
      if (orgOk(m[1])) add('department', tidyRole(dept));
    }
    for (i = 0; i < COMPANY_RES.length && !seen.company; i++) {
      m = t.match(COMPANY_RES[i]);
      if (!m || !orgOk(m[1]) || PLACE_WORD_RE.test(m[1].trim())) continue;
      if (/\b(team|department|dept|division|desk|unit|group)$/i.test(m[1].trim())) { if (!seen.department) add('department', tidyRole(m[1])); }
      else add('company', tidyProper(m[1]));
    }
    for (i = 0; i < LOC_RES.length && !seen.location; i++) {
      m = t.match(LOC_RES[i]);
      if (m && !NOT_PLACE[tidyPhrase(m[1]).toLowerCase()] && orgOk(m[1])) add('location', tidyProper(m[1]));
    }
    m = t.match(TZ_RE);
    if (m) { var tz = normaliseTz(m[1]); if (tz) add('timezone', tz); }
    for (i = 0; i < INTEREST_RES.length && !seen.interests; i++) {
      m = t.match(INTEREST_RES[i]);
      if (!m || NOT_INTEREST_RE.test(m[1].trim())) continue;
      var items = m[1].split(/\s*(?:,|;|\band\b|&|\/)\s*/i).map(tidyPhrase).filter(function (x) { return x && x.length <= 60 && !NOT_NAME[x.toLowerCase()]; }).slice(0, 6);
      if (items.length) add('interests', items.map(function (x) { return x !== x.toLowerCase() ? x : x.length <= 4 ? x.toUpperCase() : capFirst(x); }).join(', '));
    }
    STYLE_RES.forEach(function (s) { if (!seen[s[0]] && s[2].test(t)) add(s[0], s[1]); });
    return out;
  }

  // --- explicit memory commands --------------------------------------------------
  // "remember that …", "forget my role", "what do you remember about me?"
  // "X means Y" is vocabulary teaching and belongs to the server.
  var TEACH_RE = /\b(means|stands for|is short for|refers to|is the same as|is an? (?:abbreviation|acronym) for)\b/i;
  var REMEMBER_RE = /^\s*(?:(?:hey |ok |okay )?kris[,:]?\s+)?(?:please\s+|can you\s+|could you\s+)?(?:remember|memori[sz]e|keep in mind|don'?t forget|make a note)\s*(?:that\s+|this:?\s+|of\s+)?([\s\S]{3,300}?)\s*[.!]*\s*$/i;
  var FORGET_RE = /^\s*(?:(?:hey |ok |okay )?kris[,:]?\s+)?(?:please\s+|can you\s+|could you\s+)?(?:forget|stop remembering|don'?t remember|unlearn|erase)\s+(?:about\s+)?([\s\S]{1,120}?)\s*[.!]*\s*$/i;
  var RECALL_RE = /^\s*(?:so\s+|and\s+|ok\s+|okay\s+)?(?:what (?:do|did) you (?:know|remember) about me|what (?:do|did|else do) you remember|what(?:'s| is) in (?:your )?memory|what have you (?:saved|remembered|stored|learned|learnt)(?: about me)?|show (?:me )?(?:my |your )?(?:saved )?memor(?:y|ies)|what do you know of me|what are you remembering)\s*[?.!]*\s*$/i;
  var FORGET_ALL_RE = /^(?:everything|all|it all|all of (?:it|that|this)|all about me|everything about me|me|what you (?:know|remember)(?: about me)?|my (?:data|details|profile|memory))$/i;
  var FORGET_LAST_RE = /^(?:that|this|the last (?:one|thing)|what i just (?:said|told you))$/i;
  // Most specific first: "my company name" is the company, not the user's name.
  var FORGET_FIELDS = [
    [/\b(?:preferred name|nickname|what to call me|what you call me)\b/i, ['preferredName']],
    [/\b(?:company|employer|organi[sz]ation|firm|where i work)\b/i, ['company']],
    [/\b(?:department|team|dept|division|desk)\b/i, ['department']],
    [/\b(?:role|job|title|position|designation|what i do)\b/i, ['role']],
    [/\b(?:location|city|where i (?:live|am|'m) based|where i live|where i am)\b/i, ['location']],
    [/\btime ?zone\b/i, ['timezone']],
    [/\binterests?\b/i, ['interests']],
    [/\b(?:style|preferences?|tone|length)\b/i, ['length', 'tone']],
    [/\binstructions?\b/i, ['instructions']],
    [/^(?:(?:my )?(?:full )?name|who i am)$/i, ['name', 'preferredName']]
  ];

  // --- questions about the user: "what do you know about me?", "where do I work?" --
  // Answered from the profile and this chat, never by the app guide or a
  // model, never guessed. Recognised by the SHAPE of the question — a recall
  // verb aimed at "me", "who am I", "my <field>" asked as a question — so
  // "wat u kno abt me" and "what have you got on me" are the same question.
  // src/identity.js carries the same classifier, line for line;
  // test/about_me_test.js runs one corpus through both.
  function normaliseQuestion(text) {
    return ' ' + String(text || '').toLowerCase()
      .replace(/[‘’`´]/g, "'")
      .replace(/[^a-z0-9'\s]/g, ' ')
      .replace(/\b(?:were|wher|whre|wehre)\b/g, 'where')
      .replace(/\b(?:wat|wht|whta|waht|wot|wut)\b/g, 'what')
      .replace(/\bwhat'?s\b/g, 'what is')
      .replace(/\bwho'?s\b/g, 'who is')
      .replace(/\b(?:comp|compny|companey|compnay|cmpany|campany|co)\b/g, 'company')
      .replace(/\b(?:ur|yr)\b/g, 'your')
      .replace(/\b(?:u|ya|yu|yuo)\b/g, 'you')
      .replace(/\b(?:i'?m|im)\b/g, 'i am')
      .replace(/\b(?:wrk|wok|werk)\b/g, 'work')
      .replace(/\bdept\b/g, 'department')
      .replace(/\b(?:abt|abut|bout|abot)\b/g, 'about')
      .replace(/\b(?:kno|knw|knwo|nkow)\b/g, 'know')
      .replace(/\b(?:rember|remeber|remembr|rmember|remmember|rememeber)\b/g, 'remember')
      .replace(/\b(?:info|infos|informations)\b/g, 'information')
      .replace(/\bdeets\b/g, 'details')
      .replace(/\b(?:myslef|myslf|mysef)\b/g, 'myself')
      .replace(/\bnmae\b/g, 'name')
      .replace(/\b(?:please|pls|plz|kris|k r 1 s|k r i s|hey|hi|hello|ok|okay|so|btw|actually|exactly|really|now|again|then|anyway)\b/g, ' ')
      .replace(/\s+/g, ' ').trim() + ' ';
  }
  // A statement about themselves is information, not a question about it —
  // unless it is phrased as a question ("who do I work for?", "what do you call me").
  var ABOUT_QUESTION_START_RE = /^ (?:what|who|where|which|how|do|did|does|can|could|would|will|is|are|tell|remind|show|describe|give|list|say|any|anything|my) /;
  var ABOUT_STATEMENT_RE = / (?:my name is|i am called|call me|i work (?:as|at|for|in|on|with)|i am (?:an? |the |based |from |in |at )|i live |i would like you to (?:know|remember)|i want you to (?:know|remember)) /;
  // "my <field>" asked as a question, and nothing after it but the field's name.
  var ABOUT_Q = '(?:what is|what are|what was|what were|which is|tell me|remind me(?: of)?|do you (?:know|remember|have)|did you (?:get|catch|save)|you know|remember|recall|what|which|say|confirm)';
  function aboutFieldRe(words) {
    return new RegExp(' ' + ABOUT_Q + ' (?:\\w+ ){0,2}my (?:' + words + ')(?: name| called)? $|^ my (?:' + words + ')(?: name)? $');
  }
  var ABOUT_TOPICS = [
    ['name', [/ what (?:do|should|will|would) you call me | (?:know|remember) (?:what )?i am called /, aboutFieldRe('(?:full |first |last |preferred )?name|nickname')]],
    ['role', [/ what (?:do|did) i do(?: for (?:work|a living))? $| what (?:do|did) i work as /, aboutFieldRe('role|job|job title|title|position|designation|profession|occupation')]],
    ['work', [/ where (?:do|did) i work | who do i work for | (?:what|which) company (?:do|am|did) i /, aboutFieldRe('company|employer|organi[sz]ation|firm|workplace|office')]],
    ['department', [/ (?:which|what) (?:department|team|division|unit) (?:am i|do i) /, aboutFieldRe('department|team|division|unit|desk')]],
    ['location', [/ where am i (?:based|located|working from|from) | where do i (?:live|work from|stay) /, aboutFieldRe('location|city|country|base|hometown|home town')]],
    ['timezone', [/ (?:which|what) time ?zone (?:am i|do i) /, aboutFieldRe('time ?zone')]],
    ['interests', [/ what (?:am i interested in|are my interests|do i focus on|do i care about) /, aboutFieldRe('interests?|focus|speciali[sz]ation|speciality|specialty')]]
  ];
  // Everything K.R.1.S knows about the user.
  var ABOUT_ALL = [
    / who am i /,
    / (?:do|did|does) you (?:still )?(?:know|remember|recogni[sz]e) (?:who i am|me) /,
    / (?:know|remember|recall|have|got|hold|keep|kept|store|stored|save|saved|learn|learned|learnt|collect|collected|gather|gathered|noted) (?:\w+ ){0,5}(?:about|on|of|regarding) (?:me|myself) /,
    / (?:information|details|data|facts|profile|memory|memories|notes?) (?:\w+ ){0,4}(?:about|on|of|regarding) (?:me|myself) /,
    / (?:tell|talk|say|share|show|list|describe|summari[sz]e|give|remind) (?:me )?(?:\w+ ){0,3}(?:about|of) (?:me|myself) /,
    / describe me /,
    /^ (?:about|on) me $/,
    / (?:said|asked|asking|meant|mean|talking) (?:about )?(?:me|myself) $/,
    / (?:my|your) (?:profile|saved details|personal details|personal information)(?: on me)? $/,
    / what is (?:in )?my (?:information|details|profile) /,
    / who do you think i am /
  ];
  /** Which question about the user this is ('all', 'name', 'role', …), or null. */
  function aboutTopic(text) {
    var raw = String(text || '');
    if (!raw.trim() || raw.length > 200 || /\n/.test(raw)) return null;
    // "Forget my company", "remember that I …" are memory commands, not questions.
    if (/^\s*(?:(?:hey |ok |okay )?kris[,:]?\s+)?(?:please\s+)?(?:forget|remember|don'?t forget|stop remembering|erase|keep in mind|save|store|note)\b/i.test(raw) && !/\?\s*$/.test(raw)) return null;
    var n = normaliseQuestion(raw);
    if (/ who am i (?:talking|speaking|chatting|with|to) /.test(n)) return null;
    if (!ABOUT_QUESTION_START_RE.test(n) && !/\?\s*$/.test(raw) && ABOUT_STATEMENT_RE.test(n)) return null;
    for (var i = 0; i < ABOUT_TOPICS.length; i++) {
      for (var j = 0; j < ABOUT_TOPICS[i][1].length; j++) if (ABOUT_TOPICS[i][1][j].test(n)) return ABOUT_TOPICS[i][0];
    }
    for (var k = 0; k < ABOUT_ALL.length; k++) if (ABOUT_ALL[k].test(n)) return 'all';
    return null;
  }
  // "what?" / "huh?" after an answer: the last reply missed.
  var CONFUSED_RE = /^\s*(?:(?:what|wat|huh|eh|pardon|come again|what do you mean|i don'?t (?:get it|understand)|that'?s not what i (?:asked|meant))\s*[?!.]*|sorry\s*\?+)\s*$/i;

  var FIELD_FOR_TOPIC = { work: ['company', 'department', 'role'], role: ['role'], department: ['department'], location: ['location'], timezone: ['timezone'], interests: ['interests'], name: ['name', 'preferredName'] };

  function parseMemoryCommand(text) {
    var t = String(text || '').trim();
    if (!t || t.length > 320) return null;
    if (RECALL_RE.test(t)) return { type: 'recall' };
    var m = t.match(REMEMBER_RE);
    if (m && !TEACH_RE.test(m[1]) && !/\?\s*$/.test(t) && !/^[,;]/.test(m[1]) && !/^(?:to|when|what|how|where|who|if|the (?:last|first) time)\b/i.test(m[1])) return { type: 'remember', content: m[1].trim() };
    m = t.match(FORGET_RE);
    // "Forget that, show me …" is a new request, not a memory command.
    if (m && !/\?\s*$/.test(t) && !/[,;:]/.test(m[1]) && m[1].trim().split(/\s+/).length <= 8) {
      return { type: 'forget', target: m[1].trim().replace(/^(?:my|the|about)\s+/i, ''), raw: t };
    }
    // Last, so "forget my company name" stays a forget, not a question.
    if (REMEMBER_RE.test(t) || FORGET_RE.test(t)) return null;
    var topic = aboutTopic(t);
    if (topic) return topic === 'all' ? { type: 'recall' } : { type: 'about', topic: topic };
    return null;
  }

  /** "I'm a superintendent" → "You're a superintendent" — for a note read back to the user. */
  function secondPerson(s) {
    return String(s).replace(/^i am\b/i, 'You are').replace(/^i'm\b/i, 'You’re').replace(/^i’m\b/i, 'You’re').replace(/^i\b/i, 'You').replace(/\bmy\b/g, 'your').replace(/\bme\b/g, 'you');
  }

  function article(s) { return /^[aeiou]/i.test(s) && !/^(?:uni|use|eu)/i.test(s) ? 'an' : 'a'; }
  function joinOr(list) { return list.length <= 1 ? list.join('') : list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1]; }
  var UNKNOWN_USER = 'I don’t have enough information about you yet. Tell me your name and a few basics — your role, where you work, where you’re based — and I’ll use them in this chat and offer to remember them for next time.';

  /** The question on the "remember this?" card for one fact. */
  function askFor(f) {
    var v = f.value;
    switch (f.key) {
      case 'name': return 'Would you like me to remember your name, ' + v + '?';
      case 'preferredName': return 'Should I call you ' + v + ' from now on?';
      case 'role': return 'Would you like me to remember that you’re ' + article(v) + ' ' + lowerFirst(v) + '?';
      case 'company': return 'Should I remember that you work at ' + v + '?';
      case 'department': return 'Should I remember that you’re in ' + v + '?';
      case 'location': return 'Should I remember that you’re based in ' + v + '?';
      case 'timezone': return 'Should I use ' + v + ' as your time zone?';
      case 'interests': return 'Should I remember that you’re interested in ' + v + '?';
      case 'length': return v === 'brief' ? 'Should I keep my answers brief from now on?' : v === 'detailed' ? 'Should I give fuller, more detailed answers from now on?' : 'Should I remember your answer-length preference?';
      case 'tone': return v === 'formal' ? 'Should I keep a formal tone from now on?' : 'Should I keep things relaxed and conversational from now on?';
      default: return 'Should I remember this for next time?';
    }
  }

  /** How a fact reads back in a sentence: "that you're a marine emissions analyst". */
  function sayFact(key, value) {
    switch (key) {
      case 'name': return 'your name is ' + value;
      case 'preferredName': return 'you’d like me to call you ' + value;
      case 'role': return 'you’re ' + article(value) + ' ' + lowerFirst(value);
      case 'company': return 'you work at ' + value;
      case 'department': return 'you’re in ' + value;
      case 'location': return 'you’re based in ' + value;
      case 'timezone': return 'your time zone is ' + value;
      case 'interests': return 'you’re interested in ' + value;
      case 'length': return 'you prefer ' + choiceLabel('length', value).toLowerCase() + ' answers';
      case 'tone': return 'you prefer a ' + choiceLabel('tone', value).toLowerCase() + ' tone';
      case 'instructions': return 'your instructions: “' + value + '”';
      default: return value;
    }
  }

  // --- role-aware suggestions for the empty state ---------------------------------
  // Only phrasings the data parser already understands; no vessel is named, so
  // the page context (or a clarifying question) supplies it.
  var PERSONA_PROMPTS = [
    { re: /emission|compliance|environment|sustainab|esg|decarbon|carbon|fueleu|ets|\bcii\b|regulat|green/i, prompts: [
      { tag: 'Briefing', text: 'Anything I should know today?' },
      { tag: 'Compliance', text: 'Compliance balance this quarter' },
      { tag: 'Compliance', text: 'GHG intensity this year' },
      { tag: 'Data', text: 'Leg CO2 last month' }
    ] },
    { re: /technical|superintend|engineer|chief|machinery|fleet manager|marine super|maintenance|performance/i, prompts: [
      { tag: 'Briefing', text: 'Anything I should know today?' },
      { tag: 'Data', text: 'Shaft power trend last 30 days' },
      { tag: 'Data', text: 'ME consumption last month' },
      { tag: 'Data', text: 'Average speed last week' }
    ] },
    { re: /commercial|charter|operat|voyage|broker|trader|freight|post.?fixture|claims/i, prompts: [
      { tag: 'Briefing', text: 'Anything I should know today?' },
      { tag: 'Data', text: 'Off hire hours this year' },
      { tag: 'Data', text: 'Leg distance last month' },
      { tag: 'Data', text: 'Fuel consumption last month' }
    ] }
  ];

  // --- time labels ---------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function dayStart(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
  function whenLabel(at, now) {
    now = now || Date.now();
    var d = new Date(at);
    var diff = now - at;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.round(diff / 60000) + ' min ago';
    var today = dayStart(now);
    if (at >= today) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (at >= today - 86400000) return 'Yesterday';
    if (at >= today - 6 * 86400000) return DAYS[d.getDay()];
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date(now).getFullYear() ? ' ' + d.getFullYear() : '');
  }
  function dateLabel(at) { var d = new Date(at); return d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function bucketOf(at, now) {
    var today = dayStart(now || Date.now());
    if (at >= today) return 'Today';
    if (at >= today - 86400000) return 'Yesterday';
    if (at >= today - 6 * 86400000) return 'Previous 7 days';
    if (at >= today - 29 * 86400000) return 'Previous 30 days';
    return 'Older';
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /** A conversation's title: its first real question, not "hi". { title, real } */
  function titleFor(turns) {
    var first = null, real = false;
    for (var i = 0; i < turns.length; i++) {
      if (turns[i].role !== 'user') continue;
      var t = oneLine(turns[i].text);
      if (!first) first = t;
      if (t.split(' ').length >= 3 && !localReply(t, null)) { first = t; real = true; break; }
    }
    if (!first) return { title: 'New conversation', real: false };
    first = capFirst(first.replace(/[?.!]+$/, ''));
    return { title: first.length > 60 ? first.slice(0, 57).replace(/\s+\S*$/, '') + '…' : first, real: real };
  }

  // --- user settings -------------------------------------------------------------
  // Browser-wide, not personal: kept apart from memory, and reset on their own.
  var SETTINGS_KEY = 'kris:settings';
  var SETTING_DEFAULTS = {
    textSize: 'm',           // 's' | 'm' | 'l'
    density: 'comfortable',  // 'comfortable' | 'compact'
    timestamps: true,
    motion: 'system',        // 'system' | 'reduce'
    character: true,         // the character's idle animation
    sendWithEnter: true,
    followups: true,
    history: true
  };

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
    theme: 'auto',          // 'light' | 'dark' | 'auto' (follows the OS until the user picks one)
    themeToggle: true,      // show the light/dark switch in the header
    rememberTheme: true,    // keep the user's pick for this browser (localStorage)
    onThemeChange: null,    // fn(theme 'light'|'dark', preference 'light'|'dark'|'auto')
    brand: null,            // { accent, accentDark, accent2, font }
    nudge: true,            // first-visit speech bubble on the badge
    nudgeText: 'Namaste! Ask me anything about your fleet.',
    followups: true,        // contextual next-question chips after a data answer (the user can change it)
    persist: true,          // keep the conversation for this tab (sessionStorage); false also turns history off
    localReplies: true,     // answer pure greetings/thanks instantly, offline
    mapTiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', // map tiles for position answers; false: no tiles, positions only
    warm: true,             // warm the server connection when the page is idle
    maxLength: 8000,
    timeoutMs: 90000,       // longest SILENCE before giving up; every streamed event restarts it
    onOpen: null,
    onClose: null,
    onAnswer: null,
    onReaction: null,       // fn({reaction,question,answer,source,status,at})
    reactionEndpoint: null, // optional URL to POST reaction feedback to

    // --- people -------------------------------------------------------------
    user: null,             // { id, name, preferredName, role, company, department, location, timezone }
                            // from your own account record. `id` keeps each user's memory and history
                            // apart on a shared browser; the other fields pre-fill the profile
                            // ("From your account") and the user can still edit or remove them.
    memory: true,           // false: no long-term memory at all — no Profile or Memory, nothing kept
    memoryStore: null,      // { load(): memory|Promise, save(memory): void|Promise } to keep memory in
                            // your own backend instead of this browser (e.g. to follow the user across devices)
    onMemoryChange: null,   // fn(memory) whenever what K.R.1.S remembers changes
    history: true,          // keep past conversations on this device (localStorage)
    historyDays: 30,        // …for this long
    historyMax: 40,         // …and at most this many
    settings: null,         // defaults for the user's settings: { textSize, density, timestamps, motion,
                            // character, sendWithEnter, followups, history }
    hotkey: null            // e.g. 'mod+k': open / close from anywhere on the page (mod = Ctrl, or ⌘ on a Mac)
  };

  // What the model sees of this chat (the server applies the same limits).
  var HISTORY_TURNS = 20;
  var HISTORY_CHARS = 6000;

  var THEMES = ['light', 'dark', 'auto'];
  var THEME_KEY = 'kris:theme';
  var NUDGE_KEY = 'kris:nudge';
  var VIEW_TITLES = { history: 'History', profile: 'Profile', memory: 'Memory', appearance: 'Appearance', settings: 'Settings', about: 'About' };
  var CLIENT = { v: VERSION, features: ['stream', 'profile', 'memory', 'actions'] };
  var NAME_MEANING = 'K.R.1.S is a codename inspired by Lord Krishna — the calm charioteer who guided Arjuna without ever taking the reins from him. That is the idea here: I guide you through your fleet’s records and the app, and you stay in charge.';

  function Widget(options) {
    this.opts = assign({}, DEFAULTS, options || {});
    VZ_MAP_TILES = this.opts.mapTiles;
    if (options && options.examples && !options.examples.length) this.opts.examples = [];
    this._customExamples = !!(options && Array.isArray(options.examples));
    this.pending = null;
    this.history = [];
    this.turns = [];          // this conversation: { role, text, data, at, ms, send, memo }
    this.context = null;      // what questions default to: the user's pick, else the host page's vessel
    this.pageContext = null;  // set by the host page (KRIS.setContext)
    this.pick = null;         // set by the user in the picker: { fleet: true } or { vesselId, vesselName }; kept with the chat
    this._vessels = null;     // the picker's list, loaded on first open
    this.convId = uid();
    this.convFacts = {};      // conversation context: what the user said about themselves in THIS chat
    this.suggested = {};      // "key|value" already offered for memory in this chat
    this.busy = false;
    this.open = false;
    this.inline = false;
    this.view = 'chat';
    this.currentMood = 'idle';
    this.submitTimes = [];
    this.turnCount = 0;
    this._lastNorm = null;
    this._stick = true;
    this._conn = 'connecting';
    this._listeners = {};
    this._osReducedMotion = mediaMatches('(prefers-reduced-motion: reduce)');
    this._reducedMotion = this._osReducedMotion;
    this._hotkey = parseHotkey(this.opts.hotkey);
    this._hostFollowups = this.opts.followups !== false;   // the host's default, kept apart from the user's choice
    this.setIdentity(this.opts.user);
    this.settings = this.loadSettings();
    this.memLoad();
    this.mount();
  }

  /** Storage namespaces: per endpoint, and per user when the host says who. */
  Widget.prototype.setIdentity = function (user) {
    var u = user && typeof user === 'object' ? user : null;
    this._userId = u && u.id != null ? String(u.id).slice(0, 200) : '';
    this._ns = 'kris:v2:' + hashStr(this.opts.endpoint + '|' + this._userId);
    this._storeKey = 'kris:v1:' + this.opts.endpoint + (this._userId ? '|' + hashStr(this._userId) : '');
  };

  // --- storage (every access guarded; storage can be absent or throw) --------
  function store(kind) {
    try { var s = kind === 'local' ? global.localStorage : global.sessionStorage; var k = '__kris_probe'; s.setItem(k, '1'); s.removeItem(k); return s; }
    catch (_) { return null; }
  }
  function readLocal(key) { try { var s = store('local'); return s ? s.getItem(key) : null; } catch (_) { return null; } }
  function writeLocal(key, value) {
    try { var s = store('local'); if (!s) return false; if (value == null) s.removeItem(key); else s.setItem(key, value); return true; } catch (_) { return false; }
  }
  function readJSON(key) { var raw = readLocal(key); if (!raw) return null; try { return JSON.parse(raw); } catch (_) { return null; } }
  function writeJSON(key, obj) { return writeLocal(key, obj == null ? null : JSON.stringify(obj)); }

  // --- events: KRIS.on('memory' | 'settings' | 'view' | 'conversation' | 'open' | 'close' | 'answer', fn)
  Widget.prototype.on = function (evt, fn) { (this._listeners[evt] = this._listeners[evt] || []).push(fn); };
  Widget.prototype.off = function (evt, fn) {
    var l = this._listeners[evt]; if (!l) return;
    var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
  };
  Widget.prototype.emit = function (evt, payload) {
    var l = (this._listeners[evt] || []).concat(this._listeners['*'] || []);
    for (var i = 0; i < l.length; i++) { try { l[i](payload, evt); } catch (_) { /* host hook */ } }
  };

  // --- settings ----------------------------------------------------------------
  Widget.prototype.loadSettings = function () {
    var s = assign({}, SETTING_DEFAULTS);
    if (!this._hostFollowups) s.followups = false;
    var host = this.opts.settings;
    var k;
    if (host && typeof host === 'object') for (k in SETTING_DEFAULTS) if (typeof host[k] === typeof SETTING_DEFAULTS[k]) s[k] = host[k];
    var saved = readJSON(SETTINGS_KEY);
    if (saved && typeof saved === 'object') for (k in SETTING_DEFAULTS) if (typeof saved[k] === typeof SETTING_DEFAULTS[k]) s[k] = saved[k];
    return s;
  };

  Widget.prototype.setSetting = function (key, value) {
    if (!(key in SETTING_DEFAULTS) || typeof value !== typeof SETTING_DEFAULTS[key]) return false;
    this.settings[key] = value;
    var saved = readJSON(SETTINGS_KEY);
    if (!saved || typeof saved !== 'object') saved = {};
    saved[key] = value;
    writeJSON(SETTINGS_KEY, saved);
    this.applySettings();
    if (key === 'history' && value) this.save();
    this.emit('settings', assign({}, this.settings));
    return true;
  };

  Widget.prototype.resetSettings = function () {
    writeJSON(SETTINGS_KEY, null);
    if (this.opts.rememberTheme) writeLocal(THEME_KEY, null);
    this.settings = this.loadSettings();
    this._themePref = THEMES.indexOf(this.opts.theme) >= 0 ? this.opts.theme : 'auto';
    this.applyTheme(true);
    this.applySettings();
    this.emit('settings', assign({}, this.settings));
  };

  Widget.prototype.applySettings = function () {
    var s = this.settings, r = this.root;
    if (!r) return;
    r.setAttribute('data-size', s.textSize === 's' || s.textSize === 'l' ? s.textSize : 'm');
    r.setAttribute('data-density', s.density === 'compact' ? 'compact' : 'comfortable');
    r.setAttribute('data-times', s.timestamps ? 'on' : 'off');
    var calm = s.motion === 'reduce';
    r.classList.toggle('calm', calm);
    r.classList.toggle('still', !s.character);
    this._reducedMotion = this._osReducedMotion || calm;
    this._still = !s.character || this._reducedMotion;
    this.opts.followups = !!s.followups;
    if (this._still && this.badgeFace) this.clearEyeOffset();
    if (this.input) this.input.setAttribute('enterkeyhint', s.sendWithEnter ? 'send' : 'enter');
    this.updateHint();
  };

  // --- this tab's working copy of the conversation (sessionStorage) -------------
  // The same conversation is also archived to History (localStorage) when
  // history is on; this copy is what makes a page navigation seamless.
  Widget.prototype.save = function () {
    if (this._restoring) return;
    if (this.opts.persist) {
      var s = store('session');
      if (s) {
        try {
          var turns = this.turns.slice(-40);
          var rec = { v: 2, id: this.convId, turns: turns, facts: this.convFacts, suggested: this.suggested, pending: this.pending, pick: this.pick, open: this.open, wide: this.root.classList.contains('wide'), at: Date.now() };
          var blob = JSON.stringify(rec);
          if (blob.length > 400000) { rec.turns = turns.slice(-10); blob = JSON.stringify(rec); }
          s.setItem(this._storeKey, blob);
        } catch (_) { /* quota or privacy mode: memory only */ }
      }
    }
    this.histSaveCurrent();
  };

  Widget.prototype.load = function () {
    if (!this.opts.persist) return null;
    var s = store('session'); if (!s) return null;
    try {
      var raw = s.getItem(this._storeKey);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || (d.v !== 1 && d.v !== 2) || !Array.isArray(d.turns)) return null;
      if (Date.now() - (d.at || 0) > 12 * 3600 * 1000) return null;
      // An older build kept only the name, for this tab: it is conversation context.
      if (d.v === 1 && d.userName) d.facts = { name: String(d.userName).slice(0, 60) };
      return d;
    } catch (_) { return null; }
  };

  /**
   * The character on its gold-rimmed indigo disc, appended into `parent`.
   * Returns the figure wrapper and the SVG so moods can be driven on it.
   */
  function portrait(parent, prefix, withNotes) {
    parent.appendChild(el('span', 'disc'));
    var fig = el('span', 'fig');
    fig.innerHTML = krisSvg(prefix);
    parent.appendChild(fig);
    if (withNotes) {
      var notes = el('span', 'notes');
      for (var i = 0; i < 3; i++) { var n = el('i'); n.innerHTML = NOTE; notes.appendChild(n); }
      parent.appendChild(notes);
    }
    var svg = fig.querySelector('svg');
    svg.setAttribute('data-mood', 'idle');
    return { fig: fig, svg: svg };
  }

  // --- mount -------------------------------------------------------------------
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
    root.setAttribute('data-conn', 'connecting');
    root.setAttribute('data-mood', 'idle');
    var brand = this.opts.brand;
    if (brand) {
      if (brand.accent) root.style.setProperty('--brand-accent', String(brand.accent));
      if (brand.accentDark) root.style.setProperty('--brand-accent-dark', String(brand.accentDark));
      if (brand.accent2) root.style.setProperty('--brand-accent-2', String(brand.accent2));
      if (brand.font) { root.style.setProperty('--font', String(brand.font)); root.style.setProperty('--display', String(brand.font)); }
    }
    var mountEl = this.opts.mount ? (typeof this.opts.mount === 'string' ? document.querySelector(this.opts.mount) : this.opts.mount) : null;
    this.inline = !!mountEl;
    if (this.inline) root.classList.add('inline');
    else if (this.opts.position === 'left') root.classList.add('left');
    this.root = root;

    // A remembered pick beats the host's default; the host's default beats the OS.
    var remembered = this.opts.rememberTheme ? readLocal(THEME_KEY) : null;
    this.initTheme(remembered === 'light' || remembered === 'dark' ? remembered : this.opts.theme);

    var panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', this.opts.title);
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('data-view', 'chat');
    panel.id = 'kris-panel';
    this.panel = panel;
    panel.appendChild(this.buildHeader());

    // Everything under the header lives on one stage: the conversation and
    // composer, the section views that slide over them, the drawer, toasts.
    var stage = el('div', 'stage');
    this.stage = stage;
    stage.appendChild(this.buildBody());
    stage.appendChild(this.buildComposer());
    this.viewsEl = el('div', 'views');
    this.panes = {};
    stage.appendChild(this.viewsEl);
    stage.appendChild(this.buildDrawer());
    this.toasts = el('div', 'toasts');
    this.toasts.setAttribute('role', 'status');
    this.toasts.setAttribute('aria-live', 'polite');
    stage.appendChild(this.toasts);
    panel.appendChild(stage);

    this.live = el('div', 'sr');
    this.live.setAttribute('aria-live', 'polite');
    this.live.setAttribute('role', 'status');
    panel.appendChild(this.live);
    root.appendChild(panel);

    var nudge = this.buildNudge();
    if (nudge) root.appendChild(nudge);
    root.appendChild(this.buildLauncher());
    shadow.appendChild(root);
    this.applySettings();

    // Esc peels back one layer at a time: drawer, then section, then the panel.
    this._onKeydown = function (e) {
      if (self._hotkey && hotkeyMatch(self._hotkey, e)) { e.preventDefault(); self.toggle(); return; }
      if (e.key !== 'Escape' || !self.open) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(self.host) < 0 && document.activeElement !== self.host) return;
      if (!self.ctxMenu.hidden) { self.closePicker(true); return; }
      if (self.panel.classList.contains('drawer-open')) { self.toggleDrawer(false); return; }
      if (self.view !== 'chat') { self.showView('chat'); return; }
      if (self.busy) { self.stop(); return; }
      if (!self.inline) self.close();
    };
    document.addEventListener('keydown', this._onKeydown);
    root.addEventListener('keydown', function (e) { self.trapDrawerFocus(e); });
    root.addEventListener('pointerdown', function (e) {
      var p = e.composedPath ? e.composedPath() : [];
      if (!self.ctxMenu.hidden && p.indexOf(self.ctxMenu) < 0 && p.indexOf(self.ctxChip) < 0) self.closePicker();
    });

    // Another tab changed what K.R.1.S remembers: follow it.
    this._onStorage = function (e) {
      if (!e || e.key !== self._ns + ':mem' || self.opts.memoryStore) return;
      self.memLoad();
      self.memChanged({ save: false, from: 'profile' });
    };
    if (global.addEventListener) global.addEventListener('storage', this._onStorage);

    (mountEl || document.body || document.documentElement).appendChild(host);

    // Restore this tab's conversation (page navigations inside the app).
    var saved = this.load();
    if (saved) this.restore(saved);
    else this.applyContext();
    this.histPrune();
    if (!saved || !saved.turns.length) this.refreshWelcome();

    if (this.inline || this.opts.openOnLoad || (saved && saved.open)) this.openPanel(saved && saved.open ? 'restored' : null);

    this.setupLife();
    this.scheduleWarm();
    this.memLoadAsync();
  };

  Widget.prototype.buildHeader = function () {
    var self = this;
    var head = el('div', 'head');
    var eye = el('span', 'eye');
    eye.innerHTML = FEATHER_EYE;
    head.appendChild(eye);

    var bMenu = toolButton('tool menu', ICON.menu, 'Menu');
    bMenu.title = 'Menu: history, profile, memory and settings';
    bMenu.setAttribute('aria-expanded', 'false');
    bMenu.setAttribute('aria-controls', 'kris-drawer');
    bMenu.addEventListener('click', function () { self.toggleDrawer(); });
    this.menuBtn = bMenu;
    head.appendChild(bMenu);

    var avatar = el('div', 'avatar blinking');
    var hp = portrait(avatar, 'h', false);
    this.headFace = hp.svg;
    this.headFaceWrap = hp.fig;
    avatar.appendChild(el('span', 'presence'));
    head.appendChild(avatar);

    var titles = el('div', 'titles');
    var h2 = el('h2', null, this.opts.title);
    if (this.opts.tagline) h2.appendChild(el('span', 'sub', this.opts.tagline));
    titles.appendChild(h2);
    this.statusEl = el('p', 'status', this.opts.subtitle || 'Connecting…');
    this.statusEl.setAttribute('aria-live', 'polite');
    titles.appendChild(this.statusEl);
    head.appendChild(titles);

    var tools = el('div', 'tools');
    if (this.opts.themeToggle) {
      var bTheme = toolButton('tool theme', ICON.moon + ICON.sunTool, 'Switch theme');
      bTheme.addEventListener('click', function () { self.toggleTheme(); });
      this.themeBtn = bTheme;
      tools.appendChild(bTheme);
      this.syncThemeButton();
    }
    var bNew = toolButton('tool newchat', ICON.newchat, 'New conversation');
    bNew.hidden = true;
    bNew.addEventListener('click', function () { self.newChat(); });
    this.newBtn = bNew;
    var bExpand = toolButton('tool expand', ICON.expand, 'Expand');
    bExpand.setAttribute('aria-pressed', 'false');
    bExpand.addEventListener('click', function () { self.setWide(!self.root.classList.contains('wide')); });
    this.expandBtn = bExpand;
    var bClose = toolButton('tool close', ICON.close, 'Close');
    bClose.addEventListener('click', function () { self.close(); });
    tools.appendChild(bNew); tools.appendChild(bExpand); tools.appendChild(bClose);
    head.appendChild(tools);
    return head;
  };

  Widget.prototype.buildBody = function () {
    var self = this;
    var body = el('div', 'body');
    var log = el('div', 'log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'off');
    log.setAttribute('aria-label', 'Conversation');
    log.addEventListener('scroll', function () {
      var d = log.scrollHeight - log.scrollTop - log.clientHeight;
      self._stick = d < 48;
      if (self._stick) self.jump.classList.remove('on');
      self.panel.classList.toggle('scrolled', log.scrollTop > 4);
    }, { passive: true });
    this.log = log;

    var jump = el('button', 'jump');
    jump.type = 'button';
    jump.innerHTML = ICON.down2;
    jump.appendChild(document.createTextNode('Latest'));
    jump.addEventListener('click', function () { self.scrollDown(true); });
    this.jump = jump;

    body.appendChild(log);
    body.appendChild(jump);
    this.bodyEl = body;
    this.buildWelcome();
    return body;
  };

  Widget.prototype.buildComposer = function () {
    var self = this;
    var composer = el('div', 'composer');
    this.composerEl = composer;

    // Shown while an already-sent message is being edited.
    var editbar = el('div', 'editbar');
    editbar.innerHTML = ICON.edit;
    editbar.appendChild(el('span', null, 'Editing your message — send to ask again'));
    editbar.appendChild(el('span', 'sp'));
    var cancel = el('button', 'btn ghost sm', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { self.cancelEdit(true); self.input.focus(); });
    editbar.appendChild(cancel);
    composer.appendChild(editbar);

    var form = el('form', 'box');
    form.setAttribute('novalidate', '');

    var ta = el('textarea');
    ta.rows = 1;
    ta.placeholder = this.opts.placeholder;
    ta.setAttribute('aria-label', 'Message ' + this.opts.title);
    ta.setAttribute('enterkeyhint', 'send');
    ta.setAttribute('autocomplete', 'off');
    ta.setAttribute('spellcheck', 'true');

    var send = el('button', 'send');
    send.type = 'submit';
    send.innerHTML = ICON.send;
    send.setAttribute('aria-label', 'Send message');
    send.disabled = true;

    // Below the text: the current vessel / fleet (a button that opens the
    // picker) and the length counter.
    var foot = el('div', 'foot');
    var ctx = el('button', 'ctx');
    ctx.type = 'button';
    ctx.setAttribute('aria-haspopup', 'menu');
    ctx.setAttribute('aria-expanded', 'false');
    ctx.innerHTML = ICON.vessel;
    this.ctxText = el('span');
    ctx.appendChild(this.ctxText);
    ctx.addEventListener('click', function () { self.togglePicker(); });
    this.ctxChip = ctx;
    var clr = el('button', 'ctx-clear');
    clr.type = 'button';
    clr.hidden = true;
    clr.innerHTML = ICON.close;
    clr.setAttribute('aria-label', 'Clear the current vessel or fleet');
    clr.addEventListener('click', function () { self.pickContext(null); });
    this.ctxClear = clr;
    this.ctxMenu = el('div', 'ctxmenu');
    this.ctxMenu.setAttribute('role', 'menu');
    this.ctxMenu.setAttribute('aria-label', 'Current vessel or fleet');
    this.ctxMenu.hidden = true;
    this.countEl = el('span', 'count');
    // The key hint lives in the same row, shown while typing, instead of a
    // line of its own under the box.
    var hint = el('span', 'hint');
    hint.setAttribute('aria-hidden', 'true');
    this.hintKeys = el('span', 'keys');
    hint.appendChild(this.hintKeys);
    foot.appendChild(ctx); foot.appendChild(clr); foot.appendChild(this.ctxMenu);
    foot.appendChild(el('span', 'spacer')); foot.appendChild(hint); foot.appendChild(this.countEl);
    this.foot = foot;

    form.appendChild(ta); form.appendChild(send); form.appendChild(foot);
    composer.appendChild(form);

    this.input = ta; this.sendBtn = send; this.form = form;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (self.busy) { self.stop(); return; }
      var v = ta.value.trim();
      if (!v || v.length > self.opts.maxLength) return;
      ta.value = '';
      self.autosize();
      self.updateComposer();
      if (self._editing) self.commitEdit(v); else self.submit(v);
    });
    ta.addEventListener('input', function () { self.autosize(); self.updateComposer(); });
    ta.addEventListener('focus', function () { form.classList.add('focus'); });
    ta.addEventListener('blur', function () { form.classList.remove('focus'); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        var mod = e.ctrlKey || e.metaKey;
        var sendNow = self.settings.sendWithEnter ? !e.shiftKey : mod;
        if (!sendNow) return;            // a new line
        e.preventDefault();
        if (self.busy) return;
        if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
      } else if (e.key === 'ArrowUp' && !ta.value && !self.busy) {
        if (self.beginEdit()) e.preventDefault();
      } else if (e.key === 'Escape') {
        if (self.busy) { e.stopPropagation(); self.stop(); }
        else if (self._editing) { e.stopPropagation(); self.cancelEdit(true); }
      }
    });
    // Clicking anywhere in the box that is not a control puts the caret in.
    form.addEventListener('click', function (e) { if (e.target === form || e.target === foot) ta.focus(); });
    return composer;
  };

  /** The key hint under the composer follows the send-key setting. */
  Widget.prototype.updateHint = function () {
    var keys = this.hintKeys;
    if (!keys) return;
    keys.textContent = '';
    var k = function (t) { keys.appendChild(el('kbd', null, t)); };
    var tx = function (t) { keys.appendChild(document.createTextNode(t)); };
    if (this.settings.sendWithEnter) { k('Enter'); tx(' send · '); k('Shift'); tx('+'); k('Enter'); tx(' new line'); }
    else { k(isMac() ? '⌘' : 'Ctrl'); tx('+'); k('Enter'); tx(' send · '); k('Enter'); tx(' new line'); }
  };

  // --- drawer: where everything beyond the chat lives -------------------------------
  Widget.prototype.buildDrawer = function () {
    var self = this;
    var frag = document.createDocumentFragment();
    var scrim = el('div', 'scrim');
    scrim.addEventListener('click', function () { self.toggleDrawer(false); });
    var d = el('nav', 'drawer');
    d.id = 'kris-drawer';
    d.setAttribute('aria-label', this.opts.title + ' menu');
    var sc = el('div', 'dscroll');

    var nb = el('button', 'dnew');
    nb.type = 'button';
    var nic = el('span', 'ic'); nic.innerHTML = ICON.newchat; nb.appendChild(nic);
    nb.appendChild(el('span', null, 'New chat'));
    nb.addEventListener('click', function () { self.toggleDrawer(false, true); self.newChat(); });
    sc.appendChild(nb);

    this.navItems = {};
    var addItem = function (list, name, label, svg) {
      var li = el('li');
      var b = el('button', 'ditem');
      b.type = 'button';
      b.innerHTML = svg;
      b.appendChild(el('span', 'lbl', label));
      b.addEventListener('click', function () { self.showView(name); });
      li.appendChild(b);
      list.appendChild(li);
      self.navItems[name] = b;
      return b;
    };
    var nav = el('ul', 'dnav');
    addItem(nav, 'chat', 'Chat', ICON.chat);
    if (this.historyAllowed()) addItem(nav, 'history', 'History', ICON.history);
    sc.appendChild(nav);
    if (this.historyAllowed()) {
      sc.appendChild(el('div', 'dlabel', 'Recent'));
      this.drecent = el('ul', 'drecent');
      sc.appendChild(this.drecent);
    }
    sc.appendChild(el('div', 'dsep'));
    var nav2 = el('ul', 'dnav');
    if (this.memoryAllowed()) {
      addItem(nav2, 'profile', 'Profile', ICON.user);
      var mb = addItem(nav2, 'memory', 'Memory', ICON.memory);
      this.memPill = el('span', 'pill');
      mb.appendChild(this.memPill);
    }
    addItem(nav2, 'appearance', 'Appearance', ICON.palette);
    addItem(nav2, 'settings', 'Settings', ICON.gear);
    addItem(nav2, 'about', 'About', ICON.info);
    sc.appendChild(nav2);
    d.appendChild(sc);

    if (this.memoryAllowed()) {
      var foot = el('div', 'dfoot');
      this.duser = el('button', 'duser');
      this.duser.type = 'button';
      this.duser.addEventListener('click', function () { self.showView('profile'); });
      foot.appendChild(this.duser);
      d.appendChild(foot);
    }
    this.drawer = d;
    this.scrim = scrim;
    frag.appendChild(scrim);
    frag.appendChild(d);
    return frag;
  };

  Widget.prototype.toggleDrawer = function (open, noFocus) {
    if (!this.drawer) return;
    if (open == null) open = !this.panel.classList.contains('drawer-open');
    if (open && !this.open) this.openPanel();
    this.panel.classList.toggle('drawer-open', !!open);
    this.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      this.refreshDrawer();
      var first = this.drawer.querySelector('.dnew');
      setTimeout(function () { try { first.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }, 30);
    } else if (!noFocus) {
      try { this.menuBtn.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
  };

  /** While the drawer is open, Tab cycles inside it (and the menu button that closes it). */
  Widget.prototype.trapDrawerFocus = function (e) {
    if (e.key !== 'Tab' || !this.panel.classList.contains('drawer-open')) return;
    var f = [this.menuBtn].concat(Array.prototype.slice.call(this.drawer.querySelectorAll('button:not([disabled])')));
    if (!f.length) return;
    var active = this.shadow.activeElement;
    var i = f.indexOf(active);
    var next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
    e.preventDefault();
    try { f[next].focus(); } catch (_) { /* ignore */ }
  };

  Widget.prototype.buildLauncher = function () {
    var self = this;
    var badge = el('button', 'badge blinking');
    badge.type = 'button';
    badge.setAttribute('aria-label', 'Open ' + this.opts.title);
    badge.setAttribute('aria-expanded', 'false');
    badge.setAttribute('aria-controls', 'kris-panel');
    badge.appendChild(el('span', 'glow'));
    badge.appendChild(el('span', 'aura'));
    this.badgeFace = portrait(badge, 'b', true).svg;
    badge.appendChild(el('span', 'dot'));
    badge.addEventListener('click', function () { self.toggle(); });
    this.badge = badge;
    return badge;
  };

  Widget.prototype.buildNudge = function () {
    var self = this;
    if (this.inline || !this.opts.nudge || readLocal(NUDGE_KEY)) return null;
    var nudge = el('div', 'nudge');
    nudge.setAttribute('role', 'status');
    nudge.hidden = true;
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
    this.nudge = nudge;
    this._nudgeT = setTimeout(function () { if (!self.open && self.nudge) self.nudge.hidden = false; }, 2500);
    return nudge;
  };

  // --- theme ---------------------------------------------------------------
  /**
   * `pref` is what was asked for ('light' | 'dark' | 'auto'); the root always
   * carries the resolved theme in data-theme, so the stylesheet only ever
   * has two cases to handle.
   */
  Widget.prototype.initTheme = function (pref) {
    var self = this;
    this._themePref = THEMES.indexOf(pref) >= 0 ? pref : 'auto';
    this._mqDark = global.matchMedia ? global.matchMedia('(prefers-color-scheme: dark)') : null;
    if (this._mqDark) {
      this._onScheme = function () { if (self._themePref === 'auto') self.applyTheme(true); };
      if (this._mqDark.addEventListener) this._mqDark.addEventListener('change', this._onScheme);
      else if (this._mqDark.addListener) this._mqDark.addListener(this._onScheme);
    }
    this.applyTheme(false);
  };

  Widget.prototype.resolvedTheme = function () {
    if (this._themePref === 'dark' || this._themePref === 'light') return this._themePref;
    return this._mqDark && this._mqDark.matches ? 'dark' : 'light';
  };

  Widget.prototype.applyTheme = function (animate) {
    var self = this;
    var next = this.resolvedTheme();
    var root = this.root;
    root.setAttribute('data-theme-pref', this._themePref);
    if (root.getAttribute('data-theme') === next) { this.syncThemeButton(); return; }
    var swap = function () { root.setAttribute('data-theme', next); self.syncThemeButton(); };
    if (!animate || this._reducedMotion || !this.open) { swap(); }
    else if (typeof document.startViewTransition === 'function') {
      // A true cross-fade, gradients and all, where the browser supports it.
      // A skipped transition (tab hidden, a second toggle) rejects its promises; the swap still happens.
      try { var vt = document.startViewTransition(swap); vt.ready.catch(function () {}); vt.finished.catch(function () {}); } catch (_) { swap(); }
    } else {
      root.classList.add('theming');
      swap();
      clearTimeout(this._themeT);
      this._themeT = setTimeout(function () { root.classList.remove('theming'); }, 420);
    }
    if (typeof this.opts.onThemeChange === 'function') { try { this.opts.onThemeChange(next, this._themePref); } catch (_) { /* host hook */ } }
  };

  /**
   * Change the theme. `fromUser` marks a pick made with the header switch:
   * that one is remembered for this browser; a host's setTheme() is not.
   */
  Widget.prototype.setTheme = function (pref, fromUser) {
    if (THEMES.indexOf(pref) < 0) return false;
    this._themePref = pref;
    if (fromUser && this.opts.rememberTheme) writeLocal(THEME_KEY, pref === 'auto' ? null : pref);
    this.applyTheme(true);
    return true;
  };

  Widget.prototype.toggleTheme = function () {
    this.setTheme(this.resolvedTheme() === 'dark' ? 'light' : 'dark', true);
  };

  Widget.prototype.syncThemeButton = function () {
    if (this.panes && this.view === 'appearance') this.refreshView('appearance');
    var b = this.themeBtn;
    if (!b) return;
    var dark = this.root.getAttribute('data-theme') === 'dark';
    var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
    b.setAttribute('aria-label', label);
    b.title = label;
  };

  // --- welcome -----------------------------------------------------------------
  Widget.prototype.buildWelcome = function () {
    var w = el('div', 'welcome');
    var hero = el('div', 'hero blinking');
    hero.appendChild(el('span', 'ring'));
    portrait(hero, 'w', false).svg.setAttribute('data-mood', 'happy');
    w.appendChild(hero);
    w.appendChild(el('p', 'kicker', this.opts.kicker || this.opts.title));
    this.welcomeTitle = el('h3', null, this.greetingText());
    w.appendChild(this.welcomeTitle);
    w.appendChild(el('p', 'intro', this.opts.intro));

    var ctxl = el('div', 'ctxline');
    ctxl.hidden = true;
    ctxl.innerHTML = ICON.vessel;
    this.welcomeCtxText = el('span');
    ctxl.appendChild(this.welcomeCtxText);
    this.welcomeCtx = ctxl;
    w.appendChild(ctxl);

    if (!(this._customExamples && !this.opts.examples.length)) {
      this.promptList = el('ul', 'prompts');
      this.promptList.setAttribute('aria-label', 'Suggested questions');
      w.appendChild(this.promptList);
    }
    this.resumeWrap = el('div');
    w.appendChild(this.resumeWrap);

    var trust = el('div', 'trust');
    var lot = el('span', 'lotus'); lot.innerHTML = LOTUS; trust.appendChild(lot);
    trust.appendChild(el('span', null, 'Every figure comes straight from your records. If they don’t hold the answer, ' + this.opts.title + ' says so.'));
    w.appendChild(trust);
    this.welcome = w;
    this.log.appendChild(w);
    this.refreshPrompts();
  };

  Widget.prototype.greetingText = function () {
    if (this.opts.greeting) return this.opts.greeting;
    var name = this.addressName();
    return timeGreeting() + (name ? ', ' + name : '') + '.';
  };

  /**
   * The suggestions on the empty state. A host's own examples are used as
   * given; the built-in set leans towards the user's role or interests once
   * K.R.1.S knows them, and names the vessel on screen.
   */
  Widget.prototype.promptSet = function () {
    if (this._customExamples) return this.opts.examples || [];
    var p = this.profileView();
    var hay = [p.role, p.department, p.interests].filter(Boolean).join(' ');
    if (hay) {
      for (var i = 0; i < PERSONA_PROMPTS.length; i++) if (PERSONA_PROMPTS[i].re.test(hay)) return PERSONA_PROMPTS[i].prompts;
    }
    return this.opts.examples || [];
  };

  Widget.prototype.refreshPrompts = function () {
    var self = this;
    var ul = this.promptList;
    if (!ul) return;
    ul.textContent = '';
    var name = this.context && (this.context.vesselName || this.context.vesselId);
    this.promptSet().slice(0, 4).forEach(function (ex) {
      var item = typeof ex === 'string' ? { tag: 'Ask', text: ex } : ex;
      var t = String(item.text || '');
      if (name && /^(fuel consumption|me consumption|shaft power|speed|average speed|distance|leg co2|leg distance|off hire hours|ghg intensity|compliance balance)\b/i.test(t) && !/\bfor\b/i.test(t)) {
        t = t.replace(/^(.+?)( last| this| today| yesterday)/i, '$1 for ' + name + '$2');
      }
      var li = el('li');
      var b = el('button');
      b.type = 'button';
      var tag = el('span', 'tag');
      var ic = el('span', 'ic');
      ic.innerHTML = ICON[PROMPT_ICONS[item.tag] || 'arrow'];
      tag.appendChild(ic);
      tag.appendChild(document.createTextNode(item.tag || 'Ask'));
      b.appendChild(tag);
      var q = el('span', 'q', t);
      b.appendChild(q);
      var go = el('span', 'go'); go.innerHTML = ICON.arrow; b.appendChild(go);
      b.addEventListener('click', function () { self.submit(q.textContent); });
      li.appendChild(b);
      ul.appendChild(li);
    });
  };

  /** "Continue …" — the most recent other conversation from the past week. */
  Widget.prototype.renderResume = function () {
    var self = this;
    var wrap = this.resumeWrap;
    if (!wrap) return;
    wrap.textContent = '';
    if (!this.historyAllowed()) return;
    var now = Date.now();
    var items = this.histIndex().items.filter(function (it) { return it.id !== self.convId && now - it.updated < 7 * 86400000; });
    if (!items.length) return;
    var it = items[0];
    var b = el('button', 'resume');
    b.type = 'button';
    b.innerHTML = ICON.history;
    var t = el('span', 't');
    t.appendChild(document.createTextNode('Continue '));
    t.appendChild(el('b', null, it.title));
    b.appendChild(t);
    b.appendChild(el('span', 'w', whenLabel(it.updated)));
    b.title = 'Continue “' + it.title + '”';
    b.addEventListener('click', function () { self.openConversation(it.id); });
    wrap.appendChild(b);
  };

  Widget.prototype.refreshWelcome = function () {
    if (!this.welcome) return;
    if (this.welcomeTitle) this.welcomeTitle.textContent = this.greetingText();
    this.refreshPrompts();
    this.renderResume();
  };

  Widget.prototype.showWelcome = function () {
    if (this.welcome && !this.welcome.parentNode) this.log.appendChild(this.welcome);
    this.refreshWelcome();
    this.newBtn.hidden = true;
    this.panel.classList.remove('chatting');
  };

  Widget.prototype.hideWelcome = function () {
    if (this.welcome && this.welcome.parentNode) this.welcome.parentNode.removeChild(this.welcome);
    this.newBtn.hidden = false;
    if (this.panel) this.panel.classList.add('chatting');
  };

  Widget.prototype.hideNudge = function (forever) {
    if (this._nudgeT) clearTimeout(this._nudgeT);
    if (this.nudge) this.nudge.classList.add('gone');
    if (forever) writeLocal(NUDGE_KEY, '1');
  };

  // --- composer helpers ------------------------------------------------------
  Widget.prototype.autosize = function () {
    var ta = this.input;
    ta.style.height = 'auto';
    ta.style.height = Math.min(Math.max(ta.scrollHeight, 48), 180) + 'px';
    // A scrollbar only once the text outgrows the box (half a pixel of
    // rounding used to show one on an empty composer).
    ta.style.overflowY = ta.scrollHeight > 180 ? 'auto' : 'hidden';
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
    var near = raw > max * 0.8;
    this.countEl.textContent = near ? raw + ' / ' + max : '';
    this.countEl.classList.toggle('over', raw > max);
    this.updateFoot();
  };

  Widget.prototype.updateFoot = function () {
    this.foot.classList.toggle('on', this.opts.vesselPicker !== false || this.ctxChip.classList.contains('on') || !!this.countEl.textContent);
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
      .then(function (h) { self.health = h || null; if (self.view === 'about') self.refreshView('about'); })
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
      if (self.view === 'chat' && (how !== 'restored' || !('ontouchstart' in global))) { try { self.input.focus({ preventScroll: true }); } catch (_) { self.input.focus(); } }
    }, 30);
    if (typeof this.opts.onOpen === 'function') this.opts.onOpen();
    this.emit('open');
    this.save();
  };

  Widget.prototype.close = function () {
    var self = this;
    if (this.inline || !this.open) return;
    this.open = false;
    this.panel.classList.remove('drawer-open');
    this.menuBtn.setAttribute('aria-expanded', 'false');
    if (this.view !== 'chat') this.showView('chat', true);
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
    this.emit('close');
    this.save();
  };

  /**
   * Start a fresh conversation. The one just finished is already in History;
   * what the user said about themselves in it (conversation context) stays
   * with it. Only what they chose to have remembered carries over.
   */
  Widget.prototype.reset = function () {
    this.stop(true);
    this.cancelEdit(false);
    this.save();
    this.turns = []; this.history = []; this.pending = null;
    this.convId = uid();
    this.convFacts = {};
    this.suggested = {};
    this._histSig = null;
    this.clearLog();
    this.showWelcome();
    this.setMood('idle');
    this.save();
    this.emit('conversation', { id: this.convId, fresh: true });
  };

  Widget.prototype.newChat = function () {
    if (this.view !== 'chat') this.showView('chat', true);
    this.reset();
    try { this.input.focus({ preventScroll: true }); } catch (_) { this.input.focus(); }
  };

  Widget.prototype.clearLog = function () {
    var kids = Array.prototype.slice.call(this.log.childNodes);
    for (var i = 0; i < kids.length; i++) if (kids[i] !== this.welcome) this.log.removeChild(kids[i]);
  };

  /** Reopen a conversation from History, exactly where it was left. */
  Widget.prototype.openConversation = function (id) {
    if (this.busy) this.stop(true);
    if (id === this.convId) { this.showView('chat'); return true; }
    var rec = this.histLoad(id);
    if (!rec) { this.toast('That conversation is no longer on this device.'); return false; }
    this.cancelEdit(false);
    this.save();
    this.clearLog();
    this.turns = []; this.history = []; this.pending = null;
    this._histSig = null;
    this.restore({ id: rec.id, turns: rec.turns, facts: rec.facts, suggested: rec.suggested, pending: rec.pending || null, pick: rec.pick || null });
    this._histSig = this.histSig();   // opening a conversation is not a change to it
    if (!this.turns.length) this.showWelcome();
    this.showView('chat');
    this.scrollDown();
    this.save();
    this.emit('conversation', { id: this.convId, fresh: false });
    return true;
  };

  /** Tell K.R.1.S what the user is looking at. Pass null to clear. */
  Widget.prototype.setContext = function (ctx) {
    this.pageContext = ctx && typeof ctx === 'object'
      ? { vesselId: ctx.vesselId != null ? String(ctx.vesselId) : null,
          vesselName: ctx.vesselName != null ? String(ctx.vesselName) : null,
          page: ctx.page != null ? String(ctx.page) : null }
      : null;
    this.applyContext();
  };

  /** A pick from the vessel / fleet picker, or from a saved chat. */
  function cleanPick(p) {
    if (!p || typeof p !== 'object') return null;
    if (p.fleet === true) return { fleet: true };
    if (p.vesselId == null || p.vesselId === '') return null;
    return { vesselId: String(p.vesselId).slice(0, 40), vesselName: p.vesselName != null ? String(p.vesselName).slice(0, 80) : null };
  }

  /** The user's own choice: it stays for this chat (and new ones) until they change or clear it. */
  Widget.prototype.pickContext = function (pick) {
    this.pick = cleanPick(pick);
    this.applyContext();
    this.closePicker(true);
    this.save();
  };

  /** What the chip shows and questions default to: the user's pick beats the page's vessel. */
  Widget.prototype.applyContext = function () {
    var page = this.pageContext;
    var pk = this.pick;
    this.context = pk
      ? (pk.fleet ? { fleet: true, page: page && page.page } : { vesselId: pk.vesselId, vesselName: pk.vesselName, page: page && page.page })
      : page;
    var name = this.ctxName();
    var picker = this.opts.vesselPicker !== false;
    var scope = this.context && this.context.fleet ? 'your whole fleet' : name;
    this.ctxText.textContent = name || (picker ? 'Vessel or fleet' : '');
    this.ctxChip.classList.toggle('on', !!name || picker);
    this.ctxChip.classList.toggle('unset', !name);
    this.ctxChip.disabled = !picker;
    this.ctxChip.title = name ? 'Questions default to ' + scope + (picker ? '. Click to change.' : '') : 'Set a vessel or your fleet as the current context';
    this.ctxClear.hidden = !pk;
    // The box says what questions will be about, so the chip is never missed.
    if (this.input) this.input.placeholder = !name ? this.opts.placeholder : 'Ask about ' + (this.context.fleet ? 'your fleet' : name) + '…';
    this.updateFoot();
    if (this.welcomeCtx) {
      this.welcomeCtx.hidden = !name;
      this.welcomeCtxText.textContent = !name ? ''
        : this.context.fleet ? 'Questions default to your whole fleet unless you name a vessel'
        : 'Questions default to ' + name + ' unless you name another vessel';
    }
    this.refreshPrompts();
    if (this.view === 'memory') this.refreshView('memory');
  };

  Widget.prototype.ctxName = function () {
    var c = this.context;
    return !c ? null : c.fleet ? 'Entire fleet' : (c.vesselName || c.vesselId || null);
  };

  /** The vessels this user may read: the host's list if it gave one, else the server's. */
  Widget.prototype.loadVessels = function () {
    var self = this;
    if (this._vessels) return Promise.resolve(this._vessels);
    var norm = function (list) {
      return (Array.isArray(list) ? list : []).filter(function (v) { return v && v.id != null; })
        .map(function (v) { return { id: String(v.id), name: String(v.name || v.id) }; });
    };
    if (Array.isArray(this.opts.vessels)) return Promise.resolve(this._vessels = norm(this.opts.vessels));
    if (!this.opts.endpoint) return Promise.resolve([]);
    return this.post({ action: 'vessels', client: CLIENT }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.detail) || (data && data.text) || 'HTTP ' + res.status);
        return (self._vessels = norm(data && data.vessels));
      });
    });
  };

  Widget.prototype.togglePicker = function () {
    if (this.opts.vesselPicker === false) return;
    if (!this.ctxMenu.hidden) { this.closePicker(); return; }
    this.ctxMenu.hidden = false;
    this.ctxChip.setAttribute('aria-expanded', 'true');
    this.renderPicker(null, 'loading');
    var self = this;
    this.loadVessels().then(function (list) { if (!self.ctxMenu.hidden) self.renderPicker(list); },
      function (err) { if (!self.ctxMenu.hidden) self.renderPicker(null, 'error', err && err.message); });
  };

  Widget.prototype.closePicker = function (focusChip) {
    if (!this.ctxMenu || this.ctxMenu.hidden) return;
    this.ctxMenu.hidden = true;
    this.ctxChip.setAttribute('aria-expanded', 'false');
    if (focusChip) { try { this.ctxChip.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  };

  Widget.prototype.renderPicker = function (list, state, detail) {
    var self = this;
    var m = this.ctxMenu;
    m.textContent = '';
    m.appendChild(el('div', 'ctxmenu-h', 'Answer questions about'));
    var item = function (label, checked, onPick, cls) {
      var b = el('button', cls || null);
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', checked ? 'true' : 'false');
      b.appendChild(el('span', null, label));
      if (checked) { var ok = el('span', 'tick'); ok.innerHTML = ICON.check; b.appendChild(ok); }
      b.addEventListener('click', onPick);
      m.appendChild(b);
      return b;
    };
    var pk = this.pick;
    var first = item('Entire fleet', !!(pk && pk.fleet), function () { self.pickContext({ fleet: true }); });
    if (state === 'loading') m.appendChild(el('div', 'ctxmenu-note', 'Loading your vessels…'));
    else if (state === 'error') {
      m.appendChild(el('div', 'ctxmenu-note', 'Your vessels could not be loaded' + (detail ? ': ' + String(detail).slice(0, 160) : '.')));
    } else if (!list.length) m.appendChild(el('div', 'ctxmenu-note', 'No vessels are linked to your account.'));
    else list.forEach(function (v) {
      item(v.name, !!(pk && !pk.fleet && pk.vesselId === v.id), function () { self.pickContext({ vesselId: v.id, vesselName: v.name }); });
    });
    if (pk) item(this.pageContext && (this.pageContext.vesselName || this.pageContext.vesselId) ? 'Clear (use this page’s vessel)' : 'Clear', false, function () { self.pickContext(null); }, 'clear');
    if (state !== 'loading') { try { first.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  };

  // --- sections ----------------------------------------------------------------
  /**
   * Show a section over the conversation ('history', 'profile', 'memory',
   * 'appearance', 'settings', 'about') or go back to it ('chat'). Sections
   * are built the first time they are opened. The conversation underneath
   * keeps its scroll position and is made inert while covered.
   */
  Widget.prototype.showView = function (name, quiet) {
    if (name !== 'chat' && !VIEW_TITLES[name]) return false;
    if ((name === 'profile' || name === 'memory') && !this.memoryAllowed()) return false;
    if (name === 'history' && !this.historyAllowed()) return false;
    if (!this.open && !quiet) this.openPanel();
    this.panel.classList.remove('drawer-open');
    this.menuBtn.setAttribute('aria-expanded', 'false');
    var prev = this.view;
    this.view = name;
    var inView = name !== 'chat';
    this.panel.classList.toggle('in-view', inView);
    this.panel.setAttribute('data-view', name);
    setInert(this.bodyEl, inView);
    setInert(this.composerEl, inView);
    if (inView) {
      var pane = this.panes[name] || this.buildPane(name);
      for (var k in this.panes) this.panes[k].el.classList.toggle('on', k === name);
      this.refreshView(name);
      if (prev !== name) pane.body.scrollTop = 0;
      if (!quiet) setTimeout(function () { try { pane.h.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }, 20);
    } else if (!quiet && this.open) {
      var self = this;
      setTimeout(function () { try { self.input.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }, 20);
    }
    if (prev !== name) this.emit('view', name);
    return true;
  };

  Widget.prototype.buildPane = function (name) {
    var self = this;
    var pane = el('section', 'vpane');
    pane.setAttribute('aria-labelledby', 'kris-v-' + name);
    var head = el('div', 'vhead');
    var back = el('button', 'vback');
    back.type = 'button';
    back.innerHTML = ICON.back;
    back.appendChild(document.createTextNode('Chat'));
    back.setAttribute('aria-label', 'Back to chat');
    back.addEventListener('click', function () { self.showView('chat'); });
    var h = el('h3', null, VIEW_TITLES[name]);
    h.id = 'kris-v-' + name;
    h.tabIndex = -1;
    head.appendChild(back);
    head.appendChild(h);
    var body = el('div', 'vbody');
    pane.appendChild(head);
    pane.appendChild(body);
    this.viewsEl.appendChild(pane);
    var rec = { el: pane, body: body, h: h };
    this.panes[name] = rec;
    return rec;
  };

  /**
   * Re-render a section. Focus is carried across by data-fk, so a switch
   * that was just flipped keeps the keyboard. The Profile form is never
   * re-rendered by its own edits (the user may be mid-way through it).
   */
  Widget.prototype.refreshView = function (name, from) {
    var pane = this.panes[name];
    if (!pane || name !== this.view) return;
    if (from && from === name && name === 'profile') return;
    var active = this.shadow && this.shadow.activeElement;
    var fk = active && active.getAttribute ? active.getAttribute('data-fk') : null;
    var hadFocus = !!(active && pane.el.contains(active));
    var top = pane.body.scrollTop;
    pane.body.textContent = '';
    var render = {
      history: this.renderHistory, profile: this.renderProfile, memory: this.renderMemory,
      appearance: this.renderAppearance, settings: this.renderSettings, about: this.renderAbout
    }[name];
    if (render) render.call(this, pane.body);
    pane.body.scrollTop = top;
    // Keep the keyboard where it was; if that control is gone (a deleted
    // row), fall back to the section heading rather than losing focus.
    if (hadFocus || fk) {
      var again = fk ? pane.body.querySelector('[data-fk="' + fk + '"]') : null;
      try { (again || pane.h).focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
  };

  /**
   * Ambient "alive" behaviour, entirely local: eyes follow the cursor, a slow
   * idle look-around when the mouse has been still, a subtle breathing loop
   * (pure CSS, always on). None of this touches the network or the request
   * pipeline — it is cosmetic only, throttled to one recompute per animation
   * frame, and idle whenever motion is reduced or the character is set still.
   */
  Widget.prototype.setupLife = function () {
    var self = this;
    var rafId = null;
    var mx = null, my = null;

    function apply() {
      rafId = null;
      // Some moods own the eyes — thought looks away, a laugh shuts them, a
      // blush drops the gaze. Tracking must not fight them.
      if (self._still || NO_TRACK[self.currentMood]) return;
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
    if (this._reducedMotion || this._still) return;
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
    if (this._reducedMotion || this._still) return;
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
    if (this._onStorage && global.removeEventListener) global.removeEventListener('storage', this._onStorage);
    [this._idleT, this._moodT, this._nudgeT, this._themeT, this._toastT, this._closeT].forEach(function (t) { if (t) clearTimeout(t); });
    if (this._tick) clearInterval(this._tick);
    if (this._rafCancel) this._rafCancel();
    if (this._mqDark && this._onScheme) {
      if (this._mqDark.removeEventListener) this._mqDark.removeEventListener('change', this._onScheme);
      else if (this._mqDark.removeListener) this._mqDark.removeListener(this._onScheme);
    }
    if (this._bodyOverflow !== undefined) document.body.style.overflow = this._bodyOverflow;
    this.stop(true);
    this._listeners = {};
  };

  // ==========================================================================
  //  Transport
  // ==========================================================================
  /**
   * Sent with every message. `profile` is what the user has allowed K.R.1.S
   * to remember, merged with what they said about themselves in this chat;
   * the server uses it for tone and relevance only, and keeps none of it.
   */
  Widget.prototype.buildContext = function () {
    var p = this.profileForServer();
    var tz = p && p.timezone && validTz(p.timezone) ? p.timezone : (detectedTz() || null);
    var ctx = assign({}, this.context || {}, {
      tz: tz,
      locale: (typeof navigator !== 'undefined' && navigator.language) || null,
      userName: this.addressName() || null
    });
    if (p) ctx.profile = p;
    return ctx;
  };

  /**
   * Send one message. Resolves to the final payload. `hooks.onDelta(evt)` is
   * called for streamed events: { t: 'delta'|'replace'|'status', text }.
   */
  /** POST to the K.R.1.S endpoint with the host's sign-in token. */
  Widget.prototype.post = function (payload, signal) {
    var self = this;
    var tokenP;
    try { tokenP = Promise.resolve(typeof this.opts.getToken === 'function' ? this.opts.getToken() : null); }
    catch (e) { tokenP = Promise.resolve(null); }
    return tokenP.then(function (token) {
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
        signal: signal
      });
    });
  };

  Widget.prototype.transport = function (text, pending, history, hooks) {
    var self = this;
    var context = this.buildContext();
    if (typeof this.opts.ask === 'function') {
      return Promise.resolve(this.opts.ask(text, pending, history, context, hooks));
    }
    return this.post({ text: text, pending: pending, history: history, context: context, stream: true, client: CLIENT }, hooks && hooks.signal).then(function (res) {
      self.setConn('online');
      var ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (/ndjson/i.test(ctype) && res.body && res.body.getReader) return readStream(res, hooks);
      return res.json().then(function (data) {
        // Use the server's own explanation: "sign-in isn't set up on this
        // server" and "your session expired" need very different reactions.
        if (res.status === 401) return {
          status: 'error',
          reason: (data && data.reason) || 'unauthenticated',
          text: (data && typeof data.text === 'string' && data.text) || 'I couldn\u2019t confirm your sign-in. Sign in again and ask me once more.',
          detail: data && typeof data.detail === 'string' ? data.detail : undefined
        };
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
    // A chip or suggestion sent mid-edit abandons the edit.
    if (this._editing && !opts.fromEdit) this.cancelEdit(true);

    if (this.view !== 'chat') this.showView('chat', !this.open);
    this.hideWelcome();
    // Choices offered earlier belong to a question this message moves past.
    var stale = this.log.querySelectorAll('.choices button');
    for (var si = 0; si < stale.length; si++) stale[si].disabled = true;
    this.busy = true;
    this.updateComposer();
    var userEl = opts.retry ? this.lastUserEl() : this.addUserTurn(String(displayText));
    if (!opts.retry) this.turns.push({ role: 'user', text: String(displayText), send: body, at: Date.now() });
    if (userEl) { userEl.classList.remove('failed'); setUserState(userEl, ''); }
    this.markLastUser();
    this._stick = true;
    this.scrollDown(true);

    var reactiveMood = this.classifyOutgoing(body);
    this.submitTimes.push(Date.now());
    this.submitTimes = this.submitTimes.slice(-12);
    this.turnCount++;
    this.setMood(reactiveMood);

    var started = performanceNow();
    var carried = this.pending;
    var askedName = !!(carried && carried.kind === 'name');
    var cmd = (!carried || askedName) && this.memoryAllowed() ? parseMemoryCommand(body) : null;
    if (cmd && askedName) carried = null;
    // Conversation context: whatever the user just said about themselves
    // belongs to THIS chat at once, so the reply can already use it. ("Forget
    // that I work at Maersk" is not a statement that they do.)
    var facts = (carried && !askedName) || cmd ? [] : this.noticeFacts(body);
    var historySnapshot = this.history.slice(-HISTORY_TURNS);
    this.pending = null;

    // ---- local: memory commands and greetings never touch the network --------
    var local = null;
    if (cmd) local = this.runMemoryCommand(cmd);
    if (!local && !carried && this.turns.length > 1 && CONFUSED_RE.test(body)) {
      local = { status: 'answer', source: 'local', instant: true, text: 'Sorry — I didn’t get that right. Could you ask it another way?' };
    }
    if (!local && this.opts.localReplies && !carried && typeof this.opts.ask !== 'function') {
      var hello = localReply(body, this.addressName());
      if (hello) local = { status: 'answer', source: 'local', instant: true, text: hello };
    }
    if (local) {
      var slotL = this.addAssistantTurn();
      this.finishTurn(slotL, local, body, reactiveMood, started, historySnapshot, cmd ? [] : facts);
      return;
    }

    // ---- sending: only worth showing when the server is not known to be up
    // (waking, reconnecting). Otherwise the message is on its way at once and
    // the thinking indicator says the rest.
    var unsure = this._conn !== 'online';
    if (userEl && unsure) userEl.classList.add('sending');
    var sendingT = unsure ? setTimeout(function () { setUserState(userEl, 'Sending…'); }, 450) : null;
    var delivered = false;
    var markDelivered = function () {
      if (delivered) return;
      delivered = true;
      clearTimeout(sendingT);
      if (userEl) { userEl.classList.remove('sending'); setUserState(userEl, ''); }
    };

    var slot = this.addAssistantTurn();
    var thinking = el('div', 'thinking');
    var dots = el('span', 'dots'); dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    thinking.appendChild(dots);
    var label = el('span', 'label', waitLabelFor(body));
    thinking.appendChild(label);
    var secs = el('span', 'secs');
    thinking.appendChild(secs);
    slot.msg.appendChild(thinking);
    this.scrollDown();
    this._busyLabel = waitLabelFor(body) + '…';
    this.setStatusText(this._busyLabel);

    // Waiting is easier with a clock, and with a reason once it runs long.
    var t0 = Date.now();
    var slowShown = false;
    clearInterval(this._tick);
    this._tick = setInterval(function () {
      var s = Math.round((Date.now() - t0) / 1000);
      if (s >= 3) secs.textContent = s + 's';
      if (s >= 20 && !slowShown && thinking.parentNode) {
        slowShown = true;
        slot.msg.appendChild(el('div', 'slowhint', self._conn === 'waking'
          ? 'The server is waking up — the first reply can take up to a minute.'
          : 'Still thinking. A careful answer to a bigger question can take a little longer.'));
        self.stick();
      }
    }, 1000);
    var stopClock = function () { clearInterval(self._tick); self._tick = null; };

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timedOut = false;
    // Restarted by every streamed event (text, or "still thinking"), so only
    // silence gives up; a long answer that keeps coming is never cut off.
    var timer = null;
    var arm = function () { clearTimeout(timer); timer = setTimeout(function () { timedOut = true; if (ctrl) ctrl.abort(); }, self.opts.timeoutMs); };
    var disarm = function () { clearTimeout(timer); };
    arm();
    var stream = new Typewriter(this, slot);
    // A reply belongs to the conversation that asked for it. New chat, opening
    // another conversation or a change of user abandons it (gen moves on), and
    // whatever arrives later is dropped instead of landing in the wrong chat.
    var gen = this._gen = (this._gen || 0) + 1;
    var stale = function () { return gen !== self._gen; };
    this._active = { ctrl: ctrl, stream: stream, slot: slot, body: body, disarm: disarm, gen: gen };

    var hooks = {
      signal: ctrl ? ctrl.signal : undefined,
      onDelta: function (evt) {
        if (!evt || stale()) return;
        arm();
        markDelivered();
        if (evt.t === 'status') {
          label.textContent = evt.text || label.textContent;
          self.setStatusText((evt.text || '') + '…');
          if (evt.phase === 'visual') stream.hold();
          return;
        }
        if (evt.t === 'delta' || evt.t === 'replace') {
          if (!stream.started) { stopClock(); stream.start(); self.setStatusText('Replying…'); if (self.currentMood === 'thinking') self.setMood('idle'); }
          if (evt.t === 'replace') stream.replace(evt.text || ''); else stream.push(evt.text || '');
        }
      }
    };

    this.transport(body, carried, historySnapshot, hooks).then(function (data) {
      if (stale()) return;
      disarm(); stopClock(); markDelivered();
      if (!data || typeof data !== 'object') data = { status: 'error', text: 'The server sent an empty response.' };
      return stream.finish(data).then(function () {
        if (stale()) return;
        self.finishTurn(slot, data, body, reactiveMood, started, historySnapshot, facts);
      });
    }, function (err) {
      if (stale()) return;
      disarm(); stopClock(); clearTimeout(sendingT);
      if (userEl) userEl.classList.remove('sending');
      var aborted = err && err.name === 'AbortError';
      if (aborted && !timedOut) {
        // The user pressed stop: keep what was written, say so quietly.
        setUserState(userEl, '');
        var partial = stream.text();
        stream.cancel();
        var data = partial
          ? { status: 'answer', source: 'stopped', text: partial, stopped: true }
          : { status: 'stopped', source: 'stopped', text: '' };
        self.finishTurn(slot, data, body, 'idle', started, historySnapshot, facts);
        return;
      }
      stream.cancel();
      var offline = global.navigator && navigator.onLine === false;
      if (!aborted) self.setConn('offline');
      if (userEl) { userEl.classList.add('failed'); setUserState(userEl, aborted ? 'No reply' : 'Not delivered'); }
      self.finishTurn(slot, {
        status: 'error', reason: aborted ? 'timeout' : offline ? 'offline' : 'network',
        text: aborted ? 'That took longer than I could wait. Nothing was changed — try again.'
          : offline ? 'You’re offline. Check your connection and try again.'
          : 'I couldn’t reach the server just now. Nothing was changed — try again in a moment.'
      }, body, 'sad', started, historySnapshot, facts);
    });
  };

  /** Stop the reply in progress (Esc, or the stop button). */
  Widget.prototype.stop = function (silent) {
    var a = this._active;
    if (!a) return;
    if (silent) {
      // Abandon it: whatever the transport does next is ignored.
      this._gen = (this._gen || 0) + 1;
      a.disarm();
      if (a.ctrl) a.ctrl.abort();
      a.stream.cancel();
      this._active = null;
      this.busy = false;
      this._busyLabel = null;
      this.setConn(this._conn);
      if (this._tick) { clearInterval(this._tick); this._tick = null; }
      this.updateComposer();
      return;
    }
    if (a.ctrl) a.ctrl.abort();
  };

  Widget.prototype.finishTurn = function (slot, data, body, reactiveMood, started, historySnapshot, facts) {
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

    // What the server heard ("my name is …") joins this chat's context now;
    // it only becomes long-term memory if the user says yes below.
    var heard = serverFacts(data);
    for (var i = 0; i < heard.length; i++) this.convFacts[heard[i].key] = heard[i].value;

    // Every turn goes into history, data answers and clarifying questions
    // included: a transcript with holes makes an answered question look open,
    // and the model then answers it again instead of the latest message.
    this.history.push({ role: 'user', text: body });
    if (isConversational(data) && data.text) this.history.push({ role: 'assistant', text: String(data.text).slice(0, HISTORY_CHARS) });
    this.history = this.history.slice(-HISTORY_TURNS);

    var rec = { role: 'assistant', text: data.text || '', data: slimForStore(data), at: Date.now(), ms: ms, send: body };
    // The user's own words stand whatever the server made of them — but a
    // message that never arrived will be sent again, and offered again then.
    var undelivered = data.status === 'error' && /^(?:network|offline|timeout)$/.test(String(data.reason || ''));
    var offer = undelivered ? [] : this.memoryOffer((facts || []).concat(heard));
    if (offer.length) {
      rec.memo = { state: 'asked', items: offer.map(function (f) { return { key: f.key, value: f.value, on: true }; }) };
      offer.forEach(function (f) { self.suggested[factSig(f.key, f.value)] = 1; });
      this.renderMemo(slot.el, rec);
    }
    this.turns.push(rec);
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
    this.live.textContent = visualPlain(data.text).slice(0, 400) + (offer.length ? ' ' + (offer.length === 1 ? askFor(offer[0]) : 'Would you like me to remember this for next time?') : '');
    this.reveal(slot.el);
    if (this.open && this.view === 'chat' && document.activeElement !== this.input && !('ontouchstart' in global)) {
      try { this.input.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    }
    this.save();
    this.emit('answer', data);
    if (typeof this.opts.onAnswer === 'function') { try { this.opts.onAnswer(data); } catch (_) { /* host hook */ } }
  };

  function isConversational(data) {
    return !!data && data.status !== 'error' && data.status !== 'stopped';
  }

  Widget.prototype.markLast = function (turnEl) {
    var prev = this.log.querySelectorAll('.turn.assistant.last');
    for (var i = 0; i < prev.length; i++) if (prev[i] !== turnEl) prev[i].classList.remove('last');
    turnEl.classList.add('last');
    var retries = this.log.querySelectorAll('.act.retry');
    for (var j = 0; j < retries.length; j++) retries[j].hidden = !turnEl.contains(retries[j]);
  };

  Widget.prototype.markLastUser = function () {
    var users = this.log.querySelectorAll('.turn.user');
    for (var i = 0; i < users.length; i++) users[i].classList.toggle('lastu', i === users.length - 1);
  };

  Widget.prototype.lastUserEl = function () {
    var users = this.log.querySelectorAll('.turn.user');
    return users.length ? users[users.length - 1] : null;
  };

  Widget.prototype.lastUserIndex = function () {
    for (var i = this.turns.length - 1; i >= 0; i--) if (this.turns[i].role === 'user') return i;
    return -1;
  };

  /** Rebuild the model-facing history from the turns on screen. */
  Widget.prototype.rebuildHistory = function () {
    var h = [];
    this.turns.forEach(function (tr) {
      if (tr.role === 'user') h.push({ role: 'user', text: tr.send || tr.text });
      else {
        var data = tr.data || { text: tr.text };
        if (isConversational(data) && data.text) h.push({ role: 'assistant', text: String(data.text).slice(0, HISTORY_CHARS) });
      }
    });
    this.history = h.slice(-HISTORY_TURNS);
  };

  /** Re-ask the last question, replacing the last answer. */
  Widget.prototype.retry = function () {
    if (this.busy) return;
    var lastA = null, lastU = null, i;
    for (i = this.turns.length - 1; i >= 0; i--) { if (this.turns[i].role === 'assistant') { lastA = i; break; } }
    for (i = (lastA == null ? this.turns.length : lastA) - 1; i >= 0; i--) { if (this.turns[i].role === 'user') { lastU = i; break; } }
    if (lastU == null) return;
    var u = this.turns[lastU];
    if (lastA != null) {
      // A "remember this?" card that goes with the replaced answer was never
      // answered: the new answer may ask again.
      var gone = this.turns[lastA].memo, self = this;
      if (gone && gone.state === 'asked') (gone.items || []).forEach(function (it) { delete self.suggested[factSig(it.key, it.value)]; });
      this.turns.splice(lastA, 1);
    }
    // drop the matching history entries
    if (this.history.length && this.history[this.history.length - 1].role === 'assistant') this.history.pop();
    if (this.history.length && this.history[this.history.length - 1].role === 'user') this.history.pop();
    var nodes = this.log.querySelectorAll('.turn.assistant');
    var lastNode = nodes[nodes.length - 1];
    if (lastNode) lastNode.parentNode.removeChild(lastNode);
    this.submit(u.text, u.send || u.text, { retry: true });
  };

  // --- editing the last message ---------------------------------------------------
  Widget.prototype.beginEdit = function () {
    if (this.busy) return false;
    var idx = this.lastUserIndex();
    if (idx < 0) return false;
    this.cancelEdit(false);
    var tr = this.turns[idx];
    var node = this.lastUserEl();
    this._editing = { index: idx, el: node };
    this.composerEl.classList.add('editing');
    if (node) node.classList.add('editing');
    var ta = this.input;
    ta.value = tr.text;
    this.autosize();
    this.updateComposer();
    try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* ignore */ }
    return true;
  };

  Widget.prototype.cancelEdit = function (clear) {
    if (!this._editing) return;
    if (this._editing.el) this._editing.el.classList.remove('editing');
    this._editing = null;
    this.composerEl.classList.remove('editing');
    if (clear) { this.input.value = ''; this.autosize(); this.updateComposer(); }
  };

  /** Replace the edited question (and everything after it), then ask again. */
  Widget.prototype.commitEdit = function (text) {
    var ed = this._editing;
    this.cancelEdit(false);
    if (!ed || !this.turns[ed.index] || this.turns[ed.index].role !== 'user') { this.submit(text); return; }
    this.turns.splice(ed.index);
    var node = ed.el;
    while (node) {
      var next = node.nextSibling;
      if (node.classList && node.classList.contains('turn')) this.log.removeChild(node);
      node = next;
    }
    this.rebuildHistory();
    // A clarification the removed answer asked no longer stands; the one
    // before it, if any, does.
    var prev = this.turns[this.turns.length - 1];
    this.pending = prev && prev.role === 'assistant' && prev.data && prev.data.pending ? prev.data.pending : null;
    this.submit(text);
  };

  // --- memory in the conversation ---------------------------------------------------
  /** Facts in an outgoing message: straight into conversation context. */
  Widget.prototype.noticeFacts = function (text) {
    var facts = detectFacts(text);
    for (var i = 0; i < facts.length; i++) this.convFacts[facts[i].key] = facts[i].value;
    return facts;
  };

  /** Which of these facts are worth asking about: new, not declined, not already known. */
  Widget.prototype.memoryOffer = function (facts) {
    if (!this.memoryAllowed() || !this.memory.enabled || !this.memory.suggest) return [];
    var self = this, byKey = {}, order = [];
    (facts || []).forEach(function (f) {
      if (!f || !FIELD[f.key] || !f.value) return;
      var sig = factSig(f.key, f.value);
      if (self.suggested[sig] || self.memory.declined.indexOf(sig) >= 0) return;
      var cur = self.memGet(f.key);
      if (cur != null && String(cur).toLowerCase() === String(f.value).toLowerCase()) return;
      if (!byKey[f.key]) order.push(f.key);
      byKey[f.key] = f;          // one value per field; a later source (the server) wins
    });
    return order.map(function (k) { return byKey[k]; }).slice(0, 4);
  };

  /** The "remember this?" card under a reply, in whichever state it is in. */
  Widget.prototype.renderMemo = function (turnEl, rec) {
    var self = this;
    var old = turnEl.querySelector('.memo');
    if (old) old.parentNode.removeChild(old);
    var memo = rec.memo;
    if (!memo || memo.state === 'dismissed') return;
    if (memo.state === 'saved') { turnEl.appendChild(this.memoDone(turnEl, rec)); return; }
    if (!this.memoryAllowed()) return;

    var items = memo.items || [];
    var card = el('div', 'memo');
    card.setAttribute('role', 'group');
    var head = el('div', 'mh');
    var lot = el('span', 'lotus'); lot.innerHTML = LOTUS; head.appendChild(lot);
    var q = el('span', null, items.length === 1 ? askFor(items[0]) : 'Would you like me to remember this for next time?');
    q.id = 'kris-memo-' + uid();
    head.appendChild(q);
    card.setAttribute('aria-labelledby', q.id);
    card.appendChild(head);

    var ul = el('ul');
    var rows = [];
    items.forEach(function (it) {
      var f = FIELD[it.key];
      if (!f) return;
      var li = el('li');
      var cb = null;
      if (items.length > 1) {
        cb = el('input', 'check');
        cb.type = 'checkbox';
        cb.checked = it.on !== false;
        cb.setAttribute('aria-label', 'Remember ' + f.label.toLowerCase());
        li.appendChild(cb);
      }
      li.appendChild(el('span', 'k', f.label));
      var inp = el('input', 'v');
      inp.type = 'text';
      inp.value = f.choices ? choiceLabel(it.key, it.value) : it.value;
      inp.maxLength = f.max || 80;
      inp.readOnly = !!f.choices;
      inp.setAttribute('aria-label', f.label + (f.choices ? '' : ' (you can correct it before saving)'));
      if (cb) cb.addEventListener('change', function () { inp.disabled = !cb.checked; it.on = cb.checked; });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); yes.click(); } });
      li.appendChild(inp);
      ul.appendChild(li);
      rows.push({ it: it, cb: cb, inp: inp, f: f });
    });
    card.appendChild(ul);

    var acts = el('div', 'ma');
    var yes = el('button', 'btn primary sm', 'Remember');
    yes.type = 'button';
    var no = el('button', 'btn ghost sm', 'Not now');
    no.type = 'button';
    acts.appendChild(yes); acts.appendChild(no);
    acts.appendChild(el('span', 'mf', 'You can change this any time in Memory.'));
    card.appendChild(acts);

    yes.addEventListener('click', function () {
      if (!self.memory.enabled) {
        self.toast('Memory is paused, so nothing can be saved.', { label: 'Turn on', fn: function () { self.memEnable(true); } });
        return;
      }
      var saved = [], undo = [], refused = false;
      rows.forEach(function (r) {
        if (r.cb && !r.cb.checked) { self.memDecline(r.it.key, r.it.value); return; }
        var v = r.f.choices ? r.it.value : oneLine(r.inp.value, r.f.max);
        if (!v) return;
        var prev = self.memory.fields[r.it.key] ? assign({}, self.memory.fields[r.it.key]) : null;
        var res = self.memSet(r.it.key, v, 'chat');
        if (res.ok) {
          r.it.value = res.value;
          r.it.prev = prev;
          saved.push(r.it.key);
          undo.push({ key: r.it.key, value: res.value, prev: prev });
          self.convFacts[r.it.key] = res.value;
        } else if (res.reason === 'sensitive') refused = true;
      });
      if (undo.length) self._lastSaved = { at: Date.now(), fields: undo };
      memo.state = saved.length ? 'saved' : 'dismissed';
      memo.saved = saved;
      self.renderMemo(turnEl, rec);
      if (saved.length) { self.setMood('happy', MOOD_HOLD.happy); self.live.textContent = 'Saved to memory.'; }
      if (refused) self.toast('Private details like passwords, IDs or contact information aren’t saved.');
      self.refreshWelcome();
      self.save();
      try { self.input.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    });
    no.addEventListener('click', function () {
      items.forEach(function (it) { self.memDecline(it.key, it.value); });
      memo.state = 'dismissed';
      self.renderMemo(turnEl, rec);
      self.toast('Okay — that stays in this conversation only.');
      self.save();
      try { self.input.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
    });
    turnEl.appendChild(card);
  };

  Widget.prototype.memoDone = function (turnEl, rec) {
    var self = this;
    var memo = rec.memo;
    var keys = (memo.saved || []).filter(function (k) { return FIELD[k]; });
    var d = el('div', 'memo done');
    var ok = el('span', 'ok'); ok.innerHTML = ICON.check; d.appendChild(ok);
    var t = el('span');
    t.appendChild(document.createTextNode('Saved to memory: '));
    t.appendChild(el('b', null, keys.map(function (k) { return FIELD[k].label.toLowerCase(); }).join(', ') || 'details'));
    d.appendChild(t);
    d.appendChild(el('span', 'sp'));
    var undo = el('button', 'linkbtn', 'Undo');
    undo.type = 'button';
    undo.addEventListener('click', function () {
      (memo.items || []).forEach(function (it) {
        if (keys.indexOf(it.key) < 0) return;
        var cur = self.memGet(it.key);
        // Only if it still holds what this card saved: put back what was there.
        if (cur != null && String(cur) === String(it.value)) {
          if (it.prev) self.memPut(it.key, it.prev); else self.memRemove(it.key);
        }
        self.memDecline(it.key, it.value);
      });
      self._lastSaved = null;
      memo.state = 'dismissed';
      self.renderMemo(turnEl, rec);
      self.toast('Removed from memory.');
      self.save();
    });
    var manage = el('button', 'linkbtn', 'Manage');
    manage.type = 'button';
    manage.addEventListener('click', function () { self.showView('memory'); });
    d.appendChild(undo);
    d.appendChild(manage);
    return d;
  };

  /**
   * "What do you remember about me?", "remember that …", "forget my role".
   * Answered here, instantly, and never by a model: what K.R.1.S stores
   * about a person should not depend on a model's reading of a sentence.
   * Returns a reply, or null to let the message go to the server.
   */
  Widget.prototype.runMemoryCommand = function (cmd) {
    var self = this;
    var paused = !this.memory.enabled;
    var reply = function (text, actions) { return { status: 'answer', source: 'local', instant: true, text: text, actions: actions || undefined }; };
    var manage = { label: 'Manage memory', run: 'view:memory', icon: 'memory' };
    var turnOn = { label: 'Turn memory on', run: 'memory:enable', icon: 'memory' };

    if (cmd.type === 'recall') {
      var kept = this.memItems();
      var items = paused ? [] : kept;
      var only = this.convOnlyFacts();       // this chat's details that memory doesn't hold
      var show = function (f) { return FIELD[f.key].choices ? choiceLabel(f.key, f.value) : f.value; };
      var lines = [];
      if (items.length) {
        lines.push('Here’s what I remember about you:', '');
        items.forEach(function (it) { lines.push('- **' + it.label + ':** ' + it.display); });
      }
      if (only.length) {
        lines.push.apply(lines, items.length ? ['', 'From this conversation only:', ''] : ['Here’s what I know about you from this conversation:', '']);
        only.forEach(function (f) { lines.push('- **' + FIELD[f.key].label + ':** ' + show(f)); });
      }
      if (paused) {
        var why = 'Memory is paused, so I’m not using anything I’ve saved' + (kept.length
          ? ' — ' + kept.length + (kept.length === 1 ? ' detail is' : ' details are') + ' kept until you delete ' + (kept.length === 1 ? 'it' : 'them') + '.'
          : '.');
        return reply(only.length ? lines.concat(['', why + ' What you tell me is used in this chat only.']).join('\n') : why, [turnOn, manage]);
      }
      if (!lines.length) {
        // Nothing known: say so, ask, and wait for the name (a bare "Abhinav" is the answer).
        return assign(reply(UNKNOWN_USER, [{ label: 'Open profile', run: 'view:profile', icon: 'user' }]), { pending: { kind: 'name' } });
      }
      var pv = this.profileView();
      var missing = [!(pv.name || pv.preferredName) && 'your name', !pv.role && 'your role', !pv.company && 'where you work'].filter(Boolean);
      if (missing.length) lines.push('', 'I don’t know ' + joinOr(missing) + ' yet — tell me if you’d like me to.');
      if (only.length) {
        lines.push('', (items.length ? 'Those aren’t' : 'None of this is') + ' saved — it’s used in this chat only.');
        return reply(lines.join('\n'), [{ label: only.length === 1 ? 'Remember it' : 'Remember these', run: 'memory:keep-conv', icon: 'memory' }, manage]);
      }
      lines.push('', 'You can change or delete any of it in Memory.');
      return reply(lines.join('\n'), [manage]);
    }

    if (cmd.type === 'about') return this.aboutReply(cmd.topic);

    if (cmd.type === 'remember') {
      var content = oneLine(cmd.content, 320);
      if (isSensitive(content)) {
        return reply('That looks like private information — a password, an ID or account number, contact details, or something about health or money — so I won’t save it to memory. It stays in this conversation only.');
      }
      if (paused) return reply('Memory is paused, so I can’t keep that beyond this conversation. Turn it on and ask me again.', [turnOn]);
      var facts = detectFacts(content);
      if (facts.length) {
        var saved = [];
        facts.forEach(function (f) {
          var prevRec = self.memory.fields[f.key] ? assign({}, self.memory.fields[f.key]) : null;
          var r = self.memSet(f.key, f.value, 'chat');
          if (r.ok) { saved.push({ key: f.key, value: r.value, prev: prevRec }); self.convFacts[f.key] = r.value; }
        });
        if (saved.length) {
          this._lastSaved = { at: Date.now(), fields: saved };
          this.toast('Saved to memory', { label: 'Undo', fn: function () { self.undoFields(saved); } });
          return reply('Done — I’ll remember that ' + joinAnd(saved.map(function (f) { return sayFact(f.key, f.value); })) + '.', [manage]);
        }
      }
      if (content.length > NOTE_MAX) return reply('That’s a little long for me to keep. Could you put it in a sentence or two?');
      var note = capFirst(content.replace(/[.!]+$/, ''));
      var res = this.memAddNote(note, 'chat');
      if (!res.ok) {
        return reply(res.reason === 'full'
          ? 'My memory for notes is full. Delete one in Memory and ask me again.'
          : 'I couldn’t save that one.', [manage]);
      }
      if (res.existed) return reply('I already remember that.', [manage]);
      this._lastSaved = { at: Date.now(), note: res.id };
      this.toast('Saved to memory', { label: 'Undo', fn: function () { self.memRemoveNote(res.id); self.toast('Removed from memory.'); } });
      return reply('Got it. I’ll remember: “' + secondPerson(note) + '.”', [manage]);
    }

    if (cmd.type === 'forget') {
      var target = cmd.target;
      if (FORGET_ALL_RE.test(target)) {
        var n = this.memItems().length;
        if (!n) return reply('There’s nothing saved to forget — I don’t remember anything about you yet.');
        return reply('This clears everything I remember about you (' + n + (n === 1 ? ' detail' : ' details') + '). Your conversations stay as they are.',
          [{ label: 'Clear all memory', run: 'memory:clear', danger: true, icon: 'trash' }, { label: 'Keep it', run: 'dismiss' }]);
      }
      if (FORGET_LAST_RE.test(target)) {
        var ls = this._lastSaved;
        if (!ls || Date.now() - ls.at > 30 * 60000) return null;
        this._lastSaved = null;
        if (ls.note) this.memRemoveNote(ls.note);
        if (ls.fields) this.undoFields(ls.fields, true);
        return reply('Done — I’ve forgotten that.', [manage]);
      }
      var named = detectFacts(target.replace(/^that\s+/i, ''));
      if (named.length) {
        var nk = named.map(function (f) { return f.key; });
        nk.forEach(function (k) { delete self.convFacts[k]; });
        var saved2 = nk.filter(function (k) { return self.memGet(k) != null; });
        if (!saved2.length) return reply('I hadn’t saved that, so there’s nothing to forget. It won’t be used beyond this message.');
        var before2 = saved2.map(function (k) { return { key: k, rec: assign({}, self.memory.fields[k]) }; });
        saved2.forEach(function (k) { self.memRemove(k); });
        this.toast('Removed from memory', { label: 'Undo', fn: function () { before2.forEach(function (b) { self.memPut(b.key, b.rec); }); self.toast('Restored.'); } });
        return reply('Done — I’ve forgotten your ' + joinAnd(saved2.map(function (k) { return FIELD[k].label.toLowerCase(); })) + '.', [manage]);
      }
      for (var i = 0; i < FORGET_FIELDS.length; i++) {
        if (!FORGET_FIELDS[i][0].test(target)) continue;
        var keys = FORGET_FIELDS[i][1];
        keys.forEach(function (k) { delete self.convFacts[k]; });
        var have = keys.filter(function (k) { return self.memGet(k) != null; });
        if (!have.length) return reply('I don’t have your ' + FIELD[keys[0]].label.toLowerCase() + ' saved, so there’s nothing to forget.');
        var before = have.map(function (k) { return { key: k, rec: assign({}, self.memory.fields[k]) }; });
        have.forEach(function (k) { self.memRemove(k); });
        this.toast('Removed from memory', { label: 'Undo', fn: function () { before.forEach(function (b) { self.memPut(b.key, b.rec); }); self.toast('Restored.'); } });
        return reply('Done — I’ve forgotten your ' + joinAnd(have.map(function (k) { return FIELD[k].label.toLowerCase(); })) + '.', [manage]);
      }
      var hit = this.findNote(target);
      if (hit) {
        var at = this.memory.notes.indexOf(hit);
        this.memRemoveNote(hit.id);
        this.toast('Removed from memory', { label: 'Undo', fn: function () { self.memInsertNote(hit, at); self.toast('Restored.'); } });
        return reply('Done — I’ve forgotten “' + hit.text + '”.', [manage]);
      }
      if (/^\s*(?:please\s+)?(?:forget|stop remembering)\s+(?:about\s+)?(?:my|mine|what you know about me)\b/i.test(cmd.raw || '') && target.split(/\s+/).length <= 4) {
        return reply('I couldn’t find anything like that in what I remember.', [manage]);
      }
      return null;
    }
    return null;
  };

  /**
   * "Where do I work?", "what's my role?" — answered from this chat and what
   * the user let K.R.1.S remember. What it does not know, it says so.
   */
  Widget.prototype.aboutReply = function (topic) {
    var p = this.profileView();
    var paused = this.memoryAllowed() && !this.memory.enabled;
    var reply = function (text, actions) { return { status: 'answer', source: 'local', instant: true, text: text, actions: actions || undefined }; };
    var profileAct = { label: 'Add it to your profile', run: 'view:profile', icon: 'user' };
    var role = p.role ? article(p.role) + ' ' + lowerFirst(p.role) : null;
    var unknown = function (what, example) {
      var savedButPaused = paused && FIELD_FOR_TOPIC[topic] && FIELD_FOR_TOPIC[topic].some(function (k) { return this.memGet(k) != null; }, this);
      if (savedButPaused) return reply('Memory is paused, so I’m not using what I saved about ' + what + '. Turn it on and ask me again.', [{ label: 'Turn memory on', run: 'memory:enable', icon: 'memory' }]);
      return reply('You haven’t told me ' + what + ' yet. Tell me — for example “' + example + '” — and I’ll use it in this chat and offer to remember it.', [profileAct]);
    }.bind(this);
    switch (topic) {
      case 'work':
        if (p.company) return reply('You work at **' + p.company + '**' + (p.department ? ', in ' + p.department : '') + (role ? ', as ' + role : '') + '.');
        if (role || p.department) return reply('You haven’t told me which company you work for — I do know you’re ' + (role || 'in ' + p.department) + '.', [profileAct]);
        return unknown('where you work', 'I work at …');
      case 'role':
        if (role) return reply('You’re ' + role + (p.company ? ' at ' + p.company : '') + '.');
        return unknown('your role', 'I work as a marine emissions analyst');
      case 'department':
        if (p.department) return reply('You’re in ' + p.department + (p.company ? ' at ' + p.company : '') + '.');
        return unknown('your department', 'I’m in the emissions team');
      case 'location':
        if (p.location) return reply('You’re based in ' + p.location + '.');
        return unknown('where you’re based', 'I’m based in …');
      case 'timezone':
        if (p.timezone) return reply('Your time zone is ' + p.timezone + '.');
        return reply('You haven’t set a time zone, so I use this device’s' + (detectedTz() ? ' (' + detectedTz() + ')' : '') + '.', [profileAct]);
      case 'interests':
        if (p.interests) return reply('You’re interested in ' + p.interests + '.');
        return unknown('what you focus on', 'I’m interested in FuelEU Maritime');
      case 'name':
        if (p.preferredName || p.name) return reply('You’re ' + (p.name || p.preferredName) + (p.preferredName && p.name && p.preferredName !== p.name ? ' — I call you ' + p.preferredName : '') + '.');
        var askName = unknown('your name', 'my name is …');
        return /paused/.test(askName.text) ? askName : assign(askName, { text: 'You haven’t told me your name yet. What should I call you?', pending: { kind: 'name' } });
      default:
        return null;
    }
  };

  /** Put back what a "remember" replaced (or remove what it added). */
  Widget.prototype.undoFields = function (saved, quiet) {
    var self = this;
    saved.forEach(function (f) {
      if (f.prev) self.memPut(f.key, f.prev); else self.memRemove(f.key);
      delete self.convFacts[f.key];
    });
    if (!quiet) this.toast('Removed from memory.');
  };

  /** Buttons inside a reply. Only section links may come from the server. */
  Widget.prototype.runAction = function (a, wrap) {
    var run = String(a && a.run || '');
    var lock = function () { var b = wrap ? wrap.querySelectorAll('button') : []; for (var i = 0; i < b.length; i++) b[i].disabled = true; };
    var m = run.match(/^view:(\w+)$/);
    if (m) { this.showView(m[1]); return; }
    if (run === 'memory:enable') { this.memEnable(true); this.toast('Memory is on.'); lock(); return; }
    if (run === 'memory:clear') { this.memClear(); this.toast('Memory cleared.'); lock(); return; }
    if (run === 'memory:keep-conv') {
      var self = this, kept = 0;
      if (!this.memory.enabled) { this.toast('Memory is paused, so nothing can be saved.', { label: 'Turn on', fn: function () { self.memEnable(true); } }); return; }
      var saved = [];
      this.convOnlyFacts().forEach(function (f) {
        var prev = self.memory.fields[f.key] ? assign({}, self.memory.fields[f.key]) : null;
        if (self.memSet(f.key, f.value, 'chat').ok) { saved.push({ key: f.key, prev: prev }); kept++; }
      });
      if (kept) {
        this.toast(kept === 1 ? 'Saved to memory.' : 'Saved ' + kept + ' details to memory.', { label: 'Undo', fn: function () {
          saved.forEach(function (f) { if (f.prev) self.memPut(f.key, f.prev); else self.memRemove(f.key); });
          self.toast('Removed from memory.');
        } });
      } else this.toast('Nothing new to save.');
      lock();
      return;
    }
    if (run === 'dismiss') { lock(); if (this.input) this.input.focus(); }
  };

  // ==========================================================================
  //  Streaming renderer: steady reveal, markdown re-rendered per frame
  // ==========================================================================
  /**
   * Blocks that can no longer change (everything before the last blank line
   * outside a code fence) are drawn once and kept; only the block still being
   * written is redrawn each frame. The result is the same DOM a full render
   * gives, without rebuilding a long answer sixty times a second.
   */
  function Typewriter(widget, slot) {
    this.w = widget; this.slot = slot;
    this.target = ''; this.shown = 0; this.started = false; this.done = false;
    this.raf = null; this.resolve = null; this.last = 0;
    this.frozen = 0; this.tail = []; this.caret = null; this.skel = null; this.holding = false;
  }
  Typewriter.prototype.reset = function () {
    this.slot.msg.innerHTML = '';
    this.frozen = 0; this.tail = []; this.caret = null;
  };
  Typewriter.prototype.start = function () {
    this.started = true;
    this.slot.el.classList.add('streaming');
    this.reset();
    this.tick();
  };
  Typewriter.prototype.push = function (t) { this.target += t; this.holding = false; this.tick(); };
  /** The server is holding a visual until it is complete: show where it will land. */
  Typewriter.prototype.hold = function () { if (!this.started || this.holding) return; this.holding = true; this.render(); };
  Typewriter.prototype.replace = function (t) { this.target = t; this.shown = Math.min(this.shown, t.length); if (this.started) this.reset(); this.tick(); };
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
      this.shown = skipVisual(this.target, Math.min(this.target.length, this.shown + step));
      this.render(false);
    }
    if (this.shown < this.target.length) this.tick();
    else if (this.resolve) { var r = this.resolve; this.resolve = null; r(); }
  };
  Typewriter.prototype.render = function () {
    var msg = this.slot.msg;
    var text = this.target.slice(0, this.shown);
    if (this.caret && this.caret.parentNode) this.caret.parentNode.removeChild(this.caret);
    if (this.skel && this.skel.parentNode) this.skel.parentNode.removeChild(this.skel);
    for (var i = 0; i < this.tail.length; i++) if (this.tail[i].parentNode === msg) msg.removeChild(this.tail[i]);
    var cut = stableCut(text);
    if (cut > this.frozen) {
      var chunk = text.slice(this.frozen, cut);
      if (chunk.trim()) { var done = document.createDocumentFragment(); renderRich(done, chunk, false); msg.appendChild(done); }
      this.frozen = cut;
    }
    var live = document.createDocumentFragment();
    renderRich(live, text.slice(this.frozen), true);
    this.tail = Array.prototype.slice.call(live.childNodes);
    msg.appendChild(live);
    var caret = this.caret = el('span', 'caret');
    var lastBlock = msg.lastElementChild;
    var host = lastBlock && /^(P|LI|H4)$/.test(lastBlock.tagName) ? lastBlock
      : lastBlock && (lastBlock.tagName === 'UL' || lastBlock.tagName === 'OL') ? (lastBlock.lastElementChild || lastBlock) : msg;
    host.appendChild(caret);
    if (this.holding) { this.skel = vzSkeleton(); msg.appendChild(this.skel); }
    this.w.stick();
  };

  /** Where the finished blocks end: just after the last blank line outside a code fence. */
  var FENCE_OPEN_RE = /^\s*```\s*([\w+#.-]*)\s*$/, FENCE_CLOSE_RE = /^\s*```\s*$/;
  var VZ_SPEC_START = /^\{ ?"type" ?: ?"(?:stats|bar|line|breakdown|meter|compare|steps|timeline|map|dashboard)"/i;
  function stableCut(text) {
    var lines = String(text).split('\n'), pos = 0, cut = 0, fence = false;
    for (var i = 0; i < lines.length - 1; i++) {   // the last line may still be growing
      var line = lines[i];
      if (fence) { if (FENCE_CLOSE_RE.test(line)) { fence = false; cut = pos + line.length + 1; } }
      else if (FENCE_OPEN_RE.test(line)) fence = true;
      else if (!line.trim()) cut = pos + line.length + 1;
      pos += line.length + 1;
    }
    return cut;
  }
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

  /**
   * Where the view should rest so an answer can be read from its first line:
   * the bottom, unless the answer is taller than the view — then its top,
   * with the tail of the question still showing above it.
   */
  Widget.prototype.restingTop = function (turnEl) {
    var log = this.log;
    var bottom = log.scrollHeight - log.clientHeight;
    if (!turnEl || !log.clientHeight || !turnEl.getBoundingClientRect) return bottom;
    var lr = log.getBoundingClientRect(), ar = turnEl.getBoundingClientRect();
    if (!ar.height) return bottom;
    var top = ar.top - lr.top + log.scrollTop - 44;
    return Math.max(0, Math.min(bottom, top));
  };

  /** Keep pinned to the new text while it streams — until the answer fills the view, or the user scrolls up. */
  Widget.prototype.stick = function () {
    if (!this._stick) { this.jump.classList.add('on'); return; }
    var a = this._active && this._active.slot ? this._active.slot.el : null;
    var log = this.log;
    var bottom = log.scrollHeight - log.clientHeight;
    var rest = this.restingTop(a);
    log.scrollTop = rest;
    if (rest < bottom - 4) { this._stick = false; this.jump.classList.add('on'); }
  };

  /** A finished answer: show it from its beginning if it is long. */
  Widget.prototype.reveal = function (turnEl) {
    var log = this.log;
    var bottom = log.scrollHeight - log.clientHeight;
    if (!this._stick && log.scrollTop < bottom - 48) { this.jump.classList.add('on'); return; }
    var rest = this.restingTop(turnEl);
    log.scrollTop = Math.max(log.scrollTop, rest);
    this._stick = rest >= bottom - 4;
    this.jump.classList.toggle('on', !this._stick);
  };

  Widget.prototype.addUserTurn = function (text, restoring) {
    var self = this;
    var t = el('div', 'turn user' + (restoring ? '' : ' anim'));
    t.appendChild(el('div', 'bubble', text));
    var ua = el('div', 'uact');
    ua.appendChild(el('span', 'ustate'));
    var copy = toolButton('act copy', ICON.copy, 'Copy message');
    copy.addEventListener('click', function () {
      copyText(text, function () { flashCopied(copy); self.live.textContent = 'Copied.'; });
    });
    var edit = toolButton('act edit', ICON.edit, 'Edit and resend');
    edit.addEventListener('click', function () { self.beginEdit(); });
    ua.appendChild(copy);
    ua.appendChild(edit);
    t.appendChild(ua);
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
    if (saved.id) this.convId = String(saved.id).slice(0, 40);
    this.convFacts = cleanFacts(saved.facts);
    this.pick = cleanPick(saved.pick);
    this.applyContext();
    this.suggested = saved.suggested && typeof saved.suggested === 'object' ? saved.suggested : {};
    if (saved.pending) this.pending = saved.pending;
    var turns = Array.isArray(saved.turns) ? saved.turns.filter(function (t) { return t && (t.role === 'user' || t.role === 'assistant'); }) : [];
    this.turns = turns;
    // Nothing is saved half-restored (setWide saves).
    this._restoring = true;
    try { if (saved.wide) this.setWide(true); } finally { this._restoring = false; }
    if (!turns.length) return;
    this.hideWelcome();
    var lastSlot = null;
    turns.forEach(function (tr) {
      if (tr.role === 'user') {
        self.addUserTurn(String(tr.text || ''), true);
      } else {
        var slot = self.addAssistantTurn(true);
        var data = tr.data || { status: 'answer', text: tr.text };
        slot.msg.appendChild(self.renderAnswer(data, tr.send, true));
        self.renderMeta(slot, data, tr.send, tr.ms, tr.at);
        if (tr.memo) self.renderMemo(slot.el, tr);
        lastSlot = slot;
      }
    });
    this.rebuildHistory();
    if (lastSlot) this.markLast(lastSlot.el);
    this.markLastUser();
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
      var copy = toolButton('act copy', ICON.copy, 'Copy');
      copy.addEventListener('click', function () {
        copyText(plainText(data), function () { flashCopied(copy); self.live.textContent = 'Copied.'; });
      });
      meta.appendChild(copy);
    }
    if (data.status === 'answer' || data.status === 'help') {
      var up = toolButton('act react up', ICON.up, 'Good answer');
      var down = toolButton('act react down', ICON.down, 'Bad answer');
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
    if (!isErr && data.source !== 'local') {   // an error card carries its own "Try again"; a local reply has nothing to regenerate
      var retry = toolButton('act retry', ICON.retry, 'Regenerate');
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
      n.setAttribute('role', 'alert');
      var ic = el('span', 'ic'); ic.innerHTML = ICON.alert; n.appendChild(ic);
      var tx = el('div', 'txt');
      tx.appendChild(el('div', null, data.text || 'Something went wrong.'));
      var sub = [data.code, data.detail || null, data.build ? 'build ' + data.build : null].filter(Boolean).join(' · ');
      if (sub) tx.appendChild(el('div', 'sub', sub));
      if (data.status === 'error' && !/^(unauthenticated|no_token|session_rejected|auth_not_configured)$/.test(String(data.reason || '')) && question && !restoring) {
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

    // What a follow-up was read against, so the user can see it at a glance.
    if (data.context && data.context.kind === 'follow_up' && data.context.about) {
      frag.appendChild(el('p', 'ctxline', 'Following up on “' + String(data.context.about).slice(0, 80) + '”'));
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

    // Visuals the server attached (a map of positions it read): the same renderer as the model's.
    vzList(data.visuals, 2).forEach(function (spec) { var v = renderVisual(spec); if (v) container.appendChild(v); });

    if (data.interpreted) container.appendChild(el('p', 'subject', 'Read as “' + data.interpreted + '”'));
    if (data.footnote) container.appendChild(el('p', 'subject', data.footnote));
    if (data.note) container.appendChild(el('div', 'note', data.note));
    if (data.truncated && data.rows) container.appendChild(el('div', 'note hard', 'Only the first ' + data.rows.length + ' readings are shown. Narrow the period to see the rest.'));
    if (data.provenance) container.appendChild(renderProvenance(data));

    if (data.options && data.options.length) frag.appendChild(this.renderChoices(data.options, restoring));

    var actions = safeActions(data);
    if (actions.length) frag.appendChild(this.renderActions(actions, restoring));

    var chips = [];
    if (this.opts.followups && data.status === 'answer') chips = followupsFor(data);
    if (Array.isArray(data.suggestions)) chips = chips.concat(data.suggestions.slice(0, 4).map(function (s) { return { label: String(s), text: String(s) }; }));
    if (chips.length) frag.appendChild(this.renderFollowups(chips));
    return frag;
  };

  /** Action buttons in a reply. A restored destructive action stays disabled. */
  Widget.prototype.renderActions = function (actions, restoring) {
    var self = this;
    var wrap = el('div', 'chips actions');
    actions.forEach(function (a) {
      var b = el('button', 'chip' + (a.danger ? ' danger' : ''));
      b.type = 'button';
      if (a.icon && Object.prototype.hasOwnProperty.call(ICON, a.icon)) b.innerHTML = ICON[a.icon];
      b.appendChild(document.createTextNode(a.label));
      if (restoring && !/^view:/.test(a.run)) b.disabled = true;
      b.addEventListener('click', function () { if (!self.busy) self.runAction(a, wrap); });
      wrap.appendChild(b);
    });
    return wrap;
  };

  /** Actions a reply may carry: anything from K.R.1.S itself, only section links from a server. */
  function safeActions(data) {
    if (!Array.isArray(data.actions)) return [];
    var local = data.source === 'local';
    return data.actions.filter(function (a) {
      if (!a || typeof a.label !== 'string' || typeof a.run !== 'string') return false;
      if (/^view:(history|profile|memory|appearance|settings|about)$/.test(a.run)) return true;
      return local && /^(memory:enable|memory:clear|memory:keep-conv|dismiss)$/.test(a.run);
    }).slice(0, 4).map(function (a) {
      return { label: a.label.slice(0, 40), run: a.run, danger: !!a.danger && local, icon: typeof a.icon === 'string' ? a.icon : null };
    });
  }

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
    var t = visualPlain(data.text);
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
      var fence = line.match(FENCE_OPEN_RE);
      if (fence) {
        flushPara();
        var code = [];
        i++;
        while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i])) { code.push(lines[i]); i++; }
        var closed = i < lines.length;
        i++;
        // A visual spec the model fenced as ```json (or bare ```) is still a
        // visual: drawn, never shown as raw JSON. Other JSON stays code.
        var json = code.join('\n');
        var loose = /^(?:json|js|javascript)?$/i.test(fence[1]) && VZ_SPEC_START.test(json.replace(/\s+/g, ' ').trim());
        if (/^visual$/i.test(fence[1]) || loose) {
          // Still arriving: a placeholder. Complete: the component, or nothing
          // if it is malformed — the prose around it still reads on its own.
          if (!closed && streaming) { container.appendChild(vzSkeleton()); continue; }
          var spec = null;
          try { spec = JSON.parse(json); } catch (_) { spec = null; }
          var fig = spec ? renderVisual(spec) : null;
          if (fig) {
            var sig = hashStr(json);
            if (!VZ_SEEN[sig]) { VZ_SEEN[sig] = 1; fig.classList.add('fresh'); }
            container.appendChild(fig);
            continue;
          }
          if (!loose) continue;
        }
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
    var isNum = function (c) { return /^[-+]?[\d,.]+\s*%?$/.test(c); };
    var head = cells(rows[0]);
    var body = rows.slice(2).map(cells);
    // A column is numeric when every filled cell in it is a number; its
    // header then lines up with the figures beneath it. The first column
    // names the rows (a year, a vessel), so it always reads left to right.
    var numCol = head.map(function (_, k) {
      if (!k) return false;
      var seen = false;
      for (var r = 0; r < body.length; r++) { var c = body[r][k]; if (c == null || c === '') continue; if (!isNum(c)) return false; seen = true; }
      return seen;
    });
    var t = el('table', 'grid');
    var tr = el('tr');
    head.forEach(function (c, k) { var th = el('th', numCol[k] ? 'num' : null); appendInline(th, c); tr.appendChild(th); });
    t.appendChild(tr);
    body.forEach(function (r) {
      var row = el('tr');
      r.forEach(function (c, k) { var td = el('td', numCol[k] ? 'num' : null); appendInline(td, c); row.appendChild(td); });
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
    var w = el('div', 'tablewrap');
    w.appendChild(table);
    return w;
  }

  // --- charts ----------------------------------------------------------------
  // ==========================================================================
  //  Visuals — a ```visual {json}``` block in an answer becomes a component.
  //
  //  The model picks the form (stats, bar, line, breakdown, meter, compare,
  //  steps, timeline, or a dashboard of them); this code owns how it looks.
  //  Every spec is untrusted: known types and fields only, every string capped
  //  and set with textContent, every number checked, colours from the palette
  //  below and never from the spec. Anything malformed renders nothing, and
  //  the prose around it still stands.
  //
  //  Palette: categorical slots validated (dataviz six checks) against the
  //  panel surface in each theme; one series always takes slot 1; status
  //  colours are reserved for good / watch / risk and always carry an icon
  //  and a word.
  // ==========================================================================
  var VZ_SEEN = {};   // specs already animated on this page: a re-render stays still

  function vzStr(v, max) { return typeof v === 'string' || typeof v === 'number' ? oneLine(String(v), max || 80) : ''; }
  function vzNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && /^\s*[-+]?(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?\s*$/.test(v) && /\d/.test(v)) { var n = Number(v.replace(/[,\s]/g, '')); return isFinite(n) ? n : null; }
    return null;
  }
  function vzList(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
  function vzRound(x) { return Math.round(x * 10) / 10; }
  /** 1,284 · 12.9K · 4.2M — compact past 100,000, plain below. */
  function vzFmt(v, unit) {
    var a = Math.abs(v), s;
    if (a >= 1e9) s = vzRound(v / 1e9).toLocaleString('en-GB') + 'B';
    else if (a >= 1e6) s = vzRound(v / 1e6).toLocaleString('en-GB') + 'M';
    else if (a >= 1e5) s = vzRound(v / 1e3).toLocaleString('en-GB') + 'K';
    else s = Number(v).toLocaleString('en-GB', { maximumFractionDigits: a >= 100 ? 1 : a >= 1 ? 2 : 3 });
    return s + (unit ? (/^[%°‰]/.test(unit) ? '' : ' ') + unit : '');
  }
  var VZ_TONES = { good: 'good', ok: 'good', positive: 'good', pass: 'good', compliant: 'good', warn: 'warn', warning: 'warn', watch: 'warn', caution: 'warn', medium: 'warn', bad: 'bad', risk: 'bad', critical: 'bad', negative: 'bad', danger: 'bad', fail: 'bad', neutral: 'neutral', info: 'neutral' };
  var VZ_TONE_WORD = { good: 'On track', warn: 'Watch', bad: 'At risk', neutral: 'Info' };
  function vzTone(v) { return VZ_TONES[String(v || '').toLowerCase()] || null; }
  function vzBadge(tone, word) {
    var b = el('span', 'vz-tone t-' + tone);
    var ic = el('span', 'ic');
    ic.innerHTML = tone === 'good' ? ICON.check : tone === 'bad' ? ICON.close : ICON.alert;
    b.appendChild(ic);
    b.appendChild(document.createTextNode(word || VZ_TONE_WORD[tone]));
    return b;
  }

  /** A visual from a parsed spec, or null. `o.bare`: no card chrome (inside a data card). */
  function renderVisual(spec, o) {
    o = o || {};
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
    var type = String(spec.type || '').toLowerCase();
    var fn = VZ_RENDER[type];
    if (!fn || (o.nested && type === 'dashboard')) return null;
    var body;
    try { body = fn(spec, o); } catch (_) { body = null; }
    if (!body) return null;
    var title = vzStr(spec.title, 90);
    var sub = vzStr(spec.subtitle, 60) || (/^(?:bar|line|breakdown)$/.test(type) ? vzStr(spec.unit, 20) : '');
    if (o.bare) {
      var frag = document.createDocumentFragment();
      if (title) frag.appendChild(el('p', 'chart-title', title));
      frag.appendChild(body);
      return frag;
    }
    var fig = el('figure', 'vz vz-' + type);
    if (title || sub) {
      var cap = el('figcaption', 'vz-h');
      if (title) cap.appendChild(el('span', 'vz-t', title));
      if (sub) cap.appendChild(el('span', 'vz-u', sub));
      fig.appendChild(cap);
    }
    fig.appendChild(body);
    return fig;
  }

  var VZ_MAP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  /** Web Mercator pixel of a position at zoom z (256-px tiles). */
  function vzMerc(lat, lon, z) {
    var n = 256 * Math.pow(2, z), sn = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n];
  }
  function vzPos(lat, lon) {
    var f = function (v, p, q) { var a = Math.abs(v), d = Math.floor(a), m = Math.round((a - d) * 60); if (m === 60) { d++; m = 0; } return d + '°' + (m < 10 ? '0' : '') + m + '′' + (v >= 0 ? p : q); };
    return f(lat, 'N', 'S') + ' ' + f(lon, 'E', 'W');
  }

  var VZ_RENDER = {
    // Positions on a map: tiles under an SVG, so it scales with the panel and
    // needs no library. Tile addresses come from the widget's mapTiles option,
    // never from the spec; the spec supplies only numbers and short labels.
    map: function (s) {
      var pts = vzList(s.points, 12).map(function (p) {
        if (!p || typeof p !== 'object') return null;
        var lat = vzNum(p.lat), lon = vzNum(p.lon);
        if (lat == null || lon == null || Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
        return { lat: lat, lon: lon, name: vzStr(p.name, 40), note: vzStr(p.note, 90) };
      }).filter(Boolean);
      if (!pts.length) return null;
      var track = vzList(s.track, 600).map(function (t) {
        var la = vzNum(t && t[0]), lo = vzNum(t && t[1]);
        return la != null && lo != null && Math.abs(la) <= 85 && Math.abs(lo) <= 180 ? [la, lo] : null;
      }).filter(Boolean);
      var W = 320, H = 200, ns = 'http://www.w3.org/2000/svg';
      var all = pts.map(function (p) { return [p.lat, p.lon]; }).concat(track);
      var z, box;
      for (z = 7; z >= 1; z--) {
        var xy = all.map(function (a) { return vzMerc(a[0], a[1], z); });
        box = [Math.min.apply(null, xy.map(function (q) { return q[0]; })), Math.min.apply(null, xy.map(function (q) { return q[1]; })),
               Math.max.apply(null, xy.map(function (q) { return q[0]; })), Math.max.apply(null, xy.map(function (q) { return q[1]; }))];
        if (box[2] - box[0] <= W - 70 && box[3] - box[1] <= H - 50) break;
      }
      z = Math.max(z, 1);
      var ox = (box[0] + box[2]) / 2 - W / 2, oy = (box[1] + box[3]) / 2 - H / 2;
      var mk = function (tag, attrs) { var e = document.createElementNS(ns, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); return e; };
      var svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Map: ' + pts.map(function (p) { return (p.name ? p.name + ' ' : '') + vzPos(p.lat, p.lon); }).join('; ') });
      if (VZ_MAP_TILES && typeof VZ_MAP_TILES === 'string') {
        var n = Math.pow(2, z);
        for (var tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++) {
          for (var ty = Math.max(0, Math.floor(oy / 256)); ty <= Math.min(n - 1, Math.floor((oy + H) / 256)); ty++) {
            var href = VZ_MAP_TILES.replace('{z}', z).replace('{x}', ((tx % n) + n) % n).replace('{y}', ty);
            svg.appendChild(mk('image', { href: href, x: tx * 256 - ox - 0.5, y: ty * 256 - oy - 0.5, width: 257, height: 257 }));
          }
        }
      }
      if (track.length > 1) {
        svg.appendChild(mk('polyline', { class: 'trk', points: track.map(function (a) { var q = vzMerc(a[0], a[1], z); return (q[0] - ox).toFixed(1) + ',' + (q[1] - oy).toFixed(1); }).join(' ') }));
      }
      pts.forEach(function (p) {
        var q = vzMerc(p.lat, p.lon, z), x = q[0] - ox, y = q[1] - oy;
        svg.appendChild(mk('circle', { class: 'pin', cx: x.toFixed(1), cy: y.toFixed(1), r: 5.5 }));
        if (p.name) {
          var left = x > W - 90;
          var t = mk('text', { class: 'pin-l', x: (x + (left ? -9 : 9)).toFixed(1), y: (y + 4).toFixed(1), 'text-anchor': left ? 'end' : 'start' });
          t.textContent = p.name;
          svg.appendChild(t);
        }
      });
      var wrap = el('div', 'vz-map-b');
      wrap.appendChild(svg);
      var list = el('ul', 'vz-map-l');
      pts.forEach(function (p) {
        var li = el('li');
        if (p.name) li.appendChild(el('b', null, p.name + ' '));
        li.appendChild(document.createTextNode(vzPos(p.lat, p.lon) + (p.note ? ' · ' + p.note : '')));
        list.appendChild(li);
      });
      wrap.appendChild(list);
      if (VZ_MAP_TILES && typeof VZ_MAP_TILES === 'string') wrap.appendChild(el('p', 'vz-map-a', 'Map data © OpenStreetMap contributors'));
      return wrap;
    },

    stats: function (s) {
      var items = vzList(s.items, 6).map(function (it) {
        if (!it || typeof it !== 'object') return null;
        var label = vzStr(it.label, 48);
        var num = vzNum(it.value);
        var value = num != null ? vzFmt(num) : vzStr(it.value, 24);
        if (!label || !value) return null;
        return { label: label, value: value, unit: vzStr(it.unit != null ? it.unit : num != null ? s.unit : '', 20), note: vzStr(it.note, 90), delta: vzStr(it.delta, 24), tone: vzTone(it.tone), status: vzStr(it.status, 24) };
      }).filter(Boolean);
      if (!items.length) return null;
      var g = el('div', 'vz-stats-g');
      items.forEach(function (it, i) {
        var tile = el('div', 'vz-stat');
        tile.style.setProperty('--i', i);
        tile.appendChild(el('div', 'vz-sl', it.label));
        var v = el('div', 'vz-sv', it.value);
        if (it.unit) v.appendChild(el('span', 'vz-su', it.unit));
        tile.appendChild(v);
        if (it.tone || it.note || it.delta) {
          var foot = el('div', 'vz-sn');
          if (it.tone) foot.appendChild(vzBadge(it.tone, it.status));
          if (it.delta) foot.appendChild(el('span', 'vz-d', it.delta));
          if (it.note) foot.appendChild(el('span', null, it.note));
          tile.appendChild(foot);
        }
        g.appendChild(tile);
      });
      return g;
    },

    bar: function (s, o) {
      var labels = vzList(s.labels, 16), values = vzList(s.values, 16), rows = [];
      for (var i = 0; i < Math.min(labels.length, values.length); i++) {
        var v = vzNum(values[i]), l = vzStr(labels[i], 40);
        if (v == null || !l) return null;
        rows.push({ l: l, v: v });
      }
      if (rows.length < 2 || labels.length !== values.length) return null;
      var unit = vzStr(s.unit, 16), hl = vzStr(s.highlight, 40).toLowerCase();
      var vals = rows.map(function (r) { return r.v; });
      var max = Math.max.apply(null, vals.concat(0)), min = Math.min.apply(null, vals.concat(0));
      var span = max - min || 1, zero = (-min / span) * 100;
      var wrap = el('div', 'vz-bars' + (min < 0 ? '' : ' pos'));
      wrap.setAttribute('role', 'list');
      rows.forEach(function (r, i) {
        var row = el('div', 'vz-row' + (hl ? (r.l.toLowerCase() === hl ? ' hi' : ' lo') : ''));
        row.setAttribute('role', 'listitem');
        row.title = r.l + ': ' + vzFmt(r.v, unit);
        row.style.setProperty('--i', i);
        row.appendChild(el('span', 'vz-bl', r.l));
        var track = el('span', 'vz-track');
        var w = Math.abs(r.v) / span * 100;
        var bar = el('i', r.v < 0 ? 'neg' : null);
        bar.style.left = (r.v < 0 ? zero - w : zero) + '%';
        bar.style.width = Math.max(w, 0.8) + '%';
        track.appendChild(bar);
        if (min < 0) { var z = el('b', 'vz-zero'); z.style.left = zero + '%'; track.appendChild(z); }
        row.appendChild(track);
        row.appendChild(el('span', 'vz-bv', vzFmt(r.v, o && o.bare ? unit : '')));
        wrap.appendChild(row);
      });
      return wrap;
    },

    line: function (s) {
      var labels = vzList(s.labels, 400).map(function (l) { return vzStr(l, 24); });
      var raw = Array.isArray(s.series) ? s.series : Array.isArray(s.values) ? [{ name: s.name || '', values: s.values }] : [];
      var unit = vzStr(s.unit, 16);
      var series = raw.slice(0, 3).map(function (se) {
        if (!se || !Array.isArray(se.values) || se.values.length !== labels.length) return null;
        var vs = se.values.map(vzNum);
        return vs.every(function (v) { return v != null; }) ? { name: vzStr(se.name, 40), values: vs } : null;
      });
      if (labels.length < 2 || !series.length || series.some(function (x) { return !x; })) return null;
      var all = [].concat.apply([], series.map(function (x) { return x.values; }));
      var sc = niceScale(Math.min.apply(null, all), Math.max.apply(null, all), 4);
      var n = labels.length;
      var X = function (i) { return (i / (n - 1)) * 100; };
      var Y = function (v) { return (1 - (v - sc.lo) / (sc.hi - sc.lo)) * 100; };
      var ns = 'http://www.w3.org/2000/svg';

      var box = el('div', 'vz-linec');
      var plot = el('div', 'vz-plot');
      plot.tabIndex = 0;
      plot.setAttribute('role', 'img');
      plot.setAttribute('aria-label', (vzStr(s.title, 90) || 'Trend') + ': ' + series.map(function (se) {
        return (se.name ? se.name + ' ' : '') + 'from ' + vzFmt(se.values[0], unit) + ' (' + labels[0] + ') to ' + vzFmt(se.values[n - 1], unit) + ' (' + labels[n - 1] + ')';
      }).join('; '));
      sc.ticks.forEach(function (t) {
        var gl = el('div', 'vz-gl');
        gl.style.top = Y(t) + '%';
        gl.appendChild(el('span', null, vzFmt(t)));
        plot.appendChild(gl);
      });
      var area = el('div', 'vz-area');
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      series.forEach(function (se, k) {
        var d = se.values.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(2) + ' ' + Y(v).toFixed(2); }).join(' ');
        if (series.length === 1) {
          var ar = document.createElementNS(ns, 'path');
          ar.setAttribute('class', 'ar s' + k);
          ar.setAttribute('d', d + ' L100 100 L0 100 Z');
          svg.appendChild(ar);
        }
        var ln = document.createElementNS(ns, 'path');
        ln.setAttribute('class', 'ln s' + k);
        ln.setAttribute('d', d);
        svg.appendChild(ln);
      });
      area.appendChild(svg);
      series.forEach(function (se, k) {
        var dot = el('span', 'vz-dot s' + k);
        dot.style.left = '100%';
        dot.style.top = Y(se.values[n - 1]) + '%';
        area.appendChild(dot);
      });
      if (series.length === 1) {
        var endv = el('span', 'vz-endv', vzFmt(series[0].values[n - 1], unit));
        endv.style.top = Y(series[0].values[n - 1]) + '%';
        area.appendChild(endv);
      }
      // Hover / focus: a crosshair that snaps to the nearest point, and one
      // readout for every series at that point.
      var xh = el('div', 'vz-x'), tip = el('div', 'vz-tip'), hd = series.map(function (se, k) { var d = el('span', 'vz-dot vz-hd s' + k); area.appendChild(d); return d; });
      area.appendChild(xh);
      area.appendChild(tip);
      plot.appendChild(area);
      var at = n - 1;
      var show = function (i) {
        at = Math.max(0, Math.min(n - 1, i));
        plot.classList.add('hover');
        xh.style.left = X(at) + '%';
        tip.innerHTML = '';
        tip.appendChild(el('div', 'k', labels[at]));
        series.forEach(function (se, k) {
          hd[k].style.left = X(at) + '%';
          hd[k].style.top = Y(se.values[at]) + '%';
          var row = el('div', 'r');
          if (series.length > 1) row.appendChild(el('i', 's' + k));
          row.appendChild(el('b', null, vzFmt(se.values[at], unit)));
          if (se.name && series.length > 1) row.appendChild(el('span', null, se.name));
          tip.appendChild(row);
        });
        tip.classList.toggle('left', X(at) > 55);
        tip.style.left = X(at) + '%';
      };
      var hide = function () { plot.classList.remove('hover'); };
      plot.addEventListener('pointermove', function (e) {
        var r = area.getBoundingClientRect();
        if (r.width) show(Math.round(((e.clientX - r.left) / r.width) * (n - 1)));
      });
      plot.addEventListener('pointerleave', hide);
      plot.addEventListener('focus', function () { show(at); });
      plot.addEventListener('blur', hide);
      plot.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); show(at + (e.key === 'ArrowLeft' ? -1 : 1)); }
        else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); show(e.key === 'Home' ? 0 : n - 1); }
      });
      box.appendChild(plot);
      var xa = el('div', 'vz-xa');
      var ticks = n >= 5 ? [0, Math.floor((n - 1) / 2), n - 1] : [0, n - 1];
      ticks.forEach(function (i, k) {
        var lab = el('span', k === 0 ? 'first' : i === n - 1 ? 'last' : null, labels[i]);
        lab.style.left = X(i) + '%';
        xa.appendChild(lab);
      });
      box.appendChild(xa);
      // The y-label gutter fits the widest tick label.
      var widest = sc.ticks.reduce(function (m, t) { return Math.max(m, vzFmt(t).length); }, 1);
      box.style.setProperty('--gut', Math.max(20, Math.min(56, widest * 6.4 + 6)) + 'px');
      if (series.length > 1) {
        var lg = el('div', 'vz-lg');
        series.forEach(function (se, k) { var it = el('span'); it.appendChild(el('i', 's' + k)); it.appendChild(document.createTextNode(se.name || 'Series ' + (k + 1))); lg.appendChild(it); });
        box.appendChild(lg);
      }
      return box;
    },

    breakdown: function (s, o) {
      var items = vzList(s.items, 12).map(function (it) {
        var v = it && vzNum(it.value), l = it && vzStr(it.label, 40);
        return v != null && v >= 0 && l ? { l: l, v: v } : null;
      });
      if (items.length < 2 || items.some(function (x) { return !x; })) return null;
      if (items.length > 6) {
        var rest = items.slice(5).reduce(function (a, x) { return a + x.v; }, 0);
        items = items.slice(0, 5).concat([{ l: 'Other', v: rest, other: true }]);
      }
      var total = items.reduce(function (a, x) { return a + x.v; }, 0);
      if (!(total > 0)) return null;
      var unit = vzStr(s.unit, 16);
      var box = el('div', 'vz-brk');
      var stack = el('div', 'vz-stack');
      stack.setAttribute('aria-hidden', 'true');
      var pctOnly = unit === '%';
      var ul = el('ul', 'vz-legend' + (pctOnly ? ' pct' : ''));
      items.forEach(function (it, k) {
        var pct = it.v / total * 100;
        var cls = it.other ? 'so' : 's' + k;
        var seg = el('span', cls);
        seg.style.flex = String(Math.max(it.v, total * 0.004));
        seg.style.setProperty('--i', k);
        seg.title = it.l + ': ' + vzFmt(it.v, unit) + ' (' + vzRound(pct) + '%)';
        stack.appendChild(seg);
        var li = el('li');
        li.appendChild(el('i', cls));
        li.appendChild(el('span', 'l', it.l));
        if (!pctOnly) li.appendChild(el('span', 'v', vzFmt(it.v, o && o.bare ? unit : '')));
        li.appendChild(el('span', 'p', (pct < 1 && pct > 0 ? '<1' : vzRound(pct)) + '%'));
        ul.appendChild(li);
      });
      box.appendChild(stack);
      box.appendChild(ul);
      return box;
    },

    meter: function (s) {
      var value = vzNum(s.value);
      if (value == null) return null;
      var unit = vzStr(s.unit, 40);
      var bands = vzList(s.bands, 6).map(function (b) {
        var to = b && vzNum(b.to);
        return to != null ? { to: to, label: vzStr(b.label, 16), tone: vzTone(b.tone) } : null;
      }).filter(Boolean);
      for (var i = 1; i < bands.length; i++) if (bands[i].to <= bands[i - 1].to) return null;
      var target = vzNum(s.target);
      var min = vzNum(s.min);
      if (min == null) min = Math.min(0, value);
      var max = vzNum(s.max);
      if (max == null) max = bands.length ? bands[bands.length - 1].to : Math.max(value, target || 0) * 1.25;
      if (!(max > min)) return null;
      var lowerBetter = String(s.better || '').toLowerCase() === 'lower';
      var pos = function (v) { return Math.max(0, Math.min(100, (v - min) / (max - min) * 100)); };
      // Default band tones run best → worst in the direction that is better.
      if (bands.length) {
        var nb = bands.length;
        var order = nb === 5 ? ['good', 'good', 'neutral', 'warn', 'bad'] : nb === 4 ? ['good', 'neutral', 'warn', 'bad'] : nb === 3 ? ['good', 'warn', 'bad'] : nb === 2 ? ['good', 'bad'] : ['neutral'];
        if (!lowerBetter && String(s.better || '').toLowerCase() === 'higher') order = order.slice().reverse();
        else if (!lowerBetter) order = bands.map(function () { return 'neutral'; });
        bands.forEach(function (b, k) { if (!b.tone) b.tone = order[k]; });
      }
      var box = el('div', 'vz-gauge');
      var head = el('div', 'vz-mh');
      head.appendChild(el('span', 'vz-mv', vzFmt(value)));
      if (unit) head.appendChild(el('span', 'vz-mu', unit));
      var inBand = null;
      for (var j = 0; j < bands.length; j++) { if (value <= bands[j].to) { inBand = bands[j]; break; } }
      if (!inBand && bands.length) inBand = bands[bands.length - 1];
      var tone = inBand ? inBand.tone : target != null && (lowerBetter || String(s.better || '').toLowerCase() === 'higher')
        ? ((lowerBetter ? value <= target : value >= target) ? 'good' : 'bad') : null;
      // A one- or two-letter band ("C", "B+") reads as a rating.
      if (inBand && inBand.label) head.appendChild(vzBadge(inBand.tone || 'neutral', (inBand.label.length <= 2 ? 'Rating ' : '') + inBand.label));
      else if (tone && tone !== 'neutral') head.appendChild(vzBadge(tone, vzStr(s.status, 24) || (tone === 'good' ? 'Within limit' : 'Over limit')));
      box.appendChild(head);
      var track = el('div', 'vz-mtrack' + (bands.length ? ' banded' : ''));
      if (bands.length) {
        var from = min;
        bands.forEach(function (b, k) {
          var last = k === bands.length - 1;
          var seg = el('span', 'vz-mseg t-' + (b.tone || 'neutral') + (b === inBand ? ' on' : '') + (k === 0 ? ' first' : '') + (last ? ' last' : ''));
          seg.style.left = pos(from) + '%';
          // a 2px surface gap between neighbouring bands
          seg.style.width = 'calc(' + (pos(b.to) - pos(from)) + '% - ' + (last ? 0 : 2) + 'px)';
          seg.style.setProperty('--i', k);
          track.appendChild(seg);
          from = b.to;
        });
      } else {
        var fill = el('span', 'vz-mfill' + (tone && tone !== 'neutral' ? ' t-' + tone : ''));
        fill.style.width = pos(value) + '%';
        track.appendChild(fill);
      }
      if (target != null) {
        // Near either end the label hangs inward instead of past the card edge.
        var tg = el('span', 'vz-tg' + (pos(target) < 15 ? ' lo' : pos(target) > 85 ? ' hi' : ''));
        tg.style.left = pos(target) + '%';
        tg.appendChild(el('span', null, (vzStr(s.targetLabel, 20) || 'Target') + ' ' + vzFmt(target)));
        track.appendChild(tg);
      }
      var mk = el('span', 'vz-mk');
      mk.style.left = pos(value) + '%';
      mk.title = vzFmt(value, unit);
      track.appendChild(mk);
      box.appendChild(track);
      var scale = el('div', 'vz-ms');
      if (bands.length) {
        var f = min, spots = [];
        bands.forEach(function (b, k) {
          if (b.label) spots.push({ b: b, at: (pos(f) + pos(b.to)) / 2, range: k === bands.length - 1 && k ? '> ' + vzFmt(bands[k - 1].to) : '≤ ' + vzFmt(b.to) });
          f = b.to;
        });
        // Bands too narrow for their labels (CII's B, C and D sit a few
        // hundredths apart) get a legend with their limits instead of a
        // pile-up of letters under the scale.
        var crowded = spots.some(function (p, k) { return k && p.at - spots[k - 1].at < 2.5 + 1.1 * (p.b.label.length + spots[k - 1].b.label.length); });
        if (crowded) {
          scale = el('ul', 'vz-mlegend');
          spots.forEach(function (p) {
            var li = el('li', p.b === inBand ? 'on' : null);
            li.appendChild(el('i', 't-' + (p.b.tone || 'neutral')));
            li.appendChild(el('b', null, p.b.label));
            li.appendChild(document.createTextNode(' ' + p.range));
            scale.appendChild(li);
          });
        } else {
          spots.forEach(function (p) { var t = el('span', null, p.b.label); t.style.left = p.at + '%'; scale.appendChild(t); });
        }
      } else {
        var a = el('span', 'lo', vzFmt(min)), z = el('span', 'hi', vzFmt(max));
        scale.appendChild(a); scale.appendChild(z);
      }
      box.appendChild(scale);
      return box;
    },

    compare: function (s) {
      var hl = vzStr(s.highlight, 60).toLowerCase();
      var items = vzList(s.items, 4).map(function (it) {
        if (!it || typeof it !== 'object') return null;
        var name = vzStr(it.name || it.title, 60);
        if (!name) return null;
        var num = vzNum(it.value);
        return {
          name: name, tag: vzStr(it.tag, 24), value: num != null ? vzFmt(num) : vzStr(it.value, 24), unit: vzStr(it.unit, 16),
          points: vzList(it.points, 6).map(function (p) { return vzStr(p, 140); }).filter(Boolean), verdict: vzStr(it.verdict, 120),
          hi: !!hl && name.toLowerCase() === hl
        };
      }).filter(Boolean);
      if (items.length < 2) return null;
      var g = el('div', 'vz-cmp');
      items.forEach(function (it, i) {
        var c = el('div', 'vz-card' + (it.hi ? ' hi' : ''));
        c.style.setProperty('--i', i);
        if (it.hi) c.appendChild(el('span', 'vz-best', vzStr(s.highlightLabel, 20) || 'Best fit'));
        if (it.tag) c.appendChild(el('div', 'vz-ctag', it.tag));
        c.appendChild(el('div', 'vz-cn', it.name));
        if (it.value) { var v = el('div', 'vz-cv', it.value); if (it.unit) v.appendChild(el('span', 'vz-su', it.unit)); c.appendChild(v); }
        if (it.points.length) { var ul = el('ul'); it.points.forEach(function (p) { ul.appendChild(el('li', null, p)); }); c.appendChild(ul); }
        if (it.verdict) c.appendChild(el('div', 'vz-cver', it.verdict));
        g.appendChild(c);
      });
      return g;
    },

    steps: function (s) {
      var steps = vzList(s.steps || s.items, 10).map(function (st) {
        if (typeof st === 'string') return { t: vzStr(st, 120), d: '' };
        return st && typeof st === 'object' ? { t: vzStr(st.title || st.label, 120), d: vzStr(st.detail, 260) } : null;
      }).filter(function (x) { return x && x.t; });
      if (steps.length < 2) return null;
      var ol = el('ol', 'vz-flow');
      steps.forEach(function (st, i) {
        var li = el('li');
        li.style.setProperty('--i', i);
        li.appendChild(el('span', 'vz-n', String(i + 1)));
        var tx = el('div');
        tx.appendChild(el('b', null, st.t));
        if (st.d) tx.appendChild(el('p', null, st.d));
        li.appendChild(tx);
        ol.appendChild(li);
      });
      return ol;
    },

    timeline: function (s) {
      var evs = vzList(s.events || s.items, 12).map(function (ev) {
        return ev && typeof ev === 'object' ? { w: vzStr(ev.when || ev.date, 24), t: vzStr(ev.title || ev.label, 120), d: vzStr(ev.detail, 260) } : null;
      }).filter(function (x) { return x && x.w && x.t; });
      if (evs.length < 2) return null;
      // Up to six milestones fit side by side when the panel is wide.
      var ol = el('ol', 'vz-tl' + (evs.length <= 6 ? ' fits' : ''));
      evs.forEach(function (ev, i) {
        var li = el('li');
        li.style.setProperty('--i', i);
        li.appendChild(el('span', 'vz-when', ev.w));
        li.appendChild(el('b', null, ev.t));
        if (ev.d) li.appendChild(el('p', null, ev.d));
        ol.appendChild(li);
      });
      return ol;
    },

    dashboard: function (s) {
      var g = el('div', 'vz-dash');
      vzList(s.blocks, 6).forEach(function (b) { var v = renderVisual(b, { nested: true }); if (v) g.appendChild(v); });
      return g.childNodes.length ? g : null;
    }
  };

  /** Round axis bounds and 3–5 clean ticks around [lo, hi]. */
  function niceScale(lo, hi, count) {
    if (lo === hi) { var pad = Math.abs(lo) * 0.1 || 1; lo -= pad; hi += pad; }
    var raw = (hi - lo) / count;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var step = [1, 2, 2.5, 5, 10].map(function (m) { return m * mag; }).filter(function (x) { return x >= raw; })[0] || 10 * mag;
    var a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step, ticks = [];
    for (var v = a; v <= b + step / 2; v += step) ticks.push(Math.round(v / step) * step);
    return { lo: a, hi: b, ticks: ticks };
  }

  /** The text of a visual block, for copying and for screen readers. */
  var VISUAL_BLOCK_RE = /(^|\n)[ \t]*```[ \t]*visual[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/gi;
  function visualPlain(text) {
    return String(text || '').replace(VISUAL_BLOCK_RE, function (all, pre, json) {
      var s;
      try { s = JSON.parse(json); } catch (_) { return pre; }
      var lines = [];
      (function walk(o, unit) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(function (x) { walk(x, unit); }); return; }
        var u = typeof o.unit === 'string' ? o.unit : unit;
        var name = vzStr(o.title || o.name || o.label || o.when, 90);
        if (o.value != null) lines.push((name ? name + ': ' : '') + o.value + (u ? ' ' + u : ''));
        else if (name && !Array.isArray(o.values)) lines.push(name + (o.detail ? ' — ' + vzStr(o.detail, 260) : ''));
        if (Array.isArray(o.values) && Array.isArray(o.labels)) o.labels.forEach(function (l, i) { lines.push(l + ': ' + o.values[i] + (u ? ' ' + u : '')); });
        if (Array.isArray(o.points)) o.points.forEach(function (p) { lines.push('- ' + vzStr(p, 140)); });
        ['items', 'series', 'steps', 'events', 'blocks'].forEach(function (k) { walk(o[k], u); });
      })(s, '');
      return pre + lines.join('\n');
    });
  }

  /** While the reveal is inside a finished visual block, jump past it: a chart appears whole. */
  var VISUAL_OPEN_G = /(^|\n)[ \t]*```[ \t]*visual[ \t]*\n/gi;
  function skipVisual(text, shown) {
    VISUAL_OPEN_G.lastIndex = 0;
    var m, out = shown;
    while ((m = VISUAL_OPEN_G.exec(text)) && m.index < out) {
      var close = text.indexOf('\n```', m.index + m[0].length - 1);
      if (close < 0) break;
      var end = close + 4;
      while (end < text.length && text.charAt(end) !== '\n') end++;
      if (end < text.length) end++;
      if (end > out) out = end;
      VISUAL_OPEN_G.lastIndex = end;
    }
    return out;
  }

  /** The placeholder while a visual is being prepared. */
  function vzSkeleton() {
    var sk = el('div', 'vz-skel');
    sk.setAttribute('aria-hidden', 'true');
    sk.appendChild(el('div', 'lbl', 'Preparing a visual…'));
    sk.appendChild(el('i', 'a')); sk.appendChild(el('i', 'b')); sk.appendChild(el('i', 'c'));
    return sk;
  }

  // The widget's own charts (number comparisons, data answers) wear the same design.
  function renderBars(chart) {
    return renderVisual({ type: 'bar', title: chart.title, unit: chart.unit, labels: chart.labels, values: chart.values }, { bare: true })
      || document.createDocumentFragment();
  }

  function renderSeries(data) {
    var pts = data.series;
    var frag = document.createDocumentFragment();
    var v = renderVisual({ type: 'line', title: data.title, unit: data.unit, labels: pts.map(function (p) { return String(p.bucket); }), series: [{ name: '', values: pts.map(function (p) { return p.value; }) }] }, { bare: true });
    if (v) frag.appendChild(v);
    var vals = pts.map(function (p) { return p.value; });
    var lohi = el('p', 'lohi');
    lohi.appendChild(document.createTextNode('Low ')); lohi.appendChild(el('b', null, fmtNumber(Math.min.apply(null, vals), data.unit)));
    lohi.appendChild(document.createTextNode(' · High ')); lohi.appendChild(el('b', null, fmtNumber(Math.max.apply(null, vals), data.unit)));
    lohi.appendChild(document.createTextNode(' · ' + pts.length + ' points'));
    frag.appendChild(lohi);
    return frag;
  }

  /** A header row; columns from `numFrom` on hold figures and align right. */
  function headRow(labels, numFrom) {
    var tr = el('tr');
    labels.forEach(function (h, i) { tr.appendChild(el('th', numFrom != null && i >= numFrom ? 'num' : null, h)); });
    return tr;
  }

  function renderRows(data) {
    var table = el('table', 'grid');
    table.appendChild(headRow(['Date', data.unit || 'Value'], 1));
    data.rows.slice(0, 60).forEach(function (r) {
      var tr = el('tr'); tr.appendChild(el('td', null, r.at)); tr.appendChild(el('td', 'num', fmtNumber(r.value))); table.appendChild(tr);
    });
    return table;
  }

  function renderOverview(data) {
    var table = el('table', 'grid');
    table.appendChild(headRow(['Measurement', 'Reports', 'Figure', 'Low', 'High'], 1));
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
    table.appendChild(headRow(['Period', 'Reports', data.unit || 'Value'], 1));
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
    table.appendChild(headRow(['Measurement', 'Unit', 'Also called']));
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
  function toolButton(cls, svg, label) {
    var b = el('button', cls);
    b.type = 'button';
    b.innerHTML = svg;
    b.setAttribute('aria-label', label);
    b.title = label;
    return b;
  }
  function fmtNumber(n, unit) {
    if (n == null) return null;
    return Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 }) + (unit ? ' ' + unit : '');
  }
  function fmtMs(ms) { return ms < 1000 ? Math.max(1, Math.round(ms)) + ' ms' : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function mediaMatches(q) { try { return !!(global.matchMedia && global.matchMedia(q).matches); } catch (_) { return false; } }
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
  //  Long-term memory — stored in this browser (per user, per endpoint), or in
  //  the host's own store when `memoryStore` is given. Every write goes
  //  through memSet / memAddNote, which refuse private details outright.
  // ==========================================================================
  Widget.prototype.memoryAllowed = function () { return this.opts.memory !== false; };
  Widget.prototype.historyAllowed = function () { return this.opts.history !== false && this.opts.persist !== false; };
  Widget.prototype.historyOn = function () { return this.historyAllowed() && !!this.settings.history; };

  function emptyMemory() { return { v: 2, enabled: true, suggest: true, fields: {}, notes: [], declined: [], suppressed: [], updated: 0 }; }

  /** Whitelist and tidy a value for one profile field, or null if it is not usable. */
  function normaliseField(key, value) {
    var f = FIELD[key];
    if (!f || value == null || typeof value === 'object') return null;
    if (f.choices) {
      for (var i = 0; i < f.choices.length; i++) if (f.choices[i][0] === value) return value;
      return null;
    }
    var v = f.multi
      ? String(value).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, f.max)
      : oneLine(value, f.max);
    if (!v) return null;
    if (key === 'timezone') return normaliseTz(v);
    if (key === 'interests') v = v.split(/\s*[,;]\s*/).filter(Boolean).slice(0, 8).join(', ');
    return v || null;
  }

  function sanitizeMemory(m) {
    var out = emptyMemory();
    if (!m || typeof m !== 'object') return out;
    out.enabled = m.enabled !== false;
    out.suggest = m.suggest !== false;
    if (m.fields && typeof m.fields === 'object') {
      FIELDS.forEach(function (f) {
        var r = m.fields[f.key];
        if (r == null) return;
        var value = normaliseField(f.key, typeof r === 'object' ? r.value : r);
        if (value == null) return;
        var src = typeof r === 'object' && (r.source === 'you' || r.source === 'app') ? r.source : 'chat';
        out.fields[f.key] = { value: value, source: src, at: (typeof r === 'object' && +r.at) || Date.now() };
      });
    }
    if (Array.isArray(m.notes)) {
      m.notes.slice(0, NOTES_MAX).forEach(function (n) {
        var t = oneLine(n && typeof n === 'object' ? n.text : n, NOTE_MAX);
        if (t && !isSensitive(t)) out.notes.push({ id: String((n && n.id) || uid()).slice(0, 40), text: t, source: n && (n.source === 'you' || n.source === 'app') ? n.source : 'chat', at: (n && +n.at) || Date.now() });
      });
    }
    if (Array.isArray(m.declined)) out.declined = m.declined.filter(function (s) { return typeof s === 'string'; }).slice(-60);
    if (Array.isArray(m.suppressed)) out.suppressed = m.suppressed.filter(function (k) { return !!FIELD[k]; });
    out.updated = +m.updated || 0;
    return out;
  }

  function cleanFacts(facts) {
    var out = {};
    if (!facts || typeof facts !== 'object') return out;
    FIELDS.forEach(function (f) { var v = normaliseField(f.key, facts[f.key]); if (v != null) out[f.key] = v; });
    return out;
  }

  function factSig(key, value) { return key + '|' + String(value).toLowerCase(); }

  /** Facts a server reply says it heard: the legacy name, or a list of { key, value }. */
  function serverFacts(data) {
    var out = [];
    var r = data && data.remember;
    if (!r || typeof r !== 'object') return out;
    if (r.userName) { var n = normaliseField('name', r.userName); if (n) out.push({ key: 'name', value: n }); }
    if (Array.isArray(r.facts)) {
      r.facts.slice(0, 6).forEach(function (f) {
        if (!f || !FIELD[f.key] || f.key === 'instructions') return;
        var v = normaliseField(f.key, f.value);
        if (v != null && !isSensitive(v)) out.push({ key: f.key, value: v });
      });
    }
    return out;
  }

  Widget.prototype.memLoad = function () {
    this.memory = this.memoryAllowed() && !this.opts.memoryStore ? sanitizeMemory(readJSON(this._ns + ':mem')) : emptyMemory();
    this.applyAppUser();
    return this.memory;
  };

  /** A host-provided store answers later; until then memory starts from the account details only. */
  Widget.prototype.memLoadAsync = function () {
    var self = this;
    var st = this.opts.memoryStore;
    if (!st || typeof st.load !== 'function' || !this.memoryAllowed()) return;
    Promise.resolve().then(function () { return st.load(); }).then(function (data) {
      if (!data) return;
      self.memory = sanitizeMemory(data);
      self.applyAppUser();
      self.memChanged({ save: false });
    }, function () { /* the host's store is unavailable: carry on without it */ });
  };

  /** Details from the host's own account record, unless the user removed them. */
  Widget.prototype.applyAppUser = function () {
    var u = this.opts.user;
    if (!u || typeof u !== 'object' || !this.memoryAllowed()) return;
    var m = this.memory;
    ['name', 'preferredName', 'role', 'company', 'department', 'location', 'timezone'].forEach(function (k) {
      if (u[k] == null || m.suppressed.indexOf(k) >= 0) return;
      var v = normaliseField(k, u[k]);
      if (v == null) return;
      var cur = m.fields[k];
      if (!cur || cur.source === 'app') m.fields[k] = { value: v, source: 'app', at: cur && cur.value === v ? cur.at : Date.now() };
    });
  };

  Widget.prototype.memSave = function () {
    if (!this.memoryAllowed()) return;
    this.memory.updated = Date.now();
    var st = this.opts.memoryStore;
    if (st && typeof st.save === 'function') {
      try { Promise.resolve(st.save(this.memSnapshot(true))).catch(function () { /* host store */ }); } catch (_) { /* host store */ }
    } else {
      writeJSON(this._ns + ':mem', this.memory);
    }
  };

  /** Everything that shows memory follows a change here. */
  Widget.prototype.memChanged = function (o) {
    o = o || {};
    if (o.save !== false) this.memSave();
    if (this.welcome && this.welcome.parentNode) this.refreshWelcome();
    this.refreshDrawer();
    this.refreshView(this.view, o.from);
    var snap = this.memSnapshot();
    this.emit('memory', snap);
    if (typeof this.opts.onMemoryChange === 'function') { try { this.opts.onMemoryChange(snap); } catch (_) { /* host hook */ } }
  };

  Widget.prototype.memSnapshot = function (full) {
    var m = this.memory;
    var out = { enabled: m.enabled, suggest: m.suggest, fields: {}, notes: m.notes.map(function (n) { return assign({}, n); }), updated: m.updated };
    for (var k in m.fields) out.fields[k] = assign({}, m.fields[k]);
    if (full) { out.v = 2; out.declined = m.declined.slice(); out.suppressed = m.suppressed.slice(); }
    return out;
  };

  Widget.prototype.memGet = function (key) { var r = this.memory.fields[key]; return r ? r.value : null; };

  /** @returns {{ ok: boolean, value?: string, reason?: 'sensitive'|'invalid'|'timezone'|'unknown'|'off' }} */
  Widget.prototype.memSet = function (key, value, source, o) {
    if (!this.memoryAllowed()) return { ok: false, reason: 'off' };
    if (!FIELD[key]) return { ok: false, reason: 'unknown' };
    if (value == null || String(value).trim() === '') { this.memRemove(key, o); return { ok: true, value: null }; }
    var v = normaliseField(key, value);
    if (v == null) return { ok: false, reason: key === 'timezone' ? 'timezone' : 'invalid' };
    if (!FIELD[key].choices && (key === 'instructions' ? looksLikeSecret(v) : isSensitive(v))) return { ok: false, reason: 'sensitive' };
    var i = this.memory.suppressed.indexOf(key);
    if (i >= 0 && source !== 'app') this.memory.suppressed.splice(i, 1);
    var cur = this.memory.fields[key];
    if (cur && cur.value === v && cur.source === (source || 'you')) return { ok: true, value: v };
    this.memory.fields[key] = { value: v, source: source || 'you', at: Date.now() };
    this.memChanged(o);
    return { ok: true, value: v };
  };

  /** Put a field back exactly as it was (undo). */
  Widget.prototype.memPut = function (key, rec) {
    if (!FIELD[key] || !rec) return;
    this.memory.fields[key] = assign({}, rec);
    var i = this.memory.suppressed.indexOf(key);
    if (i >= 0) this.memory.suppressed.splice(i, 1);
    this.memChanged();
  };

  Widget.prototype.memRemove = function (key, o) {
    var r = this.memory.fields[key];
    if (!r) return false;
    if (r.source === 'app' && this.memory.suppressed.indexOf(key) < 0) this.memory.suppressed.push(key);
    delete this.memory.fields[key];
    this.memChanged(o);
    return true;
  };

  Widget.prototype.memAddNote = function (text, source) {
    if (!this.memoryAllowed()) return { ok: false, reason: 'off' };
    var t = oneLine(text, NOTE_MAX);
    if (!t) return { ok: false, reason: 'empty' };
    if (isSensitive(t)) return { ok: false, reason: 'sensitive' };
    for (var i = 0; i < this.memory.notes.length; i++) if (this.memory.notes[i].text.toLowerCase() === t.toLowerCase()) return { ok: true, id: this.memory.notes[i].id, existed: true };
    if (this.memory.notes.length >= NOTES_MAX) return { ok: false, reason: 'full' };
    var n = { id: uid(), text: t, source: source || 'you', at: Date.now() };
    this.memory.notes.push(n);
    this.memChanged();
    return { ok: true, id: n.id };
  };

  Widget.prototype.memEditNote = function (id, text) {
    var t = oneLine(text, NOTE_MAX);
    if (!t) return { ok: false, reason: 'empty' };
    if (isSensitive(t)) return { ok: false, reason: 'sensitive' };
    for (var i = 0; i < this.memory.notes.length; i++) {
      if (this.memory.notes[i].id === id) { this.memory.notes[i].text = t; this.memory.notes[i].source = 'you'; this.memory.notes[i].at = Date.now(); this.memChanged(); return { ok: true }; }
    }
    return { ok: false, reason: 'missing' };
  };

  Widget.prototype.memRemoveNote = function (id) {
    for (var i = 0; i < this.memory.notes.length; i++) {
      if (this.memory.notes[i].id === id) { var n = this.memory.notes.splice(i, 1)[0]; this.memChanged(); return n; }
    }
    return null;
  };

  Widget.prototype.memInsertNote = function (note, index) {
    if (!note) return;
    this.memory.notes.splice(Math.max(0, Math.min(index == null ? this.memory.notes.length : index, this.memory.notes.length)), 0, note);
    this.memChanged();
  };

  /** Clear everything remembered — and this chat's picture of the user with it. */
  Widget.prototype.memClear = function () {
    var m = this.memory;
    for (var k in m.fields) if (m.fields[k].source === 'app' && m.suppressed.indexOf(k) < 0) m.suppressed.push(k);
    m.fields = {};
    m.notes = [];
    m.declined = [];
    this.convFacts = {};
    this._lastSaved = null;
    this.memChanged();
    this.save();
  };

  Widget.prototype.memEnable = function (on) { this.memory.enabled = !!on; this.memChanged(); };
  Widget.prototype.memSuggest = function (on) { this.memory.suggest = !!on; this.memChanged(); };

  /** "Not now": do not ask about this value again. */
  Widget.prototype.memDecline = function (key, value) {
    var sig = factSig(key, value);
    if (this.memory.declined.indexOf(sig) < 0) this.memory.declined.push(sig);
    this.memory.declined = this.memory.declined.slice(-60);
    this.memSave();
  };

  /** What K.R.1.S remembers, as rows for the Memory list and the recall reply. */
  Widget.prototype.memItems = function () {
    var self = this, out = [];
    FIELDS.forEach(function (f) {
      var r = self.memory.fields[f.key];
      if (r) out.push({ kind: 'field', key: f.key, label: f.label, value: r.value, display: f.choices ? choiceLabel(f.key, r.value) : r.value, source: r.source, at: r.at });
    });
    this.memory.notes.forEach(function (n) { out.push({ kind: 'note', id: n.id, key: 'note', label: 'Note', value: n.text, display: n.text, source: n.source, at: n.at }); });
    return out;
  };

  /** What the user said about themselves in this chat that is not in memory. */
  Widget.prototype.convOnlyFacts = function () {
    var self = this, out = [];
    FIELDS.forEach(function (f) {
      var v = self.convFacts[f.key];
      if (v == null) return;
      var saved = self.memory.enabled ? self.memGet(f.key) : null;
      if (saved == null || String(saved).toLowerCase() !== String(v).toLowerCase()) out.push({ key: f.key, value: v });
    });
    return out;
  };

  /** Saved memory (when on), with this chat's newer statements laid over it. */
  Widget.prototype.profileView = function () {
    var p = {};
    if (this.memoryAllowed() && this.memory.enabled) for (var k in this.memory.fields) p[k] = this.memory.fields[k].value;
    for (var c in this.convFacts) p[c] = this.convFacts[c];
    return p;
  };

  /** The profile as the server's src/profile.js expects it, or null. */
  Widget.prototype.profileForServer = function () {
    var p = this.profileView();
    var out = {};
    ['name', 'preferredName', 'role', 'company', 'department', 'location', 'timezone'].forEach(function (k) { if (p[k]) out[k] = p[k]; });
    if (p.interests) out.interests = String(p.interests).split(/\s*,\s*/).filter(Boolean).slice(0, 8);
    var style = {};
    if (p.length && p.length !== 'balanced') style.length = p.length;
    if (p.tone) style.tone = p.tone;
    if (style.length || style.tone) out.style = style;
    if (p.instructions) out.instructions = p.instructions;
    if (this.memoryAllowed() && this.memory.enabled && this.memory.notes.length) out.notes = this.memory.notes.map(function (n) { return n.text; });
    return Object.keys(out).length ? out : null;
  };

  /** What to call the user: what they asked for, else their first name. */
  Widget.prototype.addressName = function () {
    var p = this.profileView();
    return p.preferredName || (p.name ? String(p.name).split(' ')[0] : null) || null;
  };

  Widget.prototype.findNote = function (target) {
    var words = String(target || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2 && !NOT_NAME[w]; });
    if (!words.length) return null;
    var best = null, bestScore = 0;
    this.memory.notes.forEach(function (n) {
      var t = n.text.toLowerCase();
      var hits = words.filter(function (w) { return t.indexOf(w) >= 0; }).length;
      var score = hits / words.length;
      if (score > bestScore) { best = n; bestScore = score; }
    });
    return bestScore >= 0.6 ? best : null;
  };

  /** Host changed who is signed in (or updated their account details). */
  Widget.prototype.setUser = function (user) {
    var id = user && user.id != null ? String(user.id).slice(0, 200) : '';
    this.opts.user = user && typeof user === 'object' ? user : null;
    if (id !== this._userId) {
      this.save();
      this.setIdentity(this.opts.user);
      this.memLoad();
      this._skipArchive = true;
      this.reset();
      this._skipArchive = false;
      this.memLoadAsync();
      this.memChanged({ save: false });
      return;
    }
    this.applyAppUser();
    this.memChanged();
  };

  /** Sign-out on a shared machine: nothing about this user stays in this browser. */
  Widget.prototype.forgetUser = function () {
    this.histClear();
    writeJSON(this._ns + ':mem', null);
    try { var s = store('session'); if (s) s.removeItem(this._storeKey); } catch (_) { /* ignore */ }
    this.memory = emptyMemory();
    this._lastSaved = null;
    this.discardCurrent();
    this.memChanged({ save: false });
  };

  // ==========================================================================
  //  History — past conversations on this device. An index for listing and
  //  search, and one key per conversation, so saving a message rewrites one
  //  conversation, not all of them.
  // ==========================================================================
  Widget.prototype.histIndex = function () {
    if (!this.historyAllowed()) return { v: 2, items: [] };
    var idx = readJSON(this._ns + ':idx');
    if (!idx || !Array.isArray(idx.items)) idx = { v: 2, items: [] };
    idx.items = idx.items.filter(function (it) { return it && typeof it.id === 'string'; });
    idx.items.sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
    return idx;
  };

  function previewFor(turns) {
    for (var i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant' && turns[i].text) return oneLine(String(turns[i].text).replace(/[*_`#>|]/g, ''), 110);
    }
    return '';
  }
  function keywordsFor(turns) {
    return turns.filter(function (t) { return t.role === 'user'; }).map(function (t) { return oneLine(t.text); }).join(' ').toLowerCase().slice(0, 600);
  }

  /** Changes when the conversation does: a new turn, or any card answered. */
  Widget.prototype.histSig = function () {
    var last = this.turns[this.turns.length - 1];
    var memos = this.turns.filter(function (t) { return t.memo; }).map(function (t) { return t.memo.state.charAt(0); }).join('');
    return this.convId + ':' + this.turns.length + ':' + ((last && last.at) || 0) + ':' + memos;
  };

  Widget.prototype.histSaveCurrent = function (force) {
    if (!this.historyOn() || this._skipArchive || this._restoring || !this.turns.length) return;
    var sig = this.histSig();
    if (!force && sig === this._histSig) return;
    this._histSig = sig;
    var turns = this.turns.slice(-40);
    var now = Date.now();
    var idx = this.histIndex();
    var existing = null;
    for (var i = 0; i < idx.items.length; i++) if (idx.items[i].id === this.convId) { existing = idx.items[i]; break; }
    var created = existing ? existing.created : (turns[0].at || now);
    var rec = { v: 2, id: this.convId, created: created, updated: now, turns: turns, facts: this.convFacts, suggested: this.suggested, pending: this.pending, pick: this.pick };
    var key = this._ns + ':c:' + this.convId;
    var ok = writeJSON(key, rec);
    // Out of room: let the oldest conversations go first.
    var guard = 0;
    while (!ok && guard++ < 8) {
      var oldest = null;
      for (var j = idx.items.length - 1; j >= 0; j--) if (idx.items[j].id !== this.convId) { oldest = idx.items[j]; break; }
      if (!oldest) break;
      writeLocal(this._ns + ':c:' + oldest.id, null);
      idx.items.splice(idx.items.indexOf(oldest), 1);
      ok = writeJSON(key, rec);
    }
    if (!ok) { writeJSON(this._ns + ':idx', idx); return; }
    // A title settles once the conversation has a real question in it.
    var named = titleFor(this.turns);
    var title = existing && existing.real ? existing.title : named.title;
    var meta = { id: this.convId, title: title, real: !!(existing && existing.real) || named.real, created: created, updated: now, count: turns.length, preview: previewFor(turns), kw: keywordsFor(turns) };
    if (existing) idx.items.splice(idx.items.indexOf(existing), 1);
    idx.items.unshift(meta);
    var max = Math.max(1, this.opts.historyMax || 40);
    while (idx.items.length > max) { var gone = idx.items.pop(); writeLocal(this._ns + ':c:' + gone.id, null); }
    writeJSON(this._ns + ':idx', idx);
  };

  /** Start afresh without keeping what is on screen (it was just deleted). */
  Widget.prototype.discardCurrent = function () {
    this._skipArchive = true;
    this.reset();
    this._skipArchive = false;
    this.refreshDrawer();
    if (this.view === 'history') this.refreshView('history');
  };

  Widget.prototype.histLoad = function (id) {
    var rec = readJSON(this._ns + ':c:' + id);
    if (!rec || !Array.isArray(rec.turns)) return null;
    return rec;
  };

  Widget.prototype.histDelete = function (id) {
    var idx = this.histIndex();
    var meta = null;
    for (var i = 0; i < idx.items.length; i++) if (idx.items[i].id === id) { meta = idx.items.splice(i, 1)[0]; break; }
    var rec = this.histLoad(id);
    writeLocal(this._ns + ':c:' + id, null);
    writeJSON(this._ns + ':idx', idx);
    if (id === this.convId) this._histSig = null;
    return meta ? { meta: meta, rec: rec } : null;
  };

  Widget.prototype.histRestore = function (removed) {
    if (!removed || !removed.meta || !removed.rec) return;
    writeJSON(this._ns + ':c:' + removed.meta.id, removed.rec);
    var idx = this.histIndex();
    idx.items = idx.items.filter(function (it) { return it.id !== removed.meta.id; });
    idx.items.push(removed.meta);
    writeJSON(this._ns + ':idx', idx);
  };

  Widget.prototype.histClear = function () {
    var self = this;
    this.histIndex().items.forEach(function (it) { writeLocal(self._ns + ':c:' + it.id, null); });
    writeJSON(this._ns + ':idx', null);
    this._histSig = null;
  };

  Widget.prototype.histPrune = function () {
    if (!this.historyAllowed()) return;
    var self = this;
    var idx = this.histIndex();
    var cutoff = Date.now() - Math.max(1, this.opts.historyDays || 30) * 86400000;
    var max = Math.max(1, this.opts.historyMax || 40);
    var keep = [];
    idx.items.forEach(function (it, i) {
      if ((it.updated || 0) < cutoff || i >= max) writeLocal(self._ns + ':c:' + it.id, null);
      else keep.push(it);
    });
    if (keep.length !== idx.items.length) { idx.items = keep; writeJSON(this._ns + ':idx', keep.length ? idx : null); }
  };

  // ==========================================================================
  //  Sections. Each renders into its pane's body from current state, so a
  //  change anywhere (a "remember this?" yes, another tab, the host API) is
  //  reflected the next time — or, for the open section, straight away.
  // ==========================================================================
  Widget.prototype.refreshDrawer = function () {
    var self = this;
    if (!this.drawer) return;
    for (var k in this.navItems) {
      if (k === this.view) this.navItems[k].setAttribute('aria-current', 'page');
      else this.navItems[k].removeAttribute('aria-current');
    }
    if (this.memPill) {
      this.memPill.textContent = this.memory.enabled ? 'On' : 'Paused';
      this.memPill.className = 'pill' + (this.memory.enabled ? '' : ' off');
    }
    if (this.drecent) {
      this.drecent.textContent = '';
      var items = this.histIndex().items.slice(0, 5);
      if (!items.length) this.drecent.appendChild(el('li', 'dempty', this.historyOn() ? 'Your conversations will appear here.' : 'Chat history is off.'));
      items.forEach(function (it) {
        var li = el('li');
        var b = el('button');
        b.type = 'button';
        b.title = it.title;
        b.appendChild(el('span', 't', it.title));
        b.appendChild(el('span', 'w', whenLabel(it.updated)));
        if (it.id === self.convId) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', function () { self.toggleDrawer(false, true); self.openConversation(it.id); });
        li.appendChild(b);
        self.drecent.appendChild(li);
      });
    }
    if (this.duser) {
      this.duser.textContent = '';
      var name = this.memGet('name') || this.memGet('preferredName');
      this.duser.appendChild(userAvatar(name));
      var txt = el('span', 'txt');
      txt.appendChild(el('span', 'nm', name || 'Tell ' + this.opts.title + ' about you'));
      var sub = [this.memGet('role'), this.memGet('company')].filter(Boolean).join(' · ');
      txt.appendChild(el('span', 'sb', sub || (name ? 'Profile and memory' : 'Your name, role and preferences')));
      this.duser.appendChild(txt);
      this.duser.setAttribute('aria-label', 'Profile' + (name ? ': ' + name : ''));
    }
  };

  // --- History ---------------------------------------------------------------------
  Widget.prototype.renderHistory = function (body) {
    var self = this;
    if (!this.historyOn()) {
      body.appendChild(banner(ICON.pause, 'Chat history is off. New conversations aren’t kept on this device.', 'Turn on', function () {
        self.setSetting('history', true);
        self.refreshView('history');
      }, 'hist-on'));
    }
    var idx = this.histIndex();
    if (!idx.items.length) {
      body.appendChild(emptyState('No conversations yet', 'Your chats are kept on this device for ' + (this.opts.historyDays || 30) + ' days, so you can pick up where you left off.', 'Start a chat', function () { self.newChat(); }));
      return;
    }
    var search = el('div', 'search');
    search.innerHTML = ICON.search;
    var q = el('input', 'input');
    q.type = 'search';
    q.placeholder = 'Search conversations';
    q.setAttribute('aria-label', 'Search conversations');
    q.setAttribute('data-fk', 'hist-search');
    q.value = this._histQuery || '';
    search.appendChild(q);
    body.appendChild(search);
    var list = el('div');
    body.appendChild(list);

    var draw = function () {
      list.textContent = '';
      var needle = String(q.value || '').toLowerCase().trim();
      self._histQuery = q.value;
      var now = Date.now();
      var items = self.histIndex().items.filter(function (it) {
        return !needle || (String(it.title) + ' ' + (it.preview || '') + ' ' + (it.kw || '')).toLowerCase().indexOf(needle) >= 0;
      });
      if (!items.length) { list.appendChild(el('div', 'empty', 'No conversations match “' + q.value.trim() + '”.')); return; }
      var groups = [], byName = {};
      items.forEach(function (it) {
        var g = bucketOf(it.updated, now);
        if (!byName[g]) { byName[g] = []; groups.push(g); }
        byName[g].push(it);
      });
      groups.forEach(function (g) {
        var sec = el('div', 'sec');
        var h = el('h4', null, g);
        h.appendChild(el('span', 'count', String(byName[g].length)));
        sec.appendChild(h);
        var ul = el('ul', 'hlist');
        byName[g].forEach(function (it) {
          var li = el('li', 'hrow');
          var open = el('button', 'hopen');
          open.type = 'button';
          open.setAttribute('data-fk', 'h-' + it.id);
          var ht = el('div', 'ht');
          ht.appendChild(el('span', null, it.title));
          if (it.id === self.convId) ht.appendChild(el('span', 'pill gold', 'Current'));
          open.appendChild(ht);
          open.appendChild(el('div', 'hs', it.count + (it.count === 1 ? ' message' : ' messages') + ' · ' + whenLabel(it.updated, now) + (it.preview ? ' · ' + it.preview : '')));
          open.addEventListener('click', function () { self.openConversation(it.id); });
          var del = el('button', 'iconbtn del');
          del.type = 'button';
          del.innerHTML = ICON.trash;
          del.setAttribute('aria-label', 'Delete “' + it.title + '”');
          del.title = 'Delete';
          del.addEventListener('click', function () {
            var current = it.id === self.convId;
            var removed = self.histDelete(it.id);
            if (current) self.discardCurrent();
            self.refreshView('history');
            self.refreshDrawer();
            self.toast('Conversation deleted', { label: 'Undo', fn: function () {
              self.histRestore(removed);
              if (current) self.openConversation(it.id);
              self.refreshView('history');
            } });
          });
          li.appendChild(open);
          li.appendChild(del);
          ul.appendChild(li);
        });
        sec.appendChild(ul);
        list.appendChild(sec);
      });
    };
    q.addEventListener('input', draw);
    draw();
    body.appendChild(el('p', 'fhint', 'Kept on this device for ' + (this.opts.historyDays || 30) + ' days. Delete all of it in Settings.'));
  };

  // --- Profile -----------------------------------------------------------------------
  Widget.prototype.renderProfile = function (body) {
    var self = this;
    if (!this.memory.enabled) {
      body.appendChild(banner(ICON.pause, 'Memory is paused. ' + this.opts.title + ' won’t use these details until you turn it back on.', 'Turn on', function () { self.memEnable(true); self.refreshView('profile'); }, 'prof-on'));
    }
    var name = this.memGet('name') || this.memGet('preferredName');
    var card = el('div', 'pcard');
    card.appendChild(userAvatar(name));
    var txt = el('div', 'txt');
    txt.appendChild(el('div', 'nm', name || 'Tell ' + this.opts.title + ' about you'));
    var sub = [this.memGet('role'), this.memGet('company')].filter(Boolean).join(' · ');
    txt.appendChild(el('div', 'sb', sub || 'These details help ' + this.opts.title + ' tailor its answers and suggestions. All of them are optional.'));
    card.appendChild(txt);
    this.profileCard = { name: txt.firstChild, sub: txt.lastChild, avatar: card.firstChild };
    body.appendChild(card);

    var group = function (title, keys, lead) {
      var sec = el('div', 'sec');
      sec.appendChild(el('h4', null, title));
      if (lead) sec.appendChild(el('p', 'lead', lead));
      var g = el('div', 'group');
      keys.forEach(function (k) { g.appendChild(self.fieldRow(k)); });
      sec.appendChild(g);
      body.appendChild(sec);
    };
    group('About you', ['name', 'preferredName']);
    group('Work', ['role', 'company', 'department', 'location', 'timezone']);
    group('Interests', ['interests']);
    group('How ' + this.opts.title + ' answers', ['length', 'tone', 'instructions']);
    body.appendChild(el('p', 'fhint', (this.opts.memoryStore ? 'Kept by your app' : 'Kept in this browser') + ' and sent only with your own messages. These details shape how ' + this.opts.title + ' talks — they never change a figure from your records.'));
  };

  /** Keep the profile card in step with the form, without re-rendering the form. */
  Widget.prototype.paintProfileCard = function () {
    var c = this.profileCard;
    if (!c) return;
    var name = this.memGet('name') || this.memGet('preferredName');
    c.name.textContent = name || 'Tell ' + this.opts.title + ' about you';
    var sub = [this.memGet('role'), this.memGet('company')].filter(Boolean).join(' · ');
    c.sub.textContent = sub || 'These details help ' + this.opts.title + ' tailor its answers and suggestions. All of them are optional.';
    var fresh = userAvatar(name);
    c.avatar.parentNode.replaceChild(fresh, c.avatar);
    c.avatar = fresh;
  };

  /** One profile field: label, where the value came from, the control, and a quiet "Saved". */
  Widget.prototype.fieldRow = function (key) {
    var self = this;
    var f = FIELD[key];
    var wrap = el('div', 'field');
    var lab = el('div', 'flabel');
    var id = 'kris-f-' + key;
    var l = el('label', null, f.long || f.label);
    l.htmlFor = id;
    lab.appendChild(l);
    var src = el('span', 'src');
    lab.appendChild(src);
    var saved = el('span', 'saved');
    saved.innerHTML = ICON.check;
    saved.appendChild(document.createTextNode('Saved'));
    saved.setAttribute('aria-hidden', 'true');
    lab.appendChild(saved);
    wrap.appendChild(lab);

    var paint = function () {
      var r = self.memory.fields[key];
      src.hidden = !r || r.source === 'you';
      if (r && r.source === 'chat') { src.className = 'src'; src.textContent = 'Learned in chat · ' + dateLabel(r.at); }
      else if (r && r.source === 'app') { src.className = 'src app'; src.textContent = 'From your account'; }
    };
    var done = function () {
      paint();
      self.paintProfileCard();
      saved.classList.add('on');
      clearTimeout(saved._t);
      saved._t = setTimeout(function () { saved.classList.remove('on'); }, 1400);
      self.live.textContent = (f.label) + ' saved.';
    };
    paint();

    if (f.choices) {
      var defaults = { length: 'balanced', tone: 'warm' };
      var seg = segmented(f.choices, this.memGet(key) || defaults[key], function (v) {
        var r = self.memSet(key, v, 'you', { from: 'profile' });
        if (r.ok) done();
      }, f.label, 'f-' + key);
      seg.classList.add('full');
      seg.id = id;
      wrap.appendChild(seg);
      return wrap;
    }

    var inp = el(f.multi ? 'textarea' : 'input', f.multi ? 'textarea' : 'input');
    if (!f.multi) inp.type = 'text';
    inp.id = id;
    inp.maxLength = f.max;
    inp.value = this.memGet(key) || '';
    inp.setAttribute('data-fk', 'f-' + key);
    inp.setAttribute('autocomplete', 'off');
    var tzNow = detectedTz();
    inp.placeholder = key === 'timezone' ? (tzNow ? 'Detected: ' + tzNow : 'e.g. Asia/Kolkata') : (f.ph || '');
    if (key === 'timezone' || key === 'name' || key === 'preferredName') inp.setAttribute('spellcheck', 'false');
    if (key === 'timezone') {
      var zones = [];
      try { if (typeof Intl.supportedValuesOf === 'function') zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = []; }
      if (zones.length) {
        var dl = el('datalist');
        dl.id = 'kris-tz-list';
        zones.forEach(function (z) { var o = el('option'); o.value = z; dl.appendChild(o); });
        wrap.appendChild(dl);
        inp.setAttribute('list', dl.id);
      }
    }
    var hint = el('div', 'fhint', f.hint || (key === 'timezone' ? 'Used for “today”, “yesterday” and times in answers. Leave empty to follow this device.' : ''));
    hint.hidden = !hint.textContent;
    var baseHint = hint.textContent;
    var commit = function () {
      var v = f.multi ? inp.value.trim() : oneLine(inp.value, f.max);
      var cur = self.memGet(key) || '';
      if (v === String(cur)) return;
      var r = self.memSet(key, v, 'you', { from: 'profile' });
      if (r.ok) {
        inp.removeAttribute('aria-invalid');
        hint.className = 'fhint';
        hint.textContent = baseHint;
        hint.hidden = !baseHint;
        if (r.value != null && !f.multi) inp.value = r.value;
        done();
      } else {
        inp.setAttribute('aria-invalid', 'true');
        hint.hidden = false;
        hint.className = 'fhint err';
        hint.textContent = r.reason === 'sensitive'
          ? 'That looks like private information (a password, ID number, contact, health or financial detail), so it isn’t saved.'
          : r.reason === 'timezone' ? 'Use a time zone like Asia/Kolkata or Europe/London.' : 'That couldn’t be saved.';
      }
    };
    inp.addEventListener('change', commit);
    if (!f.multi) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    hint.id = id + '-hint';
    inp.setAttribute('aria-describedby', hint.id);
    wrap.appendChild(inp);
    wrap.appendChild(hint);
    return wrap;
  };

  // --- Memory ---------------------------------------------------------------------------
  Widget.prototype.renderMemory = function (body) {
    var self = this;
    var m = this.memory;
    var top = el('div', 'sec');
    var g = el('div', 'group');
    g.appendChild(switchRow('Memory', 'Let ' + this.opts.title + ' remember details you approve, across conversations.', m.enabled, function (on) {
      self.memEnable(on);
      self.toast(on ? 'Memory is on.' : 'Memory is paused. Nothing saved is used or added.');
    }, 'mem-on'));
    g.appendChild(switchRow('Ask to remember useful details', 'When you mention your role, team or preferences, ' + this.opts.title + ' offers to save them. Nothing is saved without a yes.', m.suggest && m.enabled, function (on) {
      self.memSuggest(on);
    }, 'mem-suggest', !m.enabled));
    top.appendChild(g);
    body.appendChild(top);

    // Long-term
    var items = this.memItems();
    var sec = el('div', 'sec');
    var h = el('h4', null, this.opts.title + ' remembers');
    h.appendChild(el('span', 'count', items.length ? String(items.length) : ''));
    sec.appendChild(h);
    if (!m.enabled && items.length) sec.appendChild(el('p', 'lead', 'Paused — kept, but not used, until you turn memory back on.'));
    var list = el('div', 'group');
    if (!items.length) {
      list.appendChild(emptyState('Nothing saved yet', 'Tell ' + this.opts.title + ' about your role or your team and it will ask before remembering — or fill in your profile.', 'Open profile', function () { self.showView('profile'); }));
    }
    items.forEach(function (it) { list.appendChild(self.memoryRow(it)); });
    if (m.enabled) {
      var add = el('form', 'addrow');
      add.setAttribute('novalidate', '');
      var ai = el('input', 'input');
      ai.type = 'text';
      ai.maxLength = NOTE_MAX;
      ai.placeholder = 'Add something to remember…';
      ai.setAttribute('aria-label', 'Add something for ' + self.opts.title + ' to remember');
      ai.setAttribute('data-fk', 'mem-add');
      var ab = el('button', 'btn sm', 'Add');
      ab.type = 'submit';
      add.appendChild(ai);
      add.appendChild(ab);
      add.addEventListener('submit', function (e) {
        e.preventDefault();
        var v = ai.value.trim();
        if (!v) { ai.focus(); return; }
        var facts = detectFacts(v);
        var res;
        if (facts.length === 1 && v.split(/\s+/).length <= 12) res = self.memSet(facts[0].key, facts[0].value, 'you');
        else res = self.memAddNote(v, 'you');
        if (!res.ok) {
          self.toast(res.reason === 'sensitive' ? 'That looks like private information, so it isn’t saved.' : res.reason === 'full' ? 'Memory is full — delete a note first.' : 'That couldn’t be saved.');
          return;
        }
        self.toast('Saved to memory.');
        var again = self.panes.memory && self.panes.memory.body.querySelector('[data-fk="mem-add"]');
        if (again) again.focus();
      });
      list.appendChild(add);
    }
    sec.appendChild(list);
    body.appendChild(sec);

    // This conversation only
    var cs = el('div', 'sec');
    cs.appendChild(el('h4', null, 'This conversation only'));
    cs.appendChild(el('p', 'lead', 'Used while this chat is open, and left behind when you start a new one.'));
    var cg = el('div', 'group');
    var only = this.convOnlyFacts();
    only.forEach(function (f) {
      var row = el('div', 'mrow');
      var mt = el('div', 'mt');
      mt.appendChild(el('div', 'mk', FIELD[f.key].label));
      mt.appendChild(el('div', 'mv', FIELD[f.key].choices ? choiceLabel(f.key, f.value) : f.value));
      mt.appendChild(el('div', 'mm', 'Mentioned in this chat'));
      row.appendChild(mt);
      if (m.enabled) {
        var keep = el('button', 'btn sm', 'Remember');
        keep.type = 'button';
        keep.setAttribute('data-fk', 'keep-' + f.key);
        keep.addEventListener('click', function () {
          var r = self.memSet(f.key, f.value, 'chat');
          self.toast(r.ok ? 'Saved to memory.' : 'That couldn’t be saved.');
        });
        row.appendChild(keep);
      }
      cg.appendChild(row);
    });
    var vessel = this.ctxName();
    if (vessel) cg.appendChild(infoRow(this.pick ? 'Chosen for this chat' : 'Vessel on this page', vessel, this.pick && this.pick.fleet ? 'Questions default to all your vessels unless you name one' : 'Questions default to it unless you name another'));
    if (this.turns.length) cg.appendChild(infoRow('Recent messages', this.turns.length + (this.turns.length === 1 ? ' message' : ' messages') + ' in this chat', 'The latest few go with each question so follow-ups make sense'));
    if (!cg.childNodes.length) cg.appendChild(el('div', 'empty', 'Nothing yet — this fills in as you chat.'));
    cs.appendChild(cg);
    body.appendChild(cs);

    // Clear
    if (items.length) {
      var ds = el('div', 'sec');
      var dg = el('div', 'group');
      var row = el('div', 'row');
      var rt = el('div', 'rt');
      rt.appendChild(el('div', 'rl', 'Clear all memory'));
      rt.appendChild(el('div', 'rd', 'Removes everything above. Your conversations aren’t affected.'));
      row.appendChild(rt);
      row.appendChild(confirmButton('Clear all', 'Confirm', function () { self.memClear(); self.toast('Memory cleared.'); }, 'mem-clear'));
      dg.appendChild(row);
      ds.appendChild(dg);
      body.appendChild(ds);
    }
    body.appendChild(el('p', 'fhint', (this.opts.memoryStore ? 'Kept by your app' : 'Kept in this browser') + ' and sent only with your own messages; the ' + this.opts.title + ' server keeps none of it. Passwords, ID numbers, contact, health and financial details are never saved.'));
  };

  Widget.prototype.memoryRow = function (it) {
    var self = this;
    var row = el('div', 'mrow');
    var mt = el('div', 'mt');
    mt.appendChild(el('div', 'mk', it.label));
    var mv = el('div', 'mv', it.display);
    mt.appendChild(mv);
    mt.appendChild(el('div', 'mm', (it.source === 'chat' ? 'Learned in chat' : it.source === 'app' ? 'From your account' : 'Added by you') + ' · ' + dateLabel(it.at)));
    row.appendChild(mt);
    var btns = el('div', 'mbtns');
    var ed = el('button', 'iconbtn');
    ed.type = 'button';
    ed.innerHTML = ICON.edit;
    ed.setAttribute('aria-label', 'Edit ' + it.label.toLowerCase());
    ed.title = 'Edit';
    ed.setAttribute('data-fk', 'ed-' + (it.id || it.key));
    ed.addEventListener('click', function () {
      if (it.kind === 'field') {
        self.showView('profile');
        var target = self.panes.profile && self.panes.profile.body.querySelector('#kris-f-' + it.key);
        if (target) setTimeout(function () { try { target.focus(); if (target.scrollIntoView) target.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ } }, 40);
        return;
      }
      // a note is edited in place
      if (row.querySelector('.medit')) return;
      mv.hidden = true;
      var f = el('form', 'medit');
      f.setAttribute('novalidate', '');
      var inp = el('input', 'input');
      inp.type = 'text';
      inp.maxLength = NOTE_MAX;
      inp.value = it.value;
      inp.setAttribute('aria-label', 'Edit note');
      var ok = el('button', 'btn sm primary', 'Save'); ok.type = 'submit';
      var no = el('button', 'btn sm ghost', 'Cancel'); no.type = 'button';
      f.appendChild(inp); f.appendChild(ok); f.appendChild(no);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var r = self.memEditNote(it.id, inp.value);
        if (!r.ok) self.toast(r.reason === 'sensitive' ? 'That looks like private information, so it isn’t saved.' : 'That couldn’t be saved.');
      });
      no.addEventListener('click', function () { self.refreshView('memory'); });
      inp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); self.refreshView('memory'); } });
      mt.appendChild(f);
      inp.focus();
    });
    var del = el('button', 'iconbtn del');
    del.type = 'button';
    del.innerHTML = ICON.trash;
    del.setAttribute('aria-label', 'Forget ' + (it.kind === 'note' ? 'this note' : it.label.toLowerCase()));
    del.title = 'Forget';
    del.addEventListener('click', function () {
      if (it.kind === 'note') {
        var at = self.memory.notes.map(function (n) { return n.id; }).indexOf(it.id);
        var gone = self.memRemoveNote(it.id);
        self.toast('Forgotten', { label: 'Undo', fn: function () { self.memInsertNote(gone, at); } });
      } else {
        var before = assign({}, self.memory.fields[it.key]);
        self.memRemove(it.key);
        delete self.convFacts[it.key];
        self.toast('Forgotten', { label: 'Undo', fn: function () { self.memPut(it.key, before); } });
      }
    });
    btns.appendChild(ed);
    btns.appendChild(del);
    row.appendChild(btns);
    return row;
  };

  // --- Appearance ---------------------------------------------------------------------------
  Widget.prototype.renderAppearance = function (body) {
    var self = this;
    var s = this.settings;
    var sec = el('div', 'sec');
    sec.appendChild(el('h4', null, 'Theme'));
    var grid = el('div', 'themes');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Theme');
    var cards = [];
    [['light', 'Light'], ['dark', 'Dark'], ['auto', 'System']].forEach(function (t, i) {
      var b = el('button', 'tcard');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-fk', 'theme-' + t[0]);
      var prev = el('span', 'tprev ' + t[0]);
      ['band', 'b1', 'b2', 'b3'].forEach(function (c) { prev.appendChild(el('i', c)); });
      b.appendChild(prev);
      var tl = el('span', 'tl');
      tl.appendChild(el('span', null, t[1]));
      var ck = el('span'); ck.innerHTML = ICON.check; tl.appendChild(ck);
      b.appendChild(tl);
      var on = self._themePref === t[0];
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      b.addEventListener('click', function () { self.setTheme(t[0], true); });
      b.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = cards[(i + d + cards.length) % cards.length];
        n.focus();
        n.click();
      });
      cards.push(b);
      grid.appendChild(b);
    });
    sec.appendChild(grid);
    sec.appendChild(el('p', 'foot-note', 'System follows your device’s light or dark setting.'));
    body.appendChild(sec);

    var ts = el('div', 'sec');
    ts.appendChild(el('h4', null, 'Text and spacing'));
    var tg = el('div', 'group');
    var sizeRow = el('div', 'row stack');
    sizeRow.appendChild(rowText('Text size'));
    sizeRow.appendChild(segmented([['s', 'Small'], ['m', 'Default'], ['l', 'Large']], s.textSize, function (v) { self.setSetting('textSize', v); }, 'Text size', 'size', true));
    sizeRow.appendChild(el('p', 'sample', this.opts.title + ' answers at this size. Every figure still comes straight from your records.'));
    tg.appendChild(sizeRow);
    var denRow = el('div', 'row stack');
    denRow.appendChild(rowText('Density', 'Compact fits more of the conversation on screen.'));
    denRow.appendChild(segmented([['comfortable', 'Comfortable'], ['compact', 'Compact']], s.density, function (v) { self.setSetting('density', v); }, 'Density', 'density', true));
    tg.appendChild(denRow);
    ts.appendChild(tg);
    body.appendChild(ts);

    var cs = el('div', 'sec');
    cs.appendChild(el('h4', null, 'Chat'));
    var cg = el('div', 'group');
    cg.appendChild(switchRow('Show times', 'When each reply arrived and how long it took.', s.timestamps, function (on) { self.setSetting('timestamps', on); }, 'times'));
    cs.appendChild(cg);
    body.appendChild(cs);

    var ms = el('div', 'sec');
    ms.appendChild(el('h4', null, 'Motion'));
    var mg = el('div', 'group');
    mg.appendChild(switchRow('Reduce motion', 'Turns off animations and transitions. When off, ' + this.opts.title + ' follows your system setting' + (this._osReducedMotion ? ' — which asks for reduced motion right now.' : '.'), s.motion === 'reduce', function (on) { self.setSetting('motion', on ? 'reduce' : 'system'); }, 'motion'));
    mg.appendChild(switchRow('Animate ' + this.opts.title, 'Blinking, the swaying feather, the turning aura and eyes that follow the cursor.', s.character, function (on) { self.setSetting('character', on); }, 'character'));
    ms.appendChild(mg);
    body.appendChild(ms);
  };

  // --- Settings ---------------------------------------------------------------------------------
  Widget.prototype.renderSettings = function (body) {
    var self = this;
    var s = this.settings;
    var mod = isMac() ? '⌘' : 'Ctrl';

    var cs = el('div', 'sec');
    cs.appendChild(el('h4', null, 'Chat'));
    var cg = el('div', 'group');
    cg.appendChild(switchRow('Send with Enter', 'When off, Enter adds a new line and ' + mod + ' + Enter sends.', s.sendWithEnter, function (on) { self.setSetting('sendWithEnter', on); }, 'enter'));
    cg.appendChild(switchRow('Suggested follow-ups', 'Next-question chips under data answers.', s.followups, function (on) { self.setSetting('followups', on); }, 'followups'));
    cs.appendChild(cg);
    body.appendChild(cs);

    if (this.historyAllowed()) {
      var hs = el('div', 'sec');
      hs.appendChild(el('h4', null, 'History'));
      var hg = el('div', 'group');
      var days = this.opts.historyDays || 30;
      hg.appendChild(switchRow('Keep chat history on this device', 'Conversations are kept for ' + days + ' days, then deleted automatically.', s.history, function (on) {
        self.setSetting('history', on);
        self.toast(on ? 'Chat history is on.' : 'Chat history is off. Saved conversations stay until you delete them.');
      }, 'history'));
      var n = this.histIndex().items.length;
      var row = el('div', 'row');
      var rt = el('div', 'rt');
      rt.appendChild(el('div', 'rl', 'Delete all chat history'));
      rt.appendChild(el('div', 'rd', n ? n + (n === 1 ? ' conversation' : ' conversations') + ' on this device.' : 'Nothing saved.'));
      row.appendChild(rt);
      var delAll = confirmButton('Delete all', 'Confirm', function () {
        self.histClear();
        self.discardCurrent();
        self.showView('settings', true);
        self.refreshView('settings');
        self.toast('Chat history deleted.');
      }, 'hist-clear');
      delAll.disabled = !n;
      row.appendChild(delAll);
      hg.appendChild(row);
      hs.appendChild(hg);
      body.appendChild(hs);
    }

    var ks = el('div', 'sec');
    ks.appendChild(el('h4', null, 'Keyboard'));
    var kg = el('div', 'group');
    var keys = el('ul', 'keys');
    var addKey = function (what, combo) {
      var li = el('li');
      li.appendChild(el('span', null, what));
      var c = el('span');
      combo.forEach(function (k, i) { if (i) c.appendChild(document.createTextNode('+')); c.appendChild(el('kbd', null, k)); });
      li.appendChild(c);
      keys.appendChild(li);
    };
    addKey('Send', s.sendWithEnter ? ['Enter'] : [mod, 'Enter']);
    addKey('New line', s.sendWithEnter ? ['Shift', 'Enter'] : ['Enter']);
    addKey('Edit your last message', ['↑']);
    addKey('Stop a reply', ['Esc']);
    addKey('Back, or close the panel', ['Esc']);
    if (this._hotkey) addKey('Open or close ' + this.opts.title, hotkeyLabel(this._hotkey));
    kg.appendChild(keys);
    ks.appendChild(kg);
    body.appendChild(ks);

    var rs = el('div', 'sec');
    rs.appendChild(el('h4', null, 'Reset'));
    var rg = el('div', 'group');
    var r1 = el('div', 'row');
    var r1t = el('div', 'rt');
    r1t.appendChild(el('div', 'rl', 'Reset appearance and settings'));
    r1t.appendChild(el('div', 'rd', 'Theme, text size, motion and chat preferences. Memory and history are kept.'));
    r1.appendChild(r1t);
    r1.appendChild(confirmButton('Reset', 'Confirm', function () { self.resetSettings(); self.refreshView('settings'); self.toast('Settings reset.'); }, 'reset', true));
    rg.appendChild(r1);
    var r2 = el('div', 'row');
    var r2t = el('div', 'rt');
    r2t.appendChild(el('div', 'rl', 'Delete everything on this device'));
    r2t.appendChild(el('div', 'rd', 'Memory, chat history and settings kept by ' + this.opts.title + ' in this browser.'));
    r2.appendChild(r2t);
    r2.appendChild(confirmButton('Delete', 'Confirm', function () {
      self.forgetUser();
      self.resetSettings();
      self.showView('settings', true);
      self.refreshView('settings');
      self.toast('Everything on this device was deleted.');
    }, 'wipe'));
    rg.appendChild(r2);
    rs.appendChild(rg);
    body.appendChild(rs);
  };

  // --- About ------------------------------------------------------------------------------------
  Widget.prototype.renderAbout = function (body) {
    var self = this;
    var a = el('div', 'about');
    var hero = el('div', 'hero blinking');
    hero.appendChild(el('span', 'ring'));
    portrait(hero, 'a', false).svg.setAttribute('data-mood', 'happy');
    a.appendChild(hero);
    a.appendChild(el('h3', null, this.opts.title));
    a.appendChild(el('p', 'say', 'Say it “Kris” · ' + (this.opts.tagline || 'your guide')));
    a.appendChild(el('p', 'meaning', NAME_MEANING));
    body.appendChild(a);

    var h = this.health || null;
    var ss = el('div', 'sec');
    ss.appendChild(el('h4', null, 'Status'));
    var sg = el('div', 'group');
    var conn = { online: ['Online', 'okc'], waking: ['Waking up…', ''], connecting: ['Connecting…', ''], offline: ['Can’t reach it', 'badc'] }[this._conn] || ['—', ''];
    sg.appendChild(kvRow('Server', conn[0], conn[1]));
    if (h && h.build) sg.appendChild(kvRow('Server build', String(h.build)));
    if (h && typeof h.database === 'boolean') sg.appendChild(kvRow('Records database', h.database ? 'Configured' : 'Not configured', h.database ? '' : 'badc'));
    if (h && h.companion) {
      // Only the display label is ever shown; the server's own model id stays out of the UI.
      var notSet = h.companion.configured === false, down = h.companion.reachable === false;
      var modelName = String(h.companion.label || 'Configured');
      sg.appendChild(kvRow('Conversation model', h.companion.enabled === false ? 'Off' : notSet ? 'Not configured' : down ? modelName + ' · unreachable' : modelName, notSet || down ? 'badc' : ''));
    }
    if (h && h.auth) sg.appendChild(kvRow('Sign-in', h.auth === 'prototype' ? 'Prototype (unsigned tokens)' : 'Production'));
    sg.appendChild(kvRow('Widget', VERSION));
    ss.appendChild(sg);
    var refresh = el('button', 'btn sm', 'Check again');
    refresh.type = 'button';
    refresh.style.marginTop = '10px';
    refresh.setAttribute('data-fk', 'about-refresh');
    refresh.addEventListener('click', function () {
      refresh.disabled = true;
      self.warm(true).then(function () { self.refreshView('about'); });
    });
    ss.appendChild(refresh);
    body.appendChild(ss);

    var ps = el('div', 'sec');
    ps.appendChild(el('h4', null, 'How your information is handled'));
    var pg = el('div', 'group');
    var ul = el('ul', 'plist');
    [
      'Every figure comes straight from your records. If they don’t hold the answer, ' + this.opts.title + ' says so.',
      'Memory is opt-in: ' + this.opts.title + ' asks before remembering anything, and never keeps passwords, ID numbers, contact, health or financial details.',
      'Memory and chat history stay ' + (this.opts.memoryStore ? 'with your app' : 'in this browser') + '. They are sent only with your own messages, and the server keeps none of it.',
      this.historyAllowed() ? 'Chat history is deleted automatically after ' + (this.opts.historyDays || 30) + ' days.' : 'Chat history is not kept.'
    ].forEach(function (t) { ul.appendChild(el('li', null, t)); });
    pg.appendChild(ul);
    ps.appendChild(pg);
    body.appendChild(ps);
  };

  // --- toasts ---------------------------------------------------------------------------------
  /** A short confirmation above the composer, optionally with one action (Undo). */
  Widget.prototype.toast = function (text, action, ms) {
    var self = this;
    var box = this.toasts;
    if (!box) return;
    clearTimeout(this._toastT);
    box.textContent = '';
    var h = this.composerEl && this.composerEl.offsetHeight;
    box.style.bottom = (this.view === 'chat' && h ? h + 8 : 16) + 'px';
    var t = el('div', 'toast' + (action ? '' : ' solo'));
    t.appendChild(el('span', null, text));
    var dismiss = function () {
      clearTimeout(self._toastT);
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, self._reducedMotion ? 0 : 180);
    };
    if (action && typeof action.fn === 'function') {
      var b = el('button', null, action.label || 'Undo');
      b.type = 'button';
      b.addEventListener('click', function () { dismiss(); try { action.fn(); } catch (_) { /* ignore */ } });
      t.appendChild(b);
    }
    box.appendChild(t);
    this._toastT = setTimeout(dismiss, ms || (action ? 6500 : 3200));
  };

  // --- building blocks -------------------------------------------------------------------------
  function userAvatar(name) {
    var a = el('span', 'uavatar');
    a.setAttribute('aria-hidden', 'true');
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length) a.textContent = (parts[0].charAt(0) + (parts.length > 1 ? parts[parts.length - 1].charAt(0) : '')).toUpperCase();
    else a.innerHTML = ICON.user;
    return a;
  }

  function rowText(label, desc, id) {
    var rt = el('div', 'rt');
    var l = el('div', 'rl', label);
    if (id) l.id = id;
    rt.appendChild(l);
    if (desc) rt.appendChild(el('div', 'rd', desc));
    return rt;
  }

  function switchRow(label, desc, on, onChange, fk, disabled) {
    var row = el('div', 'row' + (disabled ? ' disabled' : ''));
    var id = 'kris-s-' + fk;
    row.appendChild(rowText(label, desc, id));
    var sw = el('button', 'switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', on ? 'true' : 'false');
    sw.setAttribute('aria-labelledby', id);
    sw.setAttribute('data-fk', 'sw-' + fk);
    sw.disabled = !!disabled;
    sw.addEventListener('click', function () {
      var next = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', next ? 'true' : 'false');
      onChange(next);
    });
    row.appendChild(sw);
    return row;
  }

  function segmented(choices, value, onPick, label, fk, full) {
    var seg = el('div', 'seg' + (full ? ' full' : ''));
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', label);
    var btns = [];
    var set = function (v) {
      var any = false;
      btns.forEach(function (b) {
        var on = b.getAttribute('data-v') === v;
        any = any || on;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      if (!any && btns[0]) btns[0].tabIndex = 0;
    };
    choices.forEach(function (c, i) {
      var b = el('button', null, c[1]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-v', c[0]);
      if (fk) b.setAttribute('data-fk', fk + '-' + c[0]);
      b.addEventListener('click', function () { set(c[0]); onPick(c[0]); });
      b.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        var n = btns[(i + d + btns.length) % btns.length];
        n.focus();
        n.click();
      });
      btns.push(b);
      seg.appendChild(b);
    });
    set(value);
    return seg;
  }

  /** A destructive button that asks once more before it acts. */
  function confirmButton(label, armedLabel, onConfirm, fk, neutral) {
    var b = el('button', 'btn sm' + (neutral ? '' : ' danger'), label);
    b.type = 'button';
    b.setAttribute('data-fk', 'cf-' + fk);
    var t = null;
    var disarm = function () { clearTimeout(t); b.classList.remove('armed'); b.textContent = label; };
    b.addEventListener('click', function () {
      if (!b.classList.contains('armed')) {
        b.classList.add('armed');
        b.textContent = armedLabel;
        t = setTimeout(disarm, 4000);
        return;
      }
      disarm();
      onConfirm();
    });
    b.addEventListener('blur', function () { setTimeout(function () { if (b.classList.contains('armed')) disarm(); }, 150); });
    return b;
  }

  function banner(svg, text, actionLabel, onAction, fk) {
    var b = el('div', 'banner');
    b.innerHTML = svg;
    b.appendChild(el('span', 'txt', text));
    if (actionLabel) {
      var btn = el('button', 'btn sm', actionLabel);
      btn.type = 'button';
      btn.setAttribute('data-fk', 'bn-' + fk);
      btn.addEventListener('click', onAction);
      b.appendChild(btn);
    }
    return b;
  }

  function emptyState(title, text, actionLabel, onAction) {
    var e = el('div', 'empty');
    var lot = el('span', 'lotus'); lot.innerHTML = LOTUS; e.appendChild(lot);
    e.appendChild(el('b', null, title));
    e.appendChild(el('span', null, text));
    if (actionLabel) {
      e.appendChild(document.createElement('br'));
      var b = el('button', 'btn sm', actionLabel);
      b.type = 'button';
      b.addEventListener('click', onAction);
      e.appendChild(b);
    }
    return e;
  }

  function infoRow(label, value, meta) {
    var row = el('div', 'mrow');
    var mt = el('div', 'mt');
    mt.appendChild(el('div', 'mk', label));
    mt.appendChild(el('div', 'mv', value));
    if (meta) mt.appendChild(el('div', 'mm', meta));
    row.appendChild(mt);
    return row;
  }

  function kvRow(k, v, cls) {
    var r = el('div', 'kv');
    r.appendChild(el('span', null, k));
    r.appendChild(el('b', cls || null, v));
    return r;
  }

  function setUserState(userEl, text) {
    if (!userEl) return;
    var s = userEl.querySelector('.ustate');
    if (s) s.textContent = text || '';
  }
  function setInert(node, on) {
    if (!node) return;
    if (on) { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true'); }
    else { node.removeAttribute('inert'); node.removeAttribute('aria-hidden'); }
  }
  function isMac() {
    try { return /Mac|iPhone|iPad|iPod/.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || ''); } catch (_) { return false; }
  }
  function parseHotkey(s) {
    if (!s || typeof s !== 'string') return null;
    var parts = s.toLowerCase().replace(/\s+/g, '').split('+');
    var key = parts.pop();
    if (!key) return null;
    var has = function (k) { return parts.indexOf(k) >= 0; };
    return { key: key, mod: has('mod'), ctrl: has('ctrl'), alt: has('alt') || has('option'), shift: has('shift'), meta: has('meta') || has('cmd') };
  }
  function hotkeyMatch(h, e) {
    if (!h || !e.key) return false;
    var k = String(e.key).toLowerCase();
    var code = String(e.code || '');
    var keyOk = k === h.key || (h.key.length === 1 && (code === 'Key' + h.key.toUpperCase() || code === 'Digit' + h.key));
    if (!keyOk) return false;
    var mac = isMac();
    var wantCtrl = h.ctrl || (h.mod && !mac);
    var wantMeta = h.meta || (h.mod && mac);
    return !!e.ctrlKey === !!wantCtrl && !!e.metaKey === !!wantMeta && !!e.altKey === !!h.alt && !!e.shiftKey === !!h.shift;
  }
  function hotkeyLabel(h) {
    var mac = isMac();
    var out = [];
    if (h.ctrl || (h.mod && !mac)) out.push('Ctrl');
    if (h.meta || (h.mod && mac)) out.push('⌘');
    if (h.alt) out.push(mac ? '⌥' : 'Alt');
    if (h.shift) out.push('Shift');
    out.push(h.key.length === 1 ? h.key.toUpperCase() : h.key);
    return out;
  }
  function copyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, done); return; }
    } catch (_) { /* fall through */ }
    done();
  }
  function flashCopied(btn) {
    btn.innerHTML = ICON.check;
    btn.classList.add('on');
    setTimeout(function () { btn.innerHTML = ICON.copy; btn.classList.remove('on'); }, 1400);
  }
  function joinAnd(list) {
    if (list.length <= 1) return list.join('');
    return list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  }

  // ==========================================================================
  //  Public API
  // ==========================================================================
  var instance = null;
  var early = [];   // KRIS.on(...) called before init
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (_) { return null; } }

  var KRIS = {
    __loaded: true,
    version: VERSION,
    init: function (options) {
      if (instance) return KRIS;
      var start = function () {
        if (instance) return;
        instance = new Widget(options);
        early.forEach(function (p) { instance.on(p[0], p[1]); });
        early = [];
      };
      if (document.body) start();
      else document.addEventListener('DOMContentLoaded', start);
      return KRIS;
    },
    open: function () { if (instance) instance.openPanel(); },
    close: function () { if (instance) instance.close(); },
    toggle: function () { if (instance) instance.toggle(); },
    ask: function (text) { if (instance) { instance.openPanel(); instance.submit(text); } },
    reset: function () { if (instance) instance.reset(); },
    newChat: function () { if (instance) { instance.openPanel(); instance.newChat(); } },
    warm: function () { return instance ? instance.warm(true) : Promise.resolve(); },
    setContext: function (ctx) { if (instance) instance.setContext(ctx); },
    clearContext: function () { if (instance) instance.setContext(null); },
    /** 'light' | 'dark' | 'auto'. A host call is not remembered as the user's pick. */
    setTheme: function (theme) { return instance ? instance.setTheme(theme, false) : false; },
    toggleTheme: function () { if (instance) instance.toggleTheme(); },
    /** The theme on screen now: 'light' or 'dark'. */
    getTheme: function () { return instance ? instance.resolvedTheme() : null; },

    /** Open a section: 'chat' | 'history' | 'profile' | 'memory' | 'appearance' | 'settings' | 'about'. */
    openView: function (name) { return instance ? instance.showView(name) : false; },

    /**
     * What K.R.1.S remembers. Values set here count as coming from the
     * user's account ("From your account"); the user can still edit or
     * remove them. Keys: name, preferredName, role, company, department,
     * location, timezone, interests, length (brief|balanced|detailed),
     * tone (warm|neutral|formal), instructions.
     */
    memory: {
      get: function () { return instance ? instance.memSnapshot() : null; },
      set: function (key, value) { return instance ? instance.memSet(key, value, 'app').ok : false; },
      remove: function (key) { return instance ? instance.memRemove(key) : false; },
      addNote: function (text) { return instance ? instance.memAddNote(text, 'app').ok : false; },
      clear: function () { if (instance) instance.memClear(); },
      enable: function (on) { if (instance) instance.memEnable(on !== false); },
      isEnabled: function () { return instance ? !!instance.memory.enabled : false; }
    },

    /** Past conversations on this device. */
    history: {
      list: function () { return instance ? clone(instance.histIndex().items) || [] : []; },
      open: function (id) { if (!instance) return false; instance.openPanel(); return instance.openConversation(String(id)); },
      remove: function (id) {
        if (!instance) return false;
        id = String(id);
        var removed = !!instance.histDelete(id);
        if (id === instance.convId) instance.discardCurrent(); else instance.refreshDrawer();
        return removed;
      },
      clear: function () { if (instance) { instance.histClear(); instance.discardCurrent(); } }
    },

    settings: {
      get: function () { return instance ? assign({}, instance.settings) : null; },
      set: function (key, value) { return instance ? instance.setSetting(key, value) : false; },
      reset: function () { if (instance) instance.resetSettings(); }
    },

    /** Who is signed in. A different id switches to that user's memory and history. */
    setUser: function (user) { if (instance) instance.setUser(user); },
    /** Sign-out on a shared machine: remove this user's memory, history and open chat from this browser. */
    forget: function () { if (instance) instance.forgetUser(); },

    /** Events: 'open', 'close', 'answer', 'memory', 'settings', 'view', 'conversation', or '*'. */
    on: function (evt, fn) {
      if (typeof fn !== 'function') return KRIS;
      if (instance) instance.on(evt, fn); else early.push([evt, fn]);
      return KRIS;
    },
    off: function (evt, fn) {
      if (instance) instance.off(evt, fn);
      early = early.filter(function (p) { return !(p[0] === evt && p[1] === fn); });
      return KRIS;
    },

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
    _detectFacts: detectFacts,
    _parseMemoryCommand: parseMemoryCommand,
    _aboutTopic: aboutTopic,
    _renderVisual: renderVisual,
    _visualPlain: visualPlain,
    _isSensitive: isSensitive,
    scriptOrigin: SCRIPT_ORIGIN
  };

  global.KRIS = KRIS;
  if (typeof module !== 'undefined' && module.exports) module.exports = KRIS;
})(typeof window !== 'undefined' ? window : this);
