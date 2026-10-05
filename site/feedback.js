/**
 * Shared by the uninstall page and the feedback page. The extension adds
 * only ?lang= and ?v= to the uninstall address. Send posts the message to
 * the feedback worker. This page keeps nothing itself.
 */

(function () {
  const FEEDBACK_URL = 'https://feedback.ammarshahin.dev/';
  const TURNSTILE_SITE_KEY = '0x4AAAAAAFOfyFX_ARX1uSi9';

  const TEXT = {
    en: {
      title: 'Companion for YouTube was removed',
      lede: 'Sorry to see it go. What made you remove it? Anything you write helps the next version.',
      feedbackTitle: 'Send feedback — Companion for YouTube',
      feedbackLede: 'Tell us what works, what doesn\'t, or what you\'d like next.',
      label: 'Your message',
      send: 'Send',
      sendNote: 'Only what you type is sent, with the extension\'s version and this page\'s language. No name, email or account is needed, and nothing else is kept. A Cloudflare check runs first to stop spam.',
      thanks: 'Thank you. Your message was sent.',
      empty: 'Write something first.',
      limited: 'Too many messages at once. Try again in a minute.',
      failed: 'It could not be sent. Try again in a moment.',
      again: 'Changed your mind?',
      storeChrome: 'Get it again from the Chrome Web Store',
      storeEdge: 'Get it again from Edge Add-ons',
      switchTo: 'العربية',
    },
    ar: {
      title: 'تمت إزالة رفيق ليوتيوب',
      lede: 'يؤسفنا رحيلك. ما الذي جعلك تزيلها؟ أي شيء تكتبه يساعد النسخة القادمة.',
      feedbackTitle: 'أرسل ملاحظاتك — رفيق ليوتيوب',
      feedbackLede: 'أخبرنا بما يعمل، وما لا يعمل، أو بما تريده لاحقًا.',
      label: 'رسالتك',
      send: 'أرسل',
      sendNote: 'يُرسَل فقط ما تكتبه، مع إصدار الإضافة ولغة هذه الصفحة. لا حاجة لاسم أو بريد أو حساب، ولا يُحفظ شيء غير ذلك. يجري فحص من Cloudflare أولًا لمنع الرسائل المزعجة.',
      thanks: 'شكرًا لك. تم إرسال رسالتك.',
      empty: 'اكتب شيئًا أولًا.',
      limited: 'رسائل كثيرة دفعة واحدة. حاول مرة أخرى بعد دقيقة.',
      failed: 'تعذر الإرسال. حاول مرة أخرى بعد قليل.',
      again: 'غيّرت رأيك؟',
      storeChrome: 'ثبّتها مجددًا من سوق Chrome الإلكتروني',
      storeEdge: 'ثبّتها مجددًا من إضافات Microsoft Edge',
      switchTo: 'English',
    },
  };

  const params = new URLSearchParams(location.search);
  const asked = params.get('lang');
  const lang = asked === 'ar' || asked === 'en'
    ? asked
    : (String(navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
  const rawVersion = params.get('v') || '';
  const version = /^\d+(\.\d+){0,3}$/.test(rawVersion) ? rawVersion : '';
  const text = TEXT[lang];
  const form = document.getElementById('send-form');
  const kind = form.dataset.kind;
  const textarea = document.getElementById('text');
  const sendButton = form.querySelector('button[type="submit"]');
  const statusEl = document.getElementById('status');
  let token = '';

  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  for (const el of document.querySelectorAll('[data-text]')) {
    el.textContent = text[el.getAttribute('data-text')];
  }
  document.title = document.querySelector('h1').textContent;

  const other = lang === 'ar' ? 'en' : 'ar';
  const switchLink = document.getElementById('switch-lang');
  const switchParams = new URLSearchParams({ lang: other });
  if (version) switchParams.set('v', version);
  switchLink.href = `?${switchParams}`;
  switchLink.lang = other;
  switchLink.textContent = text.switchTo;

  sendButton.disabled = true;

  function show(key) {
    statusEl.textContent = key ? text[key] : '';
  }

  function giveUp() {
    show('failed');
  }

  // The widget script is async. Wait for it, then give the person a token.
  const started = Date.now();
  (function waitForTurnstile() {
    if (window.turnstile) {
      window.turnstile.render('#challenge', {
        sitekey: TURNSTILE_SITE_KEY,
        language: lang,
        callback(value) {
          token = value;
          sendButton.disabled = false;
        },
      });
      return;
    }
    if (Date.now() - started >= 10000) {
      giveUp();
      return;
    }
    setTimeout(waitForTurnstile, 100);
  })();

  function rejected() {
    token = '';
    sendButton.disabled = true;
    show('failed');
    if (window.turnstile) window.turnstile.reset();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = textarea.value.trim().slice(0, 2000);
    if (!message) {
      show('empty');
      return;
    }
    if (!token) return;
    sendButton.disabled = true;
    show('');
    try {
      const response = await fetch(FEEDBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, text: message, lang, v: version, token }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      const data = await response.json().catch(() => ({}));
      if (data.ok === true) {
        form.hidden = true;
        show('thanks');
        return;
      }
      if (data.error === 'limited') {
        show('limited');
        sendButton.disabled = false;
        return;
      }
      rejected();
    } catch {
      rejected();
    }
  });
})();
