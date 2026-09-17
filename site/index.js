/**
 * The public home page for Companion for YouTube, served from site/ on
 * GitHub Pages. Nothing leaves this page: install and footer are plain links.
 */

(function () {
  const TEXT = {
    en: {
      title: 'Companion for YouTube',
      lede: 'Follow YouTube channels without a Google account: one merged feed, alerts on new uploads, and a low-data audio mode.',
      storeChrome: 'Chrome Web Store',
      storeEdge: 'Edge Add-ons',
      free: 'Free, open source, no account.',
      feedsTitle: 'Feeds',
      feedsBody: 'Every new video from the channels you follow, in one list, newest first. Named groups narrow it. Live streams and premieres are tagged. Shorts stay hidden unless you want them. A small dot marks what arrived since you last opened the popup.',
      watchlistTitle: 'Watchlist',
      watchlistBody: 'Add a channel by pasting its link or @handle, or press Add on the tab you are on. Import your YouTube subscriptions from a Google Takeout file; it is read on your device and nothing signs in. Star favourites. Mute alerts for one channel from its menu; its videos still show in the feed.',
      playerTitle: 'Player',
      playerBody: 'Audio mode pins the video to 144p and covers it, so you keep the sound and use about 8× less data than 720p. Seek, skip 10 seconds, speed and volume sit in the popup. A sleep timer pauses after 15, 30 or 60 minutes. Switch it off and the quality you were watching comes back.',
      privateTitle: 'Private by design',
      privateBody: 'No account, no Google sign-in, no API key. It reads only public youtube.com pages, without your YouTube cookies. Your channels, feed and settings stay in the browser. Export them to a file, and import them back.',
      footerRepo: 'GitHub',
      footerPrivacy: 'Privacy policy',
      footerSupport: 'Support',
      trademark: 'Companion for YouTube is not affiliated with, endorsed by or sponsored by YouTube or Google. YouTube is a trademark of Google LLC.',
      heroAlt: 'The Feeds tab, with every new video from your channels in one list.',
      watchlistAlt: 'The Watchlist tab, with channels added by link.',
      playerAlt: 'The Player tab, with audio mode on.',
      heroSrc: 'images/home-feeds.png',
      watchlistSrc: 'images/home-watchlist.png',
      playerSrc: 'images/home-player.png',
      switchTo: 'العربية',
    },
    ar: {
      title: 'رفيق ليوتيوب',
      lede: 'تابع قنوات يوتيوب بلا حساب: موجز واحد مدمج، وتنبيهات بالفيديوهات الجديدة، ووضع صوت يوفّر البيانات.',
      storeChrome: 'سوق Chrome الإلكتروني',
      storeEdge: 'إضافات Microsoft Edge',
      free: 'مجانية ومفتوحة المصدر، بلا حساب.',
      feedsTitle: 'الموجز',
      feedsBody: 'كل فيديو جديد من القنوات التي تتابعها في قائمة واحدة، الأحدث أولًا. المجموعات تضيّق القائمة. البث المباشر والعروض الأولى عليها وسم واضح، والفيديوهات القصيرة مخفية إلا إذا أردتها. نقطة صغيرة تميّز ما وصل منذ آخر زيارة.',
      watchlistTitle: 'قائمة المتابعة',
      watchlistBody: 'أضف قناة بلصق رابطها أو ‎@handle، أو اضغط «إضافة» وأنت على تبويب القناة. استورد اشتراكاتك في يوتيوب من ملف Google Takeout؛ يُقرأ على جهازك ولا يسجّل الدخول إلى أي شيء. ميّز المفضلة بنجمة. اكتم تنبيهات قناة من قائمتها؛ وتبقى فيديوهاتها في الموجز.',
      playerTitle: 'مشغّل',
      playerBody: 'وضع الصوت يثبّت الفيديو على 144p ويغطيه، فيبقى الصوت وتستهلك بيانات أقل بنحو 8 مرات من 720p. التقديم والقفز 10 ثوانٍ والسرعة ومستوى الصوت في النافذة. مؤقت الإيقاف يوقف التشغيل بعد 15 أو 30 أو 60 دقيقة. أوقفه فيعود الفيديو إلى الجودة التي كنت تشاهد بها.',
      privateTitle: 'الخصوصية أولًا',
      privateBody: 'بلا حساب، وبلا تسجيل دخول بجوجل، وبلا مفتاح API. تقرأ صفحات youtube.com العامة فقط، ودون ملفات تعريف الارتباط الخاصة بحسابك. قنواتك وموجزك وإعداداتك تبقى في المتصفح. صدّرها إلى ملف، واستوردها مرة أخرى.',
      footerRepo: 'GitHub',
      footerPrivacy: 'سياسة الخصوصية',
      footerSupport: 'الدعم',
      trademark: '«رفيق ليوتيوب» غير تابع ليوتيوب أو جوجل، ولا يحظى بتأييدهما أو رعايتهما. يوتيوب علامة تجارية لشركة Google LLC.',
      heroAlt: 'تبويب الموجز، وكل فيديو جديد من قنواتك في قائمة واحدة.',
      watchlistAlt: 'تبويب قائمة المتابعة، والقنوات المضافة بالرابط.',
      playerAlt: 'تبويب المشغّل، ووضع الصوت قيد التشغيل.',
      heroSrc: 'images/home-feeds-ar.png',
      watchlistSrc: 'images/home-watchlist-ar.png',
      playerSrc: 'images/home-player-ar.png',
      switchTo: 'English',
    },
  };

  const params = new URLSearchParams(location.search);
  const asked = params.get('lang');
  const lang = asked === 'ar' || asked === 'en'
    ? asked
    : (String(navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en');
  const text = TEXT[lang];

  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = text.title;
  for (const el of document.querySelectorAll('[data-text]')) {
    const value = text[el.getAttribute('data-text')];
    if (el instanceof HTMLImageElement) el.setAttribute('alt', value);
    else el.textContent = value;
  }
  for (const el of document.querySelectorAll('[data-src]')) {
    const src = text[el.getAttribute('data-src')];
    if (src && el.getAttribute('src') !== src) el.setAttribute('src', src);
  }

  const other = lang === 'ar' ? 'en' : 'ar';
  const switchLink = document.getElementById('switch-lang');
  switchLink.href = `?lang=${other}`;
  switchLink.lang = other;
  switchLink.textContent = text.switchTo;
})();
