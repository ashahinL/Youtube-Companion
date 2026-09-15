/**
 * The page a browser opens after Companion for YouTube is removed. The
 * extension adds only ?lang= and ?v= to the address. Nothing leaves this
 * page on its own: Send opens a GitHub issue with the answers filled in, and
 * the person decides whether to post it.
 */

(function () {
  const ISSUE_URL = 'https://github.com/ashahinL/Youtube-Companion/issues/new';
  const MAX_DETAILS = 1500;

  const TEXT = {
    en: {
      title: 'Companion for YouTube was removed',
      lede: 'Sorry to see it go. If you have a minute, tell us why, so the next version is better.',
      question: 'Why did you remove it?',
      broken: 'Something did not work',
      audio: 'Audio mode did not work on a video',
      feed: 'New videos or alerts were missing or late',
      alerts: 'Too many alerts',
      missing: 'It is missing something I need',
      otherTool: 'I use something else now',
      trying: 'I was only trying it',
      details: 'Anything else? (optional)',
      send: 'Send on GitHub',
      sendNote: 'Nothing is sent from this page. The button opens a new GitHub issue with your answers filled in, and you post it yourself. That needs a GitHub account.',
      again: 'Changed your mind?',
      store: 'Get it again from the Chrome Web Store',
      switchTo: 'العربية',
    },
    ar: {
      title: 'تمت إزالة رفيق ليوتيوب',
      lede: 'يؤسفنا رحيلك. إن كان لديك دقيقة، أخبرنا بالسبب لتكون النسخة القادمة أفضل.',
      question: 'لماذا أزلتها؟',
      broken: 'شيء ما لم يعمل',
      audio: 'وضع الصوت لم يعمل على أحد الفيديوهات',
      feed: 'الفيديوهات الجديدة أو التنبيهات لم تصل أو تأخرت',
      alerts: 'تنبيهات كثيرة جدًا',
      missing: 'ينقصها شيء أحتاجه',
      otherTool: 'أستخدم أداة أخرى الآن',
      trying: 'كنت أجربها فقط',
      details: 'هل من شيء آخر؟ (اختياري)',
      send: 'أرسل عبر GitHub',
      sendNote: 'لا يُرسَل شيء من هذه الصفحة. يفتح الزر بلاغًا جديدًا على GitHub فيه إجاباتك، وأنت من ينشره. يتطلب ذلك حسابًا على GitHub.',
      again: 'غيّرت رأيك؟',
      store: 'ثبّتها مجددًا من سوق Chrome الإلكتروني',
      switchTo: 'English',
    },
  };

  // The issue is read by the maintainer, so reasons go in English whatever
  // language the page was read in.
  const REASON_KEYS = {
    broken: 'broken',
    audio: 'audio',
    feed: 'feed',
    alerts: 'alerts',
    missing: 'missing',
    'other-tool': 'otherTool',
    trying: 'trying',
  };

  const params = new URLSearchParams(location.search);
  const asked = params.get('lang');
  const lang = asked === 'ar' || asked === 'en'
    ? asked
    : (String(navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
  const rawVersion = params.get('v') || '';
  const version = /^\d+(\.\d+){0,3}$/.test(rawVersion) ? rawVersion : '';
  const text = TEXT[lang];

  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = text.title;
  for (const el of document.querySelectorAll('[data-text]')) {
    el.textContent = text[el.getAttribute('data-text')];
  }

  const other = lang === 'ar' ? 'en' : 'ar';
  const switchLink = document.getElementById('switch-lang');
  const switchParams = new URLSearchParams({ lang: other });
  if (version) switchParams.set('v', version);
  switchLink.href = `?${switchParams}`;
  switchLink.lang = other;
  switchLink.textContent = text.switchTo;

  document.getElementById('why').addEventListener('submit', (event) => {
    event.preventDefault();
    const ticked = [...document.querySelectorAll('input[name="reason"]:checked')]
      .map((box) => `- ${TEXT.en[REASON_KEYS[box.value]]}`);
    const details = document.getElementById('details').value.trim().slice(0, MAX_DETAILS);
    const body = [
      'Why I removed Companion for YouTube:',
      ticked.length ? ticked.join('\n') : '- (no reason ticked)',
      '',
      details,
      '',
      `Version: ${version || 'unknown'} · Language: ${lang}`,
    ].join('\n');
    const url = `${ISSUE_URL}?${new URLSearchParams({ title: 'Uninstall feedback', body })}`;
    window.open(url, '_blank', 'noopener');
  });
})();
