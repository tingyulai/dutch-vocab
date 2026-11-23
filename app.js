(() => {
  'use strict';

  const PLAY_RATES = [0.7, 0.7, 1];  // speech rate per play: two slow, then normal speed
  const PLAYS_PER_SENTENCE = PLAY_RATES.length;
  const GAP_BETWEEN_PLAYS_MS = 1000;
  const HOLD_TO_PAUSE_MS = 250;
  const DECK_SIZE = 9;                         // unread words offered each day
  const READ_VISIBLE_MS = 72 * 60 * 60 * 1000; // read words stay in the row for 72 hours
  const LOG_KEY = 'dv.studyLog';     // { "YYYY-MM-DD": ["word", ...] }
  const READ_KEY = 'dv.readAt';      // { "word": first-read timestamp (ms) }
  const DECK_KEY = 'dv.deck';        // { date: "YYYY-MM-DD", words: [unread words picked that day] }
  const REVIEWS_KEY = 'dv.reviews';  // { "word": number of times its story was opened }
  const WORDS_CSV_KEY = 'dv.wordsCsv'; // last words.csv that loaded, for offline use
  const THEME_KEY = 'dv.theme';
  const MUTE_KEY = 'dv.muted';

  // ---------- Storage helpers (never let storage errors break the app) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(f => f.trim())) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(f => f.trim())) rows.push(row);
    return rows;
  }

  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Sentence HTML with the studied word highlighted. "[...]" in the data marks what to highlight
  // (needed for conjugated / split forms like "hangt ... af"); otherwise look for the word itself.
  function highlightSentence(raw, word) {
    if (raw.includes('[')) {
      return raw.split(/(\[[^\]]*\])/).map(part =>
        part.startsWith('[') && part.endsWith(']') ? `<mark>${esc(part.slice(1, -1))}</mark>` : esc(part)
      ).join('');
    }
    const mark = (at, len) => esc(raw.slice(0, at)) + `<mark>${esc(raw.slice(at, at + len))}</mark>` + esc(raw.slice(at + len));
    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Rows typed on the phone have no brackets: try the whole entry (without het/een) as whole words,
    // then its longest single word, then a plain substring search.
    const core = word.replace(/^(het|een)\s+/i, '').replace(/\s*\(.*\)\s*/g, ' ').trim();
    const parts = core.split(/[\s/]+/).filter(p => p.length >= 3).sort((a, b) => b.length - a.length);
    for (const c of [core, ...parts]) {
      const m = new RegExp(`(^|[^\\p{L}])(${escRe(c)})(?![\\p{L}])`, 'iu').exec(raw);
      if (m) return mark(m.index + m[1].length, m[2].length);
    }
    const at = raw.toLowerCase().indexOf(core.toLowerCase());
    return at < 0 ? esc(raw) : mark(at, core.length);
  }

  // Word names drop a leading "de" (so the D section isn't full of nouns); keep the first row of a repeated word.
  const dropDe = w => w.replace(/^de\s+(.)/i, (_, c) => c.toUpperCase());
  const cell = v => (v || '').trim().replace(/;+$/, '').trim();

  function parseWords(text) {
    const rows = parseCSV(text.replace(/^﻿/, '').trim());
    const seen = new Set();
    return rows.slice(1).map(r => {
      // A whole line pasted into column A ("word,sentence,English,…"): split it into its columns.
      if (r.slice(1).every(v => !cell(v)) && /[,;]/.test(r[0] || '')) {
        const byComma = parseCSV(r[0])[0] || [];
        r = byComma.length >= 3 ? byComma : r[0].split(';');
      }
      const word = dropDe(cell(r[0]));
      const examples = [];
      for (let i = 1; i < r.length; i += 2) {
        const raw = cell(r[i]);
        if (raw) examples.push({ nl: raw.replace(/[[\]]/g, ''), html: highlightSentence(raw, word), en: cell(r[i + 1]) });
      }
      // Story slides: the word on its own first, then its example sentences.
      const slides = [{ nl: word, html: esc(word), en: '', isWord: true }, ...examples];
      return { word, examples, slides };
    }).filter(w => {
      const key = w.word.toLowerCase();
      if (!w.word || !w.examples.length || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // Each word gets a cover picture from a fixed shuffle: looks random, but stays the same between visits.
  const COVER_COUNT = 9;
  const COVERS = (() => {
    const list = Array.from({ length: COVER_COUNT }, (_, i) => `covers/cover-${i + 1}.jpg`);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  })();

  let WORDS = [];
  function setWords(text) {
    WORDS = parseWords(text || '');
    WORDS.forEach((w, i) => { w.cover = COVERS[i % COVERS.length]; });
  }

  // The word list comes from the Google Sheet (published as CSV) so words can be added from the phone.
  // If it can't be reached, use words.csv from the site, then the last copy that loaded (offline).
  const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ5iNQR0NAour4AAi3x3maT2uUKPDhacQ1DVCUiSqBqY4kqaFIpsMQCc6hLwkKmiJQHqQI9sbYis4WK/pub?output=csv';
  let lastFetch = 0, loadedCsv = '';

  // Fetches one source and returns its text, or null if it can't be reached or holds no words
  // (e.g. a sign-in page instead of CSV). The time stamp gets past Google's few-minute cache.
  async function loadListText(url) {
    try {
      const busted = url.startsWith('http') ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;
      const res = await fetch(busted, { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      return parseWords(text).length ? text : null;
    } catch { return null; }
  }
  function applyList(text) {
    setWords(text);
    store.set(WORDS_CSV_KEY, text);
    loadedCsv = text;
  }

  async function fetchWordList() {
    lastFetch = Date.now();
    for (const url of [SHEET_CSV_URL, 'words.csv'].filter(Boolean)) {
      const text = await loadListText(url);
      if (text) { applyList(text); return; }
    }
    if (!loadedCsv) { loadedCsv = store.get(WORDS_CSV_KEY, ''); setWords(loadedCsv); }
  }

  // ---------- Dates ----------
  const pad = n => String(n).padStart(2, '0');
  const dateKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayKey = () => dateKey(new Date());
  function dayLabel(key) {
    const now = new Date();
    if (key === dateKey(now)) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (key === dateKey(y)) return 'Yesterday';
    const [yy, mm, dd] = key.split('-').map(Number);
    return new Date(yy, mm - 1, dd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ---------- Study log ----------
  const getLog = () => store.get(LOG_KEY, {});
  const getReadAt = () => store.get(READ_KEY, {});
  function markStudied(word) {
    const log = getLog();
    const key = todayKey();
    const list = log[key] || [];
    if (!list.includes(word)) { list.push(word); log[key] = list; store.set(LOG_KEY, log); }
    const readAt = getReadAt();
    if (!readAt[word]) { readAt[word] = Date.now(); store.set(READ_KEY, readAt); }
  }
  const studiedToday = () => getLog()[todayKey()] || [];

  // Words studied before read times were tracked count as read at the start of the day they were logged.
  function migrateReadAt() {
    if (store.get(READ_KEY, null)) return;
    const readAt = {};
    for (const [key, words] of Object.entries(getLog())) {
      const [y, m, d] = key.split('-').map(Number);
      const t = new Date(y, m - 1, d).getTime();
      for (const w of words) if (!readAt[w] || t < readAt[w]) readAt[w] = t;
    }
    store.set(READ_KEY, readAt);
  }

  const getReviews = () => store.get(REVIEWS_KEY, {});
  function countReview(word) {
    const reviews = getReviews();
    reviews[word] = (reviews[word] || 0) + 1;
    store.set(REVIEWS_KEY, reviews);
  }
  // Before reviews were counted, each logged day counts as one review.
  function migrateReviews() {
    if (store.get(REVIEWS_KEY, null)) return;
    const reviews = {};
    for (const words of Object.values(getLog())) for (const w of words) reviews[w] = (reviews[w] || 0) + 1;
    store.set(REVIEWS_KEY, reviews);
  }

  // Words used to be listed as "De xxx"; the article was dropped. Move saved progress to the new names.
  function migrateDeNames() {
    const readAt = getReadAt(), reviews = getReviews(), log = getLog();
    const deck = store.get(DECK_KEY, null);
    let changed = false;
    for (const w of Object.keys(readAt)) {
      const n = dropDe(w);
      if (n !== w) { readAt[n] = Math.min(readAt[n] || Infinity, readAt[w]); delete readAt[w]; changed = true; }
    }
    for (const w of Object.keys(reviews)) {
      const n = dropDe(w);
      if (n !== w) { reviews[n] = (reviews[n] || 0) + reviews[w]; delete reviews[w]; changed = true; }
    }
    for (const day of Object.keys(log)) {
      const renamed = [...new Set(log[day].map(dropDe))];
      if (renamed.join('\n') !== log[day].join('\n')) { log[day] = renamed; changed = true; }
    }
    if (deck && deck.words.some(w => dropDe(w) !== w)) { deck.words = [...new Set(deck.words.map(dropDe))]; store.set(DECK_KEY, deck); }
    if (changed) { store.set(READ_KEY, readAt); store.set(REVIEWS_KEY, reviews); store.set(LOG_KEY, log); }
  }

  // Once a day: keep yesterday's still-unread picks, then top up to DECK_SIZE unread words in file order.
  function refreshDeck() {
    const deck = store.get(DECK_KEY, null);
    if (deck && deck.date === todayKey()) return;
    topUpDeck();
  }

  // Also used by the "Add words" button to fill today's circles without waiting for 00:00.
  function topUpDeck() {
    const deck = store.get(DECK_KEY, null);
    const readAt = getReadAt();
    const inList = new Set(WORDS.map(w => w.word));
    const words = (deck ? deck.words : []).filter(w => inList.has(w) && !readAt[w]);
    for (const w of WORDS) {
      if (words.length >= DECK_SIZE) break;
      if (!readAt[w.word] && !words.includes(w.word)) words.push(w.word);
    }
    store.set(DECK_KEY, { date: todayKey(), words });
  }

  // True when today has fewer than DECK_SIZE unread words and the list still has unread ones to add.
  function canAddWords() {
    const deck = store.get(DECK_KEY, { words: [] });
    const readAt = getReadAt();
    const inList = new Set(WORDS.map(w => w.word));
    const unreadInDeck = deck.words.filter(w => inList.has(w) && !readAt[w]);
    return unreadInDeck.length < DECK_SIZE && WORDS.some(w => !readAt[w.word] && !unreadInDeck.includes(w.word));
  }

  // One-time sample history so the month list isn't empty on first launch.
  const SEED_KEY = 'dv.seeded';
  const SAMPLE_YESTERDAY = ['vertrouwen op', 'twijfelen aan', 'klagen over', 'deelnemen aan', 'solliciteren naar'];
  function seedSampleHistory() {
    if (store.get(SEED_KEY, false)) return;
    const log = getLog();
    const y = new Date(); y.setDate(y.getDate() - 1);
    const key = dateKey(y);
    log[key] = [...new Set([...SAMPLE_YESTERDAY, ...(log[key] || [])])];
    store.set(LOG_KEY, log);
    store.set(SEED_KEY, true);
  }

  // ---------- Study tab rendering ----------
  const $ = id => document.getElementById(id);

  // Today's unread picks first, then words read in the last 72 hours (oldest read first).
  function storyOrder() {
    const deck = store.get(DECK_KEY, { words: [] });
    const readAt = getReadAt();
    const now = Date.now();
    const byWord = new Map(WORDS.map(w => [w.word, w]));
    const unread = deck.words.filter(w => !readAt[w] && byWord.has(w));
    const recent = Object.keys(readAt)
      .filter(w => byWord.has(w) && now - readAt[w] < READ_VISIBLE_MS)
      .sort((a, b) => readAt[a] - readAt[b]);
    return [...unread, ...recent].map(w => byWord.get(w));
  }

  let renderedOrder = '';
  function renderStories() {
    const readAt = getReadAt();
    const order = storyOrder();
    renderedOrder = order.map(w => w.word).join('|');
    const todayCount = studiedToday().length;
    let html = `
      <div class="story-item today" role="listitem" aria-label="${todayCount} words studied today">
        <div class="ring"><div class="ring-inner">
          <span class="today-num">${todayCount}</span><span class="today-unit">word${todayCount === 1 ? '' : 's'}</span>
        </div></div>
        <div class="story-label">Studied today</div>
      </div>`;
    order.forEach((w, i) => {
      const isSeen = !!readAt[w.word];
      html += `
        <button class="story-item${isSeen ? ' seen' : ''}" role="listitem" data-index="${i}" aria-label="Study ${esc(w.word)}${isSeen ? ' (read)' : ''}">
          <div class="ring"><div class="ring-inner"><img src="${w.cover}" alt="" decoding="async"></div></div>
          <div class="story-label">${esc(w.word)}</div>
        </button>`;
    });
    if (canAddWords()) {
      html += `
        <button class="story-item add" role="listitem" aria-label="Add today's words now">
          <div class="ring"><div class="ring-inner">+</div></div>
          <div class="story-label">Add words</div>
        </button>`;
    } else if (!order.length) {
      html += `<p class="stories-empty">No new words — add more to words.csv</p>`;
    }
    $('stories').innerHTML = html;
  }

  function renderMonth() {
    const log = getLog();
    const now = new Date();
    const prefix = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
    const days = Object.keys(log).filter(k => k.startsWith(prefix) && log[k].length).sort().reverse();
    const unique = new Set(days.flatMap(k => log[k]));

    $('monthTitle').textContent = `Studied in ${now.toLocaleDateString('en-US', { month: 'long' })}`;
    $('monthCount').textContent = unique.size;

    $('monthList').innerHTML = days.length
      ? days.map(k => `
          <div class="day">
            <div class="day-head"><h3>${dayLabel(k)}</h3><span>${log[k].length}</span></div>
            <ul>${log[k].map(w => `<li>${esc(w)}</li>`).join('')}</ul>
          </div>`).join('')
      : `<p class="empty">No words studied yet this month.<br>Tap a circle above to start.</p>`;
  }

  function renderStudy() { renderStories(); renderMonth(); }

  // ---------- Speech ----------
  const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  let dutchVoice = null;
  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices();
    dutchVoice = voices.find(v => /^nl[-_]NL/i.test(v.lang)) || voices.find(v => /^nl/i.test(v.lang)) || null;
  }
  if (synth) { pickVoice(); synth.addEventListener?.('voiceschanged', pickVoice); }

  // Rough speaking time at normal speed (rate 1).
  const estimateMs = text => Math.max(1500, text.length * 68);

  // Calls done() once the sentence finished (or a timer stands in when muted / unsupported).
  // force: play even when the story viewer is muted (an explicit tap on a sentence).
  function speak(text, rate, done, force = false) {
    let finished = false, safety = 0;
    const finish = () => { if (!finished) { finished = true; clearTimeout(safety); done(); } };
    const est = estimateMs(text) / rate;
    if ((muted && !force) || !synth) { safety = setTimeout(finish, est); return; }
    safety = setTimeout(finish, est * 3 + 2000); // Some browsers never fire 'end'
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'nl-NL';
    if (dutchVoice) u.voice = dutchVoice;
    u.rate = rate;
    u.onend = finish;
    u.onerror = finish;
    synth.speak(u);
  }

  // ---------- Word list tab ----------
  const openWords = new Set();   // expanded rows survive re-renders
  let listToken = 0;

  function renderWordList() {
    const reviews = getReviews();
    const sorted = [...WORDS].sort((a, b) => a.word.localeCompare(b.word, 'nl', { sensitivity: 'base' }));
    $('wordTotal').textContent = sorted.length;
    let html = '', letter = '';
    sorted.forEach(w => {
      const first = w.word[0].toUpperCase();
      if (first !== letter) { letter = first; html += `<h3 class="wl-letter">${esc(letter)}</h3>`; }
      const open = openWords.has(w.word);
      const count = reviews[w.word] || 0;
      html += `
        <div class="wl-item${open ? ' open' : ''}" data-word="${esc(w.word)}">
          <button class="wl-row" aria-expanded="${open}">
            <img class="wl-cover" src="${w.cover}" alt="" decoding="async">
            <span class="wl-word">${esc(w.word)}</span>
            <span class="wl-count" aria-label="Reviewed ${count} time${count === 1 ? '' : 's'}">${count}×</span>
            <svg class="wl-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          <div class="wl-panel"><div class="wl-panel-inner">
            ${w.examples.map((ex, i) => `
              <button class="wl-sentence" data-ex="${i}" aria-label="Play: ${esc(ex.nl)}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                <span><span class="wl-nl">${ex.html}</span><span class="wl-en">${esc(ex.en)}</span></span>
              </button>`).join('')}
          </div></div>
        </div>`;
    });
    $('wordList').innerHTML = html || `<p class="empty">No words yet — add some to words.csv</p>`;
  }

  // ---------- "Check for new words" button ----------
  let toastTimer = 0;
  function showToast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
  }

  let pendingList = '';
  async function checkForNewWords() {
    const btn = $('refreshWords');
    if (btn.classList.contains('spinning')) return;
    btn.classList.add('spinning');
    const text = SHEET_CSV_URL ? await loadListText(SHEET_CSV_URL) : await loadListText('words.csv');
    lastFetch = Date.now();
    btn.classList.remove('spinning');
    if (!text) { showToast("Couldn't reach the word list — check your connection"); return; }
    const have = new Set(WORDS.map(w => w.word.toLowerCase()));
    const added = parseWords(text).filter(w => !have.has(w.word.toLowerCase()));
    if (added.length) {
      pendingList = text;
      const n = added.length;
      $('newWordsTitle').textContent = `Load ${n} new word${n === 1 ? '' : 's'}?`;
      const names = added.slice(0, 5).map(w => w.word).join(', ');
      $('newWordsList').textContent = n > 5 ? `${names} + ${n - 5} more` : names;
      $('newWordsModal').hidden = false;
      $('newWordsLoad').focus();
    } else if (text !== loadedCsv) {
      applyList(text);
      renderStudy(); renderWordList();
      showToast('No new words · sentences updated');
    } else {
      showToast('No new words · edits can take ~5 min');
    }
  }
  function closeNewWords() { $('newWordsModal').hidden = true; pendingList = ''; }

  $('refreshWords').addEventListener('click', checkForNewWords);
  $('newWordsLater').addEventListener('click', closeNewWords);
  $('newWordsModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeNewWords(); });
  $('newWordsLoad').addEventListener('click', () => {
    const before = WORDS.length;
    applyList(pendingList);
    closeNewWords();
    renderStudy(); renderWordList();
    const n = WORDS.length - before;
    showToast(`Added ${n} word${n === 1 ? '' : 's'} · tap + on Study to practise`);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('newWordsModal').hidden) closeNewWords(); });

  function stopListSpeech() {
    listToken++;
    document.querySelectorAll('.wl-sentence.playing').forEach(b => b.classList.remove('playing'));
    if (synth) synth.cancel();
  }

  $('wordList').addEventListener('click', e => {
    const item = e.target.closest('.wl-item');
    if (!item) return;
    const word = item.dataset.word;
    const sentence = e.target.closest('.wl-sentence');
    if (sentence) {
      // Tap = read once at normal speed; tap the playing sentence again to stop.
      const wasPlaying = sentence.classList.contains('playing');
      stopListSpeech();
      if (wasPlaying) return;
      const ex = WORDS.find(w => w.word === word)?.examples[Number(sentence.dataset.ex)];
      if (!ex) return;
      const tok = listToken;
      sentence.classList.add('playing');
      speak(ex.nl, 1, () => { if (tok === listToken) sentence.classList.remove('playing'); }, true);
      return;
    }
    if (e.target.closest('.wl-row')) {
      const open = item.classList.toggle('open');
      item.querySelector('.wl-row').setAttribute('aria-expanded', open);
      if (open) openWords.add(word); else openWords.delete(word);
    }
  });

  // ---------- Story viewer ----------
  const story = $('story');
  const inner = $('storyInner');
  const body = story.querySelector('.story-body');
  let queue = [], wi = 0, si = 0;
  let token = 0, playIndex = 0, playing = false, playStart = 0, playEst = 0, raf = 0, timer = 0;
  let baseEst = 0;     // measured/estimated duration of the sentence at rate 1
  let paused = false;
  let muted = store.get(MUTE_KEY, false);

  function updateMuteBtn() {
    $('muteBtn').classList.toggle('muted', muted);
    $('muteBtn').setAttribute('aria-label', muted ? 'Unmute audio' : 'Mute audio');
  }

  function stopPlayback() {
    token++;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    playing = false;
    if (synth) synth.cancel();
  }

  function openStory(index) {
    stopListSpeech();
    clearInterval(expiryTimer);
    expiryTimer = setInterval(updateExpiry, 15000);
    queue = storyOrder();
    story.hidden = false;
    story.classList.add('opening');
    setTimeout(() => story.classList.remove('opening'), 300);
    document.body.style.overflow = 'hidden';
    showWord(index, 0);
  }

  // Long-press pause: stop the speech and replay the current play from its start on release
  // (speechSynthesis.pause/resume is unreliable across mobile browsers).
  function pausePlayback() {
    if (paused) return;
    paused = true;
    stopPlayback();
    setBars(Math.min(playIndex / PLAYS_PER_SENTENCE, 1));
    story.classList.add('paused');
  }
  function resumePlayback() {
    if (!paused) return;
    paused = false;
    story.classList.remove('paused');
    const tok = token;
    tick(tok);
    playNext(tok);
  }
  function clearPause() {
    paused = false;
    story.classList.remove('paused');
  }

  function closeStory() {
    clearInterval(expiryTimer);
    stopPlayback();
    clearPause();
    story.hidden = true;
    document.body.style.overflow = '';
    renderStudy();
    renderWordList();
  }

  function showWord(index, sentence) {
    wi = index;
    const w = queue[wi];
    markStudied(w.word);
    countReview(w.word);
    $('storyWord').textContent = w.word;
    updateExpiry();
    $('storyAvatar').style.backgroundImage = `url("${w.cover}")`;
    $('storyBars').innerHTML = w.slides.map(() => '<div class="bar"><i></i></div>').join('');
    startSentence(sentence === 'last' ? w.slides.length - 1 : sentence);
  }

  // "Disappears in 71h 58m" under the title, counting down to the end of the word's 72 hours.
  function updateExpiry() {
    const w = queue[wi];
    const readAt = w && getReadAt()[w.word];
    if (!readAt) { $('storyExpiry').textContent = ''; return; }
    const mins = Math.max(0, Math.ceil((readAt + READ_VISIBLE_MS - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    $('storyExpiry').textContent = `Disappears in ${h ? `${h}h ${m}m` : `${m}m`}`;
  }
  let expiryTimer = 0;

  function setBars(fraction) {
    $('storyBars').querySelectorAll('.bar i').forEach((el, i) => {
      el.style.width = i < si ? '100%' : i > si ? '0%' : `${(fraction * 100).toFixed(2)}%`;
    });
  }

  function startSentence(index) {
    stopPlayback();
    clearPause();
    si = index;
    const ex = queue[wi].slides[si];
    $('storyNl').innerHTML = ex.html;
    $('storyEn').textContent = ex.en;
    body.classList.toggle('word-slide', !!ex.isWord);
    body.classList.remove('swap'); void body.offsetWidth; body.classList.add('swap');
    playIndex = 0;
    baseEst = estimateMs(ex.nl);
    updatePlays();
    setBars(0);
    const tok = token;
    tick(tok);
    playNext(tok);
  }

  function updatePlays() {
    $('storyPlays').textContent = `${Math.min(playIndex + 1, PLAYS_PER_SENTENCE)}/${PLAYS_PER_SENTENCE}`;
  }

  function playNext(tok) {
    if (tok !== token) return;
    if (playIndex >= PLAYS_PER_SENTENCE) {
      timer = setTimeout(() => { if (tok === token) nextSentence(); }, 500);
      return;
    }
    const rate = PLAY_RATES[playIndex];
    playing = true;
    playStart = performance.now();
    playEst = baseEst / rate;
    updatePlays();
    speak(queue[wi].slides[si].nl, rate, () => {
      if (tok !== token) return;
      // Use the real duration of this play to make the bar accurate for the next ones.
      baseEst = Math.max(700, (performance.now() - playStart) * rate);
      playing = false;
      playIndex++;
      timer = setTimeout(() => playNext(tok), playIndex < PLAYS_PER_SENTENCE ? GAP_BETWEEN_PLAYS_MS : 0);
    });
  }

  function tick(tok) {
    if (tok !== token) return;
    const partial = playing ? Math.min((performance.now() - playStart) / playEst, 0.97) : 0;
    setBars(Math.min((playIndex + partial) / PLAYS_PER_SENTENCE, 1));
    raf = requestAnimationFrame(() => tick(tok));
  }

  function nextSentence() {
    if (si < queue[wi].slides.length - 1) startSentence(si + 1);
    else nextWord();
  }
  function prevSentence() {
    if (si > 0) startSentence(si - 1);
    else if (wi > 0) changeWord(-1, 'last');
    else startSentence(0);
  }
  function nextWord() {
    if (wi < queue.length - 1) changeWord(1, 0);
    else closeStory();
  }
  function prevWord() {
    if (wi > 0) changeWord(-1, 0);
    else { slideBack(); startSentence(0); }
  }

  function changeWord(dir, sentence) {
    stopPlayback();
    const out = inner.animate(
      [{ transform: inner.style.transform || 'none', opacity: 1 }, { transform: `translateX(${-dir * 100}%)`, opacity: 0.4 }],
      { duration: 200, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = () => {
      out.cancel();
      inner.style.transform = '';
      showWord(wi + dir, sentence);
      inner.animate(
        [{ transform: `translateX(${dir * 100}%)`, opacity: 0.4 }, { transform: 'none', opacity: 1 }],
        { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
    };
  }

  function slideBack() {
    if (!inner.style.transform) return;
    inner.animate([{ transform: inner.style.transform }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
    inner.style.transform = '';
  }

  // Tap left third = previous sentence, rest = next. Swipe left/right = next/previous word, swipe down = close.
  // Press and hold = pause until released.
  let gesture = null;
  inner.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    const g = { x: e.clientX, y: e.clientY, axis: null, held: false };
    g.holdTimer = setTimeout(() => {
      if (gesture === g && !g.axis) { g.held = true; pausePlayback(); }
    }, HOLD_TO_PAUSE_MS);
    gesture = g;
    inner.setPointerCapture(e.pointerId);
  });
  inner.addEventListener('pointermove', e => {
    if (!gesture || gesture.held) return;
    const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
    if (!gesture.axis && Math.hypot(dx, dy) > 10) {
      gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      clearTimeout(gesture.holdTimer);
    }
    if (gesture.axis === 'x') inner.style.transform = `translateX(${dx * 0.6}px)`;
    else if (gesture.axis === 'y' && dy > 0) inner.style.transform = `translateY(${dy * 0.6}px) scale(${1 - Math.min(dy / 2000, 0.08)})`;
  });
  const endGesture = e => {
    if (!gesture) return;
    const g = gesture; gesture = null;
    clearTimeout(g.holdTimer);
    if (g.held) return resumePlayback();
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.axis === 'x' && Math.abs(dx) > 60) return dx < 0 ? nextWord() : prevWord();
    if (g.axis === 'y' && dy > 110) { inner.style.transform = ''; return closeStory(); }
    if (g.axis) return slideBack();
    const rect = inner.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 3) prevSentence(); else nextSentence();
  };
  inner.addEventListener('pointerup', endGesture);
  inner.addEventListener('pointercancel', () => {
    if (gesture) { clearTimeout(gesture.holdTimer); if (gesture.held) resumePlayback(); }
    gesture = null;
    slideBack();
  });
  // Stop the long-press menu (Android) from appearing while holding.
  inner.addEventListener('contextmenu', e => e.preventDefault());

  $('closeBtn').addEventListener('click', closeStory);
  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    store.set(MUTE_KEY, muted);
    updateMuteBtn();
    startSentence(si);
  });

  document.addEventListener('keydown', e => {
    if (story.hidden) return;
    if (e.key === 'Escape') closeStory();
    else if (e.key === ' ') { e.preventDefault(); paused ? resumePlayback() : pausePlayback(); }
    else if (e.key === 'ArrowRight') nextSentence();
    else if (e.key === 'ArrowLeft') prevSentence();
    else if (e.key === 'ArrowDown' || e.key === 'PageDown') nextWord();
    else if (e.key === 'ArrowUp' || e.key === 'PageUp') prevWord();
  });

  document.addEventListener('visibilitychange', () => {
    if (story.hidden) return;
    if (document.hidden) stopPlayback(); else startSentence(si);
  });

  $('stories').addEventListener('click', e => {
    const item = e.target.closest('button.story-item');
    if (!item) return;
    if (item.classList.contains('add')) {
      topUpDeck();
      renderStudy();
      renderWordList();
      return;
    }
    openStory(Number(item.dataset.index));
  });

  // ---------- Tabs ----------
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      stopListSpeech();
      document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === btn.dataset.view));
    });
  });

  // ---------- Theme ----------
  const root = document.documentElement;
  const savedTheme = store.get(THEME_KEY, null);
  if (savedTheme) root.dataset.theme = savedTheme;
  $('themeToggle').addEventListener('click', () => {
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    store.set(THEME_KEY, next);
  });

  // ---------- Boot ----------
  seedSampleHistory();
  migrateReadAt();
  migrateReviews();
  migrateDeNames();
  updateMuteBtn();
  renderMonth();
  let lastDay = todayKey();
  fetchWordList().then(() => { refreshDeck(); renderStudy(); renderWordList(); });

  // The app can't wake itself at 00:00, so check whenever it's running or comes back to the front:
  // on a new day re-read the word list and pick the day's words; otherwise drop read words past 72 hours.
  // Words added in the sheet show up when the app comes back to the front (re-read at most every 5 minutes).
  async function periodicCheck() {
    if (todayKey() !== lastDay) {
      lastDay = todayKey();
      await fetchWordList();
      refreshDeck();
      if (story.hidden) { renderStudy(); renderWordList(); }
    } else if (!document.hidden && Date.now() - lastFetch > 5 * 60000) {
      const before = loadedCsv;
      await fetchWordList();
      if (loadedCsv !== before && story.hidden) { renderStudy(); renderWordList(); }
    } else if (story.hidden && storyOrder().map(w => w.word).join('|') !== renderedOrder) {
      renderStories();
    }
  }
  setInterval(periodicCheck, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) periodicCheck(); });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
