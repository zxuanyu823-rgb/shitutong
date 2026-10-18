// Small-screen workspace controls; model and assistant behavior stay in App.
export function initMobile(app) {
  const $ = id => document.getElementById(id);
  const compact = window.matchMedia('(max-width: 1180px)');
  const portrait = window.matchMedia('(max-width: 760px) and (orientation: portrait)');
  const body = document.body;
  const panel = $('chatPanel');
  const input = $('askInput');
  const intent = $('chatIntent');
  const tabs = [...document.querySelectorAll('[data-mobile-view]')];
  let drawerOpen = false;
  let previousFocus = null;
  let lastPhoto = null;
  let inputViewportHeight = 0;

  function updateViewport() {
    const viewport = window.visualViewport;
    const height = viewport?.height || window.innerHeight;
    const inset = viewport ? Math.max(0, window.innerHeight - height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty('--visual-height', `${Math.round(height)}px`);
    document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
    body.classList.toggle('keyboard-open', document.activeElement === input && inputViewportHeight - height > 100);
  }

  function setView(view) {
    body.dataset.mobileView = view === 'drawing' ? 'drawing' : 'model';
    refresh();
  }

  function syncDrawer() {
    const modal = compact.matches && drawerOpen;
    body.classList.toggle('chat-open', modal);
    $('chatOpen').setAttribute('aria-expanded', String(modal));
    $('chatBackdrop').hidden = !modal;
    panel.inert = compact.matches && !modal;
    if (compact.matches && !modal) panel.setAttribute('aria-hidden', 'true');
    else panel.removeAttribute('aria-hidden');
    if (modal) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
    }
    for (const element of document.querySelectorAll('.bar, #mobileViews, .desk > section')) element.inert = modal;
  }

  function openChat({ focusInput = false } = {}) {
    if (compact.matches) {
      if (!drawerOpen) {
        previousFocus = document.activeElement;
        // Opening the keyboard can change the CSS aspect ratio on Android.
        // Keep a portrait drawer full-width for the whole conversation.
        body.dataset.chatPlacement = portrait.matches ? 'bottom' : 'auto';
      }
      drawerOpen = true;
      syncDrawer();
      requestAnimationFrame(() => {
        if (focusInput) input.focus({ preventScroll: true });
        else $('chatClose').focus({ preventScroll: true });
        $('msgs').scrollTop = $('msgs').scrollHeight;
      });
    } else if (focusInput) input.focus({ preventScroll: true });
  }

  function closeChat() {
    if (!drawerOpen) return;
    drawerOpen = false;
    if (panel.contains(document.activeElement)) document.activeElement.blur();
    syncDrawer();
    if (compact.matches) (previousFocus?.isConnected ? previousFocus : $('chatOpen')).focus({ preventScroll: true });
  }

  function setIntent(value) {
    const next = value === 'edit' ? 'edit' : 'learn';
    const changed = app.chatIntent !== next;
    app.chatIntent = next;
    intent.dataset.intent = next;
    intent.querySelectorAll('button[data-intent]').forEach(button => {
      const selected = button.dataset.intent === next;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    input.placeholder = next === 'edit' ? '如：右边少一级台阶' : '问问题，如：这条为何是虚线？';
    input.setAttribute('aria-label', next === 'edit' ? '描述模型哪里不对，以及你想怎样修改' : '向助教提问');
    $('editStatus').hidden = next !== 'edit';
    $('editToolbar').hidden = next !== 'edit';
    if (changed) intent.dispatchEvent(new CustomEvent('chatintentchange', { bubbles: true, detail: { intent: next } }));
  }

  function refresh() {
    const photo = !$('recon').hidden;
    if (lastPhoto !== null && photo !== lastPhoto && photo) body.dataset.mobileView = 'drawing';
    lastPhoto = photo;
    if (!body.dataset.mobileView) body.dataset.mobileView = 'model';
    const selected = body.dataset.mobileView;
    $('drawingTab').textContent = photo ? '照片与图纸' : '三视图';
    $('drawingTab').setAttribute('aria-controls', photo ? 'recon' : 'drawingPanel');
    tabs.forEach(button => {
      const active = button.dataset.mobileView === selected;
      button.classList.toggle('on', active);
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    for (const [id, view] of [['modelPanel', 'model'], ['drawingPanel', 'drawing'], ['recon', 'drawing']]) {
      const element = $(id);
      if (portrait.matches && selected !== view) element.setAttribute('aria-hidden', 'true');
      else element.removeAttribute('aria-hidden');
    }
    document.querySelectorAll('#modeSeg button').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('on'))));
    syncDrawer();
    updateViewport();
  }

  tabs.forEach(button => button.addEventListener('click', () => setView(button.dataset.mobileView)));
  $('mobileViews').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const view = event.key === 'Home' ? 'model' : event.key === 'End' ? 'drawing' : body.dataset.mobileView === 'model' ? 'drawing' : 'model';
    setView(view);
    tabs.find(button => button.dataset.mobileView === view).focus();
  });
  intent.addEventListener('click', event => {
    const button = event.target.closest('button[data-intent]');
    if (button) setIntent(button.dataset.intent);
  });
  $('chatOpen').addEventListener('click', () => openChat());
  $('chatClose').addEventListener('click', closeChat);
  $('chatModel').addEventListener('click', () => { setView('model'); closeChat(); });
  $('chatBackdrop').addEventListener('click', closeChat);
  document.addEventListener('keydown', event => {
    if (!compact.matches || !drawerOpen || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); closeChat(); }
    if (event.key === 'Tab') {
      const elements = [...panel.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]')].filter(element => element.getClientRects().length);
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  });
  input.addEventListener('focus', () => { inputViewportHeight = window.visualViewport?.height || window.innerHeight; updateViewport(); });
  input.addEventListener('blur', () => { inputViewportHeight = 0; updateViewport(); });
  $('askForm').addEventListener('submit', () => requestAnimationFrame(() => { if (!input.value) input.style.height = ''; }));

  // App controls these attributes when switching learning modes.
  new MutationObserver(refresh).observe($('recon'), { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(refresh).observe($('modeSeg'), { subtree: true, attributes: true, attributeFilter: ['class'] });
  compact.addEventListener('change', refresh);
  portrait.addEventListener('change', refresh);
  window.addEventListener('resize', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
  window.visualViewport?.addEventListener('scroll', updateViewport, { passive: true });
  app.refreshMobile = refresh;
  app.showMobileView = setView;
  app.setChatIntent = setIntent;
  app.openChat = openChat;
  app.closeChat = closeChat;
  setIntent(app.chatIntent || 'learn');
  refresh();
}
