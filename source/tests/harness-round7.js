/*
 * Lumen R7 renderer/host regression harness.
 * Append to a disposable copy of source/main.js and run with Electron under Xvfb.
 */
const r7fs = require('fs');
const r7results = [];
const r7errors = [];
const r7sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function r7check(name, ok, details) {
  r7results.push({ name, ok: !!ok, details: details === undefined ? null : details });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (details === undefined ? '' : ' → ' + JSON.stringify(details)));
}
async function r7run(js) {
  try { return await win.webContents.executeJavaScript(js, true); }
  catch (e) { return { error: String(e && e.stack || e) }; }
}

app.whenReady().then(async function () {
  try {
    const limit = Date.now() + 15000;
    while ((!win || win.isDestroyed() || win.webContents.isLoading()) && Date.now() < limit) await r7sleep(250);
    if (!win || win.isDestroyed()) throw new Error('Lumen window did not open');
    win.webContents.on('console-message', function (event, level, message) {
      const lev = (event && event.level != null) ? event.level : level;
      const msg = (event && event.message != null) ? event.message : message;
      if ((lev === 3 || String(lev) === 'error') && !/Failed to load resource|net::ERR/.test(String(msg))) r7errors.push(String(msg));
    });
    await r7sleep(800);

    /* clipboard defaults the URL dialog */
    clipboard.writeText('https://media.example.test/movie/master.m3u8');
    const opened = await r7run(`(async function(){
      Lumen.openUrlDialog();
      await new Promise(r => setTimeout(r, 180));
      var input = document.querySelector('#urlIn');
      return { exists: !!input, value: input && input.value,
        selected: input ? input.value.slice(input.selectionStart, input.selectionEnd) : '',
        cutCopyPasteHook: !!(input && input._r7EditBound) };
    })()`);
    r7check('Open URL prefills and selects clipboard text',
      opened.exists && opened.value === 'https://media.example.test/movie/master.m3u8' && opened.selected === opened.value, opened);

    /* exercise the actual link-input contextmenu, then Cut / Copy / Paste */
    const edit = await r7run(`(async function(){
      var input = document.querySelector('#urlIn');
      if (!input) return { error: 'missing #urlIn' };
      function context() {
        input.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, clientX:220, clientY:180 }));
        return Array.prototype.map.call(document.querySelectorAll('.ctx .mi .lbl'), function(n){ return n.textContent.trim(); });
      }
      function click(label) {
        var buttons = Array.prototype.slice.call(document.querySelectorAll('.ctx .mi'));
        var b = buttons.find(function(x){ var n=x.querySelector('.lbl'); return n && n.textContent.trim()===label; });
        if (b) b.click();
        return !!b;
      }
      input.value = 'https://copyexample.test/clip.mp4';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.setSelectionRange(8, 12);
      var labels = context();
      var copy = click('Copy');
      await new Promise(r => setTimeout(r, 100));
      var copied = await Lumen.Bridge.call('clipboard_read_text');
      input.setSelectionRange(8, 12);
      context();
      var cut = click('Cut');
      await new Promise(r => setTimeout(r, 120));
      var cutValue = input.value;
      var cutClipboard = await Lumen.Bridge.call('clipboard_read_text');
      await Lumen.Bridge.call('clipboard_write_text', 'https://paste.example.test/live.m3u8');
      input.focus(); input.setSelectionRange(0, 0);
      context();
      var paste = click('Paste');
      await new Promise(r => setTimeout(r, 120));
      return { labels, copy, copied, cut, cutValue, cutClipboard, paste, pastedValue: input.value };
    })()`);
    const editOk = edit && edit.copy && edit.cut && edit.paste &&
      edit.labels.join('|') === 'Cut|Copy|Paste' && edit.copied === 'copy' &&
      edit.cutClipboard === 'copy' && edit.cutValue === 'https://example.test/clip.mp4' &&
      edit.pastedValue === 'https://paste.example.test/live.m3u8https://example.test/clip.mp4';
    r7check('link-field context menu performs Cut / Copy / Paste', editOk, edit);
    await r7run('Lumen.Modal.close()');

    /* About card, default artwork and built-in engine status */
    const ui = await r7run(`(async function(){
      Lumen.togglePanel('settings');
      await new Promise(r => setTimeout(r, 100));
      var about = document.querySelector('#aboutPage');
      var img = document.querySelector('img.vlayer[data-scene="bright"]');
      var status = await Lumen.Bridge.call('ffmpeg_status');
      return { about: about && about.textContent.replace(/\\s+/g,' ').trim(),
        email: document.querySelector('#aboutEmail') && document.querySelector('#aboutEmail').getAttribute('href'),
        poster: img && img.getAttribute('src'), posterLoaded: !!(img && img.naturalWidth > 0),
        posterWidth: img && img.naturalWidth, screenshotIcon: Object.prototype.hasOwnProperty.call(window.LUMEN_ICONS || {}, 'screenshot'),
        subPreview: !!document.getElementById('subPreview'), resetLook: !!document.getElementById('subResetBtn'),
        engine: status && { available:status.available, path:status.path, version:status.version, bundled:status.bundled } };
    })()`);
    r7check('About has the exact developer, email and R9/version details',
      /Behnam Ehsani/.test(ui.about || '') && /Inbox\.ehsani@gmail\.com/.test(ui.about || '') &&
      ui.email === 'mailto:Inbox.ehsani@gmail.com' && /Version 1\.0\.0/.test(ui.about || '') && /r9-2026-10-04/.test(ui.about || ''), ui);
    r7check('Settings subtitle preview is absent while Reset look remains',
      ui.subPreview === false && ui.resetLook === true, { preview:ui.subPreview, resetLook:ui.resetLook });
    r7check('dark cinematic artwork loads as the default scene',
      ui.poster === 'assets/scene_cinema.jpg' && ui.posterLoaded && ui.posterWidth >= 1000, ui);
    r7check('screenshot icon/feature is absent', ui.screenshotIcon === false, { screenshotIcon:ui.screenshotIcon });
    r7check('desktop host reports a working media engine',
      !!(ui.engine && ui.engine.available), ui.engine);

    /* exact menu order (desktop and touch) and prohibited rows */
    const menus = await r7run(`(function(){
      var oldItem = Lumen.Player.item;
      Lumen.Player.item = { name:'r7-test.mkv', path:'/tmp/r7-test.mkv', ext:'mkv' };
      function get(touch) {
        Lumen.buildMainMenu(60, 60, touch);
        var root = document.querySelector('.ctx');
        var sequence = Array.prototype.map.call(root.children, function(n){
          return n.classList.contains('sep') ? '<sep>' : n.classList.contains('mi') ? n.querySelector('.lbl').textContent.trim() : '?';
        });
        var labels = Array.prototype.map.call(root.querySelectorAll('.mi .lbl'), function(n){ return n.textContent.trim(); });
        Lumen.Menu.close(); return { sequence, labels };
      }
      var out = { desktop:get(false), touch:get(true) };
      Lumen.Player.item = oldItem;
      return out;
    })()`);
    /* R9 hotfix added the destructive "Delete file (Recycle Bin)" row after Media info */
    const expectedSeq = ['Open file…','Open folder…','Open URL / stream…','<sep>','Always on top','Mini player','Fullscreen','Picture in picture','Playlist panel','<sep>','Media info…','Delete file (Recycle Bin)','<sep>','Exit Lumen'];
    function menuOk(m) {
      return m && m.sequence.join('|') === expectedSeq.join('|') &&
        !m.labels.some(x => /^(Subtitles|Audio track|Loop & shuffle)/i.test(x));
    }
    r7check('right-click main menu has the requested order and no removed rows (desktop + touch)',
      menuOk(menus.desktop) && menuOk(menus.touch), menus);

    const allok = r7results.every(x => x.ok) && r7errors.length === 0;
    r7fs.writeFileSync('/tmp/lumen-r7-harness.json', JSON.stringify({ results:r7results, consoleErrors:r7errors, allok }, null, 2));
    console.log((allok ? 'ALL PASS' : 'TESTS FAILED') + ' (' + r7results.filter(x => x.ok).length + '/' + r7results.length + ')');
    console.log('renderer errors: ' + JSON.stringify(r7errors));
  } catch (e) {
    console.error('[r7 harness] ' + (e && e.stack || e));
    try { r7fs.writeFileSync('/tmp/lumen-r7-harness.json', JSON.stringify({ results:r7results, consoleErrors:r7errors, fatal:String(e && e.stack || e) }, null, 2)); } catch (x) { }
  }
  setTimeout(function(){ app.quit(); }, 500);
});
