/* Extra icons for the app layer — drawn in the exact same style as _icons.js
   (24×24 viewBox, stroke 1.6, round caps/joins, currentColor). Merged into
   window.LUMEN_ICONS at boot by app.js. */
(function () {
  var S = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none"' +
          ' stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
  function i(paths) { return '<svg ' + S + '>' + paths + '</svg>'; }

  var extra = {
    'zoom-in': i('<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20.4 20.4"/><path d="M11 8.6v4.8M8.6 11h4.8"/>'),
    'zoom-out': i('<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20.4 20.4"/><path d="M8.6 11h4.8"/>'),
    'zoom-fit': i('<rect x="3.6" y="5.6" width="16.8" height="12.8" rx="2"/><path d="M8.4 10.2v3.6M15.6 10.2v3.6M6.4 12h11.2"/>'),
    'zoom-100': i('<path d="M9.2 5.4 6.6 7.2v11.4"/><path d="M10.6 18.6H5.8"/><circle cx="16.4" cy="11" r="4.2"/><circle cx="19.4" cy="14.2" r="3"/>'),
    'aspect': i('<rect x="3.4" y="6.6" width="17.2" height="10.8" rx="1.8"/><path d="M7 10.2h3.4M13.6 13.8H17"/>'),
    'rotate': i('<path d="M20.5 4v5h-5"/><path d="M20.2 13.5A8.3 8.3 0 1 1 18 7.2L20.5 9"/>'),
    'hand': i('<path d="M8.2 11.4V6.9a1.5 1.5 0 0 1 3 0v3.6"/><path d="M11.2 10.5V5.6a1.5 1.5 0 0 1 3 0v4.9"/><path d="M14.2 10.9V7.4a1.5 1.5 0 0 1 3 0v5.2"/><path d="M17.2 10.4a1.5 1.5 0 0 1 3 0v3.4c0 3.4-2.4 6.2-5.9 6.2-2.5 0-4.2-1.1-5.4-3.2L5 12.4a1.5 1.5 0 0 1 2.6-1.5l.6 1"/>'),
    'pin': i('<path d="M9.4 3.6h5.2l-.8 4.2 3 2.6v1.4h-4.2V21l-.6 1-.6-1v-8.8H7.2V10.6l3-2.6Z"/>'),
    'trash': i('<path d="M4.6 7.4h14.8"/><path d="M9.4 7.4V5.6a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.8"/><path d="M6.6 7.4l.9 11.2a1.6 1.6 0 0 0 1.6 1.4h5.8a1.6 1.6 0 0 0 1.6-1.4l.9-11.2"/><path d="M10.4 10.6v6M13.6 10.6v6"/>'),
    'grip': i('<path d="M9 6.4h.01M15 6.4h.01M9 12h.01M15 12h.01M9 17.6h.01M15 17.6h.01" stroke-width="2.4"/>'),
    'subs-off': i('<rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.4"/><path d="M7 14.9h4.2"/><path d="M4.6 4.4 19.4 19.6"/>'),
    'monitor': i('<rect x="3.4" y="4.6" width="17.2" height="12.2" rx="2"/><path d="M9.4 20.2h5.2M12 16.8v3.4"/>'),
    'hdr': i('<path d="M3.4 9.4v5.2M7.2 9.4v5.2M3.4 12h3.8"/><path d="M11 9.4v5.2h1.4a2.6 2.6 0 0 0 0-5.2Z"/><path d="M16.4 14.6V9.4h1.5a2.6 2.6 0 0 1 0 5.2Z"/><path d="M20.6 12h-1.9"/>'),
    'text-size': i('<path d="M3.6 6.6V4.6h11v2"/><path d="M9.1 4.6v14.8M6.4 19.4h5.4"/><path d="M15.6 19.4v-4.6h4.8v1.6"/><path d="M20.4 19.4h-4.8M18 16.6v2.8"/>'),
    'sparkle': i('<path d="M12 3.4l1.7 4.5 4.5 1.7-4.5 1.7L12 15.8l-1.7-4.5L5.8 9.6l4.5-1.7Z"/><path d="M18.6 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>'),
    'stopwatch': i('<circle cx="12" cy="13.4" r="7.2"/><path d="M12 9.6v3.8l2.6 1.7"/><path d="M9.6 3.6h4.8M12 6.2V4.4"/>'),
    'waveform': i('<path d="M3.6 12h2.2M8 7.4v9.2M12 4.8v14.4M16 8.6v6.8M20.4 12h-2.2"/>'),
    'history': i('<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1"/><path d="M3.4 4.2v4h4"/><path d="M12 8.6V12l3 1.8"/>'),
    'gauge': i('<path d="M4.2 17.4a8.6 8.6 0 1 1 15.6 0"/><path d="M12 13.6 15.6 9"/><circle cx="12" cy="17.4" r="1.4" fill="currentColor" stroke="none"/>'),
    'fullscreen': i('<path d="M4 9V6.2A2.2 2.2 0 0 1 6.2 4H9"/><path d="M15 4h2.8A2.2 2.2 0 0 1 20 6.2V9"/><path d="M20 15v2.8a2.2 2.2 0 0 1-2.2 2.2H15"/><path d="M9 20H6.2A2.2 2.2 0 0 1 4 17.8V15"/>'),
    'reset': i('<path d="M3.8 12a8.2 8.2 0 1 0 3-6.3"/><path d="M3.6 4.4v4.2H8"/>'),
    'speaker-off': i('<path d="M4 9.9v4.2h3.1l4.7 4V5.9L7.1 9.9Z" fill="currentColor" stroke="currentColor" stroke-width="1.3"/><path d="m15.9 9.7 4.7 4.6M20.6 9.7l-4.7 4.6"/>'),
    'speed-2': i('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12M9.2 14.6 12 12"/>'),
    'list-plus': i('<path d="M4 7h10M4 12h7M4 17h7"/><path d="M16.4 13.6v6.2M13.3 16.7h6.2"/>'),
    'eye': i('<path d="M2.8 12S6 6.6 12 6.6 21.2 12 21.2 12 18 17.4 12 17.4 2.8 12 2.8 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
    'film': i('<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.2"/><path d="M7.6 4.6v14.8M16.4 4.6v14.8M3.4 9.4h4.2M3.4 14.6h4.2M16.4 9.4h4.2M16.4 14.6h4.2"/>'),
    'chevron-right': i('<path d="m9.6 6.4 5.6 5.6-5.6 5.6"/>'),
    'layers': i('<path d="M12 3.6 20.4 8 12 12.4 3.6 8Z"/><path d="m3.6 12.4 8.4 4.4 8.4-4.4"/><path d="m3.6 16.4 8.4 4.4 8.4-4.4"/>')
  };

  window.LUMEN_ICONS = window.LUMEN_ICONS || {};
  for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) window.LUMEN_ICONS[k] = extra[k];
})();
