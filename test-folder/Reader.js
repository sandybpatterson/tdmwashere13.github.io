// reader.js — Drop into /stories/ folder alongside each story HTML
// Handles: voice selection, play/pause/stop, speed, progress, multilingual translation
// Uses: Web Speech API (voices) + MyMemory API (translation, free, no key needed)
//
// HOW IT WORKS AT A GLANCE:
//   1. On load, it pulls all <p> text out of the story body into an array.
//   2. It injects a sticky reader bar at the top of the page (styles + HTML built in JS).
//   3. Play queues every paragraph as a separate SpeechSynthesisUtterance so the
//      browser reads them one after another, highlighting each as it goes.
//   4. If the user picks a different language, the paragraphs are translated via the
//      MyMemory API before playback restarts.
//
// IIFE (Immediately Invoked Function Expression): the entire script is wrapped in
// (function(){ ... })() so that none of its variables leak into the global scope.
// This means it's safe to drop onto any page without naming conflicts.

(function () {
  'use strict';

  // ── CONFIG ──────────────────────────────────────────────────────────────────
  // Each entry defines a language option in the UI.
  //   code:       the ISO 639-1 language code sent to the MyMemory translation API
  //   label:      display name shown in the language panel
  //   flag:       emoji flag for the language button
  //   speechLang: the BCP-47 tag used to filter Web Speech API voices
  //               (e.g. 'en-US' will prefer voices whose lang starts with 'en')
  const LANGUAGES = [
    { code: 'en', label: 'English',    flag: '🇺🇸', speechLang: 'en-US' },
    { code: 'es', label: 'Español',    flag: '🇪🇸', speechLang: 'es-ES' },
    { code: 'fr', label: 'Français',   flag: '🇫🇷', speechLang: 'fr-FR' },
    { code: 'de', label: 'Deutsch',    flag: '🇩🇪', speechLang: 'de-DE' },
    { code: 'it', label: 'Italiano',   flag: '🇮🇹', speechLang: 'it-IT' },
    { code: 'pt', label: 'Português',  flag: '🇧🇷', speechLang: 'pt-BR' },
    { code: 'ru', label: 'Русский',    flag: '🇷🇺', speechLang: 'ru-RU' },
    { code: 'ja', label: '日本語',      flag: '🇯🇵', speechLang: 'ja-JP' },
    { code: 'zh', label: '中文',        flag: '🇨🇳', speechLang: 'zh-CN' },
    { code: 'ar', label: 'العربية',     flag: '🇸🇦', speechLang: 'ar-SA' },
    { code: 'ko', label: '한국어',       flag: '🇰🇷', speechLang: 'ko-KR' },
    { code: 'nl', label: 'Nederlands',  flag: '🇳🇱', speechLang: 'nl-NL' },
    { code: 'pl', label: 'Polski',      flag: '🇵🇱', speechLang: 'pl-PL' },
    { code: 'sv', label: 'Svenska',     flag: '🇸🇪', speechLang: 'sv-SE' },
    { code: 'hi', label: 'हिन्दी',       flag: '🇮🇳', speechLang: 'hi-IN' },
    { code: 'tr', label: 'Türkçe',      flag: '🇹🇷', speechLang: 'tr-TR' },
  ];

  // ── STATE ───────────────────────────────────────────────────────────────────
  // All mutable playback state lives here. Using plain let variables rather than
  // an object keeps the read/write syntax simple throughout the script.

  let synth = window.speechSynthesis;   // the browser's speech engine
  let utterances = [];                  // array of SpeechSynthesisUtterance, one per paragraph
  let currentIndex = 0;                 // which paragraph is currently being read
  let isPlaying = false;                // true while speech is actively running
  let isPaused = false;                 // true while synth.pause() is in effect
  let allVoices = [];                   // all voices reported by the browser
  let selectedVoice = null;             // the voice object currently chosen in the dropdown
  let currentLang = 'en';              // active language code
  let translatedParagraphs = [];        // paragraphs in the current language (may equal originalParagraphs)
  let originalParagraphs = [];          // English source text, never overwritten
  let translationCache = {};            // keyed by "lang:first40chars" to avoid re-fetching
  let speed = 1.0;                      // playback rate, controlled by the speed slider
  let translating = false;              // true while an async translation is in progress


  // ── EXTRACT STORY TEXT ───────────────────────────────────────────────────────
  // Pulls all readable paragraphs out of the page into a plain string array.
  // The selector chain tries the most specific container first and falls back
  // to document.body so the reader works on any page structure.
  // Paragraphs shorter than 10 characters are filtered out — this skips section
  // breaks (✦ ✦ ✦) and other short decorative elements that aren't prose.
  function extractParagraphs() {
    const container = document.querySelector('.story-body, article, main, .content')
                      || document.body;
    const paras = Array.from(container.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(t => t.length > 10);
    return paras;
  }


  // ── TRANSLATION ──────────────────────────────────────────────────────────────
  // MyMemory (api.mymemory.translated.net) is a free translation API that
  // requires no API key for basic use. Limits: ~500 chars per request, and
  // roughly 1,000 words/day on the anonymous tier before it rate-limits silently.
  // If a request fails or returns a non-200 status, the original English text
  // is used as a fallback so playback still works.

  async function translateChunk(text, targetLang) {
    // Cache key uses the first 40 chars of the text — enough to uniquely
    // identify a paragraph without bloating the key.
    const cacheKey = `${targetLang}:${text.slice(0, 40)}`;
    if (translationCache[cacheKey]) return translationCache[cacheKey];

    // Long paragraphs are split at word boundaries to stay under the 500-char API limit.
    const chunks = splitIntoChunks(text, 450);
    const translated = [];
    for (const chunk of chunks) {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|${targetLang}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.responseStatus === 200) {
          translated.push(data.responseData.translatedText);
        } else {
          translated.push(chunk); // fall back to English on API error
        }
      } catch {
        translated.push(chunk); // fall back to English on network error
      }
    }
    const result = translated.join(' ');
    translationCache[cacheKey] = result;
    return result;
  }

  // Splits a string into chunks of at most maxLen characters, always breaking
  // at a space so words aren't cut mid-word.
  function splitIntoChunks(text, maxLen) {
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
      let cut = remaining.lastIndexOf(' ', maxLen); // find last space before the limit
      if (cut === -1) cut = maxLen;                 // no space found — force a hard cut
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut + 1);
    }
    if (remaining.length) chunks.push(remaining);
    return chunks;
  }

  // Translates every paragraph sequentially and updates the progress bar as it goes.
  // Sequential (not parallel) to avoid hammering the free API tier simultaneously.
  async function translateAllParagraphs(targetLang) {
    if (targetLang === 'en') {
      // No translation needed — reset to the original English text.
      translatedParagraphs = [...originalParagraphs];
      return;
    }

    translating = true;
    updateStatus('Translating…');
    translatedParagraphs = [];

    for (let i = 0; i < originalParagraphs.length; i++) {
      const t = await translateChunk(originalParagraphs[i], targetLang);
      translatedParagraphs.push(t);
      updateProgress(i / originalParagraphs.length); // show how far through we are
    }

    translating = false;
    updateStatus('Ready');
  }


  // ── VOICE SELECTION ──────────────────────────────────────────────────────────
  // Browsers expose voices asynchronously — they may not be available immediately
  // on page load, which is why loadVoices() is called both on init and again via
  // onvoiceschanged and a 500ms timeout fallback.

  function loadVoices() {
    allVoices = synth.getVoices();
    populateVoiceSelect();
  }

  // Returns voices sorted by best fit for the given language tag.
  // Priority order:
  //   1. Exact lang match (e.g. voice.lang === 'en-US')
  //   2. Same language family (e.g. 'en-GB', 'en-AU')
  //   3. Any voice at all (last resort)
  // Within each tier, voices with quality keywords (natural, neural, premium,
  // enhanced, hd) are sorted to the top, since those tend to sound best.
  // The system default voice is deprioritized — it's often a low-quality
  // fallback that browsers pick when nothing else matches.
  function getBestVoicesForLang(speechLang) {
    const langPrefix = speechLang.split('-')[0].toLowerCase();

    let matches = allVoices.filter(v =>
      v.lang.toLowerCase() === speechLang.toLowerCase()
    );
    if (!matches.length) {
      matches = allVoices.filter(v =>
        v.lang.toLowerCase().startsWith(langPrefix)
      );
    }
    if (!matches.length) matches = allVoices;

    return matches.sort((a, b) => {
      if (a.default && !b.default) return 1;  // push system default down
      if (!a.default && b.default) return -1;
      const quality = ['natural', 'neural', 'premium', 'enhanced', 'hd'];
      const aQ = quality.some(q => a.name.toLowerCase().includes(q)) ? 0 : 1;
      const bQ = quality.some(q => b.name.toLowerCase().includes(q)) ? 0 : 1;
      return aQ - bQ || a.name.localeCompare(b.name);
    });
  }

  // Fills the voice <select> dropdown with up to 12 voices for the current language.
  // Brand prefixes (Microsoft, Google, Apple) are stripped from display names
  // because they add noise without being useful to the reader.
  function populateVoiceSelect() {
    const select = document.getElementById('sbp-voice-select');
    if (!select) return;

    const lang = LANGUAGES.find(l => l.code === currentLang) || LANGUAGES[0];
    const voices = getBestVoicesForLang(lang.speechLang);

    select.innerHTML = '';
    voices.slice(0, 12).forEach((v, i) => {
      const opt = document.createElement('option');
      opt.value = i;                                                     // index into the sorted voices array
      opt.textContent = v.name.replace(/Microsoft|Google|Apple/g, '').trim();
      opt.dataset.voiceUri = v.voiceURI;                                 // stored for reference, not actively used
      select.appendChild(opt);
    });

    selectedVoice = voices[0] || null; // auto-select the best available voice
  }


  // ── PLAYBACK ─────────────────────────────────────────────────────────────────
  // The Web Speech API queue works by calling synth.speak() once per utterance.
  // All utterances for the story are queued at once in playFrom() — the browser
  // then reads them in order, firing onstart/onend callbacks for each.
  // synth.cancel() clears the entire queue, which is why it's called at the top
  // of playFrom() before re-queueing from the new index.

  function buildUtterances() {
    // Rebuild the utterance array from the current translatedParagraphs and selectedVoice.
    // Must be rebuilt whenever voice, speed, or language changes, because
    // SpeechSynthesisUtterance properties are baked in at speak() time.
    utterances = translatedParagraphs.map((text, i) => {
      const u = new SpeechSynthesisUtterance(text);
      u.voice = selectedVoice;
      u.rate = speed;
      u.pitch = 1.0;
      u.volume = 1.0;

      u.onstart = () => {
        currentIndex = i;
        highlightParagraph(i);                          // visually mark the current paragraph
        updateProgressBar(i / utterances.length);       // advance the progress bar
      };
      u.onend = () => {
        // Only the last paragraph triggers the finished state.
        if (i === utterances.length - 1) {
          stopPlayback();
          updateStatus('Finished');
        }
      };
      u.onerror = (e) => {
        // 'interrupted' and 'canceled' fire when synth.cancel() is called intentionally
        // (e.g. user hits stop, or changes voice). Suppress those — only log real errors.
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.warn('TTS error:', e.error);
        }
      };
      return u;
    });
  }

  // Queues utterances starting from 'index' and begins speaking.
  // synth.cancel() is called first to flush any previously queued speech.
  function playFrom(index) {
    synth.cancel();
    isPlaying = true;
    isPaused = false;
    updatePlayButton();

    for (let i = index; i < utterances.length; i++) {
      synth.speak(utterances[i]);
    }
  }

  // Three-state toggle: stopped → playing → paused → playing → ...
  function togglePlayPause() {
    if (translating) return; // block play while translation is in progress

    if (!isPlaying && !isPaused) {
      // Fresh start from the beginning (or wherever currentIndex is after a skip).
      buildUtterances();
      playFrom(currentIndex);
    } else if (isPlaying && !isPaused) {
      synth.pause();
      isPaused = true;
      isPlaying = false;
      updatePlayButton();
      updateStatus('Paused');
    } else if (isPaused) {
      synth.resume();
      isPaused = false;
      isPlaying = true;
      updatePlayButton();
      updateStatus('Playing');
    }
  }

  // Full stop: cancels speech, resets index to 0, clears highlight and progress.
  function stopPlayback() {
    synth.cancel();
    isPlaying = false;
    isPaused = false;
    currentIndex = 0;
    clearHighlight();
    updatePlayButton();
    updateProgressBar(0);
    updateStatus('Ready');
  }

  // Seeks to a position expressed as a fraction (0–1) of the total paragraph count.
  // Restarts playback from that paragraph if something was already playing.
  function skipTo(fraction) {
    const idx = Math.floor(fraction * utterances.length);
    currentIndex = Math.max(0, Math.min(idx, utterances.length - 1));
    if (isPlaying || isPaused) {
      buildUtterances();
      playFrom(currentIndex);
    }
  }


  // ── HIGHLIGHT ────────────────────────────────────────────────────────────────
  // Adds/removes the .sbp-reading CSS class on the current paragraph element.
  // The index here matches the index in the extracted paragraph array, which
  // in turn matches the filtered set of <p> elements in the DOM — both use
  // the same length > 10 filter, so they stay in sync.

  function highlightParagraph(index) {
    clearHighlight();
    const paras = getStoryParagraphs();
    if (paras[index]) {
      paras[index].classList.add('sbp-reading');
      paras[index].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  function clearHighlight() {
    document.querySelectorAll('.sbp-reading').forEach(el => {
      el.classList.remove('sbp-reading');
    });
  }

  // Must use the same selector and filter as extractParagraphs() so that
  // DOM index i always corresponds to text index i in utterances[].
  function getStoryParagraphs() {
    const container = document.querySelector('.story-body, article, main, .content')
                      || document.body;
    return Array.from(container.querySelectorAll('p'))
      .filter(p => p.textContent.trim().length > 10);
  }


  // ── UI UPDATES ───────────────────────────────────────────────────────────────
  // Small helpers that keep the UI in sync with playback state.
  // Each checks for element existence before acting — safe if called before
  // the reader bar has been injected into the DOM.

  function updatePlayButton() {
    const btn = document.getElementById('sbp-play-btn');
    if (!btn) return;
    if (isPlaying) {
      btn.innerHTML = pauseIcon();
      btn.setAttribute('aria-label', 'Pause');
    } else {
      btn.innerHTML = playIcon();
      btn.setAttribute('aria-label', 'Play');
    }
  }

  function updateStatus(text) {
    const el = document.getElementById('sbp-status');
    if (el) el.textContent = text;
  }

  // fraction is 0–1; converts to a CSS percentage width on the fill bar.
  function updateProgressBar(fraction) {
    const bar = document.getElementById('sbp-progress-fill');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  }

  // Alias used during translation so the progress bar shows translation progress.
  function updateProgress(fraction) {
    updateProgressBar(fraction);
  }


  // ── LANGUAGE CHANGE ──────────────────────────────────────────────────────────
  // Changing language always stops current playback first, then translates,
  // then optionally restarts if the reader was active. The wasPlaying flag
  // captures state before the stop so playback can resume automatically.
  // Arabic gets special treatment: the page direction is flipped to RTL
  // so the text renders correctly for right-to-left readers.

  async function handleLanguageChange(langCode) {
    const wasPlaying = isPlaying;
    stopPlayback();

    currentLang = langCode;
    populateVoiceSelect(); // swap to voices appropriate for the new language

    document.documentElement.dir = langCode === 'ar' ? 'rtl' : 'ltr';

    await translateAllParagraphs(langCode);

    if (wasPlaying) {
      buildUtterances();
      playFrom(0); // always restart from the top after a language switch
    }
  }


  // ── ICONS ────────────────────────────────────────────────────────────────────
  // Inline SVG functions rather than icon fonts or external images — no extra
  // requests, no dependency, works offline. Strings are returned so they can
  // be assigned to innerHTML wherever needed.

  function playIcon() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z"/>
    </svg>`;
  }
  function pauseIcon() {
    return `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
    </svg>`;
  }
  function stopIcon() {
    return `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h12v12H6z"/>
    </svg>`;
  }


  // ── INJECT UI ────────────────────────────────────────────────────────────────
  // Rather than requiring a <link> tag in each story HTML file, the reader
  // injects its own <style> block into <head> at runtime. This keeps the
  // reader self-contained — drop in one <script> tag and it works.
  //
  // NOTE: Colors here are hardcoded dark (#0e0e0e, #c8b89a, etc.) because the
  // reader bar is designed to match the permanently-dark story pages.
  // It does NOT use the site's CSS variable system (--bg, --text, etc.) from
  // the template, index.html, or bookshelf.html.

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* ── SBP Reader ── */
      .sbp-reader {
        position: sticky;       /* stays at top of viewport while the user scrolls */
        top: 0;
        z-index: 100;
        background: #0e0e0e;
        border-bottom: 1px solid #2a2a2a;
        padding: 0.75rem 1.5rem;
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-wrap: wrap;        /* wraps to two rows on narrow screens */
        font-family: 'EB Garamond', Georgia, serif;
        box-shadow: 0 2px 24px rgba(0,0,0,0.5);
      }

      .sbp-controls {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-shrink: 0;         /* controls never shrink or wrap */
      }

      .sbp-btn {
        background: none;
        border: 1px solid #3a3a3a;
        color: #c8b89a;
        border-radius: 50%;
        width: 40px;
        height: 40px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 0.15s ease;
        padding: 0;
      }
      .sbp-btn:hover {
        border-color: #c8b89a;
        background: rgba(200,184,154,0.08);
      }
      .sbp-btn.sbp-play {
        width: 46px;            /* play is slightly larger — it's the primary action */
        height: 46px;
        border-color: #c8b89a;
        color: #c8b89a;
      }
      .sbp-btn.sbp-play:hover {
        background: rgba(200,184,154,0.15);
      }

      .sbp-progress-wrap {
        flex: 1;                /* stretches to fill available horizontal space */
        min-width: 120px;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }

      .sbp-progress-track {
        height: 2px;
        background: #2a2a2a;
        border-radius: 2px;
        cursor: pointer;        /* click-to-seek is handled in bindEvents() */
        position: relative;
      }
      .sbp-progress-fill {
        height: 100%;
        background: #c8b89a;
        border-radius: 2px;
        width: 0%;
        transition: width 0.3s ease;
        pointer-events: none;   /* clicks pass through to the track, not the fill */
      }

      .sbp-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
      }

      .sbp-status {
        font-size: 0.68rem;
        color: #666;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .sbp-selects {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
      }

      .sbp-select-wrap {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
      }

      .sbp-label {
        font-size: 0.6rem;
        color: #555;
        text-transform: uppercase;
        letter-spacing: 0.1em;
      }

      .sbp-select {
        background: #111;
        border: 1px solid #2a2a2a;
        color: #c8b89a;
        font-family: inherit;
        font-size: 0.78rem;
        padding: 0.3rem 0.5rem;
        border-radius: 3px;
        cursor: pointer;
        max-width: 160px;
        transition: border-color 0.15s;
      }
      .sbp-select:hover, .sbp-select:focus {
        border-color: #c8b89a;
        outline: none;
      }

      .sbp-speed-wrap {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        align-items: center;
      }
      .sbp-speed {
        font-size: 0.7rem;
        color: #888;
        letter-spacing: 0.05em;
        text-align: center;
      }
      .sbp-speed-slider {
        -webkit-appearance: none;
        appearance: none;
        width: 80px;
        height: 2px;
        background: #2a2a2a;
        border-radius: 2px;
        cursor: pointer;
      }
      .sbp-speed-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        background: #c8b89a;
        border-radius: 50%;
        cursor: pointer;
      }

      .sbp-lang-btn {
        background: none;
        border: 1px solid #2a2a2a;
        color: #999;
        padding: 0.3rem 0.6rem;
        font-size: 0.72rem;
        border-radius: 3px;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
        white-space: nowrap;
      }
      .sbp-lang-btn:hover, .sbp-lang-btn.active {
        border-color: #c8b89a;
        color: #c8b89a;
        background: rgba(200,184,154,0.06);
      }

      .sbp-lang-dropdown {
        position: relative;     /* anchor for the absolutely-positioned panel below */
      }
      .sbp-lang-panel {
        display: none;          /* toggled to grid via .open class */
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        background: #111;
        border: 1px solid #2a2a2a;
        border-radius: 4px;
        padding: 0.4rem;
        z-index: 200;
        width: 220px;
        display: none;
        grid-template-columns: 1fr 1fr;   /* two-column grid of language buttons */
        gap: 0.25rem;
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
      }
      .sbp-lang-panel.open {
        display: grid;
      }
      .sbp-lang-item {
        background: none;
        border: none;
        color: #999;
        padding: 0.35rem 0.5rem;
        font-size: 0.72rem;
        text-align: left;
        cursor: pointer;
        border-radius: 3px;
        transition: all 0.12s;
        font-family: inherit;
        display: flex;
        align-items: center;
        gap: 0.4rem;
      }
      .sbp-lang-item:hover {
        background: rgba(200,184,154,0.08);
        color: #c8b89a;
      }
      .sbp-lang-item.active {
        color: #c8b89a;
        background: rgba(200,184,154,0.06);
      }

      /* Applied by highlightParagraph() to the currently-spoken <p> element.
         Also defined in Biscuits-warmth2.html's own <style> block — the version
         injected here takes precedence due to !important. The HTML copy is redundant
         and could be removed. */
      .sbp-reading {
        background: rgba(200,184,154,0.06) !important;
        border-left: 2px solid #c8b89a;
        padding-left: 1rem;
        transition: background 0.3s ease;
      }

      /* Spinning indicator shown in the status area while translation is running. */
      .sbp-translating {
        display: inline-block;
        width: 10px;
        height: 10px;
        border: 1px solid #555;
        border-top-color: #c8b89a;
        border-radius: 50%;
        animation: sbp-spin 0.7s linear infinite;
        margin-left: 4px;
        vertical-align: middle;
      }
      @keyframes sbp-spin {
        to { transform: rotate(360deg); }
      }

      /* Narrow screens: controls wrap, selects go full-width on second row. */
      @media (max-width: 600px) {
        .sbp-reader {
          padding: 0.6rem 1rem;
          gap: 0.6rem;
        }
        .sbp-selects {
          width: 100%;
        }
        .sbp-select {
          max-width: 130px;
          font-size: 0.72rem;
        }
      }
    `;
    document.head.appendChild(style);
  }

  // Returns the full reader bar HTML as a string.
  // IDs are prefixed 'sbp-' to avoid clashing with any IDs in the host page.
  // aria-label and role attributes are included for screen reader accessibility.
  function buildReaderHTML() {
    return `
      <div class="sbp-reader" id="sbp-reader" role="region" aria-label="Story reader">

        <div class="sbp-controls">
          <button class="sbp-btn sbp-play" id="sbp-play-btn" aria-label="Play">
            ${playIcon()}
          </button>
          <button class="sbp-btn" id="sbp-stop-btn" aria-label="Stop">
            ${stopIcon()}
          </button>
        </div>

        <div class="sbp-progress-wrap">
          <div class="sbp-progress-track" id="sbp-progress-track" title="Click to skip">
            <div class="sbp-progress-fill" id="sbp-progress-fill"></div>
          </div>
          <div class="sbp-meta">
            <span class="sbp-status" id="sbp-status">Ready</span>
            <div class="sbp-speed-wrap">
              <input type="range" class="sbp-speed-slider" id="sbp-speed"
                min="0.6" max="1.8" step="0.1" value="1.0" aria-label="Speed">
              <span class="sbp-speed" id="sbp-speed-label">1.0×</span>
            </div>
          </div>
        </div>

        <div class="sbp-selects">
          <div class="sbp-select-wrap">
            <span class="sbp-label">Voice</span>
            <select class="sbp-select" id="sbp-voice-select" aria-label="Voice"></select>
          </div>

          <div class="sbp-select-wrap">
            <span class="sbp-label">Language</span>
            <div class="sbp-lang-dropdown" id="sbp-lang-dropdown">
              <button class="sbp-lang-btn" id="sbp-lang-toggle" aria-expanded="false" aria-haspopup="true">
                🇺🇸 English
              </button>
              <div class="sbp-lang-panel" id="sbp-lang-panel" role="menu">
              </div>
            </div>
          </div>
        </div>

      </div>
    `;
  }

  // Populates the language panel grid with one button per LANGUAGES entry.
  // Buttons are given data-lang attributes so a single delegated click handler
  // in bindEvents() can handle all of them without attaching 16 individual listeners.
  function buildLangPanel() {
    const panel = document.getElementById('sbp-lang-panel');
    if (!panel) return;
    panel.innerHTML = LANGUAGES.map(l => `
      <button class="sbp-lang-item ${l.code === 'en' ? 'active' : ''}"
        data-lang="${l.code}" role="menuitem">
        <span>${l.flag}</span> ${l.label}
      </button>
    `).join('');
  }

  // Finds the best insertion point and inserts the reader bar before it.
  // Targets the first <hr>, .story-body div, or article paragraph — whichever
  // comes first — so the bar sits between the story header and the story text.
  // Falls back to prepending to <body> if none of those are found.
  function injectReader() {
    const target = document.querySelector('hr, .story-body, article p');
    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildReaderHTML();
    const reader = wrapper.firstElementChild;

    if (target) {
      target.parentNode.insertBefore(reader, target);
    } else {
      document.body.prepend(reader);
    }
  }


  // ── BIND EVENTS ──────────────────────────────────────────────────────────────
  // All event listeners are attached here, after the reader bar has been injected.
  // Optional chaining (?.) is used throughout so missing elements don't throw.

  function bindEvents() {
    document.getElementById('sbp-play-btn')?.addEventListener('click', togglePlayPause);
    document.getElementById('sbp-stop-btn')?.addEventListener('click', stopPlayback);

    // Click on the progress track → calculate click position as a 0–1 fraction
    // of the track width, then seek to that paragraph.
    document.getElementById('sbp-progress-track')?.addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      if (utterances.length) {
        buildUtterances();
        skipTo(Math.max(0, Math.min(1, fraction)));
      }
    });

    // Speed slider: update rate and rebuild utterances if already playing
    // so the change takes effect immediately without the user stopping and restarting.
    const speedSlider = document.getElementById('sbp-speed');
    speedSlider?.addEventListener('input', (e) => {
      speed = parseFloat(e.target.value);
      document.getElementById('sbp-speed-label').textContent = `${speed.toFixed(1)}×`;
      if (isPlaying || isPaused) {
        const idx = currentIndex;
        buildUtterances();
        playFrom(idx);
      }
    });

    // Voice dropdown: same pattern — rebuild and restart from the current position.
    document.getElementById('sbp-voice-select')?.addEventListener('change', (e) => {
      const voices = getBestVoicesForLang(
        LANGUAGES.find(l => l.code === currentLang)?.speechLang || 'en-US'
      );
      selectedVoice = voices[parseInt(e.target.value)] || null;
      if (isPlaying || isPaused) {
        const idx = currentIndex;
        buildUtterances();
        playFrom(idx);
      }
    });

    // Language toggle button: opens/closes the panel and updates aria-expanded.
    const toggle = document.getElementById('sbp-lang-toggle');
    const panel = document.getElementById('sbp-lang-panel');
    toggle?.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open);
    });

    // Close the language panel when the user clicks anywhere outside it.
    document.addEventListener('click', (e) => {
      if (!document.getElementById('sbp-lang-dropdown')?.contains(e.target)) {
        panel?.classList.remove('open');
        toggle?.setAttribute('aria-expanded', 'false');
      }
    });

    // Delegated click handler for all language buttons — one listener on the panel
    // instead of one per button. e.target.closest('[data-lang]') walks up the DOM
    // to find the button even if the click landed on the flag <span> inside it.
    document.getElementById('sbp-lang-panel')?.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-lang]');
      if (!btn) return;

      const code = btn.dataset.lang;
      const lang = LANGUAGES.find(l => l.code === code);
      if (!lang) return;

      document.querySelectorAll('.sbp-lang-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      toggle.innerHTML = `${lang.flag} ${lang.label}`;

      panel.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');

      await handleLanguageChange(code);
    });

    // Some browsers (Firefox, older Safari) fire onvoiceschanged asynchronously.
    // Registering here ensures the dropdown is repopulated when voices arrive.
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = loadVoices;
    }
  }


  // ── INIT ─────────────────────────────────────────────────────────────────────
  // Entry point. Checks for Web Speech API support, then wires everything up.
  // loadVoices() is called twice: once immediately (in case voices are already
  // available, as on Chrome desktop) and once after 500ms (for browsers that
  // populate voices asynchronously after a short delay).

  function init() {
    if (!('speechSynthesis' in window)) {
      console.warn('SBP Reader: Web Speech API not supported in this browser.');
      return;
    }

    originalParagraphs = extractParagraphs();
    translatedParagraphs = [...originalParagraphs]; // start with English

    injectStyles();
    injectReader();
    buildLangPanel();
    bindEvents();
    loadVoices();

    setTimeout(loadVoices, 500); // second call catches async voice loading

    updateStatus('Ready');
  }

  // If the script loads before the DOM is ready, wait for DOMContentLoaded.
  // If the DOM is already parsed (e.g. script is deferred or at end of body), run now.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
