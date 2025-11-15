/* app.js
   Advanced Compass — sensor handling, smoothing, logging, export, dialogs
   Author: Ghulam Mustafa Siddiqui
   Save as: app.js
*/
(() => {
  'use strict';

  /* -----------------------
     Config & state
     ----------------------- */
  const cfg = {
    smoothing: 0.12,            // lower = smoother
    logLimitDefault: 100,
    tickStep: 10,
    majorTickStep: 30,
    storageKey: 'advanced_compass_v1',
    useSimulatedOnDesktop: true
  };

  const state = {
    currentRotation: 0,         // degrees applied to needle (CSS rotate)
    rawHeading: null,           // last measured heading (0..360)
    useTrueNorth: false,
    declination: 0,             // degrees to add/subtract for true north correction
    mode: 'magnetic',           // 'magnetic' or 'true'
    permitted: false,
    log: [],
    settings: {
      units: 'deg',
      tickDensity: 36,
      logSize: cfg.logLimitDefault
    }
  };

  /* -----------------------
     Element refs
     ----------------------- */
  const refs = {
    svg: document.getElementById('compass-svg'),
    needleGroup: document.getElementById('needle-group'),
    headingDisplay: document.getElementById('heading-display'),
    dirDisplay: document.getElementById('dir-display'),
    statusText: document.getElementById('status-text'),
    permissionIndicator: document.getElementById('permission-indicator'),
    headingDd: document.getElementById('heading-dd'),
    cardinalDd: document.getElementById('cardinal-dd'),
    accuracyDd: document.getElementById('accuracy-dd'),
    modeDd: document.getElementById('mode-dd'),
    declInput: document.getElementById('declination'),
    applyDeclBtn: document.getElementById('apply-decl'),
    toggleTrue: document.getElementById('toggle-true'),
    logList: document.getElementById('log-list'),
    btnRequest: document.getElementById('btn-request'),
    btnCalibrate: document.getElementById('btn-calibrate'),
    btnSettings: document.getElementById('btn-settings'),
    btnHelp: document.getElementById('btn-help'),
    settingsDialog: document.getElementById('settings-dialog'),
    helpDialog: document.getElementById('help-dialog'),
    settingsForm: document.getElementById('settings-form'),
    unitsSelect: document.getElementById('units-select'),
    tickDensity: document.getElementById('tick-density'),
    logSize: document.getElementById('log-size'),
    btnClearLog: document.getElementById('btn-clear-log'),
    btnExportLog: document.getElementById('btn-export-log'),
    btnRunDiagnostics: document.getElementById('btn-run-diagnostics'),
    btnShare: document.getElementById('btn-share'),
    sensorDiagnostics: document.getElementById('sensor-diagnostics'),
    compassFallback: document.getElementById('compass-fallback'),
    compassViewport: document.querySelector('.compass-viewport'),
  };

  /* -----------------------
     Utilities
     ----------------------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const nowISO = () => new Date().toISOString();
  const round = (v, d = 0) => {
    const p = Math.pow(10, d || 0);
    return Math.round(v * p) / p;
  };

  function toCardinal(deg) {
    // 16-point compass
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    const idx = Math.round(((deg % 360) / 22.5)) % 16;
    return dirs[idx];
  }

  function saveState() {
    try {
      const snapshot = {
        settings: state.settings,
        declination: state.declination,
        useTrueNorth: state.useTrueNorth,
        log: state.log.slice(0, state.settings.logSize)
      };
      localStorage.setItem(cfg.storageKey, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('Failed to save state', e);
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(cfg.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.settings) state.settings = Object.assign(state.settings, parsed.settings);
      if (typeof parsed.declination === 'number') state.declination = parsed.declination;
      if (typeof parsed.useTrueNorth === 'boolean') state.useTrueNorth = parsed.useTrueNorth;
      if (Array.isArray(parsed.log)) state.log = parsed.log.slice(0, state.settings.logSize);
    } catch (e) {
      console.warn('Failed to load state', e);
    }
  }

  /* -----------------------
     UI helpers
     ----------------------- */
  function setStatus(text, extraClass) {
    refs.statusText.textContent = 'Status: ' + text;
    document.body.classList.remove('permission-denied', 'sensor-ready');
    if (extraClass) document.body.classList.add(extraClass);
  }

  function setPermissionIndicator(ok) {
    refs.permissionIndicator.style.color = ok ? getComputedStyle(document.documentElement).getPropertyValue('--success') || '#22c55e' : getComputedStyle(document.documentElement).getPropertyValue('--danger') || '#f43f5e';
  }

  function updateReadouts(heading, accuracyHint) {
    const h = normalizeHeading(heading + (state.useTrueNorth ? state.declination : 0));
    const displayHeading = (state.settings.units === 'deg') ? `${round(h,0)}°` : `${Math.round((h/360)*6400)} mil`;
    refs.headingDisplay.textContent = displayHeading;
    refs.headingDd.textContent = displayHeading;
    refs.cardinalDd.textContent = toCardinal(h);
    refs.dirDisplay.textContent = 'Direction: ' + toCardinal(h);
    refs.cardinalDd.setAttribute('aria-label', `Direction ${toCardinal(h)}`);
    refs.accuracyDd.textContent = accuracyHint || '—';
    refs.modeDd.textContent = state.useTrueNorth ? 'True' : 'Magnetic';
  }

  /* -----------------------
     Heading math helpers
     ----------------------- */
  function normalizeHeading(h) {
    // puts heading into 0..360
    let val = Number(h);
    if (!isFinite(val)) return 0;
    val = ((val % 360) + 360) % 360;
    return val;
  }

  function shortestDiff(a, b) {
    // minimal signed angle from a to b (both 0..360)
    let d = ((b - a + 540) % 360) - 180;
    return d;
  }

  /* -----------------------
     Needle rotation (smooth)
     ----------------------- */
  function applyRotationToNeedle(targetHeading) {
    // targetHeading = compass heading in degrees (0 = North)
    // convert to needle rotation: we want 0° (needleGroup transform) to point north up: our SVG needle was designed pointing up,
    // so rotate by targetHeading.
    const target = normalizeHeading(targetHeading);
    // apply smoothing via linear interpolation on shortest path
    let cur = state.currentRotation;
    if (cur == null) cur = target;
    const diff = shortestDiff(cur, target);
    const step = diff * cfg.smoothing;
    state.currentRotation = normalizeHeading(cur + step);
    refs.needleGroup.classList.add('rotate-smooth');
    refs.needleGroup.setAttribute('transform', `translate(200,200) rotate(${state.currentRotation})`);
  }

  /* -----------------------
     Logging
     ----------------------- */
  function pushLog(heading, modeLabel) {
    const entry = {
      ts: nowISO(),
      heading: round(normalizeHeading(heading), 2),
      cardinal: toCardinal(heading),
      mode: modeLabel || (state.useTrueNorth ? 'true' : 'magnetic')
    };
    state.log.unshift(entry);
    // enforce size
    state.log = state.log.slice(0, state.settings.logSize || cfg.logLimitDefault);
    renderLog();
    saveState();
  }

  function renderLog() {
    refs.logList.innerHTML = '';
    state.log.forEach((e, idx) => {
      const li = document.createElement('li');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-pressed', 'false');

      const time = document.createElement('div');
      time.className = 'log-time';
      time.textContent = new Date(e.ts).toLocaleString();

      const heading = document.createElement('div');
      heading.className = 'log-heading';
      heading.textContent = `${e.heading}° — ${e.cardinal}`;

      const meta = document.createElement('div');
      meta.className = 'log-meta';
      meta.style.marginLeft = 'auto';
      meta.style.fontSize = '12px';
      meta.style.color = getComputedStyle(document.documentElement).getPropertyValue('--muted') || '#9fb6c6';
      meta.textContent = e.mode;

      li.appendChild(time);
      li.appendChild(heading);
      li.appendChild(meta);

      // clicking pins the value (for demo we just set heading)
      li.addEventListener('click', () => {
        // mark pinned visually
        document.querySelectorAll('.log-pinned').forEach(n => n.classList.remove('log-pinned'));
        li.classList.add('log-pinned');
        // set needle to that heading (no logging)
        applyRotationToNeedle(e.heading);
        setStatus(`pinned ${e.heading}° (${e.cardinal})`);
      });

      refs.logList.appendChild(li);
    });
  }

  function clearLog() {
    state.log = [];
    saveState();
    renderLog();
  }

  function exportLogCSV() {
    if (!state.log || !state.log.length) {
      alert('No log entries to export.');
      return;
    }
    const headers = ['timestamp,heading,cardinal,mode'];
    const rows = state.log.map(e => `${e.ts},${e.heading},${e.cardinal},${e.mode}`);
    const csv = headers.concat(rows).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `compass-log-${(new Date()).toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* -----------------------
     Diagnostics (basic)
     ----------------------- */
  function runDiagnostics() {
    let text = 'Diagnostics:\n';
    if ('DeviceOrientationEvent' in window) {
      text += '- DeviceOrientationEvent supported\n';
      if (typeof DeviceOrientationEvent.requestPermission === 'function') text += '- iOS-style permission required\n';
    } else {
      text += '- DeviceOrientationEvent NOT supported\n';
    }
    text += `- Pointer events: ${window.PointerEvent ? 'yes' : 'no'}\n`;
    refs.sensorDiagnostics.textContent = text;
    alert(text);
  }

  /* -----------------------
     DeviceOrientation handling
     ----------------------- */
  let lastEventTimestamp = 0;

  function handleDeviceOrientation(e) {
    // e may be WebKitCompassHeading capable (iOS)
    let heading = null;
    let accuracy = null;

    if (typeof e.webkitCompassHeading !== 'undefined' && e.webkitCompassHeading !== null) {
      heading = e.webkitCompassHeading; // iOS provides heading relative to magnetic north by default
      accuracy = (e.webkitCompassAccuracy !== undefined) ? `${e.webkitCompassAccuracy}°` : null;
    } else if (e.alpha !== null) {
      // If alpha is absolute and event.absolute true, it's likely compass heading.
      // Different browsers provide different frame references; this is best-effort.
      // We try to use screen orientation compensation.
      const alpha = e.alpha; // 0..360
      // On many devices, alpha is the rotation around Z axis with 0 at device-start orientation.
      // We'll use alpha as heading (best-effort).
      heading = alpha;
      if (e.absolute === true) accuracy = 'absolute';
    }

    if (heading === null) {
      // not usable
      return;
    }

    // throttle a bit: don't update too rapidly
    const now = performance.now();
    if (now - lastEventTimestamp < 15) return;
    lastEventTimestamp = now;

    // normalize & correct for screen orientation:
    heading = normalizeHeading(heading);

    // apply declination if using true north
    const effective = normalizeHeading(heading + (state.useTrueNorth ? state.declination : 0));
    // update raw heading for logging and display
    state.rawHeading = heading;

    // smoothing + rotate needle
    applyRotationToNeedle(heading);

    // update UI
    setStatus('using deviceorientation');
    setPermissionIndicator(true);
    document.body.classList.add('sensor-ready');
    refs.sensorDiagnostics && (refs.sensorDiagnostics.textContent = `Last sensor @ ${new Date().toLocaleTimeString()}`);

    updateReadouts(heading, accuracy);

    // push to log occasionally (e.g., every 3s or if heading changed by >X)
    const last = state.log[0];
    const shouldLog = !last || (Math.abs(shortestDiff(last.heading, heading)) > 3) || ((new Date() - new Date(last.ts)) > 3000);
    if (shouldLog) pushLog(heading);
  }

  /* -----------------------
     Permission flow (iOS & others)
     ----------------------- */
  async function requestMotionPermission() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit permission
        const res = await DeviceOrientationEvent.requestPermission();
        if (res === 'granted') {
          window.addEventListener('deviceorientation', handleDeviceOrientation, true);
          setStatus('permission granted — listening to sensors', 'sensor-ready');
          state.permitted = true;
          setPermissionIndicator(true);
        } else {
          setStatus('permission denied', 'permission-denied');
          state.permitted = false;
          setPermissionIndicator(false);
        }
      } else if ('DeviceOrientationEvent' in window) {
        // no permission prompt required
        window.addEventListener('deviceorientation', handleDeviceOrientation, true);
        setStatus('listening to deviceorientation', 'sensor-ready');
        state.permitted = true;
        setPermissionIndicator(true);
      } else {
        // unsupported
        setStatus('deviceorientation not supported — use mouse to simulate');
        setPermissionIndicator(false);
      }
    } catch (err) {
      console.warn('Permission request error', err);
      setStatus('permission error');
      setPermissionIndicator(false);
    }
  }

  /* -----------------------
     Mouse / touch fallback (desktop)
     ----------------------- */
  function attachPointerSimulation() {
    if (!cfg.useSimulatedOnDesktop || !refs.compassViewport) return;
    let active = false;
    refs.compassViewport.addEventListener('pointerdown', (e) => { active = true; refs.compassFallback.style.display = 'none'; refs.compassViewport.setPointerCapture(e.pointerId); });
    refs.compassViewport.addEventListener('pointerup', (e) => { active = false; refs.compassViewport.releasePointerCapture && refs.compassViewport.releasePointerCapture(e.pointerId); });
    refs.compassViewport.addEventListener('pointermove', (e) => {
      if (!active && e.buttons === 0) return;
      const rect = refs.compassViewport.getBoundingClientRect();
      const cx = rect.left + rect.width/2;
      const cy = rect.top + rect.height/2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      // angle from north (0 deg at up)
      const ang = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      state.rawHeading = ang;
      applyRotationToNeedle(ang);
      updateReadouts(ang, 'simulated');
      setStatus('simulated (pointer)');
      // do not log too frequently here; log on pointerup
    });

    refs.compassViewport.addEventListener('dblclick', () => {
      // pin current heading to log explicitly
      if (state.rawHeading !== null) pushLog(state.rawHeading, 'simulated');
    });

    // pointerup log
    refs.compassViewport.addEventListener('pointerup', () => {
      if (state.rawHeading !== null) pushLog(state.rawHeading, 'simulated');
    });
  }

  /* -----------------------
     Ticks generation (SVG)
     ----------------------- */
  function buildTicks(density = 36) {
    const ticksGroup = refs.svg.querySelector('#ticks');
    if (!ticksGroup) return;
    ticksGroup.innerHTML = '';
    const step = Math.round(360 / density);
    for (let i = 0; i < 360; i += step) {
      const g = document.createElementNS('http://www.w3.org/2000/svg','g');
      g.setAttribute('transform', `rotate(${i} 200 200)`);
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      const isMajor = (i % cfg.majorTickStep) === 0;
      const y1 = isMajor ? 24 : 34;
      line.setAttribute('x1','200'); line.setAttribute('x2','200');
      line.setAttribute('y1', String(y1)); line.setAttribute('y2', '48');
      line.setAttribute('stroke-width', isMajor ? '3' : '1');
      line.setAttribute('stroke', isMajor ? '#dff3fb' : '#9fcfdc');
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);

      // small label for major ticks (N,E,S,W already exist)
      if (isMajor && (i % 90 !== 0)) {
        const t = document.createElementNS('http://www.w3.org/2000/svg','text');
        const angleRad = (i - 90) * (Math.PI/180);
        const labelX = 200 + Math.cos(angleRad) * 156;
        const labelY = 200 + Math.sin(angleRad) * 156 + 6;
        t.setAttribute('x', String(labelX));
        t.setAttribute('y', String(labelY));
        t.setAttribute('text-anchor','middle');
        t.setAttribute('font-size','12');
        t.setAttribute('fill','#bfe9f2');
        t.textContent = String(i);
        ticksGroup.appendChild(t);
      }

      ticksGroup.appendChild(g);
    }
  }

  /* -----------------------
     Dialogs & settings
     ----------------------- */
  function wireDialogs() {
    if (refs.btnSettings && refs.settingsDialog) {
      refs.btnSettings.addEventListener('click', () => {
        if (typeof refs.settingsDialog.showModal === 'function') {
          // populate controls with current settings
          refs.unitsSelect.value = state.settings.units || 'deg';
          refs.tickDensity.value = state.settings.tickDensity || 36;
          refs.logSize.value = state.settings.logSize || cfg.logLimitDefault;
          refs.settingsDialog.showModal();
        } else {
          alert('Your browser does not support dialogs.');
        }
      });
    }

    if (refs.settingsDialog) {
      refs.settingsDialog.addEventListener('close', (ev) => {
        // nothing special
      });
      // save handler
      refs.settingsForm && refs.settingsForm.addEventListener('submit', (ev) => {
        ev.preventDefault();
        state.settings.units = refs.unitsSelect.value;
        state.settings.tickDensity = parseInt(refs.tickDensity.value, 10) || 36;
        state.settings.logSize = parseInt(refs.logSize.value, 10) || cfg.logLimitDefault;
        // rebuild ticks and re-render
        buildTicks(state.settings.tickDensity);
        saveState();
        try { refs.settingsDialog.close(); } catch (e) {}
        setStatus('settings saved');
      });
      // close button
      const closeBtn = document.getElementById('settings-close');
      if (closeBtn) closeBtn.addEventListener('click', () => refs.settingsDialog.close());
    }

    if (refs.btnHelp && refs.helpDialog) {
      refs.btnHelp.addEventListener('click', () => {
        if (typeof refs.helpDialog.showModal === 'function') refs.helpDialog.showModal();
        else alert('Help: Allow motion access on mobile. Desktop: drag on compass to simulate.');
      });
      const helpClose = document.getElementById('help-close');
      if (helpClose) helpClose.addEventListener('click', () => refs.helpDialog.close());
    }
  }

  /* -----------------------
     UI wiring for controls
     ----------------------- */
  function wireControls() {
    // request permission
    if (refs.btnRequest) refs.btnRequest.addEventListener('click', requestMotionPermission);

    // calibrate (guidance only)
    if (refs.btnCalibrate) refs.btnCalibrate.addEventListener('click', () => {
      setStatus('calibrating... rotate device gently');
      // brief wiggle animation
      let a = 0; const iv = setInterval(()=> {
        a += 18;
        refs.needleGroup.setAttribute('transform', `translate(200,200) rotate(${a})`);
        if (a > 360) { clearInterval(iv); setStatus('calibration done — waiting'); }
      }, 30);
    });

    // declination apply
    if (refs.applyDeclBtn) refs.applyDeclBtn.addEventListener('click', () => {
      const val = parseFloat(refs.declInput.value);
      if (isNaN(val)) {
        refs.declInput.classList.add('js-error');
        setTimeout(()=> refs.declInput.classList.remove('js-error'), 800);
        return;
      }
      state.declination = val;
      saveState();
      setStatus(`declination set to ${val}°`);
      if (state.rawHeading !== null) updateReadouts(state.rawHeading);
    });

    // toggle true north
    if (refs.toggleTrue) {
      refs.toggleTrue.checked = state.useTrueNorth;
      refs.toggleTrue.addEventListener('change', (ev) => {
        state.useTrueNorth = !!ev.target.checked;
        saveState();
        setStatus(state.useTrueNorth ? 'using true north' : 'using magnetic north');
        if (state.rawHeading !== null) updateReadouts(state.rawHeading);
      });
    }

    if (refs.btnClearLog) refs.btnClearLog.addEventListener('click', () => {
      if (!confirm('Clear log?')) return;
      clearLog();
      setStatus('log cleared');
    });

    if (refs.btnExportLog) refs.btnExportLog.addEventListener('click', exportLogCSV);

    if (refs.btnRunDiagnostics) refs.btnRunDiagnostics.addEventListener('click', runDiagnostics);

    if (refs.btnShare && navigator.share) {
      refs.btnShare.addEventListener('click', async () => {
        try {
          const text = `Compass log (${state.log.length} entries)`;
          await navigator.share({ title: 'Compass Log', text });
        } catch (err) {
          alert('Share failed or canceled.');
        }
      });
    } else {
      if (refs.btnShare) refs.btnShare.addEventListener('click', () => {
        alert('Share not supported in this browser.');
      });
    }
  }

  /* -----------------------
     Init & start
     ----------------------- */
  function init() {
    loadState();
    // apply loaded state UI
    refs.declInput && (refs.declInput.value = state.declination || '');
    refs.toggleTrue && (refs.toggleTrue.checked = state.useTrueNorth);

    // build ticks according to saved settings
    buildTicks(state.settings.tickDensity || 36);

    // render log
    renderLog();

    // wire dialogs & controls
    wireDialogs();
    wireControls();

    // pointer simulation for desktop
    attachPointerSimulation();

    // initial status
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      setStatus('tap "Request Motion" for iOS motion permission');
    } else if ('DeviceOrientationEvent' in window) {
      setStatus('listening (deviceorientation available)');
      // add listener right away if available
      window.addEventListener('deviceorientation', handleDeviceOrientation, true);
      state.permitted = true;
      setPermissionIndicator(true);
    } else {
      setStatus('deviceorientation not supported — use pointer simulation');
      setPermissionIndicator(false);
    }

    // other bindings
    refs.btnRequest && (refs.btnRequest.disabled = false);

    // restore needle transform if present
    if (state.currentRotation) refs.needleGroup.setAttribute('transform', `translate(200,200) rotate(${state.currentRotation})`);

    // optional: register service worker for PWA offline (best-effort)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').then(() => {
        // silent success
      }).catch(()=>{/* ignore */});
    }
  }

  // Kick off
  init();

  // Expose some debug API on window (optional)
  window._COMPASS = {
    state,
    cfg,
    pushLog,
    exportLogCSV,
    clearLog,
    requestMotionPermission
  };

})();
